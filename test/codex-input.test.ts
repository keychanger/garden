import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import type { WorkerEntry } from "../src/dashboard/registry.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const workers: Record<string, WorkerEntry[]> = {};

vi.mock("../src/dashboard/registry.js", () => ({
  readRegistry: vi.fn(() => ({ workers })),
  batchUpdateWorkerFields: vi.fn((updates: Array<{
    project: string;
    workerName: string;
    fields: Partial<WorkerEntry>;
  }>) => {
    for (const update of updates) {
      const entry = workers[update.project]?.find(candidate => candidate.name === update.workerName);
      if (entry) Object.assign(entry, update.fields);
    }
  }),
}));

vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/dashboard/tmux.js", () => ({
  shellEscape: vi.fn((value: string) => value),
  pasteAndSubmit: vi.fn(),
  stripControlSequences: vi.fn((value: string) => value),
}));

import {
  reconcileCodexInputRequests,
  startCodexInputWatcher,
} from "../src/dashboard/codex-input.js";
import { batchUpdateWorkerFields } from "../src/dashboard/registry.js";

const requestedAt = Date.parse("2026-08-07T23:35:24.483Z");
const answeredAt = Date.parse("2026-08-07T23:36:04.112Z");

function fixture(name: string): string {
  return path.join(HERE, "fixtures", "codex", name);
}

function entry(fields: Partial<WorkerEntry> = {}): WorkerEntry {
  return {
    name: "plan-worker",
    sessionId: "session-1",
    task: "draft remediation plan",
    harness: "codex",
    agentStatus: "working",
    transcriptPath: fixture("rollout-awaiting-input.jsonl"),
    ...fields,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const project of Object.keys(workers)) delete workers[project];
});

describe("reconcileCodexInputRequests", () => {
  it("marks a Codex worker asking while request_user_input has no result", () => {
    const worker = entry({ lastStateChangeAt: requestedAt - 1000 });
    workers.garden = [worker];

    expect(reconcileCodexInputRequests()).toBe(true);
    expect(worker.agentStatus).toBe("asking");
    expect(worker.lastStateChangeAt).toBeGreaterThanOrEqual(requestedAt);
  });

  it("restores working after the matching request_user_input result arrives", () => {
    const worker = entry({
      agentStatus: "asking",
      lastStateChangeAt: requestedAt,
      transcriptPath: fixture("rollout-answered-input.jsonl"),
    });
    workers.garden = [worker];

    expect(reconcileCodexInputRequests()).toBe(true);
    expect(worker.agentStatus).toBe("working");
  });

  it("does not clear a newer asking state produced by a permission request", () => {
    const worker = entry({
      agentStatus: "asking",
      lastStateChangeAt: answeredAt + 1000,
      transcriptPath: fixture("rollout-answered-input.jsonl"),
    });
    workers.garden = [worker];

    expect(reconcileCodexInputRequests()).toBe(false);
    expect(worker.agentStatus).toBe("asking");
    expect(batchUpdateWorkerFields).not.toHaveBeenCalled();
  });

  it("ignores Claude workers and inactive Codex workers", () => {
    workers.garden = [
      entry({ name: "claude", harness: "claude-code" }),
      entry({ name: "idle-codex", agentStatus: "idle" }),
    ];

    expect(reconcileCodexInputRequests()).toBe(false);
    expect(batchUpdateWorkerFields).not.toHaveBeenCalled();
  });
});

describe("startCodexInputWatcher", () => {
  it("reconciles and notifies when a Codex rollout changes", async () => {
    vi.useFakeTimers();
    let onChange: fs.WatchListener<string> | undefined;
    const watcher = new EventEmitter();
    const watchSpy = vi.spyOn(fs, "watch").mockImplementation(((
      _path: fs.PathLike,
      _options: fs.WatchOptions,
      listener: fs.WatchListener<string>,
    ) => {
      onChange = listener;
      return watcher as fs.FSWatcher;
    }) as typeof fs.watch);
    const repaint = vi.fn();

    try {
      startCodexInputWatcher(repaint);
      const worker = entry();
      workers.garden = [worker];
      onChange?.("change", worker.transcriptPath);
      await vi.advanceTimersByTimeAsync(250);

      expect(worker.agentStatus).toBe("asking");
      expect(repaint).toHaveBeenCalledTimes(1);
    } finally {
      watchSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});

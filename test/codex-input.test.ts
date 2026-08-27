import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import type { WorkerEntry } from "../src/dashboard/registry.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const workers: Record<string, WorkerEntry[]> = {};

// Runs just before updateWorkerFieldsIf evaluates its decide callback, modeling
// a concurrent hook write (a Stop that idled the turn) landing between
// reconcileCodexInputRequests' unlocked scan and its locked write — the race the
// inner status re-check defends.
let onUpdate: (() => void) | undefined;

vi.mock("../src/dashboard/registry.js", () => ({
  readRegistry: vi.fn(() => ({ workers })),
  updateWorkerFieldsIf: vi.fn((
    project: string,
    workerName: string,
    decide: (entry: WorkerEntry) => { fields: Partial<WorkerEntry> | null; result: unknown },
  ) => {
    onUpdate?.();
    const entry = workers[project]?.find(candidate => candidate.name === workerName);
    if (!entry) return undefined;
    const decision = decide(entry);
    if (decision.fields !== null) Object.assign(entry, decision.fields);
    return decision.result;
  }),
}));

vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/dashboard/poller-fifo.js", () => ({
  triggerProjectPoll: vi.fn(),
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
import { updateWorkerFieldsIf } from "../src/dashboard/registry.js";
import { triggerProjectPoll } from "../src/dashboard/poller-fifo.js";

const requestedAt = Date.parse("2026-08-07T23:35:24.483Z");
const answeredAt = Date.parse("2026-08-07T23:36:04.112Z");
const turnActivityAt = Date.parse("2026-08-09T09:36:43.187Z");
const turnCompleteAt = Date.parse("2026-08-09T09:36:46.882Z");

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
  onUpdate = undefined;
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
    expect(updateWorkerFieldsIf).not.toHaveBeenCalled();
  });

  it("drops the update when a hook moved the worker between the scan and the write", () => {
    // The Stop hook idles a turn that ended while the answered rollout was
    // still being reconciled. Writing `working` over that would leave the row
    // spinning until the operator's next prompt, with nothing to correct it.
    const worker = entry({
      agentStatus: "asking",
      lastStateChangeAt: requestedAt,
      transcriptPath: fixture("rollout-answered-input.jsonl"),
    });
    workers.garden = [worker];
    onUpdate = () => { worker.agentStatus = "idle"; };

    expect(reconcileCodexInputRequests()).toBe(false);
    expect(worker.agentStatus).toBe("idle");
  });

  it("does not clear a permission request that lands between scan and write", () => {
    const worker = entry({
      agentStatus: "asking",
      lastStateChangeAt: requestedAt,
      transcriptPath: fixture("rollout-answered-input.jsonl"),
    });
    workers.garden = [worker];
    onUpdate = () => { worker.lastStateChangeAt = answeredAt + 1000; };

    expect(reconcileCodexInputRequests()).toBe(false);
    expect(worker.agentStatus).toBe("asking");
  });

  // Codex fires `Stop` on only some of the several `task_complete` events it
  // emits per turn, and keeps firing PostToolUse afterwards — so `working` can
  // outlive the turn with no hook left to clear it. Observed 2026-08-09: a
  // worker stalled 30h in merge-pending because the merge gate refuses to touch
  // a worktree it believes an agent is editing.
  it("idles a Codex worker whose rollout shows the turn already ended", () => {
    const worker = entry({
      agentStatus: "working",
      lastEventAt: turnActivityAt,
      lastStateChangeAt: turnActivityAt,
      transcriptPath: fixture("rollout-turn-complete.jsonl"),
    });
    workers.garden = [worker];

    expect(reconcileCodexInputRequests()).toBe(true);
    expect(worker.agentStatus).toBe("idle");
    expect(triggerProjectPoll).toHaveBeenCalledWith("garden");
  });

  it("heals a worker whose prState advanced after the turn ended", () => {
    // The stalled shape from 2026-08-09: the premature Stop launched a review,
    // so reviewing -> merge-pending stamped lastStateChangeAt minutes AFTER the
    // real task_complete. Keying the freshness guard on lastStateChangeAt puts
    // the heal permanently out of reach for exactly the workers that need it.
    const worker = entry({
      agentStatus: "working",
      prState: "merge-pending",
      lastEventAt: turnActivityAt,
      lastStateChangeAt: turnCompleteAt + 219_000,
      transcriptPath: fixture("rollout-turn-complete.jsonl"),
    });
    workers.garden = [worker];

    expect(reconcileCodexInputRequests()).toBe(true);
    expect(worker.agentStatus).toBe("idle");
  });

  it("leaves working alone while activity follows the newest task_complete", () => {
    const worker = entry({
      agentStatus: "working",
      lastStateChangeAt: 0,
      transcriptPath: fixture("rollout-turn-resumed.jsonl"),
    });
    workers.garden = [worker];

    expect(reconcileCodexInputRequests()).toBe(false);
    expect(worker.agentStatus).toBe("working");
  });

  it("leaves a freshly prompted worker working when the turn end predates it", () => {
    // The rollout still ends at the PREVIOUS turn's task_complete when a new
    // prompt lands, so an unguarded heal would idle a worker that is running.
    const worker = entry({
      agentStatus: "working",
      lastEventAt: turnCompleteAt + 1000,
      transcriptPath: fixture("rollout-turn-complete.jsonl"),
    });
    workers.garden = [worker];

    expect(reconcileCodexInputRequests()).toBe(false);
    expect(worker.agentStatus).toBe("working");
  });

  it("keeps asking rather than idling it on a completed turn", () => {
    // request_user_input parks the turn; the rollout shows no activity after
    // the last task_complete, but the worker is blocked on the operator.
    const worker = entry({
      agentStatus: "asking",
      lastStateChangeAt: turnActivityAt,
      transcriptPath: fixture("rollout-turn-complete.jsonl"),
    });
    workers.garden = [worker];

    expect(reconcileCodexInputRequests()).toBe(false);
    expect(worker.agentStatus).toBe("asking");
  });

  it("drops the idle heal when a hook moved the worker between scan and write", () => {
    const worker = entry({
      agentStatus: "working",
      lastEventAt: turnActivityAt,
      lastStateChangeAt: turnActivityAt,
      transcriptPath: fixture("rollout-turn-complete.jsonl"),
    });
    workers.garden = [worker];
    onUpdate = () => { worker.agentStatus = "asking"; };

    expect(reconcileCodexInputRequests()).toBe(false);
    expect(worker.agentStatus).toBe("asking");
  });

  it("drops the idle heal when concurrent tool activity keeps the worker working", () => {
    const worker = entry({
      agentStatus: "working",
      lastEventAt: turnActivityAt,
      transcriptPath: fixture("rollout-turn-complete.jsonl"),
    });
    workers.garden = [worker];
    onUpdate = () => { worker.lastEventAt = turnCompleteAt + 1000; };

    expect(reconcileCodexInputRequests()).toBe(false);
    expect(worker.agentStatus).toBe("working");
    expect(triggerProjectPoll).not.toHaveBeenCalled();
  });

  it("ignores Claude workers and inactive Codex workers", () => {
    workers.garden = [
      entry({ name: "claude", harness: "claude-code" }),
      entry({ name: "idle-codex", agentStatus: "idle" }),
    ];

    expect(reconcileCodexInputRequests()).toBe(false);
    expect(updateWorkerFieldsIf).not.toHaveBeenCalled();
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

  it("arms the watcher on a machine where Codex has never run", () => {
    // A fresh workstation has no ~/.codex/sessions until Codex's first run, so
    // fs.watch threw ENOENT and this watcher — which has no retry — stayed dead
    // for the whole life of the watchdog process that started it. Codex workers
    // then showed no `asking` status and lost missed-turn-end healing, the class
    // that strands a worker in merge-pending indefinitely.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "garden-codex-home-"));
    const previousHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    const sessionsDir = path.join(home, "sessions");
    const watcher = new EventEmitter();
    const watchSpy = vi.spyOn(fs, "watch").mockImplementation(((
      _path: fs.PathLike,
      _options: fs.WatchOptions,
      _listener: fs.WatchListener<string>,
    ) => watcher as fs.FSWatcher) as typeof fs.watch);

    try {
      startCodexInputWatcher(vi.fn());

      expect(fs.existsSync(sessionsDir)).toBe(true);
      expect(watchSpy).toHaveBeenCalledWith(sessionsDir, expect.anything(), expect.anything());
    } finally {
      watchSpy.mockRestore();
      if (previousHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousHome;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

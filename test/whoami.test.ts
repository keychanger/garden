import { describe, it, expect, vi, beforeEach } from "vitest";
import { captureConsoleLog } from "./helpers.js";

vi.mock("../src/dashboard/registry.js", () => {
  const entries: Record<string, import("../src/dashboard/registry.js").WorkerEntry[]> = {};
  return {
    readRegistry: vi.fn(() => ({ workers: entries })),
    findWorkerByName: (project: string, workerName: string) =>
      (entries[project] ?? []).find(e => e.name === workerName),
    _setEntries: (project: string, list: import("../src/dashboard/registry.js").WorkerEntry[]) => {
      entries[project] = list;
    },
    _clear: () => {
      for (const key of Object.keys(entries)) delete entries[key];
    },
  };
});

vi.mock("../src/commands/status.js", () => ({
  resolveWorkerStatus: (entry: { prState?: string; claudeStatus?: string } | undefined) =>
    entry?.prState ?? entry?.claudeStatus ?? "ready",
}));

import { whoami } from "../src/commands/whoami.js";
import type { WorkerEntry } from "../src/dashboard/registry.js";

const registryMock = await import("../src/dashboard/registry.js") as {
  _setEntries: (project: string, list: WorkerEntry[]) => void;
  _clear: () => void;
} & typeof import("../src/dashboard/registry.js");

function makeWorker(overrides: Partial<WorkerEntry> = {}): WorkerEntry {
  return {
    name: "bold-ash",
    sessionId: "s1",
    task: "",
    branchName: "bold-ash",
    baseBranch: "main",
    worktreePath: "/tmp/wt/myproject/bold-ash",
    claudeStatus: "idle",
    ...overrides,
  };
}

beforeEach(() => {
  registryMock._clear();
  delete process.env.GARDEN_PROJECT;
  delete process.env.GARDEN_WORKER;
});

describe("whoami command", () => {
  it("errors when GARDEN_WORKER is not set and no arg given", async () => {
    await expect(whoami([])).rejects.toThrow(/GARDEN_WORKER not set/);
  });

  it("errors when the worker is not in the registry", async () => {
    await expect(whoami(["ghost"])).rejects.toThrow(/Worker 'ghost' not found/);
  });

  it("resolves the worker from GARDEN_PROJECT + GARDEN_WORKER env vars", async () => {
    registryMock._setEntries("myproject", [makeWorker()]);
    process.env.GARDEN_PROJECT = "myproject";
    process.env.GARDEN_WORKER = "bold-ash";

    const lines = await captureConsoleLog(() => whoami([]));
    const parsed = JSON.parse(lines[0]);
    expect(parsed.project).toBe("myproject");
    expect(parsed.worker).toBe("bold-ash");
    expect(parsed.branch).toBe("bold-ash");
    expect(parsed.baseBranch).toBe("main");
  });

  it("falls back to cross-project search when GARDEN_PROJECT does not contain the worker", async () => {
    registryMock._setEntries("other", [makeWorker({ name: "bold-ash" })]);
    process.env.GARDEN_PROJECT = "myproject";

    const lines = await captureConsoleLog(() => whoami(["bold-ash"]));
    expect(JSON.parse(lines[0]).project).toBe("other");
  });

  it("prefers the explicit arg over GARDEN_WORKER env", async () => {
    registryMock._setEntries("myproject", [
      makeWorker({ name: "bold-ash" }),
      makeWorker({ name: "swift-oak" }),
    ]);
    process.env.GARDEN_WORKER = "bold-ash";

    const lines = await captureConsoleLog(() => whoami(["swift-oak"]));
    expect(JSON.parse(lines[0]).worker).toBe("swift-oak");
  });

  it("lists siblings from the same project, sorted, and excludes the worker itself", async () => {
    registryMock._setEntries("myproject", [
      makeWorker({ name: "bold-ash" }),
      makeWorker({ name: "swift-oak", prState: "reviewing" }),
      makeWorker({ name: "alpha-fern", claudeStatus: "working" }),
    ]);

    const lines = await captureConsoleLog(() => whoami(["bold-ash"]));
    const parsed = JSON.parse(lines[0]);
    expect(parsed.siblings.map((s: { name: string }) => s.name)).toEqual(["alpha-fern", "swift-oak"]);
    expect(parsed.siblings.find((s: { name: string }) => s.name === "swift-oak").displayStatus).toBe("reviewing");
  });

  it("serializes epoch-ms timestamps to ISO strings", async () => {
    const t = Date.UTC(2026, 0, 1, 12, 0, 0);
    registryMock._setEntries("myproject", [
      makeWorker({ pendingReviewAt: t, reviewStartedAt: t }),
    ]);
    process.env.GARDEN_WORKER = "bold-ash";

    const lines = await captureConsoleLog(() => whoami([]));
    const parsed = JSON.parse(lines[0]);
    expect(parsed.pendingReviewAt).toBe(new Date(t).toISOString());
    expect(parsed.reviewStartedAt).toBe(new Date(t).toISOString());
  });
});

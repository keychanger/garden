import { describe, it, expect, vi, beforeEach } from "vitest";
import { captureConsoleLog } from "./helpers.js";

vi.mock("../src/dashboard/registry.js", () => {
  const entries: Record<string, import("../src/dashboard/registry.js").WorkerEntry[]> = {};
  return {
    readRegistry: vi.fn(() => ({ workers: entries })),
    findWorkerByName: (project: string, workerName: string) =>
      (entries[project] ?? []).find(e => e.name === workerName),
    // Stub sibling ordering to alphabetical (prior behavior); the real
    // comparator is unit-tested in registry.test.ts.
    compareWorkerFreshness: (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name),
    _setEntries: (project: string, list: import("../src/dashboard/registry.js").WorkerEntry[]) => {
      entries[project] = list;
    },
    _clear: () => {
      for (const key of Object.keys(entries)) delete entries[key];
    },
  };
});

vi.mock("../src/commands/status.js", () => ({
  resolveWorkerStatus: (entry: { prState?: string; agentStatus?: string } | undefined) =>
    entry?.prState ?? entry?.agentStatus ?? "ready",
}));

// Stub only getAutoContinueConfig (keep the rest of config real) so the gate
// block is deterministic and the test never reads the operator's real config.
vi.mock("../src/config.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/config.js")>()),
  getAutoContinueConfig: vi.fn(() => ({ enabled: true, usageThreshold: 95, resumeAfterReset: false })),
}));

import { whoami, formatAutoContinueLine } from "../src/commands/whoami.js";
import { getAutoContinueConfig } from "../src/config.js";
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
    agentStatus: "idle",
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
      makeWorker({ name: "alpha-fern", agentStatus: "working" }),
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

  it("includes the global auto-continue gate state", async () => {
    vi.mocked(getAutoContinueConfig).mockReturnValue({ enabled: false, usageThreshold: 95, resumeAfterReset: true, pausedReason: "opus at 96%", pausedUntil: "2026-01-01T13:00:00.000Z" });
    registryMock._setEntries("myproject", [makeWorker()]);
    process.env.GARDEN_WORKER = "bold-ash";

    const lines = await captureConsoleLog(() => whoami([]));
    const parsed = JSON.parse(lines[0]);
    expect(parsed.autoContinue).toEqual({
      enabled: false, usageThreshold: 95, resumeAfterReset: true,
      pausedReason: "opus at 96%", pausedUntil: "2026-01-01T13:00:00.000Z",
    });
  });
});

describe("formatAutoContinueLine", () => {
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");

  it("shows 'on' in green when the gate is open", () => {
    const out = formatAutoContinueLine({ enabled: true, usageThreshold: 95, resumeAfterReset: false });
    expect(stripAnsi(out)).toBe("on (post-merge)");
    expect(out).toContain("\x1b[32m"); // green
  });

  it("shows the pause reason and window when usage-paused", () => {
    const out = formatAutoContinueLine({ enabled: false, usageThreshold: 95, resumeAfterReset: true, pausedReason: "opus at 96%", pausedUntil: "2026-01-01T13:00:00.000Z" });
    expect(stripAnsi(out)).toBe("OFF opus at 96% until 2026-01-01T13:00:00.000Z");
    expect(out).toContain("\x1b[33m"); // yellow
  });

  it("shows the re-enable hint when disabled without a pause reason", () => {
    const out = formatAutoContinueLine({ enabled: false, usageThreshold: 95, resumeAfterReset: false });
    expect(stripAnsi(out)).toBe("OFF (garden auto on to re-enable)");
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/dashboard/tmux.js", () => ({
  tmux: vi.fn(),
  windowExists: vi.fn(() => false),
  killWindowSafe: vi.fn(),
}));

vi.mock("../src/dashboard/registry.js", () => {
  const entries: Record<string, import("../src/dashboard/registry.js").WorkerEntry[]> = {};
  return {
    readRegistry: vi.fn(() => ({ workers: entries })),
    _setEntries: (project: string, list: import("../src/dashboard/registry.js").WorkerEntry[]) => {
      entries[project] = list;
    },
    _clear: () => {
      for (const key of Object.keys(entries)) delete entries[key];
    },
  };
});

vi.mock("../src/dashboard/poller-fifo.js", () => ({
  triggerProjectPoll: vi.fn(),
}));

import {
  latestActivityMs, isWatchedState, isWorkerStale, tick, respawnDeadPollers,
  WATCHDOG_THRESHOLD_MS,
} from "../src/dashboard/watchdog.js";
import { triggerProjectPoll } from "../src/dashboard/poller-fifo.js";
import type { WorkerEntry, PrState } from "../src/dashboard/registry.js";

const registryMock = await import("../src/dashboard/registry.js") as unknown as {
  _setEntries: (project: string, list: WorkerEntry[]) => void;
  _clear: () => void;
};

const NOW = Date.parse("2026-06-04T12:00:00Z");

function entry(overrides: Partial<WorkerEntry> = {}): WorkerEntry {
  return { name: "swift-oak", sessionId: "s-1", task: "", ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  registryMock._clear();
});

describe("latestActivityMs", () => {
  it("returns 0 when no timestamp fields are set", () => {
    expect(latestActivityMs(entry())).toBe(0);
  });

  it("picks the max across epoch-ms fields", () => {
    expect(latestActivityMs(entry({
      lastEventAt: 1000, pendingReviewAt: 3000, reviewStartedAt: 2000,
    }))).toBe(3000);
  });

  it("parses ISO-string fields and compares against epoch fields", () => {
    const iso = "2026-06-04T11:00:00Z";
    const isoMs = Date.parse(iso);
    expect(latestActivityMs(entry({ lastEventAt: isoMs - 5000, mergedAt: iso }))).toBe(isoMs);
    expect(latestActivityMs(entry({ lastEventAt: isoMs + 5000, mergePendingAt: iso })))
      .toBe(isoMs + 5000);
  });

  it("ignores unparseable ISO strings", () => {
    expect(latestActivityMs(entry({ lastShaChangeAt: "not-a-date", lastEventAt: 42 }))).toBe(42);
  });
});

describe("isWatchedState", () => {
  it.each(["reviewing", "resolving", "ci-fixing", "merge-pending", "merged"] as PrState[])(
    "watches %s", (state) => {
      expect(isWatchedState(entry({ prState: state }))).toBe(true);
    },
  );

  it("watches working with pendingReviewAt set", () => {
    expect(isWatchedState(entry({ prState: "working", pendingReviewAt: NOW }))).toBe(true);
    expect(isWatchedState(entry({ pendingReviewAt: NOW }))).toBe(true);
  });

  it("does not watch quiescent states", () => {
    expect(isWatchedState(entry({ prState: "working" }))).toBe(false);
    expect(isWatchedState(entry())).toBe(false);
    expect(isWatchedState(entry({ prState: "failing" }))).toBe(false);
    expect(isWatchedState(entry({ prState: "done" }))).toBe(false);
  });

  it("does not watch failing or done even with pendingReviewAt set", () => {
    expect(isWatchedState(entry({ prState: "failing", pendingReviewAt: NOW }))).toBe(false);
    expect(isWatchedState(entry({ prState: "done", pendingReviewAt: NOW }))).toBe(false);
  });
});

describe("isWorkerStale", () => {
  it("true for a watched worker aged past the threshold", () => {
    const e = entry({ prState: "reviewing", reviewStartedAt: NOW - WATCHDOG_THRESHOLD_MS - 1 });
    expect(isWorkerStale(e, NOW)).toBe(true);
  });

  it("false for a watched worker with recent activity", () => {
    const e = entry({ prState: "reviewing", reviewStartedAt: NOW - WATCHDOG_THRESHOLD_MS + 1000 });
    expect(isWorkerStale(e, NOW)).toBe(false);
  });

  it("false for a watched worker with no timestamps (no clock to age)", () => {
    expect(isWorkerStale(entry({ prState: "merge-pending" }), NOW)).toBe(false);
  });

  it("false for quiescent workers no matter how old", () => {
    expect(isWorkerStale(entry({ prState: "failing", lastEventAt: 1 }), NOW)).toBe(false);
    expect(isWorkerStale(entry({ prState: "done", mergedAt: "2020-01-01T00:00:00Z" }), NOW)).toBe(false);
    expect(isWorkerStale(entry({ prState: "working", lastEventAt: 1 }), NOW)).toBe(false);
  });

  it("uses the most recent timestamp, not the state-specific one", () => {
    // Stale reviewStartedAt but a fresh hook event keeps the worker non-stale.
    const e = entry({
      prState: "reviewing",
      reviewStartedAt: NOW - 2 * WATCHDOG_THRESHOLD_MS,
      lastEventAt: NOW - 1000,
    });
    expect(isWorkerStale(e, NOW)).toBe(false);
  });

  it("respects a custom threshold", () => {
    const e = entry({ prState: "merged", mergedAt: new Date(NOW - 60_000).toISOString() });
    expect(isWorkerStale(e, NOW, 30_000)).toBe(true);
    expect(isWorkerStale(e, NOW, 120_000)).toBe(false);
  });
});

describe("tick", () => {
  const STALE_MS = NOW - WATCHDOG_THRESHOLD_MS - 60_000;

  it("pokes a project with a stale watched worker exactly once", () => {
    registryMock._setEntries("proj", [entry({ prState: "reviewing", reviewStartedAt: STALE_MS })]);
    tick(new Map(), NOW);
    expect(triggerProjectPoll).toHaveBeenCalledTimes(1);
    expect(triggerProjectPoll).toHaveBeenCalledWith("proj");
  });

  it("damps re-pokes within the threshold and re-fires past it", () => {
    registryMock._setEntries("proj", [entry({ prState: "reviewing", reviewStartedAt: STALE_MS })]);
    const lastPokeAt = new Map<string, number>();
    tick(lastPokeAt, NOW);
    tick(lastPokeAt, NOW + 60_000);
    expect(triggerProjectPoll).toHaveBeenCalledTimes(1);
    tick(lastPokeAt, NOW + WATCHDOG_THRESHOLD_MS + 1000);
    expect(triggerProjectPoll).toHaveBeenCalledTimes(2);
  });

  it("never pokes for quiescent-only registries", () => {
    registryMock._setEntries("proj", [
      entry({ prState: "working", lastEventAt: 1 }),
      entry({ name: "bold-elm", sessionId: "s-2", task: "", prState: "failing", lastEventAt: 1 }),
      entry({ name: "keen-ash", sessionId: "s-3", task: "", prState: "done", lastEventAt: 1 }),
    ]);
    tick(new Map(), NOW);
    expect(triggerProjectPoll).not.toHaveBeenCalled();
  });

  it("pokes only the project with the stale worker", () => {
    registryMock._setEntries("stale-proj", [
      entry({ prState: "merge-pending", mergePendingAt: new Date(STALE_MS).toISOString() }),
    ]);
    registryMock._setEntries("fresh-proj", [
      entry({ prState: "reviewing", reviewStartedAt: NOW - 1000 }),
    ]);
    registryMock._setEntries("empty-proj", []);
    tick(new Map(), NOW);
    expect(triggerProjectPoll).toHaveBeenCalledTimes(1);
    expect(triggerProjectPoll).toHaveBeenCalledWith("stale-proj");
  });

  it("pokes for a working worker with a stale pendingReviewAt", () => {
    registryMock._setEntries("proj", [entry({ pendingReviewAt: STALE_MS })]);
    tick(new Map(), NOW);
    expect(triggerProjectPoll).toHaveBeenCalledWith("proj");
  });
});

describe("respawnDeadPollers", () => {
  it("respawns a project whose poller window is dead", () => {
    registryMock._setEntries("dead", [entry({ prState: "reviewing" })]);
    const start = vi.fn();
    const respawned = respawnDeadPollers(() => false, start);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith("dead");
    expect(respawned).toEqual(["dead"]);
  });

  it("leaves a project whose poller is alive untouched", () => {
    registryMock._setEntries("alive", [entry({ prState: "reviewing" })]);
    const start = vi.fn();
    expect(respawnDeadPollers(() => true, start)).toEqual([]);
    expect(start).not.toHaveBeenCalled();
  });

  it("ignores projects with no workers", () => {
    registryMock._setEntries("empty", []);
    const start = vi.fn();
    expect(respawnDeadPollers(() => false, start)).toEqual([]);
    expect(start).not.toHaveBeenCalled();
  });

  it("respawns regardless of worker state — a quiescent project still needs its poller", () => {
    registryMock._setEntries("quiescent", [entry({ prState: "working", lastEventAt: 1 })]);
    const start = vi.fn();
    expect(respawnDeadPollers(() => false, start)).toEqual(["quiescent"]);
  });

  it("respawns only the projects whose pollers are down", () => {
    registryMock._setEntries("down", [entry({ prState: "reviewing" })]);
    registryMock._setEntries("up", [entry({ name: "bold-elm", sessionId: "s-2", task: "", prState: "reviewing" })]);
    const start = vi.fn();
    const respawned = respawnDeadPollers((p) => p === "up", start);
    expect(respawned).toEqual(["down"]);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith("down");
  });

  it("isolates a per-project spawn failure so other projects still respawn", () => {
    registryMock._setEntries("boom", [entry({ prState: "reviewing" })]);
    registryMock._setEntries("ok", [entry({ name: "bold-elm", sessionId: "s-2", task: "", prState: "reviewing" })]);
    const start = vi.fn((project: string) => {
      if (project === "boom") throw new Error("tmux new-window failed");
    });
    // Must not throw (a thrown error would abort the watchdog cycle and skip
    // the staleness tick for every project), and the healthy project still
    // respawns and is the only one reported.
    let respawned: string[] = [];
    expect(() => { respawned = respawnDeadPollers(() => false, start); }).not.toThrow();
    expect(start).toHaveBeenCalledTimes(2);
    expect(respawned).toEqual(["ok"]);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/dashboard/tmux.js", () => ({
  tmux: vi.fn(),
  windowExists: vi.fn(() => false),
  killWindowSafe: vi.fn(),
  listAllWindowNames: vi.fn(() => []),
}));

vi.mock("../src/dashboard/alerts.js", () => ({
  addAlert: vi.fn(),
}));

vi.mock("../src/dashboard/registry.js", async (importActual) => {
  // Spread the real module so PR_STATE_KIND (the state-classification table the
  // watchdog derives its sets from) stays live; only readRegistry is faked.
  const actual = await importActual<typeof import("../src/dashboard/registry.js")>();
  const entries: Record<string, import("../src/dashboard/registry.js").WorkerEntry[]> = {};
  return {
    ...actual,
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
  latestActivityMs, isWatchedState, isWorkerStale, hasLiveWork, tick,
  healProjectPollers, alertOrphanedWindows, WATCHDOG_THRESHOLD_MS,
} from "../src/dashboard/watchdog.js";
import { triggerProjectPoll } from "../src/dashboard/poller-fifo.js";
import { windowExists, listAllWindowNames } from "../src/dashboard/tmux.js";
import { addAlert } from "../src/dashboard/alerts.js";
import type { WorkerEntry, PrState } from "../src/dashboard/registry.js";

const windowExistsMock = vi.mocked(windowExists);

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
  // clearAllMocks wipes call history but not implementations, so a prior
  // mockReturnValue(true) would leak — restore the "no live window" default.
  windowExistsMock.mockReturnValue(false);
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

  it("watches a failing worker with new commits pending the debounce transition", () => {
    // lastSeenSha advanced past the pinned failingSha => handleFailing observed
    // an operator fix and owes a debounced failing->working transition. If its
    // one-shot poke was lost, the watchdog is the only thing that re-pokes it.
    expect(isWatchedState(entry({
      prState: "failing", failingReason: "code",
      failingSha: "old", lastSeenSha: "new",
    }))).toBe(true);
  });

  it("does not watch a parked failing worker with no new commits", () => {
    // lastSeenSha still at failingSha => no fix pushed yet; leave it parked.
    expect(isWatchedState(entry({
      prState: "failing", failingReason: "code",
      failingSha: "same", lastSeenSha: "same",
    }))).toBe(false);
  });

  it("does not watch operator-action failing dispositions even with new commits", () => {
    // trellis-flagged etc. require an explicit trellis command; pushing commits
    // must not auto-resume them.
    expect(isWatchedState(entry({
      prState: "failing", failingReason: "trellis-flagged",
      failingSha: "old", lastSeenSha: "new",
    }))).toBe(false);
  });
});

describe("hasLiveWork", () => {
  it.each(["reviewing", "resolving", "ci-fixing"] as PrState[])(
    "true for windowed state %s with a live window", (state) => {
      windowExistsMock.mockReturnValue(true);
      expect(hasLiveWork(entry({ prState: state, reviewWindowName: "_p-review-w" }))).toBe(true);
    },
  );

  it("false for a windowed state whose window has died", () => {
    windowExistsMock.mockReturnValue(false);
    expect(hasLiveWork(entry({ prState: "reviewing", reviewWindowName: "_p-review-w" }))).toBe(false);
  });

  it("false for a windowed state with no recorded window name", () => {
    windowExistsMock.mockReturnValue(true);
    expect(hasLiveWork(entry({ prState: "reviewing" }))).toBe(false);
  });

  it.each(["merge-pending", "merged"] as PrState[])(
    "false for non-windowed state %s even with a live named window", (state) => {
      // These states do their work inline with no window to probe; a stray
      // reviewWindowName must not be mistaken for live work.
      windowExistsMock.mockReturnValue(true);
      expect(hasLiveWork(entry({ prState: state, reviewWindowName: "_p-review-w" }))).toBe(false);
    },
  );

  it("false for quiescent states", () => {
    windowExistsMock.mockReturnValue(true);
    expect(hasLiveWork(entry({ prState: "working", reviewWindowName: "_p-review-w" }))).toBe(false);
    expect(hasLiveWork(entry({ prState: "failing" }))).toBe(false);
  });
});

describe("isWorkerStale", () => {
  it("true for a watched worker aged past the threshold", () => {
    const e = entry({ prState: "reviewing", reviewStartedAt: NOW - WATCHDOG_THRESHOLD_MS - 1 });
    expect(isWorkerStale(e, NOW)).toBe(true);
  });

  it("false for a long-running review whose window is still alive", () => {
    // The regression this fix targets: a review aged well past the threshold
    // but actively in flight (window alive) must not read as stale.
    windowExistsMock.mockReturnValue(true);
    const e = entry({
      prState: "reviewing",
      reviewStartedAt: NOW - 3 * WATCHDOG_THRESHOLD_MS,
      reviewWindowName: "_p-review-w",
    });
    expect(isWorkerStale(e, NOW)).toBe(false);
  });

  it("true for a stranded review whose window died and completion poke was lost", () => {
    // The genuine stranding class the watchdog must still recover: window gone,
    // aged past the threshold.
    windowExistsMock.mockReturnValue(false);
    const e = entry({
      prState: "reviewing",
      reviewStartedAt: NOW - WATCHDOG_THRESHOLD_MS - 1,
      reviewWindowName: "_p-review-w",
    });
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

  it("re-pokes a stale failing worker whose pushed fix advanced its SHA", () => {
    // End-to-end backstop: lastSeenSha advanced past failingSha (a fix was
    // observed) and the one-shot debounce poke was lost. lastShaChangeAt is the
    // only clock latestActivityMs can age this worker against, so this guards
    // that dependency along with the isWatchedState clause.
    registryMock._setEntries("proj", [entry({
      prState: "failing", failingReason: "code",
      failingSha: "old", lastSeenSha: "new",
      lastShaChangeAt: new Date(STALE_MS).toISOString(),
    })]);
    tick(new Map(), NOW);
    expect(triggerProjectPoll).toHaveBeenCalledWith("proj");
  });

  it("does not poke a parked failing worker with no pushed fix, however old", () => {
    // lastSeenSha still pinned at failingSha => nothing owed; a settled garden
    // must produce zero pokes no matter how long it has sat.
    registryMock._setEntries("proj", [entry({
      prState: "failing", failingReason: "code",
      failingSha: "same", lastSeenSha: "same",
      lastShaChangeAt: new Date(STALE_MS).toISOString(),
    })]);
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

  it("does not poke a clock-stale review whose window is still alive", () => {
    windowExistsMock.mockReturnValue(true);
    registryMock._setEntries("proj", [
      entry({ prState: "reviewing", reviewStartedAt: STALE_MS, reviewWindowName: "_p-review-w" }),
    ]);
    tick(new Map(), NOW);
    expect(triggerProjectPoll).not.toHaveBeenCalled();
  });
});

describe("healProjectPollers", () => {
  it("ensures a poller for every project that holds workers", () => {
    registryMock._setEntries("one", [entry({ prState: "reviewing" })]);
    const ensure = vi.fn();
    const ensured = healProjectPollers(ensure);
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(ensure).toHaveBeenCalledWith("one");
    expect(ensured).toEqual(["one"]);
  });

  it("ignores projects with no workers", () => {
    registryMock._setEntries("empty", []);
    const ensure = vi.fn();
    expect(healProjectPollers(ensure)).toEqual([]);
    expect(ensure).not.toHaveBeenCalled();
  });

  it("ensures regardless of worker state — a quiescent project still needs its poller", () => {
    registryMock._setEntries("quiescent", [entry({ prState: "working", lastEventAt: 1 })]);
    const ensure = vi.fn();
    expect(healProjectPollers(ensure)).toEqual(["quiescent"]);
  });

  it("calls ensurePoller once per project with workers (convergence is the callback's job)", () => {
    // Delegates blindly: spawn-vs-dedup-vs-noop lives in startProjectPoller, so
    // the watchdog no longer pre-checks liveness — it just ensures every project.
    registryMock._setEntries("a", [entry({ prState: "reviewing" })]);
    registryMock._setEntries("b", [entry({ name: "bold-elm", sessionId: "s-2", task: "", prState: "working", lastEventAt: 1 })]);
    const ensure = vi.fn();
    expect(healProjectPollers(ensure)).toEqual(["a", "b"]);
    expect(ensure).toHaveBeenCalledTimes(2);
  });

  it("isolates a per-project failure so other projects are still ensured", () => {
    registryMock._setEntries("boom", [entry({ prState: "reviewing" })]);
    registryMock._setEntries("ok", [entry({ name: "bold-elm", sessionId: "s-2", task: "", prState: "reviewing" })]);
    const ensure = vi.fn((project: string) => {
      if (project === "boom") throw new Error("tmux new-window failed");
    });
    // Must not throw — a thrown error would abort the watchdog cycle and skip
    // the staleness tick for every project — and the healthy project is still
    // ensured and the only one reported.
    let ensured: string[] = [];
    expect(() => { ensured = healProjectPollers(ensure); }).not.toThrow();
    expect(ensure).toHaveBeenCalledTimes(2);
    expect(ensured).toEqual(["ok"]);
  });
});

describe("alertOrphanedWindows", () => {
  const listWindowsMock = vi.mocked(listAllWindowNames);
  const addAlertMock = vi.mocked(addAlert);

  it("alerts on a live worker window with no registry entry", () => {
    // The create/sweep race deletes a freshly-created worker's registry entry
    // while its tmux window keeps running — the orphan the grace fix prevents
    // and this backstop surfaces.
    listWindowsMock.mockReturnValue(["_board-worker-low-arch-wolf", "_board-poller"]);
    alertOrphanedWindows({ workers: {} });
    expect(addAlertMock).toHaveBeenCalledTimes(1);
    const alert = addAlertMock.mock.calls[0][0];
    expect(alert.project).toBe("board");
    expect(alert.worker).toBe("low-arch-wolf");
    expect(alert.dedupKey).toBe("watchdog-orphan:board:low-arch-wolf");
    expect(alert.message).toContain("orphaned");
  });

  it("does not alert when the worker window has a registry entry", () => {
    listWindowsMock.mockReturnValue(["_board-worker-low-arch-wolf"]);
    alertOrphanedWindows({
      workers: { board: [entry({ name: "low-arch-wolf", sessionId: "s-9" })] },
    });
    expect(addAlertMock).not.toHaveBeenCalled();
  });

  it("ignores non-worker windows (poller, review, shell, garden)", () => {
    listWindowsMock.mockReturnValue([
      "_board-poller", "_board-review-low-arch-wolf", "_board-ci-fix-low-arch-wolf",
      "_board-shell", "_garden-watchdog", "_garden-logs",
    ]);
    alertOrphanedWindows({ workers: {} });
    expect(addAlertMock).not.toHaveBeenCalled();
  });
});

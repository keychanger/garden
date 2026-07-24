import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  parseDispatchState, retryCount, shouldReap, isIntakeLive, buildBeadSeed,
  runIntakeOnce, intakeDue, intakeStampPath, intakePokePath,
  DEFAULT_BEAD_INTAKE_CAP, INTAKE_MIN_INTERVAL_MS, REAPER_GRACE_MS,
  type IntakeDeps,
} from "../src/dashboard/poller-intake.js";
import type { BeadDetail, SwarmStatus } from "../src/dashboard/beads.js";
import type { WorkerEntry } from "../src/dashboard/registry.js";

function entry(over: Partial<WorkerEntry> & { name: string }): WorkerEntry {
  return { sessionId: "s", task: "", ...over };
}

function epic(over: Partial<BeadDetail> & { id: string }): BeadDetail {
  return { title: `epic ${over.id}`, status: "open", priority: 1, labels: [], ...over };
}

function bead(over: Partial<BeadDetail> & { id: string }): BeadDetail {
  return { title: `bead ${over.id}`, status: "open", priority: 2, labels: [], ...over };
}

const NOW = 1_700_000_000_000;

describe("parseDispatchState", () => {
  it("resolves the mode with off winning over manual and auto", () => {
    expect(parseDispatchState(["dispatch:manual"]).mode).toBe("manual");
    expect(parseDispatchState(["dispatch:auto"]).mode).toBe("auto");
    expect(parseDispatchState(["dispatch:off", "dispatch:manual", "dispatch:auto"]).mode).toBe("off");
    expect(parseDispatchState(["project:board"]).mode).toBeNull();
  });

  it("parses budget, spent, dispatched, and budget-exhausted", () => {
    const ds = parseDispatchState([
      "budget:5", "dispatch:spent:3", "dispatch:dispatched", "dispatch:budget-exhausted",
    ]);
    expect(ds.budget).toBe(5);
    expect(ds.spent).toBe(3);
    expect(ds.dispatched).toBe(true);
    expect(ds.budgetExhausted).toBe(true);
  });

  it("defaults spent to 0 and budget to null, ignoring malformed counts", () => {
    const ds = parseDispatchState(["budget:lots", "dispatch:spent:-2"]);
    expect(ds.budget).toBeNull();
    expect(ds.spent).toBe(0);
  });
});

describe("retryCount", () => {
  it("reads dispatch:retry:N and defaults to 0", () => {
    expect(retryCount(["dispatch:retry:2"])).toBe(2);
    expect(retryCount([])).toBe(0);
  });
});

describe("isIntakeLive", () => {
  it("counts working and in-pipeline workers, not exited/done/failing", () => {
    expect(isIntakeLive(entry({ name: "a" }))).toBe(true);
    expect(isIntakeLive(entry({ name: "a", prState: "reviewing" }))).toBe(true);
    expect(isIntakeLive(entry({ name: "a", agentStatus: "exited" }))).toBe(false);
    expect(isIntakeLive(entry({ name: "a", prState: "done" }))).toBe(false);
    expect(isIntakeLive(entry({ name: "a", prState: "failing" }))).toBe(false);
  });
});

describe("shouldReap", () => {
  it("reaps the legacy garden-pending marker unconditionally", () => {
    expect(shouldReap("garden-pending", undefined, NOW)).toBe(true);
  });

  it("never reaps an assignee with no registry entry (foreign actor)", () => {
    expect(shouldReap("jic", undefined, NOW)).toBe(false);
  });

  it("reaps an exited working worker only past the grace period", () => {
    const dead = entry({
      name: "w", agentStatus: "exited", lastEventAt: NOW - REAPER_GRACE_MS - 1,
    });
    expect(shouldReap("w", dead, NOW)).toBe(true);
    const fresh = entry({
      name: "w", agentStatus: "exited", lastEventAt: NOW - 1000,
    });
    expect(shouldReap("w", fresh, NOW)).toBe(false);
  });

  it("leaves live, pipeline, and terminal-state workers alone", () => {
    const old = NOW - REAPER_GRACE_MS - 1;
    expect(shouldReap("w", entry({ name: "w", lastEventAt: old }), NOW)).toBe(false);
    expect(shouldReap("w", entry({
      name: "w", agentStatus: "exited", prState: "reviewing", lastEventAt: old,
    }), NOW)).toBe(false);
    expect(shouldReap("w", entry({
      name: "w", agentStatus: "exited", prState: "done", lastEventAt: old,
    }), NOW)).toBe(false);
  });
});

describe("buildBeadSeed", () => {
  it("carries the bead, the design doc, and the protocol footer", () => {
    const seed = buildBeadSeed({
      projectName: "board",
      epic: { id: "board-e1", title: "Big feature", design: "The design text." },
      bead: bead({ id: "board-b1", title: "First slice", description: "Do the thing." }),
      mergedSiblings: ["board-b0"],
    });
    expect(seed).toContain("board-b1: First slice");
    expect(seed).toContain("Do the thing.");
    expect(seed).toContain("The design text.");
    expect(seed).toContain("bd update board-b1 --claim");
    expect(seed).toContain("bd close board-b1");
    expect(seed).toContain("bd label add board-b1 human");
    expect(seed).toContain("board-b0");
  });

  it("marks a missing design doc and empty sibling list explicitly", () => {
    const seed = buildBeadSeed({
      projectName: "board",
      epic: { id: "e", title: "t" },
      bead: bead({ id: "b" }),
      mergedSiblings: [],
    });
    expect(seed).toContain("no design doc pinned");
    expect(seed).toContain("none yet");
  });
});

interface FakeWorld {
  epics: BeadDetail[];
  statuses: Record<string, SwarmStatus>;
  details: Record<string, BeadDetail>;
  workers: WorkerEntry[];
  spawns: Array<{ seed: string; task: string }>;
  spawnResult: (n: number) => string | null;
  claims: Array<{ id: string; actor: string }>;
  claimResult: boolean;
  reopens: Array<{ id: string; reason: string }>;
  unassigns: string[];
  labelsAdded: Array<{ id: string; label: string }>;
  labelsRemoved: Array<{ id: string; label: string }>;
  alerts: Array<{ level: string; message: string }>;
}

function makeWorld(over: Partial<FakeWorld> = {}): FakeWorld {
  return {
    epics: [],
    statuses: {},
    details: {},
    workers: [],
    spawns: [],
    spawnResult: (n) => `worker-${n}`,
    claims: [],
    claimResult: true,
    reopens: [],
    unassigns: [],
    labelsAdded: [],
    labelsRemoved: [],
    alerts: [],
    ...over,
  };
}

function makeDeps(w: FakeWorld, over: Partial<IntakeDeps> = {}): IntakeDeps {
  return {
    projectName: "board",
    cap: DEFAULT_BEAD_INTAKE_CAP,
    listOpenEpics: () => w.epics,
    swarmStatus: (id) => w.statuses[id] ?? null,
    showBeads: (ids) => ids.map(id => w.details[id]).filter((d): d is BeadDetail => d !== undefined),
    claim: (id, actor) => { w.claims.push({ id, actor }); return w.claimResult; },
    reopen: (id, reason) => { w.reopens.push({ id, reason }); return true; },
    unassign: (id) => { w.unassigns.push(id); return true; },
    addLabel: (id, label) => { w.labelsAdded.push({ id, label }); return true; },
    removeLabel: (id, label) => { w.labelsRemoved.push({ id, label }); return true; },
    spawn: (seed, task) => {
      w.spawns.push({ seed, task });
      return w.spawnResult(w.spawns.length);
    },
    workers: () => w.workers,
    alert: (input) => { w.alerts.push({ level: input.level, message: input.message }); },
    nowMs: () => NOW,
    ...over,
  };
}

function st(over: Partial<SwarmStatus> = {}): SwarmStatus {
  return { ready: [], active: [], blocked: [], completed: [], ...over };
}

describe("runIntakeOnce", () => {
  it("does nothing without dispatch-labeled epics", () => {
    const w = makeWorld({ epics: [epic({ id: "e1", labels: ["project:x"] })] });
    expect(runIntakeOnce(makeDeps(w))).toBe(false);
    expect(w.spawns).toHaveLength(0);
  });

  it("dispatches unassigned ready beads, claims as the worker, and counts spend", () => {
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["dispatch:auto"], design: "D" })],
      statuses: { e1: st({ ready: [{ id: "b1", title: "one" }, { id: "b2", title: "two", assignee: "held" }] }) },
      details: { b1: bead({ id: "b1", title: "one" }) },
    });
    expect(runIntakeOnce(makeDeps(w))).toBe(true);
    expect(w.spawns).toHaveLength(1);
    expect(w.spawns[0].task).toBe("bead b1: one");
    expect(w.claims).toEqual([{ id: "b1", actor: "worker-1" }]);
    expect(w.labelsAdded).toContainEqual({ id: "e1", label: "dispatch:spent:1" });
    // No pre-existing spent label -> nothing removed.
    expect(w.labelsRemoved).toHaveLength(0);
  });

  it("consumes a manual authorization after one dispatching pass", () => {
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["dispatch:manual"] })],
      statuses: { e1: st({ ready: [{ id: "b1", title: "one" }] }) },
      details: { b1: bead({ id: "b1" }) },
    });
    runIntakeOnce(makeDeps(w));
    expect(w.labelsRemoved).toContainEqual({ id: "e1", label: "dispatch:manual" });
    expect(w.labelsAdded).toContainEqual({ id: "e1", label: "dispatch:dispatched" });
  });

  it("keeps a manual epic armed when the frontier is empty", () => {
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["dispatch:manual"] })],
      statuses: { e1: st({ ready: [{ id: "b1", title: "t", assignee: "w" }] }) },
    });
    expect(runIntakeOnce(makeDeps(w))).toBe(false);
    expect(w.labelsRemoved).toHaveLength(0);
  });

  it("does not dispatch on dispatched, off, or budget-exhausted epics", () => {
    const ready = [{ id: "b1", title: "t" }];
    for (const labels of [
      ["dispatch:manual", "dispatch:dispatched"],
      ["dispatch:off"],
      ["dispatch:auto", "dispatch:budget-exhausted"],
    ]) {
      const w = makeWorld({
        epics: [epic({ id: "e1", labels })],
        statuses: { e1: st({ ready }) },
        details: { b1: bead({ id: "b1" }) },
      });
      runIntakeOnce(makeDeps(w));
      expect(w.spawns).toHaveLength(0);
    }
  });

  it("auto mode keeps dispatching on later passes", () => {
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["dispatch:auto"] })],
      statuses: { e1: st({ ready: [{ id: "b1", title: "t" }] }) },
      details: { b1: bead({ id: "b1" }) },
    });
    runIntakeOnce(makeDeps(w));
    expect(w.labelsRemoved).not.toContainEqual({ id: "e1", label: "dispatch:auto" });
  });

  it("halts at the budget cap, labels the epic, and alerts at error level", () => {
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["dispatch:auto", "budget:2", "dispatch:spent:2"] })],
      statuses: { e1: st({ ready: [{ id: "b1", title: "t" }] }) },
      details: { b1: bead({ id: "b1" }) },
    });
    expect(runIntakeOnce(makeDeps(w))).toBe(true);
    expect(w.spawns).toHaveLength(0);
    expect(w.labelsAdded).toContainEqual({ id: "e1", label: "dispatch:budget-exhausted" });
    expect(w.alerts).toHaveLength(1);
    expect(w.alerts[0].level).toBe("error");
  });

  it("limits a pass to the remaining budget and exhausts on crossing the cap", () => {
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["dispatch:auto", "budget:2", "dispatch:spent:1"] })],
      statuses: {
        e1: st({ ready: [{ id: "b1", title: "1" }, { id: "b2", title: "2" }] }),
      },
      details: { b1: bead({ id: "b1", priority: 0 }), b2: bead({ id: "b2", priority: 1 }) },
    });
    runIntakeOnce(makeDeps(w));
    expect(w.spawns).toHaveLength(1);
    expect(w.labelsRemoved).toContainEqual({ id: "e1", label: "dispatch:spent:1" });
    expect(w.labelsAdded).toContainEqual({ id: "e1", label: "dispatch:spent:2" });
    expect(w.labelsAdded).toContainEqual({ id: "e1", label: "dispatch:budget-exhausted" });
  });

  it("dispatches higher-priority beads first when slots are scarce", () => {
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["dispatch:auto"] })],
      statuses: {
        e1: st({ ready: [{ id: "b1", title: "low" }, { id: "b2", title: "high" }] }),
      },
      details: {
        b1: bead({ id: "b1", title: "low", priority: 3 }),
        b2: bead({ id: "b2", title: "high", priority: 0 }),
      },
    });
    runIntakeOnce(makeDeps(w, { cap: 1 }));
    expect(w.spawns).toHaveLength(1);
    expect(w.spawns[0].task).toBe("bead b2: high");
  });

  it("counts live intake workers against the cap via the assignee join", () => {
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["dispatch:auto"] })],
      statuses: {
        e1: st({
          active: [{ id: "b0", title: "building", assignee: "busy-worker" }],
          ready: [{ id: "b1", title: "t" }, { id: "b2", title: "t2" }],
        }),
      },
      details: { b1: bead({ id: "b1" }), b2: bead({ id: "b2" }) },
      workers: [entry({ name: "busy-worker", agentStatus: "working" })],
    });
    runIntakeOnce(makeDeps(w, { cap: 2 }));
    expect(w.spawns).toHaveLength(1);
  });

  it("ignores dead and foreign assignees when counting live workers", () => {
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["dispatch:auto"] })],
      statuses: {
        e1: st({
          active: [
            { id: "b0", title: "t", assignee: "dead-worker" },
            { id: "b3", title: "t", assignee: "jic" },
          ],
          ready: [{ id: "b1", title: "t" }],
        }),
      },
      details: { b1: bead({ id: "b1" }) },
      workers: [entry({ name: "dead-worker", agentStatus: "exited", lastEventAt: NOW - 1000 })],
    });
    runIntakeOnce(makeDeps(w, { cap: 1 }));
    expect(w.spawns).toHaveLength(1);
  });

  it("counts same-pass spawns against the cap across epics", () => {
    const w = makeWorld({
      epics: [
        epic({ id: "e1", labels: ["dispatch:auto"] }),
        epic({ id: "e2", labels: ["dispatch:auto"] }),
      ],
      statuses: {
        e1: st({ ready: [{ id: "b1", title: "t" }] }),
        e2: st({ ready: [{ id: "b2", title: "t" }] }),
      },
      details: { b1: bead({ id: "b1" }), b2: bead({ id: "b2" }) },
    });
    runIntakeOnce(makeDeps(w, { cap: 1 }));
    expect(w.spawns).toHaveLength(1);
  });

  it("halts the pass without spending budget when a spawn fails", () => {
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["dispatch:auto", "budget:5"] })],
      statuses: { e1: st({ ready: [{ id: "b1", title: "t" }, { id: "b2", title: "t" }] }) },
      details: { b1: bead({ id: "b1" }), b2: bead({ id: "b2" }) },
      spawnResult: () => null,
    });
    expect(runIntakeOnce(makeDeps(w))).toBe(false);
    expect(w.claims).toHaveLength(0);
    expect(w.labelsAdded).toHaveLength(0);
  });

  it("treats a failed post-spawn claim as non-fatal (worker's own claim recovers)", () => {
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["dispatch:auto"] })],
      statuses: { e1: st({ ready: [{ id: "b1", title: "t" }] }) },
      details: { b1: bead({ id: "b1" }) },
      claimResult: false,
    });
    expect(runIntakeOnce(makeDeps(w))).toBe(true);
    expect(w.spawns).toHaveLength(1);
    expect(w.labelsAdded).toContainEqual({ id: "e1", label: "dispatch:spent:1" });
  });

  it("reaps a dead worker's bead: reopen, unassign, retry label", () => {
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["dispatch:dispatched"] })],
      statuses: {
        e1: st({ active: [{ id: "b1", title: "t", assignee: "dead-worker" }] }),
      },
      details: { b1: bead({ id: "b1", labels: ["dispatch:retry:1"] }) },
      workers: [entry({
        name: "dead-worker", agentStatus: "exited",
        lastEventAt: NOW - REAPER_GRACE_MS - 1,
      })],
    });
    expect(runIntakeOnce(makeDeps(w))).toBe(true);
    expect(w.reopens).toHaveLength(1);
    expect(w.reopens[0].id).toBe("b1");
    expect(w.unassigns).toEqual(["b1"]);
    expect(w.labelsRemoved).toContainEqual({ id: "b1", label: "dispatch:retry:1" });
    expect(w.labelsAdded).toContainEqual({ id: "b1", label: "dispatch:retry:2" });
    expect(w.alerts).toHaveLength(1);
    expect(w.alerts[0].level).toBe("warn");
  });

  it("does not reap beads held by live workers or foreign actors", () => {
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["dispatch:auto"] })],
      statuses: {
        e1: st({
          active: [
            { id: "b1", title: "t", assignee: "live-worker" },
            { id: "b2", title: "t", assignee: "jic" },
          ],
        }),
      },
      workers: [entry({ name: "live-worker", agentStatus: "working" })],
    });
    expect(runIntakeOnce(makeDeps(w))).toBe(false);
    expect(w.reopens).toHaveLength(0);
  });
});

describe("intakeDue", () => {
  let tmp: string;
  const realHome = process.env.HOME;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "intake-due-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    process.env.HOME = realHome;
  });

  it("runs when never stamped, then throttles, then honors a poke marker", () => {
    // SESSIONS_DIR derives from config; stamp paths land under it. Use the
    // exported path helpers against whatever HOME the suite pinned.
    const project = `intake-test-${process.pid}`;
    const stamp = intakeStampPath(project);
    fs.mkdirSync(path.dirname(stamp), { recursive: true });
    try { fs.unlinkSync(stamp); } catch { /* absent */ }

    expect(intakeDue(project, Date.now())).toBe(true);

    fs.writeFileSync(stamp, "x");
    expect(intakeDue(project, Date.now())).toBe(false);
    expect(intakeDue(project, Date.now() + INTAKE_MIN_INTERVAL_MS + 1)).toBe(true);

    fs.writeFileSync(intakePokePath(project), "x");
    expect(intakeDue(project, Date.now())).toBe(true);
    // The poke marker is consumed by the check.
    expect(fs.existsSync(intakePokePath(project))).toBe(false);
    expect(intakeDue(project, Date.now())).toBe(false);

    fs.unlinkSync(stamp);
  });
});

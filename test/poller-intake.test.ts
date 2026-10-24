import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// The real stop kills tmux windows and deletes the worktree; runBeadIntake's
// real deps reach it, so it is observed rather than run.
vi.mock("../src/dashboard/workers.js", () => ({
  newWorker: vi.fn(() => null),
  stopWorkerByName: vi.fn(),
}));

// runBeadIntake's real deps shell out to bd; the error-stamp tests drive the
// entry point with these controllable, while runIntakeOnce tests keep
// injecting FakeWorld deps directly.
const bd = vi.hoisted(() => ({
  listOpenEpics: vi.fn(() => [] as unknown[]),
}));
vi.mock("../src/dashboard/beads.js", async (importOriginal) => ({
  // Keep the pure helpers (parseLabelCount, incrementFailedLabel) real; only
  // the bd shell-outs are stubbed.
  ...(await importOriginal<typeof import("../src/dashboard/beads.js")>()),
  listOpenEpics: bd.listOpenEpics,
  swarmStatus: vi.fn(() => null),
  showBeads: vi.fn(() => []),
  claimBead: vi.fn(() => true),
  reopenBead: vi.fn(() => true),
  unassignBead: vi.fn(() => true),
  addLabel: vi.fn(() => true),
  removeLabel: vi.fn(() => true),
}));

import {
  parseDispatchState, retryCount, failedCount, shouldReap, shouldReapFailing,
  isIntakeLive, buildBeadSeed, buildPlannerSeed, describeUnlandedWork,
  runIntakeOnce, runBeadIntake, intakeDue, intakeStampPath, intakePokePath,
  BREAKER_THRESHOLD, DEFAULT_BEAD_INTAKE_CAP, INTAKE_MIN_INTERVAL_MS, REAPER_GRACE_MS,
  type IntakeDeps, type IntakeSpawnRequest,
} from "../src/dashboard/poller-intake.js";
import { log } from "../src/dashboard/log.js";
import { intakeErrorPath, readIntakeStatus } from "../src/dashboard/intake-paths.js";
import { showBeads, type BeadDetail, type SwarmStatus } from "../src/dashboard/beads.js";
import {
  addWorker, findWorkerByName, removeWorker, type WorkerEntry,
} from "../src/dashboard/registry.js";
import { worktreePath } from "../src/dashboard/git.js";
import { stopWorkerByName } from "../src/dashboard/workers.js";

function entry(over: Partial<WorkerEntry> & { name: string }): WorkerEntry {
  return { sessionId: "s", task: "", ...over };
}

// Epics default to this project's own scope label: intake filters every pass
// to `project:<name>` (the shared-store conjunct), so a fixture without one
// would be invisible. A fixture that passes its own project:* label keeps it.
function epic(over: Partial<BeadDetail> & { id: string }): BeadDetail {
  const labels = over.labels ?? [];
  const scoped = labels.some(l => l.startsWith("project:"))
    ? labels
    : [...labels, "project:board"];
  return { title: `epic ${over.id}`, status: "open", priority: 1, ...over, labels: scoped };
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

  it("parses budget, spent, dispatched, dispatching, and budget-exhausted", () => {
    const ds = parseDispatchState([
      "budget:5", "dispatch:spent:3", "dispatch:dispatched", "dispatch:dispatching",
      "dispatch:budget-exhausted",
    ]);
    expect(ds.budget).toBe(5);
    expect(ds.spent).toBe(3);
    expect(ds.dispatched).toBe(true);
    expect(ds.dispatching).toBe(true);
    expect(ds.budgetExhausted).toBe(true);
    expect(parseDispatchState([]).dispatching).toBe(false);
  });

  it("defaults spent to 0 and budget to null, ignoring malformed counts", () => {
    const ds = parseDispatchState(["budget:lots", "dispatch:spent:-2"]);
    expect(ds.budget).toBeNull();
    expect(ds.spent).toBe(0);
  });

  it("parses duplicate counter labels max-wins", () => {
    const ds = parseDispatchState([
      "budget:3", "budget:5", "dispatch:spent:4", "dispatch:spent:1",
    ]);
    expect(ds.budget).toBe(5);
    expect(ds.spent).toBe(4);
  });
});

describe("retryCount / failedCount", () => {
  it("reads dispatch:retry:N max-wins and defaults to 0", () => {
    expect(retryCount(["dispatch:retry:2"])).toBe(2);
    expect(retryCount(["dispatch:retry:1", "dispatch:retry:3"])).toBe(3);
    expect(retryCount([])).toBe(0);
  });

  it("reads dispatch:failed:N max-wins and defaults to 0", () => {
    expect(failedCount(["dispatch:failed:1"])).toBe(1);
    expect(failedCount(["dispatch:failed:1", "dispatch:failed:2"])).toBe(2);
    expect(failedCount([])).toBe(0);
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

describe("shouldReapFailing", () => {
  it("reaps only a dead failing worker past the grace period", () => {
    const old = NOW - REAPER_GRACE_MS - 1;
    expect(shouldReapFailing(entry({
      name: "w", agentStatus: "exited", prState: "failing", lastEventAt: old,
    }), NOW)).toBe(true);
    expect(shouldReapFailing(entry({
      name: "w", agentStatus: "exited", prState: "failing", lastEventAt: NOW - 1000,
    }), NOW)).toBe(false);
  });

  it("never reaps a live failing worker or a missing entry", () => {
    const old = NOW - REAPER_GRACE_MS - 1;
    expect(shouldReapFailing(undefined, NOW)).toBe(false);
    expect(shouldReapFailing(entry({
      name: "w", agentStatus: "working", prState: "failing", lastEventAt: old,
    }), NOW)).toBe(false);
    // A dead worker still in `working` is shouldReap's crash branch, not this.
    expect(shouldReapFailing(entry({
      name: "w", agentStatus: "exited", lastEventAt: old,
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

  it("tells the worker to stop when its claim loses to another actor", () => {
    const seed = buildBeadSeed({
      projectName: "board",
      epic: { id: "e", title: "t" },
      bead: bead({ id: "b" }),
      mergedSiblings: [],
    });
    expect(seed).toContain("fails because another actor holds the bead");
    expect(seed).toContain("stop and mark yourself done");
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

  it("a leaf bead does NOT carry the assembly contract", () => {
    const seed = buildBeadSeed({
      projectName: "board",
      epic: { id: "e", title: "t" },
      bead: bead({ id: "b" }),
      mergedSiblings: [],
    });
    expect(seed).not.toContain("integration gate");
    expect(seed).toContain("After your merge lands: `bd close b`");
    expect(seed).not.toContain("no glue commit is needed");
  });

  it("an integration-labeled bead gets the assembly contract, keeping the claim/close protocol", () => {
    const seed = buildBeadSeed({
      projectName: "board",
      epic: { id: "board-e1", title: "Big feature", design: "The design text." },
      bead: bead({ id: "board-int", title: "integration", labels: ["integration"] }),
      mergedSiblings: ["board-b1", "board-b2"],
    });
    // The verify-the-assembly contract (Decision 13).
    expect(seed).toContain("integration gate");
    expect(seed).toContain("ASSEMBLED feature");
    expect(seed).toContain("every sibling");
    expect(seed).toContain("full gates");
    expect(seed).toContain("File new beads");
    expect(seed).toContain("instead of fixing sibling scope");
    expect(seed).toContain("no glue commit is needed");
    expect(seed).toContain("`bd close board-int` directly");
    expect(seed).toContain("If you make glue changes");
    // The protocol lines stay identical to the leaf contract.
    expect(seed).toContain("bd update board-int --claim");
    expect(seed).toContain("bd close board-int");
    expect(seed).toContain("bd update board-int -s blocked");
    expect(seed).toContain("bd label add board-int human");
    expect(seed).toContain("stop and mark yourself done");
  });
});

describe("buildPlannerSeed", () => {
  const seed = buildPlannerSeed({
    projectName: "board",
    epic: { id: "board-e1", title: "Big feature", design: "The full design doc text." },
  });

  it("names the epic and inlines the full design doc", () => {
    expect(seed).toContain("board-e1");
    expect(seed).toContain("Big feature");
    expect(seed).toContain("The full design doc text.");
  });

  it("pins the verified wisp-create and edge spellings with the --graph and --dry-run warnings", () => {
    expect(seed).toContain("--ephemeral --parent board-e1");
    expect(seed).toContain("bd dep <blocker-id> --blocks <blocked-id>");
    // The --graph pitfalls: it drops --parent (so the children never reach the
    // epic's swarm frontier and no worker is spawned for them) and ignores
    // node-level deps; --dry-run writes anyway. On bd 1.0.3 the disqualifying
    // drop was --ephemeral instead; workflow-planner.real.test.ts is the canary
    // that tracks which drop currently holds against the installed binary.
    expect(seed).toContain("bd create --graph");
    expect(seed).toContain("silently drops --parent");
    expect(seed).toContain('"deps"');
    expect(seed).toContain("--dry-run");
    expect(seed).toContain("bd dep cycles");
  });

  it("requires the integration child that every leaf blocks", () => {
    expect(seed).toContain("integration");
    expect(seed).toContain("-l integration");
    expect(seed).toContain("bd dep <leaf-id> --blocks <integration-id>");
    expect(seed).toContain("EVERY leaf");
  });

  it("carries both label rewrites and the no-promote / no-code rules", () => {
    expect(seed).toContain("bd label remove board-e1 plan:planning");
    expect(seed).toContain("bd label add board-e1 plan:ready");
    expect(seed).toContain("plan:failed");
    expect(seed).toContain("bd promote");
    expect(seed).toContain("never");
    expect(seed).toContain("commit code");
    expect(seed).toContain("no commits, no");
  });

  it("marks a missing design doc without inventing scope", () => {
    const bare = buildPlannerSeed({
      projectName: "board",
      epic: { id: "e", title: "t" },
    });
    expect(bare).toContain("no design doc pinned");
    expect(bare).toContain("do not invent scope");
  });
});

interface FakeWorld {
  epics: BeadDetail[];
  statuses: Record<string, SwarmStatus>;
  details: Record<string, BeadDetail>;
  workers: WorkerEntry[];
  spawns: IntakeSpawnRequest[];
  spawnResult: (n: number) => string | null;
  stops: string[];
  stopResult: boolean;
  claims: Array<{ id: string; actor: string }>;
  claimResult: boolean;
  reopens: Array<{ id: string; reason: string }>;
  unassigns: string[];
  labelsAdded: Array<{ id: string; label: string }>;
  labelsRemoved: Array<{ id: string; label: string }>;
  alerts: Array<{ level: string; message: string; dedupKey?: string }>;
  // unlandedWork's answer per worker name; a worker absent here has landed
  // everything it did.
  unlanded: Record<string, string>;
  notices: Array<{ worker: string; bead: string }>;
  // Interleaved log of label writes and spawns, for ordering assertions
  // (the budget pre-charge must land before the spawn).
  ops: string[];
}

function makeWorld(over: Partial<FakeWorld> = {}): FakeWorld {
  return {
    epics: [],
    statuses: {},
    details: {},
    workers: [],
    spawns: [],
    spawnResult: (n) => `worker-${n}`,
    stops: [],
    stopResult: true,
    claims: [],
    claimResult: true,
    reopens: [],
    unassigns: [],
    labelsAdded: [],
    labelsRemoved: [],
    alerts: [],
    unlanded: {},
    notices: [],
    ops: [],
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
    addLabel: (id, label) => {
      w.labelsAdded.push({ id, label });
      w.ops.push(`add:${label}`);
      return true;
    },
    removeLabel: (id, label) => {
      w.labelsRemoved.push({ id, label });
      w.ops.push(`remove:${label}`);
      return true;
    },
    spawn: (req) => {
      w.spawns.push(req);
      w.ops.push(`spawn:${req.task}`);
      return w.spawnResult(w.spawns.length);
    },
    stopWorker: (name) => {
      w.stops.push(name);
      w.ops.push(`stop:${name}`);
      return w.stopResult;
    },
    unlandedWork: (worker) => w.unlanded[worker.name] ?? null,
    noteUnlandedNotice: (name, beadId) => {
      w.notices.push({ worker: name, bead: beadId });
      // Persisted on the entry, as the registry write does, so a later pass
      // reads it back.
      const target = w.workers.find(e => e.name === name);
      if (target) target.unlandedNoticeBead = beadId;
    },
    workers: () => w.workers,
    alert: (input) => {
      w.alerts.push({ level: input.level, message: input.message, dedupKey: input.dedupKey });
    },
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

  // Shared-store project scoping (DELEGATION.md Decision 15): every pass is
  // filtered to epics labeled project:<name>, so another project's epics in a
  // shared store never drive this project's dispatch, plan, or reaper loops.
  it("ignores dispatch epics labeled for another project", () => {
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["dispatch:auto", "project:other"] })],
      statuses: { e1: st({ ready: [{ id: "b1", title: "one" }] }) },
      details: { b1: bead({ id: "b1" }) },
    });
    expect(runIntakeOnce(makeDeps(w))).toBe(false);
    expect(w.spawns).toHaveLength(0);
  });

  it("ignores plan:pending epics labeled for another project", () => {
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["plan:pending", "project:other"] })],
    });
    expect(runIntakeOnce(makeDeps(w))).toBe(false);
    expect(w.spawns).toHaveLength(0);
    expect(w.labelsRemoved).toHaveLength(0);
  });

  it("dispatches an epic carrying this project's own scope label as before", () => {
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["dispatch:auto", "project:board"] })],
      statuses: { e1: st({ ready: [{ id: "b1", title: "one" }] }) },
      details: { b1: bead({ id: "b1" }) },
    });
    expect(runIntakeOnce(makeDeps(w))).toBe(true);
    expect(w.spawns).toHaveLength(1);
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
    // The registry→bd join: intake asks the spawn seam to stamp entry.bead.
    expect(w.spawns[0].bead).toBe("b1");
    expect(w.claims).toEqual([{ id: "b1", actor: "worker-1" }]);
    expect(w.labelsAdded).toContainEqual({ id: "e1", label: "dispatch:spent:1" });
    // No pre-existing spent label -> nothing removed.
    expect(w.labelsRemoved).toHaveLength(0);
  });

  it("consumes a manual authorization in one pass when the wave fits the cap", () => {
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["dispatch:manual"] })],
      statuses: { e1: st({ ready: [{ id: "b1", title: "one" }] }) },
      details: { b1: bead({ id: "b1" }) },
    });
    runIntakeOnce(makeDeps(w));
    expect(w.labelsRemoved).toContainEqual({ id: "e1", label: "dispatch:manual" });
    expect(w.labelsAdded).toContainEqual({ id: "e1", label: "dispatch:dispatched" });
    // Wave done in one pass: the mid-wave marker never appears.
    expect(w.labelsAdded).not.toContainEqual({ id: "e1", label: "dispatch:dispatching" });
  });

  it("keeps a manual epic armed when the frontier is empty", () => {
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["dispatch:manual"] })],
      statuses: { e1: st({ ready: [{ id: "b1", title: "t", assignee: "w" }] }) },
    });
    expect(runIntakeOnce(makeDeps(w))).toBe(false);
    expect(w.labelsRemoved).toHaveLength(0);
  });

  it("stays armed with the dispatching marker when the wave outruns the cap", () => {
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["dispatch:manual"] })],
      statuses: { e1: st({ ready: [{ id: "b1", title: "1" }, { id: "b2", title: "2" }] }) },
      details: { b1: bead({ id: "b1" }), b2: bead({ id: "b2" }) },
    });
    runIntakeOnce(makeDeps(w, { cap: 1 }));
    expect(w.spawns).toHaveLength(1);
    expect(w.labelsAdded).toContainEqual({ id: "e1", label: "dispatch:dispatching" });
    expect(w.labelsRemoved).not.toContainEqual({ id: "e1", label: "dispatch:manual" });
    expect(w.labelsAdded).not.toContainEqual({ id: "e1", label: "dispatch:dispatched" });
  });

  it("does not re-add the dispatching marker on later throttled passes", () => {
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["dispatch:manual", "dispatch:dispatching", "dispatch:spent:1"] })],
      statuses: { e1: st({ ready: [{ id: "b2", title: "2" }, { id: "b3", title: "3" }] }) },
      details: { b2: bead({ id: "b2" }), b3: bead({ id: "b3" }) },
    });
    runIntakeOnce(makeDeps(w, { cap: 1 }));
    expect(w.spawns).toHaveLength(1);
    expect(w.labelsAdded).not.toContainEqual({ id: "e1", label: "dispatch:dispatching" });
    expect(w.labelsRemoved).not.toContainEqual({ id: "e1", label: "dispatch:manual" });
  });

  it("consumes the arm once the marked wave's frontier drains, even with no spawn", () => {
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["dispatch:manual", "dispatch:dispatching"] })],
      statuses: { e1: st({ ready: [{ id: "b1", title: "t", assignee: "worker-1" }] }) },
    });
    expect(runIntakeOnce(makeDeps(w))).toBe(true);
    expect(w.spawns).toHaveLength(0);
    expect(w.labelsRemoved).toContainEqual({ id: "e1", label: "dispatch:manual" });
    expect(w.labelsRemoved).toContainEqual({ id: "e1", label: "dispatch:dispatching" });
    expect(w.labelsAdded).toContainEqual({ id: "e1", label: "dispatch:dispatched" });
  });

  it("consumes the arm when this pass finishes a previously marked wave", () => {
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["dispatch:manual", "dispatch:dispatching", "dispatch:spent:1"] })],
      statuses: { e1: st({ ready: [{ id: "b2", title: "2" }] }) },
      details: { b2: bead({ id: "b2" }) },
    });
    runIntakeOnce(makeDeps(w));
    expect(w.spawns).toHaveLength(1);
    expect(w.labelsRemoved).toContainEqual({ id: "e1", label: "dispatch:manual" });
    expect(w.labelsRemoved).toContainEqual({ id: "e1", label: "dispatch:dispatching" });
    expect(w.labelsAdded).toContainEqual({ id: "e1", label: "dispatch:dispatched" });
  });

  it("GCs the dispatching marker when the epic's mode is not manual", () => {
    for (const labels of [
      ["dispatch:auto", "dispatch:dispatching"],
      ["dispatch:off", "dispatch:dispatching"],
      ["dispatch:dispatched", "dispatch:dispatching"],
    ]) {
      const w = makeWorld({
        epics: [epic({ id: "e1", labels })],
        statuses: { e1: st() },
      });
      expect(runIntakeOnce(makeDeps(w))).toBe(true);
      expect(w.labelsRemoved).toContainEqual({ id: "e1", label: "dispatch:dispatching" });
    }
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
    expect(w.alerts[0].dedupKey).toBe("intake-budget:board:e1");
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

  it("pre-charges the budget before the spawn (never an uncounted session)", () => {
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["dispatch:auto"] })],
      statuses: { e1: st({ ready: [{ id: "b1", title: "one" }] }) },
      details: { b1: bead({ id: "b1", title: "one" }) },
    });
    runIntakeOnce(makeDeps(w));
    const chargeIdx = w.ops.indexOf("add:dispatch:spent:1");
    const spawnIdx = w.ops.indexOf("spawn:bead b1: one");
    expect(chargeIdx).toBeGreaterThanOrEqual(0);
    expect(spawnIdx).toBeGreaterThan(chargeIdx);
  });

  it("aborts the epic's pass with a distinct alert when a budget write fails", () => {
    const w = makeWorld({
      epics: [
        epic({ id: "e1", labels: ["dispatch:auto"] }),
        epic({ id: "e2", labels: ["dispatch:auto"] }),
      ],
      statuses: {
        e1: st({ ready: [{ id: "b1", title: "1" }, { id: "b2", title: "2" }] }),
        e2: st({ ready: [{ id: "b3", title: "3" }] }),
      },
      details: { b1: bead({ id: "b1" }), b2: bead({ id: "b2" }), b3: bead({ id: "b3", title: "3" }) },
    });
    const deps = makeDeps(w, {
      addLabel: (id, label) => {
        w.labelsAdded.push({ id, label });
        // Break only e1's counter writes; e2's pass must continue.
        return !(id === "e1" && label.startsWith("dispatch:spent:"));
      },
    });
    expect(runIntakeOnce(deps)).toBe(true);
    // e1 spawned nothing (charge failed before the first spawn); e2 did.
    expect(w.spawns).toHaveLength(1);
    expect(w.spawns[0].task).toBe("bead b3: 3");
    expect(w.alerts).toHaveLength(1);
    expect(w.alerts[0].level).toBe("error");
    expect(w.alerts[0].dedupKey).toBe("intake-budget-write:board:e1");
  });

  it("preserves the old durable count when adding the pre-charge fails", () => {
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["dispatch:auto", "dispatch:spent:2"] })],
      statuses: { e1: st({ ready: [{ id: "b1", title: "1" }] }) },
      details: { b1: bead({ id: "b1" }) },
    });
    const deps = makeDeps(w, {
      addLabel: (id, label) => {
        w.labelsAdded.push({ id, label });
        return !label.startsWith("dispatch:spent:");
      },
    });
    runIntakeOnce(deps);
    expect(w.spawns).toHaveLength(0);
    expect(w.labelsRemoved).not.toContainEqual({ id: "e1", label: "dispatch:spent:2" });
    expect(w.alerts[0]?.dedupKey).toBe("intake-budget-write:board:e1");
  });

  it("aborts on a failed straggler removal too (remove is half the write)", () => {
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["dispatch:auto", "dispatch:spent:2"] })],
      statuses: { e1: st({ ready: [{ id: "b1", title: "1" }] }) },
      details: { b1: bead({ id: "b1" }) },
    });
    const deps = makeDeps(w, {
      removeLabel: (id, label) => {
        w.labelsRemoved.push({ id, label });
        return !label.startsWith("dispatch:spent:");
      },
    });
    runIntakeOnce(deps);
    expect(w.spawns).toHaveLength(0);
    expect(w.labelsAdded).toContainEqual({ id: "e1", label: "dispatch:spent:3" });
    expect(w.alerts[0]?.dedupKey).toBe("intake-budget-write:board:e1");
  });

  it("refunds the pre-charge when a spawn fails and halts the pass", () => {
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["dispatch:auto", "budget:5", "dispatch:spent:2"] })],
      statuses: { e1: st({ ready: [{ id: "b1", title: "t" }, { id: "b2", title: "t" }] }) },
      details: { b1: bead({ id: "b1" }), b2: bead({ id: "b2" }) },
      spawnResult: () => null,
    });
    runIntakeOnce(makeDeps(w));
    expect(w.spawns).toHaveLength(1);
    expect(w.claims).toHaveLength(0);
    // Charge: add spent:3, remove spent:2. Refund: re-add spent:2, remove spent:3.
    expect(w.labelsRemoved).toContainEqual({ id: "e1", label: "dispatch:spent:2" });
    expect(w.labelsAdded).toContainEqual({ id: "e1", label: "dispatch:spent:3" });
    expect(w.labelsRemoved).toContainEqual({ id: "e1", label: "dispatch:spent:3" });
    expect(w.labelsAdded.filter(l => l.label === "dispatch:spent:2")).toHaveLength(1);
  });

  it("keeps the higher charge when restoring a failed spawn's prior count fails", () => {
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["dispatch:auto", "dispatch:spent:2"] })],
      statuses: { e1: st({ ready: [{ id: "b1", title: "t" }] }) },
      details: { b1: bead({ id: "b1" }) },
      spawnResult: () => null,
    });
    let chargeAdded = false;
    const deps = makeDeps(w, {
      addLabel: (id, label) => {
        w.labelsAdded.push({ id, label });
        if (label === "dispatch:spent:3") {
          chargeAdded = true;
          return true;
        }
        if (chargeAdded && label === "dispatch:spent:2") return false;
        return true;
      },
    });
    runIntakeOnce(deps);
    expect(w.spawns).toHaveLength(1);
    expect(w.labelsAdded).toContainEqual({ id: "e1", label: "dispatch:spent:3" });
    expect(w.labelsRemoved).not.toContainEqual({ id: "e1", label: "dispatch:spent:3" });
  });

  it("does not re-add a zero count when refunding the first charge", () => {
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["dispatch:auto"] })],
      statuses: { e1: st({ ready: [{ id: "b1", title: "t" }] }) },
      details: { b1: bead({ id: "b1" }) },
      spawnResult: () => null,
    });
    runIntakeOnce(makeDeps(w));
    expect(w.labelsAdded).toEqual([{ id: "e1", label: "dispatch:spent:1" }]);
    expect(w.labelsRemoved).toEqual([{ id: "e1", label: "dispatch:spent:1" }]);
  });

  it("refunds a spawn that throws and finishes the pass before rethrowing", () => {
    const w = makeWorld({
      epics: [
        epic({ id: "e1", labels: ["dispatch:auto", "budget:5", "dispatch:spent:2"] }),
        epic({ id: "e2", labels: ["dispatch:auto"] }),
      ],
      statuses: {
        e1: st({ ready: [{ id: "b1", title: "t" }] }),
        e2: st({ ready: [{ id: "b2", title: "t" }] }),
      },
      details: { b1: bead({ id: "b1" }), b2: bead({ id: "b2" }) },
    });
    const deps = makeDeps(w, {
      spawn: (req) => {
        w.spawns.push(req);
        // newWorker rolled its entry back, then rethrew the pane failure.
        if (req.bead === "b1") throw new Error("tmux new-window failed: fork failed: Device not configured");
        return `worker-${w.spawns.length}`;
      },
    });
    expect(() => runIntakeOnce(deps)).toThrow("Device not configured");
    // Charge: add spent:3, remove spent:2. Refund: re-add spent:2, remove spent:3.
    expect(w.labelsAdded).toContainEqual({ id: "e1", label: "dispatch:spent:2" });
    expect(w.labelsRemoved).toContainEqual({ id: "e1", label: "dispatch:spent:3" });
    // The rest of the pass still ran before the error surfaced.
    expect(w.spawns.map(s => s.bead)).toEqual(["b1", "b2"]);
    expect(w.claims).toEqual([{ id: "b2", actor: "worker-2" }]);
  });

  it("records the armed wave before surfacing a spawn that threw", () => {
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["dispatch:manual"] })],
      statuses: { e1: st({ ready: [{ id: "b1", title: "1" }, { id: "b2", title: "2" }] }) },
      details: { b1: bead({ id: "b1", priority: 0 }), b2: bead({ id: "b2", priority: 1 }) },
    });
    const deps = makeDeps(w, {
      spawn: (req) => {
        w.spawns.push(req);
        if (req.bead === "b2") throw new Error("tmux new-window failed");
        return "worker-1";
      },
    });
    expect(() => runIntakeOnce(deps)).toThrow("tmux new-window failed");
    // b1 started the wave and b2 is still ready: the arm stays, and is marked.
    expect(w.labelsAdded).toContainEqual({ id: "e1", label: "dispatch:dispatching" });
    expect(w.labelsRemoved).not.toContainEqual({ id: "e1", label: "dispatch:manual" });
  });

  it("keeps the charge when a spawn throws after registering its worker", () => {
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["dispatch:auto", "dispatch:spent:2"] })],
      statuses: { e1: st({ ready: [{ id: "b1", title: "t" }] }) },
      details: { b1: bead({ id: "b1" }) },
    });
    const deps = makeDeps(w, {
      spawn: (req) => {
        w.spawns.push(req);
        // The pane is up and the entry carries the bead; a later step threw.
        w.workers.push(entry({ name: "half-spawned", bead: req.bead, agentStatus: "loading" }));
        throw new Error("Could not acquire registry lock after 10000ms");
      },
    });
    expect(() => runIntakeOnce(deps)).toThrow("registry lock");
    // The session may be running: keep the charge, never refund it.
    expect(w.labelsAdded).toContainEqual({ id: "e1", label: "dispatch:spent:3" });
    expect(w.labelsAdded).not.toContainEqual({ id: "e1", label: "dispatch:spent:2" });
    expect(w.labelsRemoved).not.toContainEqual({ id: "e1", label: "dispatch:spent:3" });
  });

  it("does not exhaust the budget on a refunded spawn failure", () => {
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["dispatch:auto", "budget:2"] })],
      statuses: { e1: st({ ready: [{ id: "b1", title: "1" }, { id: "b2", title: "2" }] }) },
      details: { b1: bead({ id: "b1", priority: 0 }), b2: bead({ id: "b2", priority: 1 }) },
      spawnResult: (n) => n === 1 ? "worker-1" : null,
    });
    runIntakeOnce(makeDeps(w));
    expect(w.spawns).toHaveLength(2);
    // b2's charge was refunded, so one of two sessions is spent.
    expect(w.labelsAdded).not.toContainEqual({ id: "e1", label: "dispatch:budget-exhausted" });
    expect(w.alerts).toHaveLength(0);
  });

  it("GCs duplicate spent stragglers on rewrite, charging from the max", () => {
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["dispatch:auto", "dispatch:spent:1", "dispatch:spent:3"] })],
      statuses: { e1: st({ ready: [{ id: "b1", title: "t" }] }) },
      details: { b1: bead({ id: "b1" }) },
    });
    runIntakeOnce(makeDeps(w));
    expect(w.labelsRemoved).toContainEqual({ id: "e1", label: "dispatch:spent:1" });
    expect(w.labelsRemoved).toContainEqual({ id: "e1", label: "dispatch:spent:3" });
    expect(w.labelsAdded).toContainEqual({ id: "e1", label: "dispatch:spent:4" });
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

  it("excludes breaker-tripped beads from dispatch at the threshold, not below", () => {
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["dispatch:auto"] })],
      statuses: {
        e1: st({ ready: [{ id: "b1", title: "tripped" }, { id: "b2", title: "warm" }] }),
      },
      details: {
        b1: bead({ id: "b1", title: "tripped", labels: [`dispatch:failed:${BREAKER_THRESHOLD}`] }),
        b2: bead({ id: "b2", title: "warm", labels: ["dispatch:failed:1"] }),
      },
    });
    runIntakeOnce(makeDeps(w));
    expect(w.spawns).toHaveLength(1);
    expect(w.spawns[0].task).toBe("bead b2: warm");
  });

  it("computes slots after breaker exclusion so a tripped bead can't starve a live one", () => {
    // The tripped bead outranks the eligible one on priority; with only one
    // slot, exclusion-after-sort would hand the slot to the tripped bead and
    // dispatch nothing.
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["dispatch:auto", "budget:1"] })],
      statuses: {
        e1: st({ ready: [{ id: "b1", title: "tripped" }, { id: "b2", title: "live" }] }),
      },
      details: {
        b1: bead({ id: "b1", title: "tripped", priority: 0, labels: ["dispatch:failed:2"] }),
        b2: bead({ id: "b2", title: "live", priority: 3 }),
      },
    });
    runIntakeOnce(makeDeps(w));
    expect(w.spawns).toHaveLength(1);
    expect(w.spawns[0].task).toBe("bead b2: live");
  });

  it("excludes breaker-tripped beads from the manual consume frontier", () => {
    // The armed wave's only remaining ready bead is tripped: the wave counts
    // as done and the arm is consumed rather than parked forever.
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["dispatch:manual"] })],
      statuses: {
        e1: st({ ready: [{ id: "b1", title: "1" }, { id: "b2", title: "tripped" }] }),
      },
      details: {
        b1: bead({ id: "b1" }),
        b2: bead({ id: "b2", labels: ["dispatch:failed:2"] }),
      },
    });
    runIntakeOnce(makeDeps(w));
    expect(w.spawns).toHaveLength(1);
    expect(w.labelsRemoved).toContainEqual({ id: "e1", label: "dispatch:manual" });
    expect(w.labelsAdded).toContainEqual({ id: "e1", label: "dispatch:dispatched" });
  });

  it("skips a bead claimed since the frontier snapshot, without charging", () => {
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["dispatch:manual"] })],
      statuses: { e1: st({ ready: [{ id: "b1", title: "raced" }, { id: "b2", title: "free" }] }) },
      details: { b1: bead({ id: "b1", title: "raced" }), b2: bead({ id: "b2", title: "free" }) },
    });
    const deps = makeDeps(w, {
      showBeads: (ids) => ids.map(id =>
        // The single-bead re-check sees a claim that landed after the batch
        // frontier read.
        id === "b1" && ids.length === 1
          ? { ...w.details[id], assignee: "someone-else" }
          : w.details[id],
      ).filter((d): d is BeadDetail => d !== undefined),
    });
    runIntakeOnce(deps);
    expect(w.spawns).toHaveLength(1);
    expect(w.spawns[0].task).toBe("bead b2: free");
    expect(w.labelsAdded).toContainEqual({ id: "e1", label: "dispatch:spent:1" });
    expect(w.labelsAdded.filter(l => l.label.startsWith("dispatch:spent:"))).toHaveLength(1);
    // The raced bead left the frontier, so the wave still consumed.
    expect(w.labelsRemoved).toContainEqual({ id: "e1", label: "dispatch:manual" });
  });

  it("fails closed when the frontier detail read is incomplete", () => {
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["dispatch:manual", "dispatch:dispatching"] })],
      statuses: { e1: st({ ready: [{ id: "b1", title: "1" }, { id: "b2", title: "2" }] }) },
      details: { b1: bead({ id: "b1" }) },
    });
    expect(() => runIntakeOnce(makeDeps(w))).toThrow("incomplete frontier data");
    expect(w.spawns).toHaveLength(0);
    expect(w.labelsRemoved).not.toContainEqual({ id: "e1", label: "dispatch:manual" });
    expect(w.labelsAdded).not.toContainEqual({ id: "e1", label: "dispatch:dispatched" });
  });

  it("fails closed when the pre-spawn detail re-check returns no bead", () => {
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["dispatch:auto"] })],
      statuses: { e1: st({ ready: [{ id: "b1", title: "1" }] }) },
      details: { b1: bead({ id: "b1" }) },
    });
    let reads = 0;
    const deps = makeDeps(w, {
      showBeads: () => ++reads === 1 ? [w.details.b1] : [],
    });
    expect(() => runIntakeOnce(deps)).toThrow("returned no data for bead b1");
    expect(w.spawns).toHaveLength(0);
    expect(w.labelsAdded).toHaveLength(0);
  });

  it("fails the pass when swarm status cannot be read", () => {
    const w = makeWorld({ epics: [epic({ id: "e1", labels: ["dispatch:auto"] })] });
    expect(() => runIntakeOnce(makeDeps(w))).toThrow("returned no data for epic e1");
  });

  it("retries a failed post-spawn claim once, then leaves it to the worker", () => {
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["dispatch:auto"] })],
      statuses: { e1: st({ ready: [{ id: "b1", title: "t" }] }) },
      details: { b1: bead({ id: "b1" }) },
      claimResult: false,
    });
    expect(runIntakeOnce(makeDeps(w))).toBe(true);
    expect(w.spawns).toHaveLength(1);
    expect(w.claims).toEqual([
      { id: "b1", actor: "worker-1" },
      { id: "b1", actor: "worker-1" },
    ]);
    expect(w.labelsAdded).toContainEqual({ id: "e1", label: "dispatch:spent:1" });
  });

  it("does not dispatch a bead again while its worker's own claim is pending", () => {
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["dispatch:auto"] })],
      statuses: { e1: st({ ready: [{ id: "b1", title: "t" }] }) },
      details: { b1: bead({ id: "b1" }) },
      claimResult: false,
    });
    const deps = makeDeps(w, {
      spawn: (req) => {
        w.spawns.push(req);
        const name = `worker-${w.spawns.length}`;
        // newWorker stamps the bead on the entry it registers.
        w.workers.push(entry({ name, bead: req.bead, agentStatus: "loading" }));
        return name;
      },
    });
    runIntakeOnce(deps);
    // Both claims failed, so bd still shows b1 unassigned and ready; this
    // pass runs before worker-1's own seeded claim lands.
    runIntakeOnce(deps);
    expect(w.spawns.map(s => s.bead)).toEqual(["b1"]);
    expect(w.labelsAdded.filter(l => l.label.startsWith("dispatch:spent:"))).toEqual([
      { id: "e1", label: "dispatch:spent:1" },
    ]);
  });

  it("does not dispatch a bead twice in one pass when two epics list it", () => {
    // bd lets one bead belong to two epics. With the claim failing, the
    // second epic's pre-spawn re-check still reads it unassigned.
    const w = makeWorld({
      epics: [
        epic({ id: "e1", labels: ["dispatch:auto"] }),
        epic({ id: "e2", labels: ["dispatch:auto"] }),
      ],
      statuses: {
        e1: st({ ready: [{ id: "b1", title: "t" }] }),
        e2: st({ ready: [{ id: "b1", title: "t" }] }),
      },
      details: { b1: bead({ id: "b1" }) },
      claimResult: false,
    });
    runIntakeOnce(makeDeps(w));
    expect(w.spawns.map(s => s.bead)).toEqual(["b1"]);
  });

  it("counts a worker whose claim is pending against the cap", () => {
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["dispatch:auto"] })],
      statuses: { e1: st({ ready: [{ id: "b1", title: "1" }, { id: "b2", title: "2" }] }) },
      details: { b1: bead({ id: "b1" }), b2: bead({ id: "b2" }) },
      workers: [entry({ name: "w1", bead: "b1", agentStatus: "loading" })],
    });
    runIntakeOnce(makeDeps(w, { cap: 1 }));
    expect(w.spawns).toHaveLength(0);
  });

  it("re-dispatches a bead whose carrier exited", () => {
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["dispatch:auto"] })],
      statuses: { e1: st({ ready: [{ id: "b1", title: "t" }] }) },
      details: { b1: bead({ id: "b1" }) },
      workers: [entry({ name: "w1", bead: "b1", agentStatus: "exited", lastEventAt: NOW - 1000 })],
    });
    runIntakeOnce(makeDeps(w));
    expect(w.spawns.map(s => s.bead)).toEqual(["b1"]);
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
    // A crash recovery counts retries only — never the quality counter.
    expect(w.labelsAdded.some(l => l.label.startsWith("dispatch:failed:"))).toBe(false);
    expect(w.alerts).toHaveLength(1);
    expect(w.alerts[0].level).toBe("warn");
  });

  it("GCs duplicate retry stragglers on the reaper's bump", () => {
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["dispatch:dispatched"] })],
      statuses: {
        e1: st({ active: [{ id: "b1", title: "t", assignee: "dead-worker" }] }),
      },
      details: { b1: bead({ id: "b1", labels: ["dispatch:retry:1", "dispatch:retry:2"] }) },
      workers: [entry({
        name: "dead-worker", agentStatus: "exited",
        lastEventAt: NOW - REAPER_GRACE_MS - 1,
      })],
    });
    runIntakeOnce(makeDeps(w));
    expect(w.labelsRemoved).toContainEqual({ id: "b1", label: "dispatch:retry:1" });
    expect(w.labelsRemoved).toContainEqual({ id: "b1", label: "dispatch:retry:2" });
    expect(w.labelsAdded).toContainEqual({ id: "b1", label: "dispatch:retry:3" });
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

  it("reaps a dead failing worker's bead with the failed counter, not retry", () => {
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["dispatch:dispatched"] })],
      statuses: {
        e1: st({ active: [{ id: "b1", title: "t", assignee: "dead-fail" }] }),
      },
      details: { b1: bead({ id: "b1" }) },
      workers: [entry({
        name: "dead-fail", agentStatus: "exited", prState: "failing",
        lastEventAt: NOW - REAPER_GRACE_MS - 1,
      })],
    });
    expect(runIntakeOnce(makeDeps(w))).toBe(true);
    expect(w.reopens.map(r => r.id)).toEqual(["b1"]);
    expect(w.unassigns).toEqual(["b1"]);
    expect(w.labelsAdded).toContainEqual({ id: "b1", label: "dispatch:failed:1" });
    // A quality failure must NOT count as a crash recovery.
    expect(w.labelsAdded.some(l => l.label.startsWith("dispatch:retry:"))).toBe(false);
    expect(w.alerts).toHaveLength(1);
    expect(w.alerts[0].level).toBe("warn");
    expect(w.alerts[0].dedupKey).toBe("intake-failed:board:b1:1");
  });

  it("a second failing recovery GCs failed:1 and writes failed:2 (max-wins)", () => {
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["dispatch:dispatched"] })],
      statuses: {
        e1: st({ active: [{ id: "b1", title: "t", assignee: "dead-fail" }] }),
      },
      details: { b1: bead({ id: "b1", labels: ["dispatch:failed:1"] }) },
      workers: [entry({
        name: "dead-fail", agentStatus: "exited", prState: "failing",
        lastEventAt: NOW - REAPER_GRACE_MS - 1,
      })],
    });
    runIntakeOnce(makeDeps(w));
    expect(w.labelsAdded).toContainEqual({ id: "b1", label: "dispatch:failed:2" });
    expect(w.labelsRemoved).toContainEqual({ id: "b1", label: "dispatch:failed:1" });
    expect(w.alerts[0].dedupKey).toBe("intake-failed:board:b1:2");
  });

  it("leaves a live failing worker's bead alone", () => {
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["dispatch:auto"] })],
      statuses: {
        e1: st({ active: [{ id: "b1", title: "t", assignee: "live-fail" }] }),
      },
      workers: [entry({
        name: "live-fail", agentStatus: "working", prState: "failing",
        lastEventAt: NOW - REAPER_GRACE_MS - 1,
      })],
    });
    expect(runIntakeOnce(makeDeps(w))).toBe(false);
    expect(w.reopens).toHaveLength(0);
    expect(w.labelsAdded).toHaveLength(0);
  });

  it("reconcile stops a worker whose bead is closed, with no alert (routine GC)", () => {
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["dispatch:dispatched"] })],
      statuses: { e1: st() },
      details: { b1: bead({ id: "b1", status: "closed", assignee: "w1" }) },
      workers: [entry({ name: "w1", bead: "b1", prState: "done", agentStatus: "exited" })],
    });
    expect(runIntakeOnce(makeDeps(w))).toBe(true);
    expect(w.stops).toEqual(["w1"]);
    expect(w.alerts).toHaveLength(0);
    // Reconcile only stops the worker — it never writes to the bead (the
    // removal tail's Decision-12 guard leaves a closed bead untouched too).
    expect(w.reopens).toHaveLength(0);
    expect(w.unassigns).toHaveLength(0);
  });

  it("reconcile stops a recalled worker with a warn alert, leaving the claim", () => {
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["dispatch:auto"] })],
      statuses: { e1: st() },
      details: { b1: bead({ id: "b1", status: "in_progress", assignee: "jic" }) },
      workers: [entry({ name: "w1", bead: "b1", prState: "working", agentStatus: "working" })],
    });
    expect(runIntakeOnce(makeDeps(w))).toBe(true);
    expect(w.stops).toEqual(["w1"]);
    expect(w.alerts).toHaveLength(1);
    expect(w.alerts[0].level).toBe("warn");
    expect(w.alerts[0].dedupKey).toBe("intake-reconcile:board:w1");
    expect(w.alerts[0].message).toContain("recalled");
    expect(w.unassigns).toHaveLength(0);
  });

  it.each(["merged", "done"] as const)(
    "reconcile stops a recalled worker whose work already landed (%s) with no alert",
    (prState) => {
      // The stop completes an operator-initiated recall and the branch is
      // already merged — nothing is discarded, so this is routine lifecycle
      // (logged, like the closed-bead sweep), not an operator alert. The warn
      // above is reserved for recalls that yank a bead from a worker whose
      // work has NOT landed.
      const w = makeWorld({
        epics: [epic({ id: "e1", labels: ["dispatch:auto"] })],
        statuses: { e1: st() },
        details: { b1: bead({ id: "b1", status: "in_progress", assignee: "jic" }) },
        workers: [entry({ name: "w1", bead: "b1", prState, agentStatus: "idle" })],
      });
      expect(runIntakeOnce(makeDeps(w))).toBe(true);
      expect(w.stops).toEqual(["w1"]);
      expect(w.alerts).toHaveLength(0);
      expect(w.unassigns).toHaveLength(0);
    },
  );

  it("reconcile skips an unassigned bead (claim may still be in flight)", () => {
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["dispatch:auto"] })],
      statuses: { e1: st() },
      details: { b1: bead({ id: "b1", status: "open" }) },
      workers: [entry({ name: "w1", bead: "b1", prState: "working", agentStatus: "working" })],
    });
    expect(runIntakeOnce(makeDeps(w))).toBe(false);
    expect(w.stops).toHaveLength(0);
  });

  it("reconcile defers a mid-pipeline worker with a log line, never stopping it", () => {
    vi.mocked(log.info).mockClear();
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["dispatch:auto"] })],
      statuses: { e1: st() },
      details: { b1: bead({ id: "b1", status: "closed", assignee: "w1" }) },
      workers: [entry({ name: "w1", bead: "b1", prState: "reviewing", agentStatus: "idle" })],
    });
    expect(runIntakeOnce(makeDeps(w))).toBe(false);
    expect(w.stops).toHaveLength(0);
    expect(vi.mocked(log.info).mock.calls.some(
      c => String(c[1]).includes("deferred"),
    )).toBe(true);
  });

  it.each(["working", "failing", "merged", "done"] as const)(
    "reconcile keeps a closed-bead worker (%s) whose work has not landed, saying why once",
    (prState) => {
      // A bead closed before its worker's work merged: an agent's early
      // `bd close`, or the operator's x in board. A stop deletes the branch
      // and worktree, and prState does not say whether the work landed (a
      // merged worker that was auto-continued holds new work again).
      const w = makeWorld({
        epics: [epic({ id: "e1", labels: ["dispatch:auto"] })],
        statuses: { e1: st() },
        details: { b1: bead({ id: "b1", status: "closed", assignee: "w1" }) },
        workers: [entry({ name: "w1", bead: "b1", prState, agentStatus: "idle" })],
        unlanded: { w1: "it has 2 commits not on origin/main" },
      });
      const changed = runIntakeOnce(makeDeps(w));
      expect(w.stops).toHaveLength(0);
      expect(changed).toBe(false);
      expect(w.alerts).toHaveLength(1);
      expect(w.alerts[0].level).toBe("warn");
      expect(w.alerts[0].dedupKey).toBe("intake-unlanded:board:w1");
      expect(w.alerts[0].message).toContain("Bead b1 is closed");
      expect(w.alerts[0].message).toContain("it has 2 commits not on origin/main");
      expect(w.notices).toEqual([{ worker: "w1", bead: "b1" }]);

      // Later passes keep it without telling the operator again.
      runIntakeOnce(makeDeps(w));
      expect(w.stops).toHaveLength(0);
      expect(w.alerts).toHaveLength(1);
      expect(w.notices).toHaveLength(1);
    },
  );

  it("reconcile defers a closed-bead worker whose agent is mid-turn, saying nothing", () => {
    // An integration worker closes its bead mid-turn, as its seed tells it
    // to; the turn may still be writing to the worktree.
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["dispatch:auto"] })],
      statuses: { e1: st() },
      details: { b1: bead({ id: "b1", status: "closed", assignee: "w1" }) },
      workers: [entry({ name: "w1", bead: "b1", prState: "working", agentStatus: "working" })],
    });
    const changed = runIntakeOnce(makeDeps(w));
    expect(w.stops).toHaveLength(0);
    expect(changed).toBe(false);
    expect(w.alerts).toHaveLength(0);
  });

  it("reconcile retires a kept closed-bead worker once its work lands", () => {
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["dispatch:auto"] })],
      statuses: { e1: st() },
      details: { b1: bead({ id: "b1", status: "closed", assignee: "w1" }) },
      workers: [entry({ name: "w1", bead: "b1", prState: "working", agentStatus: "idle" })],
      unlanded: { w1: "its worktree has uncommitted changes" },
    });
    runIntakeOnce(makeDeps(w));
    expect(w.stops).toHaveLength(0);

    // Committed, reviewed and merged: nothing is left that a stop would lose.
    delete w.unlanded.w1;
    w.workers[0].prState = "done";
    expect(runIntakeOnce(makeDeps(w))).toBe(true);
    expect(w.stops).toEqual(["w1"]);
    expect(w.alerts).toHaveLength(1);
  });

  it("reconcile ignores workers without a bead field", () => {
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["dispatch:dispatched"] })],
      statuses: { e1: st() },
      workers: [entry({ name: "w1", prState: "done", agentStatus: "exited" })],
    });
    expect(runIntakeOnce(makeDeps(w))).toBe(false);
    expect(w.stops).toHaveLength(0);
  });

  it("reconcile runs even with no gated epics (handoff --bead workers)", () => {
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["project:x"] })],
      details: { b1: bead({ id: "b1", status: "closed", assignee: "w1" }) },
      workers: [entry({ name: "w1", bead: "b1", prState: "done", agentStatus: "exited" })],
    });
    expect(runIntakeOnce(makeDeps(w))).toBe(true);
    expect(w.stops).toEqual(["w1"]);
  });

  it("reconcile leaves the worker alone when bd show has no data for its bead", () => {
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["dispatch:dispatched"] })],
      statuses: { e1: st() },
      workers: [entry({ name: "w1", bead: "gone", prState: "working", agentStatus: "working" })],
    });
    expect(runIntakeOnce(makeDeps(w))).toBe(false);
    expect(w.stops).toHaveLength(0);
  });

  it("a failed stop leaves the worker counted and stops nothing else", () => {
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["dispatch:auto"] })],
      statuses: {
        e1: st({
          active: [{ id: "b1", title: "t", assignee: "w1" }],
          ready: [{ id: "b2", title: "next" }],
        }),
      },
      details: {
        b1: bead({ id: "b1", status: "closed", assignee: "w1" }),
        b2: bead({ id: "b2", title: "next" }),
      },
      // Idle with nothing unlanded, so the reconcile does reach the stop.
      workers: [entry({ name: "w1", bead: "b1", prState: "working", agentStatus: "idle" })],
      stopResult: false,
    });
    runIntakeOnce(makeDeps(w, { cap: 1 }));
    expect(w.stops).toEqual(["w1"]);
    // Stop failed → the worker still holds the single slot; nothing spawns.
    expect(w.spawns).toHaveLength(0);
  });

  it("a reconcile stop frees a governor slot used in the same pass", () => {
    // b1 is still active in the (stale) swarm snapshot with w1 as assignee,
    // but its fresh detail reads closed — the mid-pass close race. The
    // governor counts assignees from the snapshot, so without the reconcile
    // stop landing first, w1 would hold the single slot and b2 would wait a
    // pass.
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["dispatch:auto"] })],
      statuses: {
        e1: st({
          active: [{ id: "b1", title: "t", assignee: "w1" }],
          ready: [{ id: "b2", title: "next" }],
        }),
      },
      details: {
        b1: bead({ id: "b1", status: "closed", assignee: "w1" }),
        b2: bead({ id: "b2", title: "next" }),
      },
      // Its turn over and its work landed: the closed bead retires it.
      workers: [entry({ name: "w1", bead: "b1", prState: "merged", agentStatus: "idle" })],
    });
    runIntakeOnce(makeDeps(w, { cap: 1 }));
    expect(w.stops).toEqual(["w1"]);
    expect(w.spawns).toHaveLength(1);
    expect(w.spawns[0].task).toBe("bead b2: next");
  });
});

describe("runIntakeOnce — plan:* consume loop", () => {
  it("consumes plan:pending BEFORE the spawn and spawns exactly one planner", () => {
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["plan:pending"], design: "The doc." })],
    });
    expect(runIntakeOnce(makeDeps(w))).toBe(true);
    expect(w.spawns).toHaveLength(1);
    expect(w.spawns[0].workflow).toBe("planner");
    expect(w.spawns[0].task).toBe("plan epic e1: epic e1");
    // A planner carries no bead — it holds no assignee and is invisible to
    // the governor join and reconcile.
    expect(w.spawns[0].bead).toBeUndefined();
    expect(w.spawns[0].seed).toContain("The doc.");
    expect(w.spawns[0].seed).toContain("plan:ready");
    // Consume-before-spawn ordering (Decision 16): both label writes land
    // before the spawn record.
    const removeIdx = w.ops.indexOf("remove:plan:pending");
    const addIdx = w.ops.indexOf("add:plan:planning");
    const spawnIdx = w.ops.findIndex(op => op.startsWith("spawn:plan epic e1"));
    expect(removeIdx).toBeGreaterThanOrEqual(0);
    expect(addIdx).toBeGreaterThan(removeIdx);
    expect(spawnIdx).toBeGreaterThan(addIdx);
  });

  it("never spawns for plan:planning, plan:ready, or plan:failed epics (idempotency)", () => {
    for (const label of ["plan:planning", "plan:ready", "plan:failed"]) {
      const w = makeWorld({ epics: [epic({ id: "e1", labels: [label] })] });
      expect(runIntakeOnce(makeDeps(w))).toBe(false);
      expect(w.spawns).toHaveLength(0);
      expect(w.labelsAdded).toHaveLength(0);
      expect(w.labelsRemoved).toHaveLength(0);
    }
  });

  it("aborts the epic with an error alert when the pending remove fails (no spawn)", () => {
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["plan:pending"] })],
    });
    const deps = makeDeps(w, {
      removeLabel: (id, label) => {
        w.labelsRemoved.push({ id, label });
        return label !== "plan:pending";
      },
    });
    runIntakeOnce(deps);
    expect(w.spawns).toHaveLength(0);
    expect(w.labelsAdded).toHaveLength(0);
    expect(w.alerts).toHaveLength(1);
    expect(w.alerts[0].level).toBe("error");
    expect(w.alerts[0].dedupKey).toBe("intake-plan:board:e1");
  });

  it("lands plan:failed best-effort when the planning write fails after the consume", () => {
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["plan:pending"] })],
    });
    const deps = makeDeps(w, {
      addLabel: (id, label) => {
        w.labelsAdded.push({ id, label });
        w.ops.push(`add:${label}`);
        return label !== "plan:planning";
      },
    });
    expect(runIntakeOnce(deps)).toBe(true);
    expect(w.spawns).toHaveLength(0);
    expect(w.labelsAdded).toContainEqual({ id: "e1", label: "plan:failed" });
    expect(w.alerts[0]?.dedupKey).toBe("intake-plan-arm:board:e1");
  });

  it("rewrites planning -> failed with an alert when the spawn fails", () => {
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["plan:pending"] })],
      spawnResult: () => null,
    });
    expect(runIntakeOnce(makeDeps(w))).toBe(true);
    expect(w.labelsRemoved).toContainEqual({ id: "e1", label: "plan:planning" });
    expect(w.labelsAdded).toContainEqual({ id: "e1", label: "plan:failed" });
    expect(w.alerts).toHaveLength(1);
    expect(w.alerts[0].level).toBe("error");
    expect(w.alerts[0].dedupKey).toBe("intake-plan-spawn:board:e1");
  });

  it("rewrites planning -> failed when the spawn throws", () => {
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["plan:pending"] })],
    });
    const deps = makeDeps(w, {
      spawn: () => { throw new Error("tmux new-window failed"); },
    });

    expect(runIntakeOnce(deps)).toBe(true);
    expect(w.labelsRemoved).toContainEqual({ id: "e1", label: "plan:planning" });
    expect(w.labelsAdded).toContainEqual({ id: "e1", label: "plan:failed" });
    expect(w.alerts).toHaveLength(1);
    expect(w.alerts[0].dedupKey).toBe("intake-plan-spawn:board:e1");
  });

  it("dispatch epics without plan:* are untouched by the plan loop, and vice versa", () => {
    const w = makeWorld({
      epics: [
        epic({ id: "d1", labels: ["dispatch:auto"] }),
        epic({ id: "p1", labels: ["plan:pending"] }),
      ],
      statuses: { d1: st({ ready: [{ id: "b1", title: "one" }] }) },
      details: { b1: bead({ id: "b1", title: "one" }) },
    });
    expect(runIntakeOnce(makeDeps(w))).toBe(true);
    // One planner (for p1) + one build worker (for d1's bead) — and the plan
    // loop never touched d1's labels, nor did dispatch charge p1. Crucially
    // the dispatch loop never asked for p1's swarm status (w.statuses has no
    // p1 entry; the dispatch loop would throw on the missing data).
    expect(w.spawns).toHaveLength(2);
    const planner = w.spawns.find(s => s.workflow === "planner")!;
    expect(planner.task).toContain("p1");
    const builder = w.spawns.find(s => s.workflow === undefined)!;
    expect(builder.task).toBe("bead b1: one");
    expect(w.labelsRemoved.filter(l => l.id === "d1" && l.label.startsWith("plan:"))).toHaveLength(0);
    expect(w.labelsAdded.filter(l => l.id === "p1" && l.label.startsWith("dispatch:"))).toHaveLength(0);
  });

  it("the planner spawn is exempt from the intake cap (no governor slot consumed)", () => {
    // Cap 1, already fully consumed by a live intake worker. The planner
    // still spawns; the bead dispatch does not.
    const w = makeWorld({
      epics: [
        epic({ id: "d1", labels: ["dispatch:auto"] }),
        epic({ id: "p1", labels: ["plan:pending"] }),
      ],
      statuses: {
        d1: st({
          active: [{ id: "b0", title: "building", assignee: "busy-worker" }],
          ready: [{ id: "b1", title: "one" }],
        }),
      },
      details: { b1: bead({ id: "b1" }) },
      workers: [entry({ name: "busy-worker", agentStatus: "working" })],
    });
    runIntakeOnce(makeDeps(w, { cap: 1 }));
    expect(w.spawns).toHaveLength(1);
    expect(w.spawns[0].workflow).toBe("planner");
    // And the planner never charged the budget channel.
    expect(w.labelsAdded.filter(l => l.label.startsWith("dispatch:spent:"))).toHaveLength(0);
  });

  it("an epic carrying both plan:pending and dispatch:auto runs both loops", () => {
    const w = makeWorld({
      epics: [epic({ id: "e1", labels: ["plan:pending", "dispatch:auto"] })],
      statuses: { e1: st({ ready: [{ id: "b1", title: "one" }] }) },
      details: { b1: bead({ id: "b1", title: "one" }) },
    });
    runIntakeOnce(makeDeps(w));
    expect(w.spawns.map(s => s.workflow)).toContain("planner");
    expect(w.spawns.some(s => s.task === "bead b1: one")).toBe(true);
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

describe("runBeadIntake error stamp", () => {
  const project = `intake-err-${process.pid}`;
  const config = { path: "/nonexistent", beadIntake: true } as const;

  beforeEach(() => {
    fs.mkdirSync(path.dirname(intakeStampPath(project)), { recursive: true });
    try { fs.unlinkSync(intakeStampPath(project)); } catch { /* absent */ }
    try { fs.unlinkSync(intakeErrorPath(project)); } catch { /* absent */ }
    bd.listOpenEpics.mockReset();
    bd.listOpenEpics.mockReturnValue([]);
  });

  it("stamps the error on a throwing pass and clears it on the next clean one", () => {
    bd.listOpenEpics.mockImplementation(() => { throw new Error("bd exploded"); });
    expect(runBeadIntake(project, { ...config })).toBe(false);
    let status = readIntakeStatus(project);
    expect(status.lastIntakeError).toContain("bd exploded");
    expect(status.lastIntakeAt).toBeDefined();

    // Clean pass (past the throttle): the error stamp clears.
    fs.unlinkSync(intakeStampPath(project));
    bd.listOpenEpics.mockReturnValue([]);
    runBeadIntake(project, { ...config });
    status = readIntakeStatus(project);
    expect(status.lastIntakeError).toBeUndefined();
    expect(status.lastIntakeAt).toBeDefined();
  });

  // Decision 15's loud dangling-store check: a configured beadsDir that is
  // missing must never be run against (bd would bootstrap a divergent DB
  // there) — the pass is skipped fail-closed and the failure is stamped as
  // the intake error board's liveness chip reads.
  it("skips the pass fail-closed when the configured beadsDir is dangling", () => {
    expect(runBeadIntake(project, {
      ...config,
      beadsDir: "/definitely/missing/.beads",
    })).toBe(false);
    expect(bd.listOpenEpics).not.toHaveBeenCalled();
    expect(readIntakeStatus(project).lastIntakeError).toContain("does not exist");
  });

  it("a throttled call neither runs a pass nor clears the error", () => {
    bd.listOpenEpics.mockImplementation(() => { throw new Error("still broken"); });
    runBeadIntake(project, { ...config });
    expect(readIntakeStatus(project).lastIntakeError).toContain("still broken");
    // Immediately again: throttled — stamp untouched, no pass ran.
    bd.listOpenEpics.mockClear();
    expect(runBeadIntake(project, { ...config })).toBe(false);
    expect(bd.listOpenEpics).not.toHaveBeenCalled();
    expect(readIntakeStatus(project).lastIntakeError).toContain("still broken");
  });
});

// The closed-bead guard's real reads, against real git: the branch, origin's
// copy of it, and the canonical worktree that a reconcile stop deletes.
describe("describeUnlandedWork / reconcile against real git", () => {
  let root: string;
  let repo: string;
  let project: string;
  let wt: string;
  let seq = 0;

  function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  }

  function commitFile(name: string): void {
    fs.writeFileSync(path.join(wt, name), `${name}\n`);
    git(wt, "add", name);
    git(wt, "commit", "-q", "-m", name);
  }

  const w1 = (over: Partial<WorkerEntry> = {}): WorkerEntry =>
    entry({ name: "w1", bead: "b1", baseBranch: "main", ...over });

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "intake-unlanded-")));
    repo = path.join(root, "repo");
    const origin = path.join(root, "origin.git");
    git(root, "init", "-q", "--bare", "-b", "main", origin);
    git(root, "init", "-q", "-b", "main", repo);
    git(repo, "config", "user.email", "test@garden.local");
    git(repo, "config", "user.name", "garden-test");
    fs.writeFileSync(path.join(repo, "README.md"), "# test\n");
    git(repo, "add", "README.md");
    git(repo, "commit", "-q", "-m", "init");
    git(repo, "remote", "add", "origin", origin);
    git(repo, "push", "-q", "origin", "main");
    project = `unlanded-${process.pid}-${++seq}`;
    wt = worktreePath(project, "w1");
    git(repo, "worktree", "add", "-q", "-b", "w1", wt, "refs/remotes/origin/main");
  });

  afterEach(() => {
    fs.rmSync(path.dirname(wt), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("finds nothing on a branch at its base with a clean worktree", () => {
    expect(describeUnlandedWork(project, repo, w1())).toBeNull();
  });

  it("counts commits its base lacks, including ones only a detached HEAD holds", () => {
    commitFile("a.txt");
    expect(describeUnlandedWork(project, repo, w1())).toBe("it has 1 commit not on origin/main");
    // A rebase leaves HEAD detached, on commits no branch names yet.
    git(wt, "checkout", "-q", "--detach");
    commitFile("b.txt");
    expect(describeUnlandedWork(project, repo, w1())).toBe("it has 2 commits not on origin/main");
  });

  it("names uncommitted changes, tracked or new, but not garden's excluded files", () => {
    // The bootstrap keeps garden's own sentinels out of git through info/exclude.
    fs.appendFileSync(path.join(repo, ".git", "info", "exclude"), ".garden-done\n");
    fs.writeFileSync(path.join(wt, ".garden-done"), "");
    expect(describeUnlandedWork(project, repo, w1())).toBeNull();
    fs.writeFileSync(path.join(wt, "new.txt"), "new\n");
    expect(describeUnlandedWork(project, repo, w1())).toBe("its worktree has uncommitted changes");
    fs.rmSync(path.join(wt, "new.txt"));
    fs.appendFileSync(path.join(wt, "README.md"), "edit\n");
    expect(describeUnlandedWork(project, repo, w1())).toBe("its worktree has uncommitted changes");
  });

  it("still counts the branch once its worktree is gone, then origin's copy of it", () => {
    commitFile("a.txt");
    git(wt, "push", "-q", "origin", "w1");
    git(repo, "worktree", "remove", "--force", wt);
    expect(describeUnlandedWork(project, repo, w1())).toBe("it has 1 commit not on origin/main");
    // The cleanup deletes origin's branch too, so that copy counts on its own.
    git(repo, "branch", "-D", "w1");
    expect(describeUnlandedWork(project, repo, w1())).toBe("it has 1 commit not on origin/main");
  });

  it("finds nothing once the branch has merged to its base", () => {
    commitFile("a.txt");
    git(wt, "push", "-q", "origin", "HEAD:main");
    expect(describeUnlandedWork(project, repo, w1())).toBeNull();
  });

  it("states a git failure rather than reading it as nothing to lose", () => {
    expect(describeUnlandedWork(project, repo, w1({ baseBranch: "gone" })))
      .toBe("git could not count its commits against its base");
    fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(root, "missing")}\n`);
    expect(describeUnlandedWork(project, repo, w1()))
      .toBe("git could not count its commits against its base; git could not read its worktree");
  });

  it("runBeadIntake keeps a closed-bead worker until its commit lands, then retires it", () => {
    bd.listOpenEpics.mockReset();
    bd.listOpenEpics.mockReturnValue([]);
    vi.mocked(showBeads).mockReturnValue([bead({ id: "b1", status: "closed", assignee: "w1" })]);
    vi.mocked(stopWorkerByName).mockClear();
    fs.mkdirSync(path.dirname(intakeStampPath(project)), { recursive: true });
    const config = { path: repo, beadIntake: true } as const;
    addWorker(project, w1({ worktreePath: wt, branchName: "w1", agentStatus: "idle" }));
    try {
      commitFile("a.txt");
      runBeadIntake(project, config);
      expect(readIntakeStatus(project).lastIntakeError).toBeUndefined();
      expect(stopWorkerByName).not.toHaveBeenCalled();
      expect(findWorkerByName(project, "w1")?.unlandedNoticeBead).toBe("b1");

      // The merge lands it on origin's base; the next pass retires it.
      git(wt, "push", "-q", "origin", "HEAD:main");
      fs.unlinkSync(intakeStampPath(project));
      runBeadIntake(project, config);
      expect(stopWorkerByName).toHaveBeenCalledWith(project, "w1");
    } finally {
      vi.mocked(showBeads).mockReset();
      vi.mocked(showBeads).mockReturnValue([]);
      removeWorker(project, "w1");
    }
  });
});

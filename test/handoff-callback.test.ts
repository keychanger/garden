// A one-shot handoff callback prompt fires at the parent pane the first time
// a child reaches a terminal prState — from transitionState (the chokepoint)
// or from handleDone (the Stop hook's trail-off done bypasses transitionState).
// These tests exercise both sites in poller-state.ts with a real registry on disk;
// continue.notifyHandoffCallback is mocked since the dispatch tests live in
// continue.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { useTmpHome } from "./helpers.js";

vi.mock("../src/dashboard/continue.js", () => ({
  notifyHandoffCallback: vi.fn(),
}));

// poller-state imports refreshDashboard transitively through header; mock
// the FIFO writer and the rest of the I/O surface so the test stays headless.
vi.mock("../src/dashboard/poller-fifo.js", () => ({
  scheduleDelayedPoke: vi.fn(),
  triggerProjectPoll: vi.fn(),
}));
vi.mock("../src/dashboard/header.js", () => ({
  refreshDashboard: vi.fn(),
}));
vi.mock("../src/dashboard/git.js", () => ({
  getBranchHeadSha: vi.fn(() => "deadbeef"),
  getCommitSummary: vi.fn(() => null),
  getNewCommitSummary: vi.fn(() => null),
}));
// handleDone consults the holistic gate; keep it ineligible so the callback
// assertion is isolated from the holistic-review dispatch.
vi.mock("../src/dashboard/poller-holistic-review.js", () => ({
  evaluateHolisticGate: vi.fn(() => ({ eligible: false })),
  maybeDispatchHolisticReview: vi.fn(),
}));

const home = useTmpHome();

async function seedChild(opts: {
  expectCallback?: boolean;
  parentProject?: string;
  parentWorker?: string;
  parentGone?: boolean;
  alreadyFired?: boolean;
  replyNote?: string;
  worktreePath?: string;
} = {}): Promise<void> {
  const { addWorker } = await import("../src/dashboard/registry.js");
  if (opts.parentProject && opts.parentWorker && !opts.parentGone) {
    addWorker(opts.parentProject, { name: opts.parentWorker, sessionId: "p", task: "" });
  }
  addWorker("wolf", {
    name: "bold-ash",
    sessionId: "s",
    task: "",
    branchName: "bold-ash",
    worktreePath: opts.worktreePath,
    prState: "merge-pending",
    handoffCallbackExpected: opts.expectCallback,
    parentProject: opts.parentProject,
    parentWorker: opts.parentWorker,
    handoffCallbackFiredAt: opts.alreadyFired ? 12345 : undefined,
    handoffReplyNote: opts.replyNote,
  });
}

// The child as a poller handler holds it when it decides the move: seedChild
// lands it in merge-pending.
const CHILD = { name: "bold-ash", prState: "merge-pending" } as const;

// The registry file as a poller killed at this instant leaves it: read straight
// from disk, before any deferred work in this process gets to run.
function registryOnDisk(): { workers: Record<string, Array<Record<string, unknown>>> } {
  return JSON.parse(fs.readFileSync(path.join(home.sessionsDir, "dashboard.registry.json"), "utf-8"));
}

describe("transitionState handoff callback chokepoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.resetModules();
  });

  it("fires a callback when a callback-expected child transitions to merged", async () => {
    await seedChild({
      expectCallback: true,
      parentProject: "fox",
      parentWorker: "calm-bay",
      replyNote: "all green",
    });
    const { transitionState } = await import("../src/dashboard/poller-state.js");
    const { notifyHandoffCallback } = await import("../src/dashboard/continue.js");

    transitionState("wolf", CHILD, "merged");
    // The dispatch path uses a dynamic import; let the microtask flush.
    await new Promise(r => setImmediate(r));

    expect(notifyHandoffCallback).toHaveBeenCalledWith({
      childProject: "wolf",
      childWorker: "bold-ash",
      childBranch: "bold-ash",
      terminalState: "merged",
      parentProject: "fox",
      parentWorker: "calm-bay",
      replyNote: "all green",
    });
  });

  it("also fires on the done terminal state (handoff with sentinel set)", async () => {
    await seedChild({
      expectCallback: true,
      parentProject: "fox",
      parentWorker: "calm-bay",
    });
    const { transitionState } = await import("../src/dashboard/poller-state.js");
    const { notifyHandoffCallback } = await import("../src/dashboard/continue.js");

    transitionState("wolf", CHILD, "done");
    await new Promise(r => setImmediate(r));

    expect(notifyHandoffCallback).toHaveBeenCalledWith(
      expect.objectContaining({ terminalState: "done" }),
    );
  });

  it("also fires on failing (child got stuck — operator likely needs to look)", async () => {
    await seedChild({
      expectCallback: true,
      parentProject: "fox",
      parentWorker: "calm-bay",
    });
    const { transitionState } = await import("../src/dashboard/poller-state.js");
    const { notifyHandoffCallback } = await import("../src/dashboard/continue.js");

    // failing is reachable from working, reviewing, merge-pending, resolving
    // — seedChild lands the entry in merge-pending, so this is valid.
    transitionState("wolf", CHILD, "failing");
    await new Promise(r => setImmediate(r));

    expect(notifyHandoffCallback).toHaveBeenCalled();
  });

  it("does not fire when the child has no expected-callback flag (plain handoff)", async () => {
    await seedChild({
      // parent fields present but expectCallback omitted — opt-in only.
      parentProject: "fox",
      parentWorker: "calm-bay",
    });
    const { transitionState } = await import("../src/dashboard/poller-state.js");
    const { notifyHandoffCallback } = await import("../src/dashboard/continue.js");

    transitionState("wolf", CHILD, "merged");
    await new Promise(r => setImmediate(r));

    expect(notifyHandoffCallback).not.toHaveBeenCalled();
  });

  it("does not fire on non-terminal states (working, reviewing)", async () => {
    await seedChild({
      expectCallback: true,
      parentProject: "fox",
      parentWorker: "calm-bay",
    });
    const { transitionState } = await import("../src/dashboard/poller-state.js");
    const { notifyHandoffCallback } = await import("../src/dashboard/continue.js");

    transitionState("wolf", CHILD, "working");
    await new Promise(r => setImmediate(r));

    expect(notifyHandoffCallback).not.toHaveBeenCalled();
  });

  it("rejects an invalid transition without changing the persisted state", async () => {
    await seedChild();
    const { transitionState } = await import("../src/dashboard/poller-state.js");
    const { findWorkerByName } = await import("../src/dashboard/registry.js");

    expect(transitionState("wolf", CHILD, "reviewing")).toBe(false);
    expect(findWorkerByName("wolf", "bold-ash")?.prState).toBe("merge-pending");
  });

  it("requires the explicit recovery API to force an invalid transition", async () => {
    await seedChild();
    const { forceTransitionState } = await import("../src/dashboard/poller-state.js");
    const { findWorkerByName } = await import("../src/dashboard/registry.js");

    expect(forceTransitionState("wolf", "bold-ash", "reviewing")).toBe(true);
    expect(findWorkerByName("wolf", "bold-ash")?.prState).toBe("reviewing");
  });

  it("does not re-fire when handoffCallbackFiredAt is already set (idempotency)", async () => {
    await seedChild({
      expectCallback: true,
      parentProject: "fox",
      parentWorker: "calm-bay",
      alreadyFired: true,
    });
    const { transitionState } = await import("../src/dashboard/poller-state.js");
    const { notifyHandoffCallback } = await import("../src/dashboard/continue.js");

    transitionState("wolf", CHILD, "merged");
    await new Promise(r => setImmediate(r));

    expect(notifyHandoffCallback).not.toHaveBeenCalled();
  });

  it("records handoffCallbackFiredAt before dispatch so a replayed terminal can't double-fire", async () => {
    await seedChild({
      expectCallback: true,
      parentProject: "fox",
      parentWorker: "calm-bay",
    });
    const { transitionState } = await import("../src/dashboard/poller-state.js");
    const { findWorkerByName } = await import("../src/dashboard/registry.js");

    transitionState("wolf", CHILD, "merged");

    const after = findWorkerByName("wolf", "bold-ash");
    expect(typeof after?.handoffCallbackFiredAt).toBe("number");
  });

  // The claim is permanent, so a callback recorded on the parent only after the
  // rest of the poll is lost to any death or failed write in between.
  it("records the callback on the parent in the same write that claims it", async () => {
    await seedChild({
      expectCallback: true,
      parentProject: "fox",
      parentWorker: "calm-bay",
      replyNote: "all green",
    });
    const { transitionState } = await import("../src/dashboard/poller-state.js");

    transitionState("wolf", CHILD, "merged");

    const { workers } = registryOnDisk();
    expect(workers.wolf[0].handoffCallbackFiredAt).toEqual(expect.any(Number));
    expect(workers.fox[0].pendingHandoffCallbacks).toEqual([
      expect.stringMatching(/wolf\/bold-ash reached terminal state `merged`[\s\S]*all green/),
    ]);
  });

  it("spends the claim and attempts no delivery when the parent is gone", async () => {
    await seedChild({
      expectCallback: true,
      parentProject: "fox",
      parentWorker: "calm-bay",
      parentGone: true,
    });
    const { transitionState } = await import("../src/dashboard/poller-state.js");
    const { notifyHandoffCallback } = await import("../src/dashboard/continue.js");

    transitionState("wolf", CHILD, "merged");
    await new Promise(r => setImmediate(r));

    const { workers } = registryOnDisk();
    expect(workers.wolf[0].handoffCallbackFiredAt).toEqual(expect.any(Number));
    expect(workers.fox).toBeUndefined();
    expect(notifyHandoffCallback).not.toHaveBeenCalled();
  });
});

describe("handleDone trail-off callback (no-merge completion)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.resetModules();
  });

  it("fires the callback for a --expect-callback child that trailed off to done without merging", async () => {
    // The M3 case: a child spawned with --expect-callback investigates, finds
    // nothing to commit, writes .garden-done, and its Stop hook lands it in
    // `done` directly (bypassing transitionState). handleDone is the guaranteed
    // poller-context landing, so the callback must fire there.
    await seedChild({
      expectCallback: true,
      parentProject: "fox",
      parentWorker: "calm-bay",
      worktreePath: "/wt/wolf/bold-ash",
      replyNote: "nothing to change",
    });
    const { handleDone } = await import("../src/dashboard/poller-state.js");
    const { notifyHandoffCallback } = await import("../src/dashboard/continue.js");
    const { findWorkerByName } = await import("../src/dashboard/registry.js");
    const entry = findWorkerByName("wolf", "bold-ash")!;

    handleDone("wolf", "/repo/wolf", "main", entry);
    await new Promise(r => setImmediate(r));

    expect(notifyHandoffCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        childProject: "wolf",
        childWorker: "bold-ash",
        terminalState: "done",
        parentProject: "fox",
        parentWorker: "calm-bay",
        replyNote: "nothing to change",
      }),
    );
  });

  it("fires once across repeated pokes (handleDone runs on every poke of a quiescent done worker)", async () => {
    await seedChild({
      expectCallback: true,
      parentProject: "fox",
      parentWorker: "calm-bay",
      worktreePath: "/wt/wolf/bold-ash",
    });
    const { handleDone } = await import("../src/dashboard/poller-state.js");
    const { notifyHandoffCallback } = await import("../src/dashboard/continue.js");
    const { findWorkerByName } = await import("../src/dashboard/registry.js");

    handleDone("wolf", "/repo/wolf", "main", findWorkerByName("wolf", "bold-ash")!);
    // Re-read the entry: the second poke sees the handoffCallbackFiredAt the
    // first one persisted, which is what makes the dispatch one-shot.
    handleDone("wolf", "/repo/wolf", "main", findWorkerByName("wolf", "bold-ash")!);
    await new Promise(r => setImmediate(r));

    expect(notifyHandoffCallback).toHaveBeenCalledTimes(1);
  });

  it("records the trail-off callback on the parent in the same write that claims it", async () => {
    await seedChild({
      expectCallback: true,
      parentProject: "fox",
      parentWorker: "calm-bay",
      worktreePath: "/wt/wolf/bold-ash",
    });
    const { handleDone } = await import("../src/dashboard/poller-state.js");
    const { findWorkerByName } = await import("../src/dashboard/registry.js");

    handleDone("wolf", "/repo/wolf", "main", findWorkerByName("wolf", "bold-ash")!);

    const { workers } = registryOnDisk();
    expect(workers.wolf[0].handoffCallbackFiredAt).toEqual(expect.any(Number));
    expect(workers.fox[0].pendingHandoffCallbacks).toEqual([
      expect.stringContaining("wolf/bold-ash reached terminal state `done (no further work expected)`"),
    ]);
  });

  it("does not fire in handleDone for a plain child without the callback flag", async () => {
    await seedChild({
      parentProject: "fox",
      parentWorker: "calm-bay",
      worktreePath: "/wt/wolf/bold-ash",
    });
    const { handleDone } = await import("../src/dashboard/poller-state.js");
    const { notifyHandoffCallback } = await import("../src/dashboard/continue.js");
    const { findWorkerByName } = await import("../src/dashboard/registry.js");
    const entry = findWorkerByName("wolf", "bold-ash")!;

    handleDone("wolf", "/repo/wolf", "main", entry);
    await new Promise(r => setImmediate(r));

    expect(notifyHandoffCallback).not.toHaveBeenCalled();
  });
});

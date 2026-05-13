// transitionState fires a one-shot handoff callback prompt at the parent
// pane the first time a child reaches a terminal prState. These tests
// exercise the chokepoint in poller-state.ts with a real registry on disk;
// continue.notifyHandoffCallback is mocked since the dispatch tests live in
// continue.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

useTmpHome();

async function seedChild(opts: {
  expectCallback?: boolean;
  parentProject?: string;
  parentWorker?: string;
  alreadyFired?: boolean;
  replyNote?: string;
} = {}): Promise<void> {
  const { addWorker } = await import("../src/dashboard/registry.js");
  addWorker("wolf", {
    name: "bold-ash",
    sessionId: "s",
    task: "",
    branchName: "bold-ash",
    prState: "merge-pending",
    handoffCallbackExpected: opts.expectCallback,
    parentProject: opts.parentProject,
    parentWorker: opts.parentWorker,
    handoffCallbackFiredAt: opts.alreadyFired ? 12345 : undefined,
    handoffReplyNote: opts.replyNote,
  });
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

    transitionState("wolf", "bold-ash", "merged");
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

    transitionState("wolf", "bold-ash", "done");
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
    transitionState("wolf", "bold-ash", "failing");
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

    transitionState("wolf", "bold-ash", "merged");
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

    transitionState("wolf", "bold-ash", "working");
    await new Promise(r => setImmediate(r));

    expect(notifyHandoffCallback).not.toHaveBeenCalled();
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

    transitionState("wolf", "bold-ash", "merged");
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

    transitionState("wolf", "bold-ash", "merged");

    const after = findWorkerByName("wolf", "bold-ash");
    expect(typeof after?.handoffCallbackFiredAt).toBe("number");
  });
});

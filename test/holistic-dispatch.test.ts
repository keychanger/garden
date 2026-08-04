import { describe, it, expect, vi } from "vitest";
import { useTmpHome } from "./helpers.js";
import type { WorkerEntry } from "../src/dashboard/registry.js";

// The interposed final review launches via launchHeadlessAgent (a hidden tmux
// window) — stub it so the dispatcher's state work runs without a tmux server.
// refreshDashboard also touches tmux; override just that export, keeping the
// rest of header.js real for the other modules that import it.
const launchHeadlessAgent = vi.fn(() => ({ windowName: "w", launchedAt: 0 }));
vi.mock("../src/dashboard/headless-agent.js", () => ({ launchHeadlessAgent }));
vi.mock("../src/dashboard/header.js", async (orig) => ({
  ...(await orig<typeof import("../src/dashboard/header.js")>()),
  refreshDashboard: vi.fn(),
}));

const env = useTmpHome();

// Real config + registry (temp HOME), so the dispatcher's tryGetProject read
// and its high-water guard write go through production code paths.
async function setup(mode: "off" | "shadow" | "fix", over: Partial<WorkerEntry>) {
  const cfg = await import("../src/config.js");
  cfg.saveConfig({ projects: { proj: { path: "/tmp/proj", holisticReview: mode } } });
  const reg = await import("../src/dashboard/registry.js");
  reg.addWorker("proj", {
    name: "multi-phase",
    sessionId: "s",
    task: "t",
    prState: "done",
    workflow: "default",
    mergeCount: 3,
    baseBranchSha: "basesha",
    ...over,
  });
  const hol = await import("../src/dashboard/poller-holistic-review.js");
  return { reg, hol };
}

describe("maybeDispatchHolisticReview (real config + registry)", () => {
  it("sets the high-water guard to mergeCount for an eligible completion", async () => {
    const { reg, hol } = await setup("shadow", {});
    const entry = reg.findWorkerByName("proj", "multi-phase")!;
    hol.maybeDispatchHolisticReview("proj", "/tmp/proj", "main", entry, "transitionToTerminal");
    expect(reg.findWorkerByName("proj", "multi-phase")!.holisticReviewedThroughMergeCount).toBe(3);
  });

  it("is idempotent: a second dispatch on the re-read entry is a no-op (already reviewed)", async () => {
    const { reg, hol } = await setup("shadow", {});
    const first = reg.findWorkerByName("proj", "multi-phase")!;
    hol.maybeDispatchHolisticReview("proj", "/tmp/proj", "main", first, "transitionToTerminal");
    const afterFirst = reg.findWorkerByName("proj", "multi-phase")!;
    expect(afterFirst.holisticReviewedThroughMergeCount).toBe(3);
    // Re-read (now carries the guard) → gate reports already-reviewed → no write.
    hol.maybeDispatchHolisticReview("proj", "/tmp/proj", "main", afterFirst, "transitionToTerminal");
    expect(reg.findWorkerByName("proj", "multi-phase")!.holisticReviewedThroughMergeCount).toBe(3);
  });

  it("re-arms when a re-opened worker advances mergeCount past the high-water mark", async () => {
    const { reg, hol } = await setup("shadow", { holisticReviewedThroughMergeCount: 3, mergeCount: 5 });
    const entry = reg.findWorkerByName("proj", "multi-phase")!;
    hol.maybeDispatchHolisticReview("proj", "/tmp/proj", "main", entry, "transitionToTerminal");
    expect(reg.findWorkerByName("proj", "multi-phase")!.holisticReviewedThroughMergeCount).toBe(5);
  });

  it("does not set the guard for a one-shot (mergeCount 1)", async () => {
    const { reg, hol } = await setup("shadow", { mergeCount: 1 });
    const entry = reg.findWorkerByName("proj", "multi-phase")!;
    hol.maybeDispatchHolisticReview("proj", "/tmp/proj", "main", entry, "transitionToTerminal");
    expect(reg.findWorkerByName("proj", "multi-phase")!.holisticReviewedThroughMergeCount).toBeUndefined();
  });

  it("sets the guard even in mode off (idempotency holds; off completions are not retroactively reviewed)", async () => {
    const { reg, hol } = await setup("off", {});
    const entry = reg.findWorkerByName("proj", "multi-phase")!;
    hol.maybeDispatchHolisticReview("proj", "/tmp/proj", "main", entry, "transitionToTerminal");
    expect(reg.findWorkerByName("proj", "multi-phase")!.holisticReviewedThroughMergeCount).toBe(3);
    // off mode never launches a review — the worker stays done.
    expect(reg.findWorkerByName("proj", "multi-phase")!.prState).toBe("done");
  });
});

// The trail-off trigger site (the only path into holistic review for a worker
// that finished a multi-phase task with no final merge). worktreePath points at
// a non-git dir so getCommitSummary returns "" — the quiescent-done branch where
// the dispatch is wired. Proves handleDone actually invokes the dispatcher;
// maybeDispatchHolisticReview's own behavior is covered above.
describe("handleDone wires the trail-off holistic trigger", () => {
  it("fires the dispatcher for an eligible quiescent done worker (guard set)", async () => {
    const { reg } = await setup("shadow", { worktreePath: env.gardenDir });
    const ps = await import("../src/dashboard/poller-state.js");
    const entry = reg.findWorkerByName("proj", "multi-phase")!;
    const resumed = ps.handleDone("proj", "/tmp/proj", "main", entry);
    expect(resumed).toBe(false); // quiescent: no commits ahead
    expect(reg.findWorkerByName("proj", "multi-phase")!.holisticReviewedThroughMergeCount).toBe(3);
  });

  it("does not fire for an ineligible quiescent done worker (one-shot, mergeCount 1)", async () => {
    const { reg } = await setup("shadow", { worktreePath: env.gardenDir, mergeCount: 1 });
    const ps = await import("../src/dashboard/poller-state.js");
    const entry = reg.findWorkerByName("proj", "multi-phase")!;
    ps.handleDone("proj", "/tmp/proj", "main", entry);
    expect(reg.findWorkerByName("proj", "multi-phase")!.holisticReviewedThroughMergeCount).toBeUndefined();
  });
});

describe("interposed final review launch (touched files present)", () => {
  it("re-opens done → reviewing, marks the final pass, and launches the reviewer", async () => {
    launchHeadlessAgent.mockClear();
    const { reg, hol } = await setup("shadow", { holisticTouchedFiles: ["src/a.ts", "src/b.ts"] });
    const entry = reg.findWorkerByName("proj", "multi-phase")!;
    hol.maybeDispatchHolisticReview("proj", env.gardenDir, "main", entry, "transitionToTerminal");

    const after = reg.findWorkerByName("proj", "multi-phase")!;
    expect(after.prState).toBe("reviewing");
    expect(after.holisticFinalActive).toBe(true);
    expect(after.holisticReviewMode).toBe("shadow");
    expect(after.holisticReviewedThroughMergeCount).toBe(3);
    expect(after.reviewWindowName).toBeTruthy();
    // The reviewer ran headless, marked GARDEN_REVIEWER, on the review harness.
    expect(launchHeadlessAgent).toHaveBeenCalledTimes(1);
    const opts = launchHeadlessAgent.mock.calls[0][0] as { envVars?: Record<string, string> };
    expect(opts.envVars).toMatchObject({ GARDEN_REVIEWER: "1" });
  });

  it("resolves the reviewer through resolveReviewRole so a Codex reviewer is honored", async () => {
    launchHeadlessAgent.mockClear();
    const cfg = await import("../src/config.js");
    // Configure the reviewer role to Codex — the interposed pass must honor it.
    cfg.saveConfig({
      projects: {
        proj: { path: "/tmp/proj", holisticReview: "fix", roles: { reviewer: { harness: "codex" } } },
      },
    });
    const reg = await import("../src/dashboard/registry.js");
    reg.addWorker("proj", {
      name: "codex-reviewed", sessionId: "s", task: "t", prState: "done",
      workflow: "default", mergeCount: 2, baseBranchSha: "basesha",
      holisticTouchedFiles: ["src/a.ts"],
    });
    const hol = await import("../src/dashboard/poller-holistic-review.js");
    const entry = reg.findWorkerByName("proj", "codex-reviewed")!;
    hol.maybeDispatchHolisticReview("proj", env.gardenDir, "main", entry, "transitionToTerminal");

    expect(launchHeadlessAgent).toHaveBeenCalledTimes(1);
    const opts = launchHeadlessAgent.mock.calls[0][0] as { launchPlan?: { harness?: string } };
    expect(opts.launchPlan?.harness).toBe("codex");
    expect(reg.findWorkerByName("proj", "codex-reviewed")!.holisticReviewMode).toBe("fix");
  });
});

describe("default holisticReview mode (unset project)", () => {
  it("defaults to fix — an unset project launches the review in fix mode, not off", async () => {
    launchHeadlessAgent.mockClear();
    const cfg = await import("../src/config.js");
    cfg.saveConfig({ projects: { proj: { path: "/tmp/proj" } } });
    expect(cfg.DEFAULT_HOLISTIC_REVIEW).toBe("fix");
    const reg = await import("../src/dashboard/registry.js");
    reg.addWorker("proj", {
      name: "multi-phase", sessionId: "s", task: "t", prState: "done",
      workflow: "default", mergeCount: 3, baseBranchSha: "basesha",
      holisticTouchedFiles: ["src/a.ts"],
    });
    const hol = await import("../src/dashboard/poller-holistic-review.js");
    const entry = reg.findWorkerByName("proj", "multi-phase")!;
    hol.maybeDispatchHolisticReview("proj", env.gardenDir, "main", entry, "transitionToTerminal");
    // It launched (not the off short-circuit) and in fix mode (the default).
    expect(launchHeadlessAgent).toHaveBeenCalledTimes(1);
    expect(reg.findWorkerByName("proj", "multi-phase")!.holisticReviewMode).toBe("fix");
  });
});

describe("dispatch deferral (leaves the guard unset → retries next poke)", () => {
  it("defers while the worker's own Claude is still working", async () => {
    launchHeadlessAgent.mockClear();
    const { reg, hol } = await setup("shadow", {
      holisticTouchedFiles: ["src/a.ts"], agentStatus: "working",
    });
    const entry = reg.findWorkerByName("proj", "multi-phase")!;
    hol.maybeDispatchHolisticReview("proj", env.gardenDir, "main", entry, "transitionToTerminal");
    // Guard NOT set — the next merged/done sweep poke retries once Claude is idle.
    expect(reg.findWorkerByName("proj", "multi-phase")!.holisticReviewedThroughMergeCount).toBeUndefined();
    expect(reg.findWorkerByName("proj", "multi-phase")!.prState).toBe("done");
    expect(launchHeadlessAgent).not.toHaveBeenCalled();
  });
});

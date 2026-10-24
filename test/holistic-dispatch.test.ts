import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
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
// The fleet review cap counts live reviewer windows from tmux, and a deferral
// re-pokes through a detached sleeper. Stub both; the rest stays real. A mock
// factory's result outlives useTmpHome's per-test module reset, so the real
// poller-fifo it spreads would keep reading the first test's registry; the
// working check reads the current test's instead (`current.registry`).
const { listAllWindowNames, scheduleDelayedPoke, current } = vi.hoisted(() => ({
  listAllWindowNames: vi.fn((): string[] => []),
  scheduleDelayedPoke: vi.fn(),
  current: { registry: undefined as undefined | typeof import("../src/dashboard/registry.js") },
}));
vi.mock("../src/dashboard/tmux.js", async (orig) => ({
  ...(await orig<typeof import("../src/dashboard/tmux.js")>()),
  listAllWindowNames,
}));
vi.mock("../src/dashboard/poller-fifo.js", async (orig) => ({
  ...(await orig<typeof import("../src/dashboard/poller-fifo.js")>()),
  scheduleDelayedPoke,
  isWorkerClaudeWorking: (project: string, worker: string) =>
    current.registry?.findWorkerByName(project, worker)?.agentStatus === "working",
}));

const env = useTmpHome();

// Real config + registry (temp HOME), so the dispatcher's tryGetProject read
// and its high-water guard write go through production code paths.
async function setup(mode: "off" | "shadow" | "fix", over: Partial<WorkerEntry>) {
  const cfg = await import("../src/config.js");
  cfg.saveConfig({ projects: { proj: { path: "/tmp/proj", holisticReview: mode } } });
  const reg = await import("../src/dashboard/registry.js");
  current.registry = reg;
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
    current.registry = reg;
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
    // Stamped like every headless launch, so no reader sees an earlier agent's.
    expect(reg.findWorkerByName("proj", "codex-reviewed")!.headlessHarness).toBe("codex");
  });

  // The reviewer is resolved before the prompt is built: Claude Code loads the
  // AGENTS.md that a CLAUDE.md pointer names, so a claude-code reviewer given
  // it inline held it twice.
  it("names rather than inlines the AGENTS.md a claude-code reviewer already loads", async () => {
    launchHeadlessAgent.mockClear();
    const wt = path.join(env.home, "wt");
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, "CLAUDE.md"), "@AGENTS.md\n");
    fs.writeFileSync(path.join(wt, "AGENTS.md"), "# Agents\n\nAGENTS-BODY\n");
    for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "docs"]]) {
      execFileSync("git", args, { cwd: wt, stdio: "ignore" });
    }
    const { reg, hol } = await setup("shadow", { worktreePath: wt, holisticTouchedFiles: ["src/a.ts"] });
    hol.maybeDispatchHolisticReview(
      "proj", env.gardenDir, "main", reg.findWorkerByName("proj", "multi-phase")!, "transitionToTerminal",
    );

    expect(launchHeadlessAgent).toHaveBeenCalledTimes(1);
    const { prompt } = launchHeadlessAgent.mock.calls[0][0] as { prompt: string };
    expect(prompt).not.toContain("AGENTS-BODY");
    expect(prompt).toContain("AGENTS.md is already in your context");
  });
});

describe("default holisticReview mode (unset project)", () => {
  it("defaults to fix — an unset project launches the review in fix mode, not off", async () => {
    launchHeadlessAgent.mockClear();
    const cfg = await import("../src/config.js");
    cfg.saveConfig({ projects: { proj: { path: "/tmp/proj" } } });
    expect(cfg.DEFAULT_HOLISTIC_REVIEW).toBe("fix");
    const reg = await import("../src/dashboard/registry.js");
    current.registry = reg;
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

// limits.maxConcurrentReviews counts every live `-review-` window, this pass's
// included, so the pass waits for a slot like a per-phase review does.
describe("fleet review cap (limits.maxConcurrentReviews)", () => {
  const BUSY = ["_other-review-calm-bay", "_third-review-swift-oak"];

  async function atCap(windows: string[]) {
    launchHeadlessAgent.mockClear();
    scheduleDelayedPoke.mockClear();
    listAllWindowNames.mockReturnValue(windows);
    const cfg = await import("../src/config.js");
    cfg.saveConfig({
      projects: { proj: { path: "/tmp/proj", holisticReview: "fix" } },
      limits: { maxConcurrentReviews: 2 },
    });
    const reg = await import("../src/dashboard/registry.js");
    current.registry = reg;
    reg.addWorker("proj", {
      name: "multi-phase", sessionId: "s", task: "t", prState: "done",
      workflow: "default", mergeCount: 3, baseBranchSha: "basesha",
      holisticTouchedFiles: ["src/a.ts"],
    });
    const hol = await import("../src/dashboard/poller-holistic-review.js");
    const dispatch = (entryPath: "transitionToTerminal" | "trailoff-handleDone") =>
      hol.maybeDispatchHolisticReview(
        "proj", env.gardenDir, "main", reg.findWorkerByName("proj", "multi-phase")!, entryPath,
      );
    return { reg, dispatch };
  }

  it("defers at the cap with the guard unset, and arms a re-poke", async () => {
    const { reg, dispatch } = await atCap(BUSY);
    dispatch("transitionToTerminal");

    const after = reg.findWorkerByName("proj", "multi-phase")!;
    expect(launchHeadlessAgent).not.toHaveBeenCalled();
    expect(after.prState).toBe("done");
    expect(after.holisticReviewedThroughMergeCount).toBeUndefined();
    // A quiet done worker gets no other poke: a slot freed in another project
    // wakes only that project's poller.
    expect(scheduleDelayedPoke).toHaveBeenCalledWith("proj", 20_000);
  });

  it("launches once a slot is free", async () => {
    const { reg, dispatch } = await atCap(BUSY.slice(0, 1));
    dispatch("trailoff-handleDone");

    expect(launchHeadlessAgent).toHaveBeenCalledTimes(1);
    expect(reg.findWorkerByName("proj", "multi-phase")!.prState).toBe("reviewing");
    expect(scheduleDelayedPoke).not.toHaveBeenCalled();
  });

  // Every poke re-runs the deferred dispatch (handleDone), so a re-poke armed
  // per deferral would multiply. The dedup is on disk, as each poll is a fresh
  // process: the module reset below stands in for that process boundary.
  it("arms one re-poke per window across repeated deferrals, and re-arms once it lapses", async () => {
    const first = await atCap(BUSY);
    first.dispatch("transitionToTerminal");
    vi.resetModules();
    const reg = await import("../src/dashboard/registry.js");
    current.registry = reg;
    const hol = await import("../src/dashboard/poller-holistic-review.js");
    const again = () => hol.maybeDispatchHolisticReview(
      "proj", env.gardenDir, "main", reg.findWorkerByName("proj", "multi-phase")!, "trailoff-handleDone",
    );
    again();
    expect(scheduleDelayedPoke).toHaveBeenCalledTimes(1);

    // The armed poke has fired by now; still capped, the next deferral re-arms.
    const lapsed = (Date.now() - 21_000) / 1000;
    fs.utimesSync(path.join(env.controlDir, "review-cap-recheck-proj"), lapsed, lapsed);
    again();
    expect(scheduleDelayedPoke).toHaveBeenCalledTimes(2);
    expect(launchHeadlessAgent).not.toHaveBeenCalled();
  });

  // A dropped poke would leave the pass waiting on nothing, so a marker that
  // cannot be written costs at most a duplicate poke, never the poke itself.
  it("still arms the re-poke when the dedup marker cannot be written", async () => {
    const { dispatch } = await atCap(BUSY);
    fs.chmodSync(env.controlDir, 0o500);
    try {
      dispatch("transitionToTerminal");
    } finally {
      fs.chmodSync(env.controlDir, 0o700);
    }
    expect(fs.existsSync(path.join(env.controlDir, "review-cap-recheck-proj"))).toBe(false);
    expect(scheduleDelayedPoke).toHaveBeenCalledWith("proj", 20_000);
  });
});

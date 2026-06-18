import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { useTmpHome } from "./helpers.js";
import type { WorkerEntry } from "../src/dashboard/registry.js";

// Keep the detached spawn (the holistic worker launch) from forking a real
// process in the spawn-path test; everything else in child_process stays real
// (git.ts execFileSync runs and fails harmlessly on the non-repo path).
vi.mock("node:child_process", async (orig) => ({
  ...(await orig<typeof import("node:child_process")>()),
  spawn: vi.fn(() => ({ unref: vi.fn() })),
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
    expect(resumed).toBe(false); // quiescent: no commits ahead, stays done
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

describe("shadow spawn path (touched files present)", () => {
  it("writes the shadow seed and dispatches the launch", async () => {
    const { reg, hol } = await setup("shadow", { holisticTouchedFiles: ["src/a.ts", "src/b.ts"] });
    const cfg = await import("../src/config.js");
    const entry = reg.findWorkerByName("proj", "multi-phase")!;
    hol.maybeDispatchHolisticReview("proj", env.gardenDir, "main", entry, "transitionToTerminal");
    // Guard set (we got past the no-diff-inputs short-circuit into the real path).
    expect(reg.findWorkerByName("proj", "multi-phase")!.holisticReviewedThroughMergeCount).toBe(3);
    const seedPath = path.join(cfg.SESSIONS_DIR, "holistic-seed-proj-multi-phase.txt");
    const seed = fs.readFileSync(seedPath, "utf-8");
    expect(seed).toContain("SHADOW (ANALYSIS-ONLY)");
    expect(seed).toContain(".holistic-findings.md");
  });
});

describe("dispatch deferral (cap hit leaves the guard unset → retries next poke)", () => {
  it("does not set the high-water guard when a holistic worker is already in flight", async () => {
    const { reg, hol } = await setup("shadow", { holisticTouchedFiles: ["src/a.ts"] });
    // An active holistic-review worker saturates the per-project cap
    // (HOLISTIC_CONCURRENCY_CAP = 1), so this eligible completion must defer.
    reg.addWorker("proj", {
      name: "holistic-1", sessionId: "h", task: "t",
      workflow: "holistic-review", prState: "working",
    });
    const entry = reg.findWorkerByName("proj", "multi-phase")!;
    hol.maybeDispatchHolisticReview("proj", env.gardenDir, "main", entry, "transitionToTerminal");
    // Guard NOT set — the next merged/done sweep poke (or pokeOnGateReset) retries.
    expect(reg.findWorkerByName("proj", "multi-phase")!.holisticReviewedThroughMergeCount).toBeUndefined();
  });
});

describe("finalizeShadowHolistic (surface findings + consume)", () => {
  async function finalizeSetup(findings: string) {
    const { reg, hol } = await setup("shadow", { workflow: "holistic-review" });
    const wt = path.join(env.gardenDir, "wt-holistic");
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(path.join(wt, ".holistic-findings.md"), findings);
    reg.updateWorkerFields("proj", "multi-phase", { worktreePath: wt });
    const alerts = await import("../src/dashboard/alerts.js");
    return { hol, wt, alerts };
  }

  it("raises a FINDINGS alert, writes a durable copy, and consumes the worktree file", async () => {
    const { hol, wt, alerts } = await finalizeSetup("Phase 1 added X; phase 3 orphaned it.");
    const entry = (await import("../src/dashboard/registry.js")).findWorkerByName("proj", "multi-phase")!;
    hol.finalizeShadowHolistic("proj", entry);
    const msgs = alerts.readAlerts().alerts.map((a) => a.message);
    expect(msgs.some((m) => m.includes("Holistic review FINDINGS"))).toBe(true);
    expect(fs.existsSync(path.join(wt, ".holistic-findings.md"))).toBe(false); // consumed
    // Idempotent: second call finds nothing, no second alert.
    hol.finalizeShadowHolistic("proj", entry);
    expect(alerts.readAlerts().alerts.filter((a) => a.message.includes("Holistic review")).length).toBe(1);
  });

  it("classifies a CLEAN result distinctly", async () => {
    const { hol, alerts } = await finalizeSetup("CLEAN — no cross-phase defects");
    const entry = (await import("../src/dashboard/registry.js")).findWorkerByName("proj", "multi-phase")!;
    hol.finalizeShadowHolistic("proj", entry);
    expect(alerts.readAlerts().alerts.some((a) => a.message.includes("Holistic review CLEAN"))).toBe(true);
  });
});

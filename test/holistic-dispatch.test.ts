import { describe, it, expect } from "vitest";
import { useTmpHome } from "./helpers.js";
import type { WorkerEntry } from "../src/dashboard/registry.js";

useTmpHome();

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

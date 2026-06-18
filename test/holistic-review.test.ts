import { describe, it, expect } from "vitest";
import {
  evaluateHolisticGate,
  buildHolisticSeed,
} from "../src/dashboard/poller-holistic-review.js";
import type { WorkerEntry } from "../src/dashboard/registry.js";

// Minimal WorkerEntry factory — only the fields the gate reads matter.
function entry(over: Partial<WorkerEntry>): WorkerEntry {
  return {
    name: "test-worker",
    sessionId: "s",
    task: "t",
    prState: "done",
    workflow: "default",
    mergeCount: 2,
    ...over,
  };
}

describe("evaluateHolisticGate", () => {
  it("fires on a multi-phase default completion (sentinel-on-last-phase shape)", () => {
    // brown-blunt-flock shape: 3 merges, reached done, default workflow.
    expect(evaluateHolisticGate(entry({ mergeCount: 3, holisticReviewedThroughMergeCount: 0 })))
      .toEqual({ eligible: true, reason: "ok" });
  });

  it("skips a one-shot (single merge) — its whole-task diff == the delta already reviewed", () => {
    // burnt-plush-wake shape: single push, single merge.
    expect(evaluateHolisticGate(entry({ mergeCount: 1 })))
      .toEqual({ eligible: false, reason: "mergeCount<2" });
  });

  it("skips the auto-continued-then-immediately-done-with-no-second-push shape (mergeCount stays 1)", () => {
    // This is exactly why mergeCount, not lastAutoContinueAt, is the gate.
    expect(evaluateHolisticGate(entry({ mergeCount: 1 })).eligible).toBe(false);
  });

  it("excludes the holistic-review child (recursion safety)", () => {
    expect(evaluateHolisticGate(entry({ workflow: "holistic-review", mergeCount: 3 })))
      .toEqual({ eligible: false, reason: "workflow" });
  });

  it("excludes grow workers despite mergeCount>=2", () => {
    expect(evaluateHolisticGate(entry({ workflow: "grow", mergeCount: 5 })))
      .toEqual({ eligible: false, reason: "workflow" });
  });

  it("excludes trellis workers despite mergeCount>=2 (load-bearing: only the workflow clause stops trellis)", () => {
    expect(evaluateHolisticGate(entry({ workflow: "trellis", mergeCount: 9 })))
      .toEqual({ eligible: false, reason: "workflow" });
  });

  it("treats a legacy entry with no workflow as default", () => {
    expect(evaluateHolisticGate(entry({ workflow: undefined, mergeCount: 2 })).eligible).toBe(true);
  });

  it("skips when already reviewed through the current mergeCount (idempotent against replayed done)", () => {
    expect(evaluateHolisticGate(entry({ mergeCount: 3, holisticReviewedThroughMergeCount: 3 })))
      .toEqual({ eligible: false, reason: "already-reviewed" });
  });

  it("re-arms when a re-opened worker adds phases past the high-water mark", () => {
    expect(evaluateHolisticGate(entry({ mergeCount: 4, holisticReviewedThroughMergeCount: 2 })))
      .toEqual({ eligible: true, reason: "ok" });
  });

  it("skips a worker that is not done (no review mid-phase)", () => {
    expect(evaluateHolisticGate(entry({ prState: "merged", mergeCount: 3 })))
      .toEqual({ eligible: false, reason: "not-done" });
  });
});

describe("buildHolisticSeed", () => {
  const seed = buildHolisticSeed({
    originalName: "brown-blunt-flock",
    baseBranch: "main",
    baseBranchSha: "4276499c",
    mergeCount: 3,
    touchedFiles: ["src/routing.ts", "src/factory.ts"],
    transcriptPath: "/x/transcript.jsonl",
    rationale: "abc123 phase 1: add helper\ndef456 phase 3: replace uses",
  });

  it("carries the scoped diff command with the base SHA and the touched-file list", () => {
    expect(seed).toContain("git diff 4276499c..origin/main -- src/routing.ts src/factory.ts");
  });

  it("includes the original worker name and the rationale", () => {
    expect(seed).toContain("brown-blunt-flock");
    expect(seed).toContain("phase 3: replace uses");
  });

  it("instructs a clean no-op when the assembled whole is coherent", () => {
    expect(seed).toMatch(/IF COHERENT/);
    expect(seed).toContain("change NOTHING");
  });

  it("states the scoped-diff limitation (not a fence) and recursion safety", () => {
    expect(seed).toContain("not a fence");
    expect(seed).toContain("never spawn another");
  });
});

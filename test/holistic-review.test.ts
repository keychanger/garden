import { describe, it, expect } from "vitest";
import { evaluateHolisticGate } from "../src/dashboard/poller-holistic-review.js";
import { holisticReviewSections } from "../src/dashboard/prompts.js";
import { composePrompt, makeContext, type PromptData } from "../src/dashboard/prompt-compose.js";
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

// The aggregated final-review prompt is composed from holisticReviewSections
// against a PromptContext. Testing the sections directly (vs the file-I/O
// builder) keeps these pure — the mode-dependent disposition + verdict format
// and the deliberate-decision guardrail are the interesting logic.
function holisticPrompt(mode: "fix" | "shadow", over: Partial<WorkerEntry> = {}): string {
  const e = entry({
    name: "brown-blunt-flock",
    baseBranchSha: "4276499c",
    mergeCount: 3,
    holisticTouchedFiles: ["src/routing.ts", "src/factory.ts"],
    holisticRationale: "abc123 phase 1: add helper\ndef456 phase 3: replace uses",
    holisticReviewMode: mode,
    ...over,
  });
  const data: PromptData = {
    diff: "diff --git a/src/routing.ts b/src/routing.ts\n@@ cross-phase change @@",
    commitSummary: "",
    branchName: "brown-blunt-flock",
    rules: "RULES",
    checksCommand: "npm test",
    changedFiles: ["src/routing.ts", "src/factory.ts"],
    docSections: [],
    testSections: [],
    specFiles: [],
  };
  return composePrompt(holisticReviewSections, makeContext("proj", "/tmp/proj", "main", e, data));
}

describe("holistic final-review prompt", () => {
  const fix = holisticPrompt("fix");
  const shadow = holisticPrompt("shadow");

  it("frames a whole-task review of the assembled multi-phase result", () => {
    for (const s of [fix, shadow]) {
      expect(s).toContain("brown-blunt-flock");
      expect(s).toContain("ASSEMBLED WHOLE");
      expect(s).toContain("3 merges");
    }
  });

  it("embeds the assembled whole-task diff scoped to the base SHA", () => {
    expect(fix).toContain("4276499c..origin/main");
    expect(fix).toContain("cross-phase change");
  });

  it("carries the deliberate-decision guardrail with the cross-phase rationale", () => {
    for (const s of [fix, shadow]) {
      expect(s).toContain("DO NOT UNDO INTENTIONAL CHOICES");
      expect(s).toContain("phase 3: replace uses");
    }
  });

  it("states the scoped-diff limitation (not a fence) in both modes", () => {
    for (const s of [fix, shadow]) {
      expect(s).toContain("not a fence");
    }
  });

  it("fix mode: fix + commit, CLEAN/FIXED/FAILED verdict, references garden checks", () => {
    expect(fix).toContain('commit with a message prefixed "review: "');
    expect(fix).toContain("garden checks proj");
    expect(fix).toContain("`FIXED`");
    expect(fix).not.toContain("ANALYSIS-ONLY");
  });

  it("shadow mode: analysis-only, never FIXED, no commit", () => {
    expect(shadow).toContain("ANALYSIS-ONLY");
    expect(shadow).toContain("make NO code edits and NO commits");
    expect(shadow).toContain("Never emit FIXED");
    expect(shadow).not.toContain('commit with a message prefixed "review: "');
  });
});

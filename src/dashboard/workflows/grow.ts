// Grow workflow definition. See declarative-singing-graham.md (the plan)
// for design rationale: a bounded iteration loop without a frozen design
// document. Anchored by an operator-supplied seed prompt, terminates on
// `.garden-done` (worker self-declares) or budget hit.
//
// Phase 2 (this file) registers the workflow at the data layer. State
// handlers reuse the default workflow's — the verdict vocabulary is the
// default CLEAN/FIXED/FAILED, so handleReviewing's default branch
// applies as-is. Phase 3 wires the per-iteration mechanics in
// `grow-continue.ts` and the post-merge dispatch in poller-merge.ts.
//
// Crucially, this Phase 2 definition is byte-equivalent to the default
// workflow on the wire — a worker stamped with `workflow: "grow"` here
// walks the same review/merge lifecycle as a default worker. Phase 3
// adds the per-iteration cold respawn that distinguishes grow from default.
import { defaultHookHandlers } from "../hooks/default.js";
import { handleMergePending } from "../poller-merge.js";
import { handleResolving } from "../poller-resolve.js";
import { handleWorking, handleReviewing } from "../poller-review.js";
import { handleFailing, handleMerged, handleDone } from "../poller-state.js";
import { growValidTransitions, type WorkflowDefinition } from "./types.js";

export const growWorkflow: WorkflowDefinition = {
  name: "grow",
  validTransitions: growValidTransitions,
  stateHandlers: {
    working: handleWorking,
    reviewing: handleReviewing,
    "merge-pending": handleMergePending,
    resolving: handleResolving,
    failing: handleFailing,
    merged: handleMerged,
    done: handleDone,
  },
  hookHandlers: defaultHookHandlers,
  // workerModel and reviewerModel both unset — grow uses the account default
  // (locked decisions 3 and 4 in declarative-singing-graham.md). Loops are
  // bounded by N, not by quality concerns the way trellis is.
};

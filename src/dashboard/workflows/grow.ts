// Grow workflow definition: a bounded iteration loop without a frozen
// design document. Anchored by an operator-supplied seed prompt,
// terminates on `.garden-done` (worker self-declares) or budget hit.
//
// At this point the workflow is registered at the data layer only; state
// handlers reuse the default workflow's. The verdict vocabulary is the
// default CLEAN/FIXED/FAILED, so handleReviewing's default branch applies
// as-is. The per-iteration mechanics (cold respawn + grow-flavored
// continue prompt) and the post-merge dispatch wiring are not yet
// implemented.
//
// Crucially, this definition is byte-equivalent to the default workflow
// on the wire — a worker stamped with `workflow: "grow"` here walks the
// same review/merge lifecycle as a default worker. The per-iteration cold
// respawn that distinguishes grow from default lands later.
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
  // workerModel and reviewerModel both unset — grow uses the account
  // default. Loops are bounded by N, not by quality concerns the way
  // trellis is.
};

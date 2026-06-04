// Trellis workflow definition. See src/dashboard/WORKFLOWS.md for the
// authoritative spec.
//
// Phase 1 ships a skeletal definition that reuses the default workflow's
// state handlers and hook handlers. The workflow's data shape (name,
// validTransitions, workerModel, reviewerModel) is what consumers (the
// registry, model resolution in phase 3) need first; behavior divergence
// (trellis-specific reviewer prompts, per-iteration context reset,
// FLAGGED handling) lands in phase 2 by overriding individual handlers.
//
// Crucially, this skeletal definition is byte-equivalent to the default
// workflow on the wire — a worker stamped with `workflow: "trellis"` in
// phase 1 walks the same review/merge lifecycle as a default worker.
// Phase 2 swaps in trellis-specific handlers and that equivalence ends.
import { defaultHookHandlers } from "../hooks/default.js";
import { handleCiFixing } from "../poller-ci-fix.js";
import { handleMergePending, handleMerged } from "../poller-merge.js";
import { handleResolving } from "../poller-resolve.js";
import { handleWorking, handleReviewing } from "../poller-review.js";
import { handleFailing, handleDone } from "../poller-state.js";
import { trellisValidTransitions, type WorkflowDefinition } from "./types.js";

export const trellisWorkflow: WorkflowDefinition = {
  name: "trellis",
  validTransitions: trellisValidTransitions,
  stateHandlers: {
    working: handleWorking,
    reviewing: handleReviewing,
    "merge-pending": handleMergePending,
    resolving: handleResolving,
    "ci-fixing": handleCiFixing,
    failing: handleFailing,
    merged: handleMerged,
    done: handleDone,
  },
  hookHandlers: defaultHookHandlers,
  workerModel: "sonnet",
  reviewerModel: "opus",
};

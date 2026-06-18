// Holistic-review workflow: a one-time, poller-spawned worker that reviews a
// completed multi-phase task's whole-task cumulative diff for cross-phase
// coherence defects no single per-phase review could see (an abstraction an
// early phase obsoleted, dead code a later phase orphaned, a shared-registry
// collision papered over by keeping every entry, a contract a later phase
// broke). See docs/STATUS.md and the dispatcher in poller-holistic-review.ts.
//
// On the wire this is byte-equivalent to the default workflow: a holistic-review
// worker walks the same working → reviewing → merge-pending → done lifecycle,
// and its fix branch is independently reviewed + CI-gated + merged like any
// worker's. The only divergences are external to this definition: the poller
// spawns it (seeded with the whole-task diff + rationale) instead of the
// operator, it is pinned to opus, and it is excluded from triggering its OWN
// holistic review by the dispatcher's `workflow === "default"` gate.
//
// reviewerModel is pinned to opus so the fix's independent review — the safety
// the fix-and-push decision relies on — is done by the strongest model. The
// holistic worker's own model is pinned at spawn time (the child entry carries
// `model: "opus"`), not here, mirroring how default/grow workers carry a
// per-worker model rather than a workflow workerModel.
import { defaultHookHandlers } from "../hooks/default.js";
import { handleCiFixing } from "../poller-ci-fix.js";
import { handleMergePending, handleMerged } from "../poller-merge.js";
import { handleResolving } from "../poller-resolve.js";
import { handleWorking, handleReviewing } from "../poller-review.js";
import { handleFailing, handleDone } from "../poller-state.js";
import { holisticReviewValidTransitions, type WorkflowDefinition } from "./types.js";

export const holisticReviewWorkflow: WorkflowDefinition = {
  name: "holistic-review",
  validTransitions: holisticReviewValidTransitions,
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
  reviewerModel: "opus",
};

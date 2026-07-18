// Botanist workflow definition: a design worker whose unit of output is a
// design ARTIFACT (a document), not code. A botanist frames a problem, sketches
// alternatives, asks the operator clarifying questions, converges on an
// approach, and publishes the approved artifact to a tracked docs/ path for a
// downstream builder crew to implement. See docs/future/BOTANIST-WORKFLOW.md.
//
// Phase 2 (this file's initial landing) registers the workflow at the data
// layer with the DEFAULT state handlers. The design posture comes from the
// rules inversion (src/rules.ts botanist branch) and the bundled `botanist`
// skill, not from divergent handlers. Because a botanist writes its working
// notes to the git-excluded `.garden/botanist/` directory, its design phases
// produce no tracked commit — so handleWorking never sets pendingReviewAt and
// the worker naturally idles at the human gate with no review/merge activity.
//
// The skip-review merge (a botanist's published docs commit merges without a
// reviewer, since the operator already reviewed the prose at the gate) is a
// Phase 3 divergence in the `working` handler; it is NOT wired here.
import { defaultHookHandlers } from "../hooks/default.js";
import { handleCiFixing } from "../poller-ci-fix.js";
import { handleMergePending, handleMerged } from "../poller-merge.js";
import { handleResolving } from "../poller-resolve.js";
import { handleWorking, handleReviewing } from "../poller-review.js";
import { handleFailing, handleDone } from "../poller-state.js";
import { botanistValidTransitions, type WorkflowDefinition } from "./types.js";

export const botanistWorkflow: WorkflowDefinition = {
  name: "botanist",
  validTransitions: botanistValidTransitions,
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
  // The designer seat: design is judgment-heavy, so a botanist defaults to
  // Opus at max reasoning effort. Both are workflow-level defaults layered
  // beneath a per-spawn --model / --effort (newWorker resolution), so an
  // operator can still designate a cheaper or different designer per run.
  workerModel: "opus",
  workerEffort: "xhigh",
  // No reviewerModel — a botanist branch runs no reviewer (its artifact is
  // prose the operator reviewed directly at the gate).
};

// Designer workflow definition: a design worker whose unit of output is a
// design ARTIFACT (a document), not code. A designer frames a problem, sketches
// alternatives, asks the operator clarifying questions, converges on an
// approach, and publishes the approved artifact to a tracked docs/ path for a
// downstream builder crew to implement. See docs/future/DESIGNER-WORKFLOW.md.
//
// The workflow reuses the DEFAULT state handlers. The design posture comes from
// the rules inversion (src/rules.ts designer branch) and the bundled `designer`
// skill, not from divergent handlers. Because a designer writes its working
// notes to the git-excluded `.garden/designer/` directory, its design phases
// produce no tracked commit — so handleWorking never sets pendingReviewAt and
// the worker naturally idles at the human gate with no review/merge activity.
//
// At publish, the designer commits its artifact to a tracked docs/ path. The
// shared handleWorking honors `skipsReviewMerge` below: once commits are ahead
// of base it routes working → merge-pending directly (no reviewer — the operator
// already reviewed the prose at the gate), after enforcing that the committed
// diff touches only publishable paths. See handleWorking (poller-review.ts).
import { handleCiFixing } from "../poller-ci-fix.js";
import { handleMergePending, handleMerged } from "../poller-merge.js";
import { handleResolving } from "../poller-resolve.js";
import { handleWorking, handleReviewing } from "../poller-review.js";
import { handleFailing, handleDone } from "../poller-state.js";
import { designerValidTransitions, type WorkflowDefinition } from "./types.js";

export const designerWorkflow: WorkflowDefinition = {
  name: "designer",
  validTransitions: designerValidTransitions,
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
  // The designer seat: design is judgment-heavy, so a designer defaults to
  // Opus at max reasoning effort. Both are workflow-level defaults layered
  // beneath a per-spawn --model / --effort (newWorker resolution), so an
  // operator can still designate a cheaper or different designer per run.
  workerModel: "opus",
  workerEffort: "xhigh",
  // No reviewerModel — a designer branch runs no reviewer (its artifact is
  // prose the operator reviewed directly at the gate).
  skipsReviewMerge: true,
};

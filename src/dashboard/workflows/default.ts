// Default workflow definition: reproduces pre-refactor behavior bit-for-bit.
// validTransitions is a literal copy of the old VALID_TRANSITIONS constant
// from poller-state.ts (the constant was removed when transitionState moved
// to registry-routed dispatch). stateHandlers point at the existing handler
// functions — none of those handlers need to change for the foundation
// refactor. Agent hooks are shared outside the workflow state graph.
import { handleCiFixing } from "../poller-ci-fix.js";
import { handleMergePending, handleMerged } from "../poller-merge.js";
import { handleResolving } from "../poller-resolve.js";
import { handleWorking, handleReviewing } from "../poller-review.js";
import { handleFailing, handleDone } from "../poller-state.js";
import { defaultValidTransitions, type WorkflowDefinition } from "./types.js";

export const defaultWorkflow: WorkflowDefinition = {
  name: "default",
  validTransitions: defaultValidTransitions,
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
};

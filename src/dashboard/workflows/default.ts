// Default workflow definition: reproduces pre-refactor behavior bit-for-bit.
// validTransitions is a literal copy of the old VALID_TRANSITIONS constant
// from poller-state.ts (the constant was removed when transitionState moved
// to registry-routed dispatch). stateHandlers and hookHandlers point at the
// existing handler functions — none of those handlers need to change for
// the foundation refactor.
import * as hooksDefault from "../hooks/default.js";
import { handleMergePending } from "../poller-merge.js";
import { handleResolving } from "../poller-resolve.js";
import { handleWorking, handleReviewing } from "../poller-review.js";
import { handleFailing, handleMerged, handleDone } from "../poller-state.js";
import type { WorkflowDefinition } from "./types.js";

// hookHandlers is a getter rather than a captured value because hooks/default.ts
// participates in a module-init cycle (header.ts <-> hooks/default.ts, plus the
// indirect path hooks/default.ts -> create.ts -> poller.ts -> workflows/index.ts
// -> workflows/default.ts). If we captured the value at object-literal time,
// hooksDefault.defaultHookHandlers would still be undefined and every Claude
// Code hook invocation would throw "Cannot read properties of undefined
// (reading 'onStop')". The getter resolves the live binding lazily, after
// all module init has completed.
export const defaultWorkflow: WorkflowDefinition = {
  name: "default",
  validTransitions: {
    working:         ["reviewing"],
    reviewing:       ["merge-pending", "working", "failing"],
    "merge-pending": ["merged", "done", "resolving", "working"],
    resolving:       ["merge-pending", "working", "failing"],
    failing:         ["working"],
    merged:          ["working", "done"],
    done:            ["working"],
  },
  stateHandlers: {
    working: handleWorking,
    reviewing: handleReviewing,
    "merge-pending": handleMergePending,
    resolving: handleResolving,
    failing: handleFailing,
    merged: handleMerged,
    done: handleDone,
  },
  get hookHandlers() { return hooksDefault.defaultHookHandlers; },
};

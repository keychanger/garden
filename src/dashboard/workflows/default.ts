// Default workflow definition: reproduces pre-refactor behavior bit-for-bit.
// validTransitions is a literal copy of the old VALID_TRANSITIONS constant
// from poller-state.ts (the constant was removed when transitionState moved
// to registry-routed dispatch). stateHandlers and hookHandlers point at the
// existing handler functions — none of those handlers need to change for
// the foundation refactor.
//
// hookHandlers is a captured value (no getter). The init cycle that used to
// force the getter (workflows/default.ts -> hooks/default.ts -> header.ts ->
// workflows/index.ts -> workflows/default.ts) was eliminated by extracting
// handleClaudeHook out of header.ts into hook-dispatcher.ts, so header.ts
// no longer imports from workflows/. The bundled regression test
// (test/integration/claude-hook-bundled.real.test.ts) now runs as part of
// the default `npm test` and gates this on every reviewer pass.
import { defaultHookHandlers } from "../hooks/default.js";
import { handleCiFixing } from "../poller-ci-fix.js";
import { handleMergePending } from "../poller-merge.js";
import { handleResolving } from "../poller-resolve.js";
import { handleWorking, handleReviewing } from "../poller-review.js";
import { handleFailing, handleMerged, handleDone } from "../poller-state.js";
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
  hookHandlers: defaultHookHandlers,
};

// Default workflow definition: reproduces pre-refactor behavior bit-for-bit.
// validTransitions is a literal copy of the old VALID_TRANSITIONS constant
// from poller-state.ts (the constant was removed when transitionState moved
// to registry-routed dispatch). stateHandlers points at the existing handler
// functions in poller-state/review/merge/resolve — none of those handlers
// need to change for the foundation refactor.
//
// hookHandlers is stubbed for Phase 3. handleClaudeHook in header.ts does
// not yet dispatch through the registry, so the stubs are unreachable.
// Phase 4 wires up the real defaultHookHandlers.
import { handleMergePending } from "../poller-merge.js";
import { handleResolving } from "../poller-resolve.js";
import { handleWorking, handleReviewing } from "../poller-review.js";
import { handleFailing, handleMerged, handleDone } from "../poller-state.js";
import type { WorkflowDefinition, WorkflowHookHandlers } from "./types.js";

const phase4Stub = (event: string): WorkflowHookHandlers[keyof WorkflowHookHandlers] => () => {
  throw new Error(
    `defaultWorkflow.hookHandlers.${event} not yet wired (Phase 4 of WORKFLOWS.md). `
    + "If you see this thrown, handleClaudeHook in header.ts is dispatching through the registry "
    + "before defaultHookHandlers has been implemented.",
  );
};

const stubbedHookHandlers: WorkflowHookHandlers = {
  onSessionStart: phase4Stub("onSessionStart"),
  onUserPromptSubmit: phase4Stub("onUserPromptSubmit"),
  onStop: phase4Stub("onStop"),
  onNotification: phase4Stub("onNotification"),
  onPreToolUse: phase4Stub("onPreToolUse"),
  onPostToolUse: phase4Stub("onPostToolUse"),
};

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
  hookHandlers: stubbedHookHandlers,
};

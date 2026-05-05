// Workflow definition types. A WorkflowDefinition is a data record that
// describes how a worker's lifecycle is processed: which state machine
// transitions are valid, which handlers run for each state, and how the
// worker's Claude Code hooks are dispatched. See WORKFLOWS.md Component 4.
//
// The default workflow (workflows/default.ts) reproduces the pre-refactor
// behavior bit-for-bit. Future workflows declare their own definitions
// without touching the dispatcher in poller.ts.
import type { PrState, WorkerEntry } from "../registry.js";

export type StateHandler = (
  projectName: string,
  projectPath: string,
  baseBranch: string,
  entry: WorkerEntry,
) => boolean;

// Thin context passed to hook handlers. The default handler builds a richer
// accumulator pattern privately — that stays out of this type and is an
// implementation detail of defaultHookHandlers in hooks/default.ts.
export interface HookContext {
  event: string;
  /** Raw JSON parsed from stdin. Currently the only field consumed is
   *  `source?: string` (sessionstart variants). Other fields may be
   *  present for forward-compat. */
  input: Record<string, unknown>;
  workerInfo: { name: string; project: string; entry: WorkerEntry } | null;
}

export type HookMethod = (ctx: HookContext) => void;

export interface WorkflowHookHandlers {
  onSessionStart: HookMethod;
  onUserPromptSubmit: HookMethod;
  onStop: HookMethod;
  onNotification: HookMethod;
  onPreToolUse: HookMethod;
  onPostToolUse: HookMethod;
}

export interface WorkflowDefinition {
  name: string;
  /** Per-state valid transitions. Consulted by transitionState to warn on
   *  illegal transitions. The default workflow's table is the literal copy
   *  of the pre-refactor VALID_TRANSITIONS constant. */
  validTransitions: Record<PrState, PrState[]>;
  /** Dispatched by pollWorker. A state with no handler is a config bug —
   *  pollWorker logs a warning and no-ops. The default workflow has a
   *  handler for every PrState; alternate workflows may omit states they
   *  don't use. */
  stateHandlers: Partial<Record<PrState, StateHandler>>;
  /** Dispatched by handleClaudeHook in header.ts. The default workflow's
   *  handlers live in hooks/default.ts. */
  hookHandlers: WorkflowHookHandlers;
}

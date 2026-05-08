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
  /** Dispatched by pollWorker on the worker's current prState. Required
   *  to cover every PrState — the type forbids omissions, so an incomplete
   *  workflow is a TypeScript error rather than a runtime warning. A
   *  workflow that does not use a particular state should still register
   *  a handler that returns `false` (no-op) so the contract stays
   *  exhaustive and the dispatcher needs no defensive runtime check. */
  stateHandlers: Record<PrState, StateHandler>;
  /** Dispatched by handleClaudeHook in hook-dispatcher.ts. The default
   *  workflow's handlers live in hooks/default.ts. */
  hookHandlers: WorkflowHookHandlers;
  /** Default model for worker iterations. When set, the worker bootstrap
   *  passes `--model <workerModel>` to claude unless the worker entry
   *  carries a per-worker override (`WorkerEntry.workerModel`). When
   *  unset (default workflow), no `--model` flag is passed and claude
   *  uses the account's default model. Trellis sets this to "sonnet"
   *  per WORKFLOWS.md "Model selection and budget". */
  workerModel?: "opus" | "sonnet";
  /** Model used by the workflow's reviewer. When set, `launchHeadlessAgent`
   *  passes `--model <reviewerModel>` to the reviewer claude. Not
   *  overridable per worker — see WORKFLOWS.md Invariant 10 ("reviewer
   *  quality is non-negotiable"). When unset, no `--model` flag is
   *  passed and claude uses the account default. */
  reviewerModel?: "opus" | "sonnet";
}

// Per-workflow valid-transitions tables. Lives at this layer (not on the
// individual WorkflowDefinition objects in default.ts / trellis.ts) so
// poller-state.ts can read it via getValidTransitions() without pulling
// in workflows/{default,trellis}.ts. The latter import handler functions
// from poller-state.ts; routing transitionState through workflows/index.ts
// would close a module-init cycle (poller-state → workflows/index →
// workflows/default → poller-state) that — while currently safe at load
// time because no top-level call reaches getWorkflow — has bitten this
// codebase before in a structurally identical shape (see the
// hook-dispatcher.ts extraction in 2026-04). Keeping this constant in a
// leaf module pre-empts the next regression.
export const defaultValidTransitions: Record<PrState, PrState[]> = {
  working:         ["reviewing"],
  reviewing:       ["merge-pending", "working", "failing"],
  "merge-pending": ["merged", "done", "resolving", "working"],
  resolving:       ["merge-pending", "working", "failing"],
  failing:         ["working"],
  merged:          ["working", "done"],
  done:            ["working"],
};

// Trellis presently uses the same table as default. Kept as a separate
// constant (rather than aliasing) so the two can diverge later without
// fighting the type system or callers.
export const trellisValidTransitions: Record<PrState, PrState[]> = defaultValidTransitions;

// Grow uses the same table as default. Same rationale as trellis — kept as
// its own constant so it can diverge later (e.g. if grow grows a new
// state) without fighting the type system or callers.
export const growValidTransitions: Record<PrState, PrState[]> = defaultValidTransitions;

export function getValidTransitions(workflowName: string): Record<PrState, PrState[]> {
  if (workflowName === "trellis") return trellisValidTransitions;
  if (workflowName === "grow") return growValidTransitions;
  return defaultValidTransitions;
}

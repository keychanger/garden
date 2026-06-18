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

// Workflow handlers are keyed by garden's normalized lifecycle events, not
// the harness's native hook names (docs/MULTI-MODEL.md "Layer 2"). The
// dispatcher translates wire events to these: Claude Code's Stop →
// onTurnEnded, UserPromptSubmit → onPromptSubmitted, PostToolUse →
// onToolActivity, and both Notification and the PreToolUse matchers →
// onBlockedOnOperator (they signal the same thing: the agent is blocked on
// operator input mid-turn). A future harness adapter feeds the same methods
// from its own event mechanism without the workflow layer changing.
export interface WorkflowHookHandlers {
  onSessionStart: HookMethod;
  onPromptSubmitted: HookMethod;
  onTurnEnded: HookMethod;
  onBlockedOnOperator: HookMethod;
  onToolActivity: HookMethod;
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
   *  carries a per-worker override (`WorkerEntry.trellis.workerModel`).
   *  When unset (default workflow), no `--model` flag is passed and claude
   *  uses the account's default model. An opaque string, not an Anthropic
   *  alias union: aliases ("opus"/"sonnet") resolve through the provider's
   *  modelMap for provider-backed projects, and arbitrary concrete model
   *  ids pass through to the backend (docs/MULTI-MODEL.md "Layer 2").
   *  Trellis sets "sonnet" per WORKFLOWS.md "Model selection and budget". */
  workerModel?: string;
  /** Model used by the workflow's reviewer. When set, `launchHeadlessAgent`
   *  passes `--model <reviewerModel>` to the reviewer claude. Not
   *  overridable per worker — see WORKFLOWS.md Invariant 10 ("reviewer
   *  quality is non-negotiable"). When unset, no `--model` flag is
   *  passed and claude uses the account default. */
  reviewerModel?: string;
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
  "merge-pending": ["merged", "done", "resolving", "ci-fixing", "working", "failing"],
  resolving:       ["merge-pending", "working", "failing"],
  // ci-fixing: agent pushed FIXED → merge-pending re-runs the CI gate on the
  // new SHA. Worker pushed mid-fix or agent FAILED → working. Budget
  // exhausted, push verification failed, or unrecoverable → failing with
  // failingReason="ci".
  "ci-fixing":     ["merge-pending", "working", "failing"],
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

// Holistic-review workers walk the default lifecycle (working → reviewing →
// merge-pending → done). Their branch is reviewed and merged exactly like any
// worker's; the only divergence from default is how they are spawned (by the
// poller, seeded with the whole-task diff) and that they never themselves
// trigger another holistic review (excluded by the workflow !== "default" gate).
export const holisticReviewValidTransitions: Record<PrState, PrState[]> = defaultValidTransitions;

export function getValidTransitions(workflowName: string): Record<PrState, PrState[]> {
  if (workflowName === "trellis") return trellisValidTransitions;
  if (workflowName === "grow") return growValidTransitions;
  if (workflowName === "holistic-review") return holisticReviewValidTransitions;
  return defaultValidTransitions;
}

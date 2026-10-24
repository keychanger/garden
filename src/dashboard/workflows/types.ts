// Workflow definition types. A WorkflowDefinition is a data record that
// describes how a worker's poller lifecycle is processed: which state machine
// transitions are valid and which handlers run for each state. Agent hooks are
// shared lifecycle plumbing and stay outside this graph so the hot hook bundle
// does not retain poller handlers. See WORKFLOWS.md Component 4.
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

// Thin context passed to hook handlers. The shared handler builds a richer
// accumulator pattern privately — that stays out of this type and is an
// implementation detail of workerHookHandlers in hooks/default.ts.
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
// onToolActivity, the PreToolUse Bash matcher → onToolStarting, and both
// Notification and the other PreToolUse matchers → onBlockedOnOperator (they
// signal the same thing: the agent is blocked on operator input mid-turn). A future harness adapter feeds the same methods
// from its own event mechanism without the workflow layer changing.
export interface WorkflowHookHandlers {
  onSessionStart: HookMethod;
  onPromptSubmitted: HookMethod;
  onTurnEnded: HookMethod;
  onBlockedOnOperator: HookMethod;
  onToolActivity: HookMethod;
  onToolStarting: HookMethod;
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
  /** Default model for the workflow's workers. When set, the worker bootstrap
   *  passes `--model <workerModel>` to claude unless the spawn pins its own
   *  (`--model`, persisted as `WorkerEntry.model`).
   *  When unset (default workflow), no `--model` flag is passed and claude
   *  uses the account's default model. An opaque string, not an Anthropic
   *  alias union: aliases ("opus"/"sonnet") resolve through the provider's
   *  modelMap for provider-backed projects, and arbitrary concrete model
   *  ids pass through to the backend (docs/MULTI-MODEL.md "Layer 2"). */
  workerModel?: string;
  /** Model used by the workflow's reviewer. When set, `launchHeadlessAgent`
   *  passes `--model <reviewerModel>` to the reviewer claude. Not
   *  overridable per worker — see WORKFLOWS.md Invariant 10 ("reviewer
   *  quality is non-negotiable"). When unset, no `--model` flag is
   *  passed and claude uses the account default. */
  reviewerModel?: string;
  /** Default reasoning effort for the worker seat (one of
   *  WORKER_EFFORT_LEVELS — rendered as claude-code's `--effort <level>`).
   *  Sits one layer beneath a per-spawn `--effort`, exactly as `workerModel`
   *  sits beneath `--model` (per-spawn > project > this workflow default >
   *  account default). Consumed by newWorker's effort resolution. When unset
   *  (default/grow), no workflow-level effort default applies.
   *  Designer sets "xhigh": design is judgment-heavy. */
  workerEffort?: string;
  /** When true, the worker's branch merges WITHOUT a reviewer. handleWorking
   *  routes working → merge-pending directly (never launching a review) once
   *  commits are ahead of base, after enforcing that the committed diff touches
   *  only publishable paths. Used by designer: its artifact is prose the
   *  operator already reviewed at the human gate, so there is no code to
   *  critique. The merge/CI gate still applies. When unset (default/grow),
   *  the normal review-then-merge lifecycle runs. */
  skipsReviewMerge?: boolean;
}

// Per-workflow valid-transitions tables. Lives at this layer (not on the
// individual WorkflowDefinition objects in default.ts / grow.ts) so
// poller-state.ts can read it via getValidTransitions() without pulling
// in the workflows/ definitions. Those import handler functions
// from poller-state.ts; routing transitionState through workflows/index.ts
// would close a module-init cycle (poller-state → workflows/index →
// workflows/default → poller-state) that — while currently safe at load
// time because no top-level call reaches getWorkflow — has bitten this
// codebase before in a structurally identical shape (see the
// hook-dispatcher.ts extraction in 2026-04). Keeping this constant in a
// leaf module pre-empts the next regression.
export const defaultValidTransitions: Record<PrState, PrState[]> = {
  working:         ["reviewing", "failing"],
  // reviewing → done is the holistic final-review CLEAN path: the interposed
  // whole-task review found nothing to change, so the worker finalizes without
  // a merge (see poller-holistic-review.ts).
  reviewing:       ["merge-pending", "working", "failing", "done"],
  "merge-pending": ["merged", "done", "resolving", "ci-fixing", "working", "failing"],
  resolving:       ["merge-pending", "working", "failing"],
  // ci-fixing: agent pushed FIXED → merge-pending re-runs the CI gate on the
  // new SHA. Failed verification retries in ci-fixing; a worker push mid-fix
  // returns to working. Budget exhausted or unrecoverable → failing with
  // failingReason="ci".
  "ci-fixing":     ["ci-fixing", "merge-pending", "working", "failing"],
  failing:         ["working"],
  merged:          ["working", "done"],
  // done → reviewing is the holistic final-review interposition: a multi-phase
  // worker that reached `done` gets one aggregated whole-task review before it
  // truly finishes (see poller-holistic-review.ts). done → working is the
  // re-open-on-new-commits path.
  done:            ["working", "reviewing"],
};

// Grow uses the same table as default, kept as its own constant so it can
// diverge later (e.g. if grow grows a new state) without fighting the type
// system or callers.
export const growValidTransitions: Record<PrState, PrState[]> = defaultValidTransitions;

// Designer skips review: a designer goes working → merge-pending directly (no
// reviewer — its artifact is prose the operator reviewed at the gate), or
// working → failing on a writeable-path violation (it committed code, not just
// docs). It never enters `reviewing`. Every other state reuses default's edges
// (a docs branch can still hit a rebase conflict → resolving, red CI →
// ci-fixing). `done → reviewing` stays reachable-in-table but unused.
export const designerValidTransitions: Record<PrState, PrState[]> = {
  ...defaultValidTransitions,
  working: ["merge-pending", "failing", "done"],
};

// Planner skips review for the same structural reason as designer: its
// deliverable is a bead DAG written to the project's bd store, never a commit
// — with zero commits ahead of base it idles after finishing, and a planner
// that somehow commits rides the same skip-review boundary check (anything
// outside docs/ parks it in `failing`). Same table shape as designer.
export const plannerValidTransitions: Record<PrState, PrState[]> = {
  ...defaultValidTransitions,
  working: ["merge-pending", "failing", "done"],
};

export function getValidTransitions(workflowName: string): Record<PrState, PrState[]> {
  if (workflowName === "grow") return growValidTransitions;
  if (workflowName === "designer") return designerValidTransitions;
  if (workflowName === "planner") return plannerValidTransitions;
  return defaultValidTransitions;
}

// Whether the workflow's table holds the move. An unset prState reads as
// `working`. A state this build does not know holds no moves: the registry
// keeps such a value as written (a newer build's state read after a
// rollback), and the own-key check stops a value such as "constructor" from
// reading an Object.prototype member as its row.
export function isValidTransition(
  workflowName: string | undefined,
  from: PrState | undefined,
  to: PrState,
): boolean {
  const table = getValidTransitions(workflowName ?? "default");
  const state = from ?? "working";
  return Object.hasOwn(table, state) && table[state].includes(to);
}

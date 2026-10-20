# Workflows

This document covers (a) the workflow architecture — the registry that lets
garden host more than one worker lifecycle behind a single dispatcher — and
(b) the spec for each workflow that ships today. The `default` workflow is
the standard review/merge pipeline and is described inline below as the
foundation. The grow, designer and planner workflows and the holistic review
each have their own section. **For the grow workflow, if the code disagrees
with this document, the code is wrong.** The architecture section is
descriptive of completed work; the grow section is authoritative.

For the operator-facing how-to on adding a new workflow, see `AGENTS.md`
§ "Adding a new workflow". This document is the architectural reference and
the grow spec.

## Workflow architecture

Design document for the architectural lift that prepared garden's worker
lifecycle to host multiple workflows. The deliverable was a refactor: existing
behavior is preserved bit-for-bit, but four extension points (headless-agent
launch, verdict parsing, prompt composition, workflow definitions) have been
extracted into reusable primitives. No new workflows shipped as part of that
refactor itself; the workflows described later in this document were
registered against the surface afterwards.

**Status**: foundation complete. The code matches this section. Adding a new
workflow is a data-only change plus optional new prompt sections; the
dispatcher in `poller.ts` and the hook dispatcher in `hook-dispatcher.ts` do
not need edits.

### Goal

Lift the worker lifecycle so that "the way a worker is reviewed, what its state
machine looks like, and how its hooks behave" becomes data on a workflow
definition rather than hard-coded structure across `poller-*.ts`, `prompts.ts`,
and `header.ts`. The end state is a single named workflow, `default`, that
reproduces today's behavior exactly. Adding a second workflow becomes a
data change plus a new prompt composition, not a fork in the state machine.

### Non-goals

- No new workflow kinds in the foundation refactor itself. Later workflows
  build on the same primitives without modifying them.
- No new CLI surface in the foundation. `garden workers new --workflow X` was
  deferred and arrived with the first downstream workflow.
- No worker-launch refactor. `buildWorktreeBootstrapScript` and the
  interactive Claude launch in `create.ts` are untouched. The headless
  agent primitive covers reviewer and resolver only.
- No registry-shape changes beyond a single optional `workflow?: string`
  field. The vestigial `role` and `parentWorker` fields are left alone.
- No spec-marker promotion of the architecture itself. The architecture
  section is descriptive of code that already exists and matches it; the
  grow section is authoritative spec and carries the sentinel.

### Background

Three Claude-process kinds run today: workers (interactive), reviewers
(headless `claude -p` reading from a prompt file, writing to a result file),
and resolvers (headless `claude -p`, narrower scope). Reviewers and resolvers
share a near-identical launch shape (`poller-review.ts:413-422` ≈
`poller-resolve.ts:73-86`): same FIFO wiring, same tmux-new-window pattern,
same prompt-file/result-file convention, same `GARDEN_REVIEWER=1` env flag,
same timeout-poke scheduling. They differ in prompt content and verdict
vocabulary.

The state machine is a single closed union (`PrState` in `registry.ts:20`)
with one literal transition table (`VALID_TRANSITIONS` in `poller-state.ts:23`)
and a single dispatcher in `poller.ts:85-104`. Adding a new state today means
editing every file that switches on `PrState`.

Prompt construction is monolithic: `buildReviewPrompt` and `buildResolvePrompt`
in `prompts.ts` each push 30+ section strings into one array and return one
joined string. Reuse happens only at the helper-function level
(`gatherPromptData`, `findSpecFiles`, `readDocSections`).

The verdict layer is implicit: `parseReviewResult` (`poller-review.ts:477`)
hard-codes `CLEAN|FIXED|FAILED`. The resolver has its own near-duplicate
parser using `DONE|FAILED`. There is no shared "structured-output protocol"
for headless agents.

### Design overview

Four new primitives, each with a clean contract:

1. **Headless agent primitive** (`src/dashboard/headless-agent.ts`) — one
   function that launches a one-shot `claude -p` in a hidden tmux window,
   given a prompt, result path, env, cwd, FIFO, and timeout. Reviewer and
   resolver collapse to two thin callers.
2. **Verdict parsing** (`src/dashboard/verdict.ts`) — one type-parameterized
   function that takes raw output and a verdict vocabulary and returns
   `{ verdict, body }` or `null`. The two existing parsers collapse.
3. **Prompt composition** (`src/dashboard/prompt-compose.ts`) — a
   `PromptSection` interface and `composePrompt` function. Sections are
   named, ordered, individually testable, and can opt out by returning
   null. `prompts.ts` shrinks to a list of section instances and two
   compositions.
4. **Workflow definition + registry** (`src/dashboard/workflows/`) — a
   `WorkflowDefinition` shape (state machine + state handlers + hook
   behavior) and a `getWorkflow(name)` lookup. Adds `workflow?: string`
   to `WorkerEntry`. `pollWorker`, `transitionState`, and the Claude hook
   handler dispatch through the workflow.

The four primitives compose: a workflow definition holds references to
prompt compositions and verdict vocabularies; prompt compositions are built
from sections; agents launched by the workflow's state handlers go through
`launchHeadlessAgent` and use `parseLastLineVerdict`. None of the primitives
have hidden coupling — each can be unit-tested in isolation.

### Component 1 — Headless agent primitive

**Module**: `src/dashboard/headless-agent.ts` (new).

**Public surface**:

```ts
export interface HeadlessAgentLaunchOptions {
  /** Working directory for the claude process (typically the worktree). */
  cwd: string;
  /** Project sandbox policy used to restore missing Claude runtime settings. */
  project: ProjectConfig;
  /** Hidden tmux window name. Killed first if it already exists. */
  windowName: string;
  /** Prompt content. Written to promptFile. */
  prompt: string;
  /** Where to write the prompt file (caller picks the path). */
  promptFile: string;
  /** Where claude writes stdout+stderr. Cleaned before launch. */
  resultFile: string;
  /** Validated review-role harness, model, environment, and execution policy. */
  launchPlan: HeadlessLaunchPlan;
  /** Additional env vars set inline before the claude invocation. */
  envVars?: Record<string, string>;
  /** FIFO poked when the agent exits. Caller owns its lifecycle. */
  signalFifo: string;
  /** Caller-provided callback invoked after launch — typically schedules
   *  a delayed wake-up so the workflow's state handler can detect timeout
   *  on the next poll cycle. */
  onLaunched?: () => void;
}

export interface HeadlessAgentLaunchResult {
  windowName: string;
  /** Caller can record this on the registry entry as the launch baseline. */
  launchedAt: number;
}

export function launchHeadlessAgent(
  opts: HeadlessAgentLaunchOptions,
): HeadlessAgentLaunchResult;
```

**Contract**:

Before the launch sequence, Claude headless agents restore a missing
garden settings file (`claudeSettingsPath(cwd)`, passed with `--settings`) with the
Claude runtime installer and the supplied project config. This gives resurrected Codex worktrees the sandbox needed for autonomous
review commands. Existing settings are preserved; installation failure aborts
launch. Codex headless agents keep their own launch-time permission policy.

1. Writes `prompt` to `promptFile` atomically.
2. Removes `resultFile` if present (stale result from a previous run).
3. Kills `windowName` if it exists.
4. Creates a hidden tmux window in the dashboard session, working directory
   `cwd`, running:
   ```
   <inline-env-vars> <launchPlan.envPrefix>claude -p --permission-mode acceptEdits < <promptFile> > <resultFile> 2>&1; \
     [ -p <signalFifo> ] && (echo > <signalFifo>) 2>/dev/null
   ```
5. Calls `onLaunched()` if provided.
6. Returns `{ windowName, launchedAt: Date.now() }`.

The primitive does **not**:
- Touch the registry. Callers update `WorkerEntry` (e.g. `reviewWindowName`,
  `reviewStartedAt`) themselves.
- Enforce timeouts. Callers schedule a wake-up via `onLaunched` and check
  elapsed time on the next poll cycle. This is a deliberate
  separation-of-concerns: launch is synchronous; lifecycle is event-driven.
- Parse the result. Callers read `resultFile` separately and pass the
  output to `parseLastLineVerdict`.

**Migrations**:
- `launchReview` in `poller-review.ts:365-447` shrinks to a caller of
  `launchHeadlessAgent` plus the workflow-specific bookkeeping
  (computing `preReviewSha`, `launchSha`, calling `transitionState`).
- `launchResolver` in `poller-resolve.ts:45-108` shrinks identically.
- The `GARDEN_REVIEWER=1` flag becomes `envVars: { GARDEN_REVIEWER: "1" }`.

**Tests** (`test/headless-agent.test.ts`):
- Writes prompt to disk before launching the window.
- Removes a pre-existing result file before launching.
- Kills a pre-existing window with the same name.
- Issues exactly one `tmux new-window` with the expected `cwd`, `windowName`,
  and shell command.
- Calls `onLaunched` exactly once after the launch.
- Returns a `launchedAt` timestamp within ~10ms of `Date.now()`.

Tests use the existing `mockTmux` pattern in `test/helpers.ts`.

### Component 2 — Verdict parsing

**Module**: `src/dashboard/verdict.ts` (new).

**Public surface**:

```ts
export interface VerdictResult<V extends string> {
  verdict: V;
  /** Everything before the verdict line, trimmed. Empty string allowed. */
  body: string;
}

export interface ParseVerdictOptions {
  /** How many trailing lines to scan for the verdict. Defaults to 20
   *  (matches the current reviewer's `VERDICT_SCAN_LINES`). The resolver
   *  caller passes 1 to preserve its current "last non-empty line only"
   *  behavior. */
  scanLines?: number;
}

export function parseLastLineVerdict<V extends string>(
  output: string,
  vocabulary: readonly V[],
  options?: ParseVerdictOptions,
): VerdictResult<V> | null;
```

**Contract**:

1. Splits `output` by newlines.
2. Walks backwards from the last non-empty line up to `scanLines` lines.
3. For each line, trims surrounding whitespace and matches against
   `/^([A-Za-z_]+)(?:[.\s!]*$|\s*[-—–:,])/` (the line must START with the
   verdict token, followed by either end-of-line — optionally after
   trailing punctuation/whitespace — or a separator: em-dash, en-dash,
   hyphen, colon, or comma. This accepts both the bare token and the
   decorated form reviewers actually emit, e.g. `CLEAN — ready to merge`;
   the separator requirement keeps prose that merely opens with a vocab
   word, like `CLEAN code is important.`, from matching). If the captured
   token uppercased is in `vocabulary`, that line is the verdict line;
   everything before it (joined, trimmed) is the body.
4. Returns `{ verdict, body }` or `null` if no match in the scan window.

The function is pure, type-parameterized so callers get type-safe verdict
discriminants, and has no I/O. The vocabulary is read-only at the type
level so workflows can declare it `as const`.

**Migrations**:
- `parseReviewResult` in `poller-review.ts:477` becomes
  `parseLastLineVerdict(output, ["CLEAN", "FIXED", "FAILED"] as const)`
  (defaults to a 20-line scan window, matching today).
- The resolver parser becomes
  `parseLastLineVerdict(output, ["DONE", "FAILED"] as const, { scanLines: 1 })`
  — the resolver currently parses only the last non-empty line, so the
  caller pins the window to 1 to preserve that.
- Both call sites keep the `body || "No additional comments."` fallback;
  the primitive returns the trimmed body verbatim, leaving the empty-body
  substitution to callers.

**Tests** (`test/verdict.test.ts`):
- Returns the verdict and the body when the verdict is on the last line.
- Returns null when output is empty or whitespace-only.
- Returns null when no token in the scan window matches the vocabulary.
- Honors `scanLines`: a verdict outside the window is not found.
- Case-insensitive on input but vocabulary match is case-sensitive (matches
  current behavior — current code uppercases the matched token before
  comparison).
- Body is trimmed; trailing blank lines and whitespace are dropped.
- A vocabulary of one element works (degenerate case, useful for future
  one-shot verdicts).

### Component 3 — Prompt composition

**Module**: `src/dashboard/prompt-compose.ts` (new).

**Public surface**:

```ts
export interface PromptContext {
  projectName: string;
  projectPath: string;
  baseBranch: string;
  entry: WorkerEntry;
  /** Cached/derived data, gathered once at the top of the composition. */
  data: PromptData;
  /** Counter for sections that need a step number. Sections that don't
   *  participate in numbering simply don't call this. */
  nextStep(): number;
}

export interface PromptData {
  diff: string;
  commitSummary: string;
  branchName: string;
  rules: string;
  checksCommand: string | undefined;
  changedFiles: string[];
  docSections: string[];
  testSections: string[];
  specFiles: string[];
}

export interface PromptSection {
  /** Identifier for ordering, deduplication, and override. */
  name: string;
  /** Returns the rendered text of this section, or null to omit it. */
  render(ctx: PromptContext): string | null;
}

export function gatherPromptContext(
  projectName: string,
  projectPath: string,
  baseBranch: string,
  entry: WorkerEntry,
): PromptContext | null;

export function composePrompt(
  sections: readonly PromptSection[],
  ctx: PromptContext,
): string;
```

**Contract**:

1. `gatherPromptContext` performs the I/O once: reads diff, commits, rules,
   docs, tests, spec files. Returns null if the diff cannot be read.
2. `composePrompt` calls each section's `render` in order, drops nulls,
   and joins with single blank lines.
3. `nextStep` is a closure-state counter on `PromptContext`. The first call
   returns 1, the next returns 2, etc. Sections that don't participate
   in numbering never call it; numbering is a section-side decision.

**Sections**:

`src/dashboard/prompts.ts` becomes the home of named section instances
plus the two compositions. Each existing piece of `buildReviewPrompt`
becomes a section:

```ts
export const reviewIntroSection: PromptSection = { name: "intro", render: ... };
export const reviewSpecWarningSection: PromptSection = { name: "spec-warning", render: ... };
export const reviewRebaseStepSection: PromptSection = { name: "rebase-step", render: ... };
export const reviewChecksStepSection: PromptSection = { name: "checks-step", render: ... };
export const reviewCodeReviewStepSection: PromptSection = { name: "code-review-step", render: ... };
export const reviewBranchInfoSection: PromptSection = { name: "branch-info", render: ... };
export const reviewCommitsSection: PromptSection = { name: "commits", render: ... };
export const reviewRulesSection: PromptSection = { name: "rules", render: ... };
export const reviewDiffSection: PromptSection = { name: "diff", render: ... };
export const reviewDocsSection: PromptSection = { name: "docs", render: ... };
export const reviewTestsSection: PromptSection = { name: "tests", render: ... };
export const reviewVerdictFormatSection: PromptSection = { name: "verdict-format", render: ... };

export const reviewSections: readonly PromptSection[] = [
  reviewIntroSection,
  reviewSpecWarningSection,
  reviewRebaseStepSection,
  reviewChecksStepSection,
  reviewCodeReviewStepSection,
  reviewBranchInfoSection,
  reviewCommitsSection,
  reviewRulesSection,
  reviewDiffSection,
  reviewDocsSection,
  reviewTestsSection,
  reviewVerdictFormatSection,
];
```

`buildReviewPrompt` becomes:

```ts
export function buildReviewPrompt(...args): string | null {
  const ctx = gatherPromptContext(...args);
  if (!ctx) return null;
  return composeWithinCeiling(reviewSections, ctx,
    () => getDiffStat(wtPath, `origin/${baseBranch}...HEAD`));
}
```

**A review builder composes through `composeWithinCeiling`, not bare
`composePrompt`.** It measures the assembled prompt against
`MAX_REVIEW_PROMPT_BYTES` and, when it busts, recomposes once with the inline
diff replaced by its `git diff --stat` summary (the third argument is a thunk,
so the extra git call only happens on that path) — the diff sections render
paging instructions instead, and the reviewer, which runs inside the worktree
with a shell, reads the delta itself. A builder that calls `composePrompt`
directly reverts its workflow to the old hard wall: a branch too large to inline
parks the worker in `failing` with `oversized-diff` and gets no review at all.
Non-review builders (the resolver, which carries no diff) use `composePrompt`.

`buildResolvePrompt` similarly becomes a smaller list of resolve-specific
sections (some shared with review, e.g. branch info; some unique, e.g.
the resolve-only verdict-format section with `DONE|FAILED`).

**Output equivalence** is the acceptance criterion. A snapshot test
captures `buildReviewPrompt` output for a fixed `WorkerEntry` and
project state before and after the refactor; the strings must be
character-equal. Same for `buildResolvePrompt`.

**Tests** (`test/prompt-compose.test.ts`):
- `composePrompt` joins section outputs with single blank lines.
- A section returning null is omitted (no leading/trailing blank
  lines from the omission).
- `nextStep` counts up across sections that call it; sections that
  don't call it don't perturb the count.
- Section ordering is preserved.

`test/prompts.test.ts` (existing) gets extended with snapshot tests
for both `buildReviewPrompt` and `buildResolvePrompt` to lock the
character-equal output during the refactor.

### Component 4 — Workflow definition and registry

**Modules**:
- `src/dashboard/workflows/types.ts` (new) — type definitions only.
- `src/dashboard/workflows/default.ts` (new) — the default workflow.
- `src/dashboard/workflows/index.ts` (new) — registry.

**Public surface**:

```ts
// types.ts
export type StateHandler = (
  projectName: string,
  projectPath: string,
  baseBranch: string,
  entry: WorkerEntry,
) => boolean;

export interface WorkflowHookHandlers {
  // Keyed by garden's normalized lifecycle events, not the harness's
  // native hook names (docs/MULTI-MODEL.md "Layer 2").
  onSessionStart: (ctx: HookContext) => HookAction;
  onPromptSubmitted: (ctx: HookContext) => HookAction;
  onTurnEnded: (ctx: HookContext) => HookAction;
  onBlockedOnOperator: (ctx: HookContext) => HookAction;
  onToolActivity: (ctx: HookContext) => HookAction;
  onToolStarting: (ctx: HookContext) => HookAction;
}

export interface WorkflowDefinition {
  name: string;
  /** Per-state valid transitions for transitionState() validation. */
  validTransitions: Record<PrState, PrState[]>;
  /** Dispatched by pollWorker on the worker's current prState. Required —
   *  every PrState must have a handler. Workflows that don't use a state
   *  register a no-op (`() => false`); the type contract leaves the
   *  dispatcher in poller.ts free of defensive runtime guards. */
  stateHandlers: Record<PrState, StateHandler>;
}
```

`HookContext` and `HookAction` are extracted from the current Claude hook
handler in `src/dashboard/header.ts`. The shape is whatever the current
code already builds; this refactor just names it.

`WorkflowHookHandlers` is the shared normalized hook contract, not a field on
`WorkflowDefinition`. All shipped workflows use the same agent-activity
semantics (session start, prompt, turn end, operator block, tool activity), so
`hook-dispatcher.ts` binds directly to `workerHookHandlers`. Workflow
definitions remain poller-only. This boundary is load-bearing: importing the
workflow registry from the per-tool-call hook retained every review, merge,
resolve, and CI-fix handler in `dist/hook.js`.

```ts
// index.ts
export function getWorkflow(name: string): WorkflowDefinition;
export function registerWorkflow(def: WorkflowDefinition): void;
```

**Registry behavior**:
- `getWorkflow("default")` returns the default workflow.
- `getWorkflow(unknown)` logs a `warn` and falls back to the default.
  This matches existing fail-soft patterns in the codebase
  (`transitionState` warns but does not throw on illegal transitions).
- `registerWorkflow` is exported for tests and future use; it is not
  called by production code in this refactor.

**Default workflow** (`workflows/default.ts`):

```ts
import { handleWorking, handleReviewing } from "../poller-review.js";
import { handleMergePending, handleMerged } from "../poller-merge.js";
import { handleResolving } from "../poller-resolve.js";
import { handleFailing, handleDone } from "../poller-state.js";
import type { WorkflowDefinition } from "./types.js";

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
};
```

The state-handler functions stay where they are (`poller-review.ts`,
`poller-merge.ts`, `poller-resolve.ts`, `poller-state.ts`). They are
reachable from outside the workflow only via this registration.

**WorkerEntry change** (`src/dashboard/registry.ts`):

```ts
export interface WorkerEntry {
  // ... existing fields ...
  /** Workflow this worker runs under. Absent on legacy workers; treated
   *  as "default" by all consumers. New workers always set "default"
   *  until per-workflow CLI surface ships. */
  workflow?: string;
}
```

`addWorker` in `workers.ts:127-135` and `newWorker` set `workflow: "default"`
explicitly on new workers. Legacy workers (already in the registry from a
previous garden version) read with `workflow: undefined`; consumers default
to `"default"`.

**Tests** (`test/workflows.test.ts`):
- `getWorkflow("default")` returns the default workflow.
- `getWorkflow("nonexistent")` logs a warning and returns the default.
- The default workflow's `validTransitions` is character-equal to the
  current `VALID_TRANSITIONS` constant (lock in via deep-equal assertion).
- Each state in `PrState` has a registered handler in `stateHandlers`
  (exhaustiveness check — catches future PrState additions that forget
  to register a handler).

### Component 5 — Dispatcher integration

The new primitives are useless unless the existing dispatchers consult
them. Three call sites change.

#### 5a — `pollWorker` (`src/dashboard/poller.ts:74-106`)

Today, `pollWorker` switches on `entry.prState`. After the refactor:

```ts
function pollWorker(
  projectName: string,
  projectPath: string,
  baseBranch: string,
  entry: WorkerEntry,
): boolean {
  const state = entry.prState ?? "working";
  const workflow = getWorkflow(entry.workflow ?? "default");
  // Record<PrState, StateHandler> guarantees coverage; no runtime guard.
  return workflow.stateHandlers[state](projectName, projectPath, baseBranch, entry);
}
```

The exhaustive switch is gone. Exhaustiveness is enforced by TypeScript
via the `Record<PrState, StateHandler>` type — adding a new PrState in
`registry.ts` is a build error until every workflow declares a handler
for it.

#### 5b — `transitionState` (`src/dashboard/poller-state.ts:33-45`)

Today, `transitionState` consults the global `VALID_TRANSITIONS`. After:

```ts
export function transitionState(...): void {
  const entry = findWorkerByName(projectName, workerName);
  const workflow = getWorkflow(entry?.workflow ?? "default");
  const fromState: PrState = entry?.prState ?? "working";
  if (!workflow.validTransitions[fromState]?.includes(toState)) {
    log.warn("poller", "invalid state transition", {
      worker: workerName,
      data: { from: fromState, to: toState, workflow: workflow.name },
    });
  }
  updateWorkerFields(projectName, workerName, { ...extraFields, prState: toState });
}
```

The `VALID_TRANSITIONS` exported constant is removed. Any external import
breaks at compile time and is migrated to `getWorkflow(name).validTransitions`.

#### 5c — Claude hook handler (`src/dashboard/hook-dispatcher.ts`)

Today, `handleClaudeHook` is one big switch on hook kind that writes to
the registry directly. After the refactor:

1. Extract the existing handler bodies into `workerHookHandlers` in
   `src/dashboard/hooks/default.ts`. Functions are unchanged in behavior;
   only the location changes.
2. `handleClaudeHook` becomes a thin dispatcher: translate the harness wire
   event and call the matching shared `workerHookHandlers.onXxx` method.
3. Keep the dispatcher and handlers free of `workflows/index.ts`; only the
   FIFO wake primitive may cross from the poller side into the hook graph.

The reviewer/resolver short-circuit (`GARDEN_REVIEWER=1` env flag) lives at
the top of the dispatcher, before worktree or registry reads.

This is the part of the refactor that has the most surface area in
existing code. It is sequenced last (Phase 4) so the first three phases
ship a clean foundation before the hook handler is touched.

### Migration: replicating existing behavior as the default workflow

The acceptance criterion for the entire refactor was **bit-for-bit behavior
equivalence**. After Phase 4 landed, a worker on the default workflow goes
through exactly the same lifecycle as today, including:

- The same prompts (snapshot tests on `buildReviewPrompt` and
  `buildResolvePrompt`).
- The same verdict tokens and parsing.
- The same state transitions (the default workflow's `validTransitions` is
  deep-equal to the old `VALID_TRANSITIONS` constant).
- The same hook behavior (default hook handlers are byte-equal to the
  current handler bodies, just relocated).
- The same registry fields (`workflow: "default"` is the only addition).
- The same dashboard rendering (`status.ts`, `header.ts` rendering paths
  are untouched).

The integration test `test/integration/poller-failures.real.test.ts` and
`test/integration/claude-hook.real.test.ts` are the long-form proof: they
run end-to-end and pass without modification.

### Backward compatibility

- **Registry on disk**: existing entries lack `workflow`. All consumers
  default to `"default"` on read. No migration script is needed; the
  field becomes present the next time the entry is updated through
  `updateWorkerFields`.
- **External imports**: `VALID_TRANSITIONS` is removed. Any code outside
  this refactor that imported it must be updated to call
  `getWorkflow(name).validTransitions`. This is a compile-time break, not
  a runtime one.
- **Hook handler signature**: the hook handler is dispatched from the shared
  `workerHookHandlers` (not through the workflow registry), and its external
  entry point (`handleClaudeHook`) preserves its signature. CLI internal
  command `_claude-hook` is unchanged.

### Testing strategy

Three layers, each with explicit acceptance criteria.

#### Layer 1 — Unit tests for new primitives

| Module | Test file | Coverage |
|--------|-----------|----------|
| `headless-agent.ts` | `test/headless-agent.test.ts` | Launch shape, prompt write, result cleanup, window kill, `onLaunched` callback |
| `verdict.ts` | `test/verdict.test.ts` | Vocabulary match, scan window, body extraction, edge cases (empty, malformed, no match) |
| `prompt-compose.ts` | `test/prompt-compose.test.ts` | Section ordering, null skip, step counter, join behavior |
| `workflows/index.ts` | `test/workflows.test.ts` | Lookup, fallback, registration, exhaustiveness |

#### Layer 2 — Snapshot tests on existing prompt builders

`test/prompts.test.ts` (existing) gains snapshot assertions:

```ts
it("buildReviewPrompt output is byte-equal to the pre-refactor snapshot", () => {
  const entry: WorkerEntry = /* fixed fixture */;
  const out = buildReviewPrompt(...args);
  expect(out).toMatchSnapshot();
});
```

The snapshot is captured **before** the prompt-composition refactor lands
(committed as part of Phase 1 prep). Phase 2 (prompt composition) must
not change the snapshot. Same for `buildResolvePrompt`.

#### Layer 3 — Integration tests

The two existing real integration tests
(`test/integration/poller-failures.real.test.ts`,
`test/integration/claude-hook.real.test.ts`) run unmodified through every
phase. They are the end-to-end tripwire: if the workflow refactor breaks
behavior, they fail.

A new integration test `test/integration/workflow-default.real.test.ts`
explicitly drives a worker through the default workflow's full state
machine and asserts every transition. This is the executable replacement
for the old hard-coded `VALID_TRANSITIONS` constant test (if any).

#### Test command

`npx vitest run && npx tsc --noEmit` is the gate. Both must pass at the
end of every phase.

### Phasing

Each phase was independently mergeable and left the codebase in a working
state. The default workflow was incrementally constructed: Phase 1 and 2
introduced primitives that were *used by but not yet selected via* the
workflow registry; Phase 3 introduced the registry; Phase 4 routed hooks
through it. All phases have landed.

#### Phase 1 — Headless agent + verdict primitives

**Deliverables**:
- `src/dashboard/headless-agent.ts` with `launchHeadlessAgent`.
- `src/dashboard/verdict.ts` with `parseLastLineVerdict`.
- `launchReview` and `launchResolver` rewritten as callers.
- `parseReviewResult` and the resolver parser rewritten as callers.
- Unit tests for both new modules.
- Snapshot fixtures captured for `buildReviewPrompt` and
  `buildResolvePrompt` (these lock Phase 2's acceptance criteria).

**Acceptance**: integration tests pass unchanged. No behavior change.

#### Phase 2 — Prompt composition

**Deliverables**:
- `src/dashboard/prompt-compose.ts` with `composePrompt` and
  `gatherPromptContext`.
- `src/dashboard/prompts.ts` rewritten as named sections plus
  compositions.
- Unit tests for the composition layer.
- Snapshot tests on `buildReviewPrompt` and `buildResolvePrompt` enforced.

**Acceptance**: snapshots from Phase 1 prep are byte-equal. Integration
tests pass unchanged.

#### Phase 3 — Workflow definition and dispatcher

**Deliverables**:
- `src/dashboard/workflows/{types,default,index}.ts`.
- `WorkerEntry.workflow?: string` field added; `newWorker` sets
  `"default"`.
- `pollWorker` and `transitionState` route through the registry.
- `VALID_TRANSITIONS` constant removed.
- Unit tests for the registry.
- Integration test `workflow-default.real.test.ts` driving the full
  state machine.

**Acceptance**: integration tests pass unchanged. New integration test
passes. No behavior change observable from outside the dashboard.

#### Phase 4 — Shared hook handler extraction

**Deliverables**:
- `src/dashboard/hooks/default.ts` with the existing hook handler bodies
  relocated.
- `handleClaudeHook` (now in `hook-dispatcher.ts`, originally in `header.ts`)
  translates wire events onto `workerHookHandlers`.
- Workflow definitions remain poller-only; the hook import graph must not
  retain workflow state handlers.
- Tests for hook behavior plus an esbuild-metafile guard that rejects poller
  state modules and a bundle above 128KB.

**Acceptance**: `test/claude-hook.test.ts` and
`test/integration/claude-hook.real.test.ts` pass unchanged. Hook
behavior is byte-equal to pre-refactor.

After Phase 4, the foundation was complete. The workflows added since did not
modify any of the four phases above.

### Limitations and future extension points

The current foundation has one structural assumption that does not yet
generalize: **every workflow has a resolver.** This is recorded here so a
future workflow author understands the design choice and the right place to
extend it.

The merge handler in `src/dashboard/poller-merge.ts` calls `launchResolver`
(in `poller-resolve.ts`) directly when `handleMergePending` detects a
rebase conflict. It does NOT dispatch through `workflow.stateHandlers
["resolving"]`. This is intentional, not a layering oversight:

- `handleResolving` is the "in-flight resolver" handler. It checks
  `entry.reviewWindowName` and assumes the resolver subprocess is already
  running in a tmux window that the entry tracks.
- Only `launchResolver` populates those fields (`reviewWindowName`,
  `reviewStartedAt`, `preResolveSha`). It also enforces the resolver budget
  and defers when the worker's Claude is mid-turn.
- Routing through `workflow.stateHandlers["resolving"]` would either need
  `handleResolving` to grow a "fresh entry" branch (more state machine), or
  `handleMergePending` to pre-populate the resolver-launch fields itself
  (more cross-handler coupling). Neither is cleaner than the direct call
  for the only workflow that exists today.

The right shape, when a second workflow needs different conflict behavior,
is a new optional field on `WorkflowDefinition`:

```ts
export interface WorkflowDefinition {
  // ...existing fields...
  /** Called by handleMergePending when rebase onto base produces a
   *  conflict. Default workflow's value calls launchResolver.
   *  Workflows that should fail-fast on conflict can supply a handler
   *  that transitions to `failing` instead. */
  onMergeConflict?: (
    projectName: string, projectPath: string, baseBranch: string,
    entry: WorkerEntry,
  ) => boolean;
}
```

`handleMergePending` then becomes:

```ts
if (rebaseResult.kind === "conflict") {
  abortRebase(wtPath);
  const handler = workflow.onMergeConflict ?? launchResolver;
  return handler(projectName, projectPath, baseBranch, entry);
}
```

Adding it now (with the only consumer being a wrapper around
`launchResolver`) is a one-consumer extension point that risks locking in
the wrong shape. Better to defer until the second workflow's needs are
concrete; the changes when it lands will be five lines of code plus the
new workflow's own field value.

### Out of scope / explicit deferrals

The following were deliberately deferred from the foundation refactor.
Each represents a future PR that builds on this foundation; none of them
require modifying the foundation.

- **Worker launch shape variants.** `buildWorktreeBootstrapScript` ends
  with an interactive `claude --session-id ...` invocation. Loop-based,
  headless-once, or other launch shapes will need a `WorkflowDefinition`
  field (e.g., `workerLaunch`) and a branch in the bootstrap builder.
  Adding it is mechanical; not adding it during the foundation kept it
  focused on the lifecycle layer.
- **CLI surface for picking workflow.** `garden newWorker --workflow X`,
  `⌥n` picker, per-project default workflow in `~/.garden/config.yml`.
  The `workflow` field was set to `"default"` in code by `newWorker` and
  `addWorker`; `workers new --workflow` and the ⌥⇧N picker arrived with the
  first downstream workflow.
- **Per-workflow sandbox profile.** `src/dashboard/sandbox.ts` builds
  one sandbox per worktree. Workflows that want different network or
  filesystem allowlists will extend `WorkflowDefinition` and branch
  in `sandboxForTarget`.
- **Per-workflow skills.** `installClaudeSkills` writes the same skills
  for every worker. Workflows wanting different skills add a `skills`
  field and branch in the installer.
- **Per-workflow rules injection.** Today, `buildRulesContext` includes
  global + project rules. Workflow-specific rules (e.g., "you are
  inside a bounded loop") are injected by `buildWorktreeRules` for the
  grow, designer and planner workflows.
- **`role` and `parentWorker` fields.** Vestigial fields on `WorkerEntry`,
  not consulted by any production code. Cleaning them up is unrelated
  to this refactor (see global rule "Don't refactor code that is unrelated
  to your task"). They can be removed later or repurposed.

### Open questions (architecture)

These were not blockers for the foundation but were resolved during
implementation.

1. **Where does `HookContext` actually live?** The current
   `handleClaudeHook` builds an ad-hoc shape from the hook payload.
   Phase 4 needs to formalize it. Best resolved by extracting the
   current shape verbatim in Phase 4 and naming it; resist the urge
   to redesign the hook payload.

2. **Snapshot test maintenance.** Snapshot tests are durable but noisy
   when prompt content legitimately changes (e.g., a prose edit). The
   test should snapshot on a stable fixture (`WorkerEntry` with
   hard-coded fields, no Date-dependent content). Implementation
   detail; flagged so phase-1 fixture authors avoid wall-clock data.

3. **Does `getWorkflow(unknown)` warn-and-fallback or throw?**
   Recommendation: warn-and-fallback, matching `transitionState`'s
   warn-on-invalid-transition pattern. A throw would break workers
   that somehow ended up with a stale workflow name in the registry.

4. **Should `defaultWorkflow.stateHandlers` be `Required<>` or
   `Partial<>`?** **Resolved: `Record<PrState, StateHandler>` (required).**
   The early phase used `Partial` on the assumption that alternate
   workflows might want to omit states. In practice the dispatcher in
   poller.ts treated a missing handler as a config bug (warn + no-op),
   making the permissive type misleading. Tightened to required during
   the foundation hardening pass: alternate workflows declare a no-op
   (`() => false`) for states they don't use, the dispatcher needs no
   defensive runtime check, and incomplete workflows surface as
   TypeScript errors instead of runtime warnings.

## Trellis workflow (retired)

Trellis was a feature-scoped loop that iterated a worker against a frozen
design document until a reviewer declared it aligned. It was retired on
2026-10-20: one real run in its lifetime, and its default configuration had
broken. Its spec, code and tests are in git history (last present at
`c3a5cb0`). Registry entries and tombstones that name it are read as default
workers (`migrateLegacyWorkflowNames`, `registry.ts`), and a worker parked on
one of its failing reasons (`trellis-flagged`, `iteration-budget`,
`stagnation`) is read as a `code` failure, which re-reviews on its next push.

## Loop primitive

Workflow-agnostic iteration mechanics for a workflow that respawns the
worker with fresh Claude context after each merge. Lives in
`src/dashboard/loop.ts`. Its consumer today is grow (a short hardening
loop, ~5 iterations, terminal-on-budget = `done`).

### Surface

```ts
export interface LoopHooks {
  /** Read iteration / max from the workflow's per-worker sub-object. */
  readIteration(entry: WorkerEntry): { iteration: number; maxIterations: number } | null;
  /** Persist the next iteration counter (workflow-specific field path). */
  writeIteration(projectName: string, workerName: string, next: number): void;
  /** Update the in-memory entry's iteration field. */
  setInMemoryIteration(entry: WorkerEntry, next: number): void;
  /** Build the per-iteration continue prompt for K+1. */
  buildContinuePrompt(entry: WorkerEntry): string;
  /** Tag for log lines and seed-file naming ("grow"). */
  logTag: string;
}

export function persistIteration(...): void;
export function dispatchDelayedLoopContinue(
  gardenRunner: string, projectName: string, workerName: string,
  internalSubcommand: string,
): void;
export function loopAutoContinueAfterMerge(
  projectName: string, workerName: string,
  hooks: LoopHooks, workerCommandOpts: WorktreeCommandOptions,
): boolean;
```

### Cold-respawn flow

`loopAutoContinueAfterMerge` runs the workflow-agnostic sequence:

1. Resolve the worker's pane (active-pane fast path → window-name fallback).
2. Refresh garden's settings file via the worker's harness adapter (`getHarness(entry.harness).installRuntimeConfig`).
3. Generate a fresh `sessionId` and persist before respawn (concurrent
   reads see the new value).
4. Build the worker command via `buildWorktreeWorkerCommand` with the
   caller-supplied `WorktreeCommandOptions` (grow passes `grow: { iteration,
   maxIterations }` so the rules file embeds the iteration count).
5. Update worker fields: clear `pendingContinueChangedFiles`,
   `pendingContinueSyncFailed`, `mergedAt`; set `agentStatus =
   "loading"`. The local `entry` snapshot retains
   `pendingContinueChangedFiles` for the prompt builder — disk is
   cleared, in-memory carries forward.
6. `tmux respawn-pane -k` kills the existing Claude process and restarts
   with the new sessionId.
7. Build the continue prompt via `hooks.buildContinuePrompt(entry)`,
   write to a seed file under `${SESSIONS_DIR}/`, dispatch via
   `dispatchDelayedSeed`. The seed-file name uses `hooks.logTag`
   (`grow-seed-*.txt`), so a second loop workflow's files would not collide.

Workflow-specific bookkeeping (iteration counters, validation guards) stays
at the caller; the primitive is mechanism, not policy.

### Why the extraction

The cold-respawn dance is the same for any loop workflow; only the prompt
content, the sub-object field path, and the budget mechanism differ. Keeping
the mechanics in `loop.ts` makes grow a thin caller (~150 lines including the
prompt builder and the iter-1 seed), and the budget check and the continue
prompt stay the workflow's own (grow checks its budget post-merge in
`maybeAutoContinue` and inlines the seed, the changed-files list and the
grow-log).

## Grow workflow

Spec for the **grow** workflow: a bounded hardening loop **without** a
frozen design document. The operator's seed prompt anchors the loop
across iterations; convergence is worker-declared via `.garden-done` or
forced by hitting the iteration cap. **If the code disagrees with this
section, the code is wrong.**

Grow is the second workflow registered against the foundation
(`workflows/index.ts`). It reuses default's verdict vocabulary
(CLEAN/FIXED/FAILED) and state handlers — only the post-merge dispatch and the
iteration counter diverge. Agent activity hooks are shared outside the workflow
registry.

### Why this exists

The default workflow is a one-shot worker: it implements the operator's
request, gets reviewed, and merges, with no subsequent iterations.

Grow is the bounded loop beside it: "do task X and harden the area around it
for ~5 passes." Use cases:

- Implement a feature, then add edge-case tests, error handling, and
  doc updates as cascading polish.
- Fix a bug, then add a regression test, audit nearby code, update
  CLAUDE.md.
- Pre-ship pass on a PR — multiple polish iterations before merging
  to main.

The metaphor: workers grow the codebase.

### Vocabulary

| Term         | Definition                                                                                       |
|--------------|--------------------------------------------------------------------------------------------------|
| **Seed**     | Operator-supplied task description set at plant time. Persisted both on `entry.grow.seed` (registry fallback) and on disk at `<worktree>/.garden/grow-goal.md` (durable, operator-editable). Iter ≥ 2 continue prompts read the file first and fall back to the registry value. The durable goal across context resets. |
| **Iteration**| One full cycle of `working → reviewing → merge → cold respawn`. Counted on `entry.grow.iteration`. |
| **Cascade**  | Polishing the previous iteration's diff. Iter 2 hardens what iter 1 did; iter 3 hardens iter 2; etc. Termination is natural — by the Kth pass, "nothing material remains" becomes true and the worker writes `.garden-done`. |
| **Grow log** | A worker-maintained file (`<worktree>/.garden/grow-log.md`). Append-only, one line per iteration: `iter K: <one-line summary>`. Inlined into the next iteration's continue prompt so the worker doesn't re-do work. Encouraged, not enforced. |

### The loop

```
       ┌──────────────────────────────────────────────────┐
       ▼                                                  │
   working ──Stop+commits──▶ reviewing ──CLEAN/FIXED──▶ merge
       ▲                          │                    │
       │                          │                    ▼
       │                          ├──FAILED──▶ failing │
       │                          │              │     │
       │                          │       worker fix   │
       │                          │              │     │
       │                          └──────────────┘     │
       │                                               │
       │                                          merge-pending
       │                                               │
       │              ┌──.garden-done──▶ done          │
       │              │                                 │
       │              ├──iter ≥ max──▶ done             │
       │              │     (+.garden-done)             │
       │              │                                 │
       │              └──auto-continue with seed────────┘
       │                       (cold respawn)
       │                                ▲
       │                                │
       └────────────────────────────────┘
```

In this diagram, `Stop+commits` means commits ahead on a provably clean
worktree; a dirty or indeterminate worktree remains idle until a clean Stop.

`done` has two paths: worker-declared (sentinel set during iter K) or
budget-exhausted (iter K = max, sentinel auto-written by
`maybeAutoContinue`). Both land on the same terminal state — both are
"the loop completed cleanly."

### Workflow definition

`src/dashboard/workflows/grow.ts` registers `growWorkflow` alongside
`defaultWorkflow`. State handlers and hook
handlers are reused from default verbatim. The verdict vocabulary is
the default reviewer's CLEAN/FIXED/FAILED, so `handleReviewing`'s
default branch in `poller-review.ts` applies as-is.

The two workflow-aware sites that distinguish grow:

- **`launchReview` (poller-review.ts)** — increments the iteration
  counter via `persistIteration` with `growLoopHooks`. No budget
  check at preflight; that fires post-merge.
- **`maybeAutoContinue` (poller-merge.ts)** — checks
  `entry.grow.iteration >= maxIterations`. If yes: write
  `.garden-done`, transition `merged → done`, skip dispatch. Else:
  call `dispatchDelayedGrowContinue` for the cold respawn.

### Worker entry shape

```ts
export interface GrowData {
  /** Operator-supplied task description from --seed / --seed-file /
   *  picker prompt. Inlined verbatim into iter ≥ 2 continue prompts. */
  seed: string;
  /** Iteration counter. Incremented on each working → reviewing
   *  transition before dispatch. Starts at 0. */
  iteration?: number;
  maxIterations?: number;
}
```

`updateWorkerFields` deep-merges the `grow` sub-object — passing
`{ grow: { iteration: 3 } }` updates only that field without clobbering
`seed` or `maxIterations`.

### Worker system prompt

Three paragraphs appended to the baseline by `buildWorktreeRules` when
`options.grow` is set (mutually exclusive with `options.designer` and
`options.planner`):

1. **Concept.** "You are inside a bounded grow loop. Iteration K of M.
   Each iteration starts with a fresh Claude session — disk is the
   only state that crosses iteration boundaries. The seed prompt that
   anchors this loop is inlined in your iteration's continue message;
   it does not change between iterations."
2. **Bias.** "Harden the recent work, do not chase adjacent
   improvements. The seed is your scope; the diff against the base
   branch is your focus. Edge cases the seed implies but didn't list,
   missing tests, doc updates, error-handling gaps — these are the
   kinds of polish a grow loop is for."
3. **Termination.** "When nothing material remains, write
   `.garden-done`. The loop also ends after M iterations regardless.
   Append a one-line entry to `.garden/grow-log.md` describing what
   you did this iteration."

### Continue prompt structure

Sent post-merge by `growAutoContinueAfterMerge` after the cold respawn.
Built by `buildGrowContinuePrompt` in `grow-continue.ts`:

```
[garden] Your last iteration was merged. Iteration K of M — keep
growing this codebase.

Original task:

<seed verbatim, from .garden/grow-goal.md if present, else entry.grow.seed>

Files you changed last iteration:
  - <list from pendingContinueChangedFiles, truncated at 20>

What you've done so far (`.garden/grow-log.md`):
  <inlined log content if present>

Look for material improvements: edge cases, error handling, missing
tests, doc updates, security concerns. Bias toward hardening the work
you've already done — stay in the area of the original task. Do not
chase adjacent improvements; do not redesign.

If nothing material remains, write `.garden-done` at your worktree
root and end your turn — the loop terminates instead of running
another iteration. Otherwise, make your changes, append a one-line
entry to `.garden/grow-log.md`, commit, and push.
```

The iter-1 seed (sent at plant time, not via auto-continue) wraps the
operator's seed text in pacing framing so the worker doesn't cram all
hardening into iter 1 — built by `buildGrowIteration1Seed`.

### Termination

Three terminal dispositions, two of which land on `prState: "done"`:

| Disposition         | How reached                                                                                  | Decoration                                       |
|---------------------|----------------------------------------------------------------------------------------------|--------------------------------------------------|
| **Self-declared**   | Worker writes `.garden-done` mid-iteration                                                    | Default `done` rendering                          |
| **Budget-exhausted**| `entry.grow.iteration >= maxIterations` post-merge; `maybeAutoContinue` writes the sentinel and transitions | Default `done` rendering                          |
| **FAILED**          | Reviewer's FAILED verdict (same as default)                                                   | `failing/code` rendering — operator decides recovery |

`done` is "the loop completed cleanly" in both happy-path
dispositions. There is no `failing/iteration-budget` for grow:
hitting the cap is success, not failure.

### CLI surface

Cold plant — spawn a fresh grow worker:

```
garden workers new <project> --workflow grow \
  [--seed <text> | --seed-file <path>] \
  [--max-iterations N]
```

Either `--seed` or `--seed-file` is required (mutually exclusive).
Empty seeds are rejected.
`--model <alias-or-id>` pins the loop's model (persisted to
`WorkerEntry.model`, threaded through every cold respawn — absent means
the account default). `--max-iterations` overrides
`project.maxGrowIterations` (default 5). The cold-plant path produces
the goal artifact via the iter-1 seed prompt instructing the worker to
write `<seed verbatim>` to `.garden/grow-goal.md`.

The `⌥⇧N` workflow picker offers a `(h) hoop` row — `hoop` is this
workflow's operator-facing name in the picker only; the workflow, the
CLI (`--workflow grow`), and every on-disk field stay `grow`. It opens a tmux
`command-prompt` for a single-line task description. Seeds with quotes
or shell metacharacters break tmux substitution; for those, operators
use the CLI plant path with `--seed-file`.

Convert — flip an active default worker to grow:

```
garden workers grow [<worker>] \
  [--seed <text> | --seed-file <path> | --goal-file <path>] \
  [--max-iterations N]
```

Self-resolves the worker via `$GARDEN_WORKER` when no positional
argument is given (so a worker can run the command on itself).
`--seed`, `--seed-file`, and `--goal-file` are mutually exclusive;
exactly one is required. `--goal-file` is an alias for `--seed-file`,
named to match the on-disk filename (`.garden/grow-goal.md`) for
ergonomics from a slash-skill workflow. The CLI writes
`.garden/grow-goal.md` directly at flip time, then sets
`workflow: "grow"` and stamps `entry.grow` with iteration 0. Re-conversion
of a worker already on grow is rejected — operators amend
an in-flight grow loop's goal by editing `.garden/grow-goal.md`
directly.

Iter-1 launch differs by branch state at convert time:

- **Worker has unmerged commits**: status quo. The upcoming merge of
  the worker's pending push fires `growAutoContinueAfterMerge`, which
  dispatches iter-1 via the post-merge auto-continue path (cold
  respawn + iter-K continue prompt with iteration=1).
- **Branch fully merged into base**: the convert command itself
  fast-forwards the worktree to `origin/<base>` (covers sibling
  merges that landed since this branch did) and dispatches iter-1
  via `dispatchDelayedSeed` with the iter-1 seed prompt — same
  machinery `workers new --workflow grow` uses at plant time. Without
  this, the worker would sit idle on `workflow=grow,iteration=0`
  forever (no future merge means no auto-continue). The convert
  refuses up front if the worktree is dirty, so a fixable error
  never leaves the worker half-converted.

### Mid-loop goal amendment

The goal file (`<worktree>/.garden/grow-goal.md`) is operator-editable.
Every iteration's continue prompt (built by `buildGrowContinuePrompt`)
reads the file at dispatch time, so edits made between iteration K's
merge and iteration K+1's launch take effect on the next iteration
without any explicit "amend" command. The file falls back to
`entry.grow.seed` (the value stamped at plant/convert time) if it is
missing or empty, so legacy entries from before the goal-file
mechanism shipped continue to work.

### Grow skill

Garden ships a `grow` skill, bundled alongside `done`, `handoff`, and the
other worker skills and installed at
`<worktree>/.claude/skills/grow/SKILL.md` for every worker (not just
grow-workflow ones — the skill exists to convert an *active default
worker* into grow once the operator has the work in mind). The skill
triggers when the operator types `/grow [N]` or asks the worker to
"harden this for N passes" / "do an improvement pass on what we just
did" and walks the worker through:

1. Picking the iteration budget (default 5).
2. Distilling the conversation into a 1–3 paragraph goal: scope, out
   of scope, convergence criterion.
3. Writing the goal to `<worktree>/.garden/grow-goal.md`.
4. Running `garden workers grow $GARDEN_WORKER --goal-file
   .garden/grow-goal.md --max-iterations <N>` to flip the workflow.

Mid-loop goal amends are *not* a skill action — operators edit
`.garden/grow-goal.md` directly between iterations, and the next
iteration's continue prompt re-reads it. The skill is one-shot for
the convert step; amend is unbounded.

### Project config

| Key                  | Default | Behavior                                                                       |
|----------------------|---------|--------------------------------------------------------------------------------|
| `maxGrowIterations`  | 5       | Default budget for new grow workers. `--max-iterations` overrides per plant.   |

### Out of scope (now)

- **Per-project grow-prompt template.** A `growPrompt` config key
  that prepends domain-specific quality guidance to every grow
  worker's seed (e.g., "always check error messages are structured").
  Deferred until repeat usage proves the need; the seed string
  subsumes this manually.
- **Stagnation detection.** Grow has no drift list to watch shrink. A heuristic
  (e.g., "iteration K and K-1 changed the same files with identical
  diffs") could fire a `failing/stagnation` alert. Deferred — the
  iteration cap is the primary safety net.

## Designer workflow

Spec for the **designer** workflow: a **design** worker whose unit of output
is a design artifact (a document), **not code**. A designer frames a problem,
sketches alternatives, asks the operator clarifying questions, converges on an
approach, and publishes the approved artifact to a tracked `docs/` path for a
downstream builder to implement. **If the code disagrees with this section, the
code is wrong.** Design doc (superseded by this section once shipped):
`docs/future/DESIGNER-WORKFLOW.md`.

### Why this exists

Design and build are different cognitive modes. Garden's other workers are
action-biased ("make your best judgment and proceed", "never produce partial
work and stop") — correct for implementation, actively harmful for design,
where a worker told to "make the call and move on" ships the first plausible
approach before the operator can redirect. Designer inverts that posture: its
job is to think out loud with the operator and produce a document the operator
reads, edits, and approves. Once separate, the design and build **seats** no
longer have to be the same model — a strong designer (Opus) can hand off to a
cheaper or different-blind-spots builder (the multi-model pipeline).

### The four-phase pipeline

All four phases run inside the `working` poller state (the poller never sees the
boundaries; the designer tracks them by file existence under
`<worktree>/.garden/designer/`, which is git-excluded and intentionally
uncommitted — working memory, not commits):

1. **Frame** — read the seed, scan the repo, write `framing.md` (goal,
   constraints, out of scope). Flows into phase 2.
2. **Options** — write `options.md` (2–3 approaches as narrative sketches, each
   naming its load-bearing tradeoff) and `questions.md` (numbered, specific).
   Then `garden blocked "<the decision you need>"` and end the turn — the human gate.
3. **Converge** (loops) — the operator answers in chat; the designer captures
   `answers.md`, drafts `artifact.md`, and re-enters the gate as many times as
   the operator wants more options. Ends when the operator approves.
4. **Publish** — `garden designer publish` moves the artifact to a tracked
   `docs/` path, commits it, and writes `.garden-done`; the designer then
   executes the handoff plan the operator approved (see Handoff below).

### The human gate

`.garden-awaiting-input` is a general human-gate sentinel. Designer enters it
through `garden blocked "<question>"`, the same command any worker uses to stop
on an operator decision (DESIGN.md "Blocked on the operator") — so a designer
parked mid-phase also gets the alert and the top-band row placement, which a bare
`touch` did not raise. The shipped planner workflow has no mid-run gate; its
review gate is board-side promotion.
Auto-continue skips a worker holding the sentinel (`autoContinueSkipReason`,
`poller-merge.ts`); `onPromptSubmitted` clears it unconditionally (unlike
`.garden-done`, a gated worker holds it while `prState` is still `working`),
along with the recorded question.
The status pane marks a worker holding it with the `⚑` icon and shows its question
in the detail column; the older yellow `?` (`formatAwaitingInputGlyph`, `status.ts`)
remains as the fallback for a worktree that holds the sentinel with no recorded
question — one written by the previous bare `touch` and not yet refreshed. Note the gate is milder than it looks: because the phase-1–3
artifacts are git-excluded, a designer's design turns produce no tracked commit,
so `routeStopHookEnd` sees zero commits ahead and the worker simply idles — the
sentinel is the operator-visible signal + a robustness backstop, not the primary
pause mechanism.

### Skip-review merge

`WorkflowDefinition.skipsReviewMerge: true` is shared by designer and planner.
When a designer has
commits ahead of base (at publish), `handleWorking` routes `working →
merge-pending` **directly** — no reviewer, because the operator already reviewed
the prose at the gate. The reviewer is launched from `handleWorking →
launchReview`, so "skip review" lives in that handler, not the merge handler.
`designerValidTransitions` diverges from default only on `working`
(`["merge-pending", "failing", "done"]`, never `reviewing`). The CI/merge gate
still applies, which is why the branch is pushed before it enters merge-pending:
the gate reads CI for the SHA on GitHub before the merge queue pushes anything,
and an unpublished SHA reads as missing there. A failed push leaves the worker
`working` with its review armed, and a 30s re-poke retries it. Designer is excluded from the holistic whole-task review
(`evaluateHolisticGate`'s `workflow === "default"` clause), which would otherwise
re-launch a reviewer and defeat skip-review.

### Scope enforcement

A designer's only committable output is a tracked doc under `docs/`
(`isPublishablePath`, `designer-paths.ts`; `.garden/` is git-excluded so its
artifacts never appear in a diff). Before the skip-review transition,
`handleWorking` checks the committed diff: a file outside `docs/` (a designer
that drifted into building code) parks the worker in `failing` with
`failingReason: "designer-scope"` and an operator alert. It is not
operator-action-gated — removing the offending files and re-pushing auto-retries
the publish after the failing debounce.

### The three seats

| Seat | What fills it | How selected |
|---|---|---|
| **Designer** | the designer worker itself | the crew's **design seat** (`designerSeat`, `crew.ts`): per-worker `--crew`, else the project's bound crew — harness, provider, model, and effort together; a builtin's seat is its harness ladder's strong model (`claude-codex` → Fable, `codex-claude` → Codex's Astra), a stored crew naming no designer derives the seat from its review half. Beneath that, the workflow default (Opus at `xhigh`, `workflow.workerModel`/`workerEffort`); above it, per-run `--model`/`--effort`/`--harness`. A Codex designer launches (the adapter admits the workflow) |
| **Builder** | a downstream worker spawned at handoff | default-workflow: spawned by the designer via `garden handoff` on approval, **inheriting the designer's crew** (its build half — `claude-codex` builds on Opus, `codex-claude` on Astra) |
| **Reviewer** | the builder's reviewer | the same crew's review half (`claude-codex` → Codex's Astra, `codex-claude` → Fable); strong first-party by default (the shipped crew safety invariant) |

So one crew spells the whole shape — a strong model designs, a builder
implements, a strong one reviews — and binding it to a project (or passing
`--crew` at plant) is the only configuration the pipeline needs. Whether the
builder is a *lesser* model is the harness ladder's call: Claude's steps down
to Opus, Codex's stays on Astra, the model every unpinned Codex launch takes.

### Handoff

Approval-driven, designer-executed for the default case: the converge gate's
approval ask states the handoff plan alongside the final artifact, so one
"approve" authorizes both — publish, then build. On approval the designer
publishes first (a failed publish must not leave a builder working from an
unpublished design), then spawns a **default-workflow builder** itself through
the existing `garden handoff` IPC, seeded from
`.garden/designer/handoff-brief.md` — a self-contained briefing that inlines the
full design, because the child branches from `origin/<base>` before the
published doc merges, so the doc path does not yet exist in its worktree. The
operator redirects in the approval itself, for example to **no builder**.
The builder's crew is the designer's own: `garden handoff` forwards
the crew stamped on the calling worker's entry (`entry.crew`, from the
designer's `--crew`), and a designer on a project-bound crew spawns a builder
that resolves the same binding; `garden handoff --crew <name>` names a
different one when the operator asks. The publish command prints the handoff
command as a reminder.

### Triggering

```bash
garden workers new <project> --workflow designer                     # brief arrives in the pane
garden workers new <project> --workflow designer --seed "…"          # or --seed-file: inline the brief
garden workers new <project> --workflow designer --harness codex     # a Codex designer
garden workers new <project> --workflow designer --crew codex-claude # design seat from the crew; the builder inherits it
```

The `⌥⇧N` workflow picker's `(s)` row plants a designer instantly (`(d)` is the
default-worker row) — no design prompt is collected in the tmux UI. The
seed is optional everywhere: without one, no plant-time message is sent at all —
the design posture is baked into the worker's system prompt (the `rules.ts`
designer branch + the bundled skill) and the operator's design brief arrives as
the first message in its pane (multi-line, conversational, no shell-escaping
constraints); with `--seed`/`--seed-file` (the scripted-plant path) the brief is
inlined via the seed message and framing starts immediately. `--crew` names the
crew whose design seat fills this designer and whose build/review halves its
builder will inherit at handoff; without it the project's bound crew applies.

### Code layout

- `workflows/designer.ts` — the definition (reuses default's 8 state handlers;
  `skipsReviewMerge`, `workerModel: "opus"`, `workerEffort: "xhigh"`).
- `designer-paths.ts` — `isPublishablePath` leaf, letting the poller enforce the
  boundary without importing the publish mutation path.
- `designer-publish.ts` — `publishDesignerArtifact` (move + commit + `.garden-done`;
  no push — the poller merge pushes).
- `designer-prompts.ts` — `buildDesignerSeed` (plant-time framing; only used
  when `--seed`/`--seed-file` inlines a brief — seedless plants send no message).
- `commands/designer.ts` — `garden designer publish [<worker>] --to <path> [--dry-run]`.
- The rules inversion (`rules.ts` designer branch), the bundled `designer` skill
  (`skills.ts`), the picker row (`workflow-picker.ts`), and the `?` glyph
  (`status.ts`).
- The design seat: `CrewSpec.designer` + `designerSeat` (`crew.ts`), read by
  `newWorker` for a designer spawn; `garden handoff --crew` / the CLI's
  inheritance of the caller's `entry.crew` (`commands/handoff.ts`).

### Deferred

- **`--artifact-type`** (memo/freeform) — subsumed by the publish `--to` path.
- **`garden workers designer`** to convert an active default worker mid-run.

## Planner workflow

Spec for the **planner** workflow: a **decomposition** worker whose unit of
output is a dependency-gated **bead DAG** written to the project's bd store —
not code and not a commit. A planner is the garden half of board's `plan:*`
lifecycle (board's `docs/DELEGATION.md`, phase 4d + Decisions 13/16, is the
cross-repo authority): board arms an epic `plan:pending` (the `S` key); the
intake loop consumes that to `plan:planning` and spawns exactly one planner;
the planner reads the epic's pinned design doc, emits the child DAG as
ephemeral draft wisps plus an `integration`-labeled child, and finishes by
rewriting the label to `plan:ready` (or `plan:failed`); board renders the
draft dimmed and the operator's second `S` promotes it. **If the code
disagrees with this section, the code is wrong.**

### The contract

The planner's exact bd commands ride its seed message (`buildPlannerSeed`,
`poller-intake.ts`) — the rules inversion (`rules.ts` planner branch) and the
bundled `planner` skill carry the posture and method, the seed carries the
epic-specific spellings. The contract was first verified against bd 1.0.3 and
re-verified against the installed bd 1.2.2
(`test/integration/workflow-planner.real.test.ts` pins every spelling):

1. Read the design doc (inlined in the seed) and draft the child DAG — one
   worker-session per child, blocker edges for real ordering constraints
   only, plus ONE extra child titled and labeled `integration` that every
   leaf blocks. Its worker verifies the assembled feature: a clean verifier
   with no glue change closes the integration bead directly; integration glue
   follows the normal merge-before-close protocol. bd rejects epic↔task
   `blocks` edges in both directions, so the integration bead is a task like
   its siblings — DELEGATION.md Decision 13.
2. Create each child as an ephemeral wisp:
   `bd create "<title>" --ephemeral --parent <epic> -d "<desc>"`
   (`-l integration` on the gate child). Wire every edge explicitly:
   `bd dep <blocker> --blocks <blocked>`, including one edge per leaf onto
   the integration child.
3. `bd dep cycles` as belt-and-suspenders (bd also rejects cycle-closing
   edges at write time), then sanity-check `bd swarm status <epic> --json`.
4. On success `bd label remove <epic> plan:planning` + `bd label add <epic>
   plan:ready`; on ANY failure land `plan:failed`. Never leave the epic at
   `plan:planning`.
5. Never `bd promote` (board's `S` owns promotion), never claim/close beads,
   never commit code; then stop.

**Deliberate deviation from DELEGATION.md's sketch:** the doc's phase-4d
inventory wanted ONE `bd create --graph --ephemeral` call with top-level
`edges[]`. On bd 1.0.3, `--graph` silently ignored `--ephemeral` and produced
permanent children that bypassed board's draft-review gate. As of bd 1.2.2 it
honors `--ephemeral`, but it silently drops `--parent` and still ignores
node-level `deps` arrays. The resulting children are ephemeral but never enter
the epic's swarm frontier, so intake never dispatches them. The seed therefore
continues to pin the per-child create plus explicit-edge spelling above; the
canary integration test tracks which `--graph` drop is currently
disqualifying so a future fix prompts reconsidering the single-call form. The
`--dry-run` trap (it writes anyway) is carried into the seed verbatim.

### The workflow definition

Designer-shaped and data-only: reuses default's 8 state handlers,
`workerModel: "opus"` + `workerEffort: "xhigh"` (decomposition is
judgment-heavy — the designer seat), `skipsReviewMerge: true`. A planner
writes only to the bd store, so its branch never gains a tracked commit —
`handleWorking` sees zero commits and the worker idles after finishing, like
a designer at its human gate; a planner that drifts into committing rides the
same publishable-path boundary check as designer (anything outside `docs/`
parks it in `failing`). `plannerValidTransitions` diverges from default only
on `working` (`["merge-pending", "failing", "done"]`), exactly like designer.

### Spawning

The normal planner is **intake-spawned**: the plan-consume loop in
`runIntakeOnce` (`poller-intake.ts`) runs BEFORE the dispatch loop, admits
epics via the widened `plan:*` filter, and for each `plan:pending` epic
consumes the label BEFORE the spawn (Decision 16: remove `plan:pending` —
a failed remove aborts that epic with an error alert, since proceeding risks
duplicate planners on the next wake — then add `plan:planning`, then spawn
one planner through the intake spawn seam with `workflow: "planner"`). Only
`pending` is spawnable, so repeated poller wakes are idempotent by
construction; a spawn failure rewrites `planning` → `failed` with an alert.
The planner carries no bead assignee and is deliberately **exempt from the
intake cap/governor and the budget counter** — the governor joins on bd
assignees and `budget:N` caps dispatched *build* sessions, and a planner is
neither. It is likewise invisible to the intake reconcile step — cleanup
is `garden workers stop` or the dashboard `⌥x` kill.

`workers new <project> --workflow planner [--seed …|--seed-file …] [--model …]
[--effort …] [--base …]` plants one from the CLI (hand-run dispatch and
testing). The seed is optional and delivered RAW — no framing wrapper, since
intake composes the contract seed itself; without one, no message is sent and
the brief arrives as the operator's first pane message (the designer
pattern). A planner spawned outside a `beadIntake` project has no
`BEADS_DIR`/`BEADS_ACTOR` env, so its bd calls would hit a worktree-local
store — plant planners on opted-in projects.

### Code layout

- `workflows/planner.ts` — the definition (reuses default's 8 state handlers;
  `skipsReviewMerge`, `workerModel: "opus"`, `workerEffort: "xhigh"`).
- `workflows/types.ts` — `plannerValidTransitions` + the `getValidTransitions`
  branch.
- `poller-intake.ts` — the plan-consume loop in `runIntakeOnce`,
  `buildPlannerSeed`, and `IntakeSpawnRequest.workflow`.
- The rules inversion (`rules.ts` planner branch), the bundled `planner` skill
  (`skills.ts`), the `planner` badge (`status.ts` `workflowRowDecor`), the CLI
  validation union (`commands/workers.ts`), and cli.ts help.
- Tests: `test/workflows.test.ts`, `test/rules.test.ts`, `test/skills.test.ts`,
  `test/poller-intake.test.ts` (plan-consume loop + seeds),
  `test/grow-cli.test.ts` (CLI), and
  `test/integration/workflow-planner.real.test.ts` (the bd spellings).

### Deferred

- **A `⌥⇧N` picker row** — planners are intake-spawned from board's `S`; a
  tmux picker row would collect no epic context. The CLI plant covers the
  hand-run case.
- **Reconcile visibility** — a planner has no `bead` field, so the reconcile
  step cannot see it; a planner orphaned by a board-side `;plan:none` keeps
  running until stopped by hand.
- **Codex planners** — `workerWorkflows` on the codex adapter does not include
  `planner`; the seat is claude-code only for now.
- **`BEADS_DIR` injection for non-intake projects** — see Spawning above.

## Holistic-review workflow

Garden reviews each worker push in isolation (`origin/<base>..HEAD`) — one delta
against the then-current base. Nothing reviews a multi-phase task's *assembled
whole*, so cross-phase coherence defects survive every per-phase review: an
abstraction an early phase introduced that a later phase obsoleted, dead code a
later phase orphaned, a shared-registry collision "resolved" by keeping every
entry, a contract a later phase silently broke.

The holistic review closes that gap. When a multi-phase **default** worker reaches
`done`, the poller interposes ONE final review of the whole-task cumulative diff
before the worker truly finishes. This is NOT a separate spawned worker: it reuses
the **headless reviewer flow** (`launchHeadlessAgent` + `resolveReviewRole`) on the
original worker's own branch, exactly like a per-phase review — so a Codex reviewer
(configured via `role reviewer harness codex` or a crew) runs the whole-task pass
too. The reviewer reviews the aggregated diff for cross-phase coherence defects and,
in `fix` mode, fixes them directly; the fix rides the normal CI + merge gate.

### Gate (`evaluateHolisticGate`, `poller-holistic-review.ts`)

Dispatch fires iff:
- `prState === "done"`, AND
- `(workflow ?? "default") === "default"` — **load-bearing**: excludes grow and
  every other workflow in one clause. A grow loop legitimately reaches
  `mergeCount >= 2` via normal merges; only this gate keeps the whole-task review to default workers, AND
- `mergeCount >= 2` — a one-shot worker's whole-task diff equals the single
  delta the per-phase reviewer already saw, so it is skipped, AND
- `(holisticReviewedThroughMergeCount ?? 0) < mergeCount` — the high-water guard.
  Set the moment a completion is found eligible, it makes the dispatch
  once-per-arrival; it re-arms if a re-opened worker adds more phases.

Two trigger sites cover both paths into `done` (see `docs/STATUS.md` invariant 4):
`transitionToTerminal` (the sentinel-on-last-phase merge-driven path) and
`handleDone` (the trail-off path, where the Stop hook wrote `done` without a
final merge and pokes the poller). Both re-open `done` → `reviewing` for the
interposed pass; when it resolves, the worker settles back to `done`.

### Modes (per-project `holisticReview` config: `off` | `shadow` | `fix`)

- **`off`** — evaluate the gate, emit the decision trace, never launch.
- **`shadow`** — launch a report-only pass (the prompt forbids edits/commits).
  `handleHolisticFinalReview` surfaces the findings as a `warn` alert, copies them
  to a durable sessions path, and finalizes the worker to `done` (never merges).
- **`fix`** (default, `DEFAULT_HOLISTIC_REVIEW` in `config.ts`) — the reviewer
  fixes genuine cross-phase defects directly and force-pushes; the fix rides the
  normal CI + merge gate, then the worker finalizes to `done`.

Operator decision (2026-07-16): the default is `fix` — every multi-phase task
gets an auto-fixing whole-task coherence review at `done`. A project that wants
the older conservative behavior opts *out* with an explicit `off` (no review) or
`shadow` (report-only). The config is live-read, so it doubles as a no-restart
kill switch.

### Dispatch and launch

The dispatcher (`maybeDispatchHolisticReview`) captures the cross-phase rationale
(`getCommitLogRange` over `baseBranchSha..origin/<base>`, scoped to
`holisticTouchedFiles`), advances the worker's already-merged branch to the base
tip (`syncWorktreeToBase`, ff-only — so a reviewer fix lands as a single clean
delta), builds the aggregated-diff prompt (`buildHolisticFinalReviewPrompt`,
`prompts.ts`), and launches the reviewer via `launchHeadlessAgent` in the worker's
`_<project>-review-<worker>` window — the same primitive per-phase reviews and the
resolver use. The reviewer role (harness/model/env) comes from
`resolveReviewRole(project, "default", "reviewer", …)`, so it honors `project.roles`
and any crew (Codex-capable), independent of the worker's own harness. The worker
transitions `done` → `reviewing` with `holisticFinalActive = true`.

Deferral (leaves the guard **unset** so a later poke retries): the worker's own
Claude still working (`isWorkerClaudeWorking`, shared worktree), or the shared usage
gate closed (`autoContinueGateReason(projectName)` — project-scoped, so a
usage-triggered closure does not defer a project on a separate token pool via
`provider` or a non-default `claudeProfile`; an explicit `garden auto off` defers
everyone).

Launch is a routine lifecycle beat — `holisticReview` defaults to `fix`, so a
review fires on nearly every multi-phase `done`. It is logged (`garden logs`,
source `poller`) but does NOT raise an operator alert; only the shadow-mode
findings and a `FAILED` verdict (an unfixable cross-phase defect → `failing`)
warrant one.

### Verdict handling (`handleHolisticFinalReview`, `poller-review.ts`)

`handleReviewing` early-returns to this handler on `holisticFinalActive`. It reuses
the per-phase read/parse/timeout helpers (harness-aware: a Codex reviewer writes its
verdict to the result file like claude does), then:
- **shadow** → surface findings as a `warn` alert + durable copy, finalize `done`.
- **fix / FIXED with commits** (or an unparseable verdict that still left a commit)
  → force-push, `merge-pending`. `holisticFinalActive` persists through the merge
  pipeline; `transitionToTerminal` finalizes the fix merge straight to `done`
  (guard advanced past `mergeCount`, no auto-continue, no re-dispatch).
- **fix / CLEAN** (or FIXED-with-no-commits) → finalize `done` (nothing to merge).
- **FAILED** → `failing` (reason `code`) — the reviewer found a cross-phase defect
  it could not fix, surfaced to the operator.

It is a **best-effort** pass: a transient/unparseable outcome with no commit finalizes
`done` rather than failing a task whose work already merged and passed per-phase
review. Only an explicit `FAILED` verdict fails the worker.

The deliberate-decision guardrail is folded into the prompt itself
(`holisticRationaleSection`): the reviewer gets the cross-phase commit history and a
directive not to revert an intentional choice (un-ratcheting a baseline, deleting a
deliberately-kept entry, loosening a tightened contract). There is no separate
second reviewer — the single headless pass is the reviewer, matching the
no-bounceback contract that per-phase reviewers fix directly.

### Registry fields (all flat, optional, no migration)

`mergeCount`, `baseBranchSha`, `holisticTouchedFiles`,
`holisticReviewedThroughMergeCount` (the high-water guard), and `holisticRationale`
are the persistent bookkeeping. Two transient markers drive an in-flight pass and
clear when it resolves: `holisticFinalActive` (the worker is in its interposed
final review) and `holisticReviewMode` (`fix` | `shadow`). See `docs/STATUS.md`
Writers.

### Validation harness

`garden dashboard _holistic-backtest <project> <worker>` replays the production
prompt against a PAST completed worker (read-only, zero risk) by reconstructing the
diff endpoints from the dashboard log + the base-branch reflog and running the same
`resolveHolisticDiff` + `buildHolisticFinalReviewPrompt` (shadow mode) code. The
decision trace (`msg: "holistic-review gate"`) validates trigger correctness on live
traffic with dispatch in `off`.

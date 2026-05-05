# Workflow Architecture — Foundation Refactor

Design document for the architectural lift that prepared garden's worker
lifecycle to host multiple workflows. The deliverable was a refactor: existing
behavior is preserved bit-for-bit, but four extension points (headless-agent
launch, verdict parsing, prompt composition, workflow definitions) have been
extracted into reusable primitives. No new workflows shipped as part of this
work.

**Status**: foundation complete. The code matches this document. Adding a new
workflow is now a data-only change plus optional new prompt sections; the
dispatcher in `poller.ts` and the hook handler in `header.ts` do not need
edits. For the operator-facing how-to, see `CLAUDE.md` § "Adding a new
workflow". This document remains the architectural reference.

## Goal

Lift the worker lifecycle so that "the way a worker is reviewed, what its state
machine looks like, and how its hooks behave" becomes data on a workflow
definition rather than hard-coded structure across `poller-*.ts`, `prompts.ts`,
and `header.ts`. The end state is a single named workflow, `default`, that
reproduces today's behavior exactly. Adding a second workflow later becomes a
data change plus a new prompt composition, not a fork in the state machine.

## Non-goals

- No new workflow kinds. No design-doc workflow, no ralph loop, no
  alternate worker launch shapes. Those are downstream work and only
  validated against this foundation.
- No new CLI surface. `garden newWorker --workflow X` and per-project
  default workflow config are deferred. The field exists; nothing sets it
  to anything but `default`.
- No worker-launch refactor. `buildWorktreeBootstrapScript` and the
  interactive Claude launch in `create.ts` are untouched. The headless
  agent primitive covers reviewer and resolver only.
- No registry-shape changes beyond a single optional `workflow?: string`
  field. The vestigial `role` and `parentWorker` fields are left alone.
- No spec-marker promotion. This document does not declare itself
  authoritative over the code (no "the code is wrong" line). Promotion is
  a future decision after the refactor lands and stabilizes.

## Background

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

## Design overview

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

## Component 1 — Headless agent primitive

**Module**: `src/dashboard/headless-agent.ts` (new).

**Public surface**:

```ts
export interface HeadlessAgentLaunchOptions {
  /** Working directory for the claude process (typically the worktree). */
  cwd: string;
  /** Hidden tmux window name. Killed first if it already exists. */
  windowName: string;
  /** Prompt content. Written to promptFile. */
  prompt: string;
  /** Where to write the prompt file (caller picks the path). */
  promptFile: string;
  /** Where claude writes stdout+stderr. Cleaned before launch. */
  resultFile: string;
  /** Output of claudeEnvPrefix(project) — e.g. `CLAUDE_CONFIG_DIR=... `. */
  envPrefix: string;
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

1. Writes `prompt` to `promptFile` atomically.
2. Removes `resultFile` if present (stale result from a previous run).
3. Kills `windowName` if it exists.
4. Creates a hidden tmux window in the dashboard session, working directory
   `cwd`, running:
   ```
   <inline-env-vars> <envPrefix>claude -p < <promptFile> > <resultFile> 2>&1; \
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

## Component 2 — Verdict parsing

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
   `/^([A-Za-z_]+)[.\s!]*$/` (the line must be only the verdict token,
   optionally followed by trailing punctuation/whitespace — same shape
   as the current reviewer's `VERDICT_LINE` regex). If the captured token
   uppercased is in `vocabulary`, that line is the verdict line; everything
   before it (joined, trimmed) is the body.
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

## Component 3 — Prompt composition

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
  return composePrompt(reviewSections, ctx);
}
```

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

## Component 4 — Workflow definition and registry

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
  onSessionStart: (ctx: HookContext) => HookAction;
  onUserPromptSubmit: (ctx: HookContext) => HookAction;
  onStop: (ctx: HookContext) => HookAction;
}

export interface WorkflowDefinition {
  name: string;
  /** Per-state valid transitions for transitionState() validation. */
  validTransitions: Record<PrState, PrState[]>;
  /** Dispatched by pollWorker. A state with no handler is a config bug. */
  stateHandlers: Partial<Record<PrState, StateHandler>>;
  /** Dispatched by handleClaudeHook. Default workflow's handlers are
   *  the current code, extracted unchanged. */
  hookHandlers: WorkflowHookHandlers;
}
```

`HookContext` and `HookAction` are extracted from the current Claude hook
handler in `src/dashboard/header.ts`. The shape is whatever the current
code already builds; this refactor just names it.

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
import { handleMergePending } from "../poller-merge.js";
import { handleResolving } from "../poller-resolve.js";
import { handleFailing, handleMerged, handleDone } from "../poller-state.js";
import { defaultHookHandlers } from "../hooks/default.js"; // see Phase 4
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
  hookHandlers: defaultHookHandlers,
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

## Component 5 — Dispatcher integration

The new primitives are useless unless the existing dispatchers consult
them. Three call sites change.

### 5a — `pollWorker` (`src/dashboard/poller.ts:74-106`)

Today, `pollWorker` switches on `entry.prState`. After the refactor:

```ts
function pollWorker(
  projectName: string,
  projectPath: string,
  baseBranch: string,
  entry: WorkerEntry,
): boolean {
  const workflow = getWorkflow(entry.workflow ?? "default");
  const state = entry.prState ?? "working";
  const handler = workflow.stateHandlers[state];
  if (!handler) {
    log.warn("poller", "no handler for state in workflow", {
      worker: entry.name,
      data: { state, workflow: workflow.name },
    });
    return false;
  }
  return handler(projectName, projectPath, baseBranch, entry);
}
```

The exhaustive switch is gone. Exhaustiveness is now enforced by the
test `each state in PrState has a registered handler in default`.

### 5b — `transitionState` (`src/dashboard/poller-state.ts:33-45`)

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

### 5c — Claude hook handler (`src/dashboard/header.ts`)

Today, `handleClaudeHook` is one big switch on hook kind that writes to
the registry directly. After the refactor:

1. Extract the existing handler bodies into `defaultHookHandlers` in
   `src/dashboard/hooks/default.ts`. Functions are unchanged in behavior;
   only the location changes.
2. `handleClaudeHook` becomes a thin dispatcher: read the worker's
   workflow, look it up, call the appropriate `hookHandlers.onXxx` method.
3. `defaultHookHandlers` is what the default workflow points to.

The reviewer/resolver short-circuit (`GARDEN_REVIEWER=1` env flag) lives
inside the default hook handlers — it is workflow-specific, not a
top-level concern. Future workflows that want different reviewer-tagging
can override it.

This is the part of the refactor that has the most surface area in
existing code. It is sequenced last (Phase 4) so the first three phases
ship a clean foundation before the hook handler is touched.

## Migration: replicating existing behavior as the default workflow

The acceptance criterion for the entire refactor is **bit-for-bit behavior
equivalence**. After Phase 4 lands, a worker on the default workflow goes
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
run end-to-end and must pass without modification.

## Backward compatibility

- **Registry on disk**: existing entries lack `workflow`. All consumers
  default to `"default"` on read. No migration script is needed; the
  field becomes present the next time the entry is updated through
  `updateWorkerFields`.
- **External imports**: `VALID_TRANSITIONS` is removed. Any code outside
  this refactor that imported it must be updated to call
  `getWorkflow(name).validTransitions`. This is a compile-time break, not
  a runtime one.
- **Hook handler signature**: the hook handler is dispatched through the
  workflow registry, but its external entry point (`handleClaudeHook`)
  preserves its signature. CLI internal command `_claude-hook` is
  unchanged.

## Testing strategy

Three layers, each with explicit acceptance criteria.

### Layer 1 — Unit tests for new primitives

| Module | Test file | Coverage |
|--------|-----------|----------|
| `headless-agent.ts` | `test/headless-agent.test.ts` | Launch shape, prompt write, result cleanup, window kill, `onLaunched` callback |
| `verdict.ts` | `test/verdict.test.ts` | Vocabulary match, scan window, body extraction, edge cases (empty, malformed, no match) |
| `prompt-compose.ts` | `test/prompt-compose.test.ts` | Section ordering, null skip, step counter, join behavior |
| `workflows/index.ts` | `test/workflows.test.ts` | Lookup, fallback, registration, exhaustiveness |

### Layer 2 — Snapshot tests on existing prompt builders

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

### Layer 3 — Integration tests

The two existing real integration tests
(`test/integration/poller-failures.real.test.ts`,
`test/integration/claude-hook.real.test.ts`) run unmodified through every
phase. They are the end-to-end tripwire: if the workflow refactor breaks
behavior, they fail.

A new integration test `test/integration/workflow-default.real.test.ts`
explicitly drives a worker through the default workflow's full state
machine and asserts every transition. This is the executable replacement
for the old hard-coded `VALID_TRANSITIONS` constant test (if any).

### Test command

`npx vitest run && npx tsc --noEmit` is the gate. Both must pass at the
end of every phase.

## Phasing

Each phase is independently mergeable and leaves the codebase in a working
state. The default workflow is incrementally constructed: Phase 1 and 2
introduce primitives that are *used by but not yet selected via* the
workflow registry; Phase 3 introduces the registry; Phase 4 routes hooks
through it.

### Phase 1 — Headless agent + verdict primitives

**Deliverables**:
- `src/dashboard/headless-agent.ts` with `launchHeadlessAgent`.
- `src/dashboard/verdict.ts` with `parseLastLineVerdict`.
- `launchReview` and `launchResolver` rewritten as callers.
- `parseReviewResult` and the resolver parser rewritten as callers.
- Unit tests for both new modules.
- Snapshot fixtures captured for `buildReviewPrompt` and
  `buildResolvePrompt` (these lock Phase 2's acceptance criteria).

**Acceptance**: integration tests pass unchanged. No behavior change.

### Phase 2 — Prompt composition

**Deliverables**:
- `src/dashboard/prompt-compose.ts` with `composePrompt` and
  `gatherPromptContext`.
- `src/dashboard/prompts.ts` rewritten as named sections plus
  compositions.
- Unit tests for the composition layer.
- Snapshot tests on `buildReviewPrompt` and `buildResolvePrompt` enforced.

**Acceptance**: snapshots from Phase 1 prep are byte-equal. Integration
tests pass unchanged.

### Phase 3 — Workflow definition and dispatcher

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

### Phase 4 — Hook handler workflow-awareness

**Deliverables**:
- `src/dashboard/hooks/default.ts` with the existing hook handler bodies
  relocated.
- `handleClaudeHook` in `header.ts` becomes a registry-aware dispatcher.
- The default workflow points to `defaultHookHandlers`.
- Tests for the hook dispatcher (`handleClaudeHook` reads
  `entry.workflow`, looks up the workflow, calls the right method).

**Acceptance**: `test/claude-hook.test.ts` and
`test/integration/claude-hook.real.test.ts` pass unchanged. Hook
behavior is byte-equal to pre-refactor.

After Phase 4, the foundation is complete. Adding a second workflow is
new work that does not touch any of the four phases above.

## Out of scope / explicit deferrals

The following are deliberately deferred. Each represents a future PR that
builds on this foundation; none of them require modifying the foundation.

- **Worker launch shape variants.** `buildWorktreeBootstrapScript` ends
  with an interactive `claude --session-id ...` invocation. Loop-based,
  headless-once, or other launch shapes will need a `WorkflowDefinition`
  field (e.g., `workerLaunch`) and a branch in the bootstrap builder.
  Adding it is mechanical; not adding it now keeps the foundation
  focused on the lifecycle layer.
- **CLI surface for picking workflow.** `garden newWorker --workflow X`,
  `⌥n` picker, per-project default workflow in `~/.garden/config.yml`.
  None of this exists yet. The `workflow` field is set to `"default"`
  in code by `newWorker` and `addWorker`.
- **Per-workflow sandbox profile.** `src/dashboard/sandbox.ts` builds
  one sandbox per worktree. Workflows that want different network or
  filesystem allowlists will extend `WorkflowDefinition` and branch
  in `sandboxForTarget`.
- **Per-workflow skills.** `installClaudeSkills` writes the same skills
  for every worker. Workflows wanting different skills add a `skills`
  field and branch in the installer.
- **Per-workflow rules injection.** Today, `buildRulesContext` includes
  global + project rules. Workflow-specific rules (e.g., "you are
  iterating on a design document") would be a third layer. Not added
  now.
- **`role` and `parentWorker` fields.** Vestigial fields on `WorkerEntry`,
  not consulted by any production code. Cleaning them up is unrelated
  to this refactor (see global rule "Don't refactor code that is unrelated
  to your task"). They can be removed later or repurposed.
- **Promotion to spec.** This document is a design for an upcoming
  refactor, not a spec for current behavior. After the four phases land
  and stabilize, a future PR can promote it to spec status by adding
  the marker line and reframing the prose. That is not part of the
  refactor itself.

## Open questions

These do not block the design but should be answered during implementation.

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
   `Partial<>`?** The default workflow has a handler for every state.
   Future workflows may not. Type the registry field as
   `Partial<Record<PrState, StateHandler>>` and let the test
   `each state in PrState has a registered handler` enforce
   exhaustiveness *for the default workflow only*. This gives
   alternate workflows the freedom to omit states they don't use.

# Workflows

This document covers (a) the workflow architecture — the registry that lets
garden host more than one worker lifecycle behind a single dispatcher — and
(b) the spec for each workflow that ships today. The `default` workflow is
the standard review/merge pipeline and is described inline below as the
foundation. The `trellis` workflow is a feature-scoped, spec-driven loop and
has its own section. **For the trellis workflow, if the code disagrees with
this document, the code is wrong.** The architecture section is descriptive
of completed work; the trellis section is authoritative.

For the operator-facing how-to on adding a new workflow, see `CLAUDE.md`
§ "Adding a new workflow". This document is the architectural reference and
the trellis spec.

## Workflow architecture

Design document for the architectural lift that prepared garden's worker
lifecycle to host multiple workflows. The deliverable was a refactor: existing
behavior is preserved bit-for-bit, but four extension points (headless-agent
launch, verdict parsing, prompt composition, workflow definitions) have been
extracted into reusable primitives. No new workflows shipped as part of that
refactor itself; the trellis workflow described later in this document was
the first concrete second workflow registered against the surface.

**Status**: foundation complete. The code matches this section. Adding a new
workflow is a data-only change plus optional new prompt sections; the
dispatcher in `poller.ts` and the hook handler in `header.ts` do not need
edits.

### Goal

Lift the worker lifecycle so that "the way a worker is reviewed, what its state
machine looks like, and how its hooks behave" becomes data on a workflow
definition rather than hard-coded structure across `poller-*.ts`, `prompts.ts`,
and `header.ts`. The end state is a single named workflow, `default`, that
reproduces today's behavior exactly. Adding a second workflow becomes a
data change plus a new prompt composition, not a fork in the state machine.

### Non-goals

- No new workflow kinds in the foundation refactor itself. Trellis was the
  first downstream workflow validated against the surface; further workflows
  build on the same primitives without modifying them.
- No new CLI surface in the foundation. `garden newWorker --workflow X` and
  per-project default workflow config were deferred and arrived with trellis.
- No worker-launch refactor. `buildWorktreeBootstrapScript` and the
  interactive Claude launch in `create.ts` are untouched. The headless
  agent primitive covers reviewer and resolver only.
- No registry-shape changes beyond a single optional `workflow?: string`
  field. The vestigial `role` and `parentWorker` fields are left alone.
- No spec-marker promotion of the architecture itself. The architecture
  section is descriptive of code that already exists and matches it; the
  trellis section is authoritative spec and carries the sentinel.

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
import { handleMergePending, handleMerged } from "../poller-merge.js";
import { handleResolving } from "../poller-resolve.js";
import { handleFailing, handleDone } from "../poller-state.js";
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

#### 5c — Claude hook handler (`src/dashboard/header.ts`)

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
- **Hook handler signature**: the hook handler is dispatched through the
  workflow registry, but its external entry point (`handleClaudeHook`)
  preserves its signature. CLI internal command `_claude-hook` is
  unchanged.

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

#### Phase 4 — Hook handler workflow-awareness

**Deliverables**:
- `src/dashboard/hooks/default.ts` with the existing hook handler bodies
  relocated.
- `handleClaudeHook` (now in `hook-dispatcher.ts`, originally in `header.ts`) becomes a registry-aware dispatcher.
- The default workflow points to `defaultHookHandlers`.
- Tests for the hook dispatcher (`handleClaudeHook` reads
  `entry.workflow`, looks up the workflow, calls the right method).

**Acceptance**: `test/claude-hook.test.ts` and
`test/integration/claude-hook.real.test.ts` pass unchanged. Hook
behavior is byte-equal to pre-refactor.

After Phase 4, the foundation was complete. Adding the trellis workflow
(see "Trellis workflow" below) did not modify any of the four phases above.

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
  `addWorker`; the trellis workflow brought CLI surface for picking.
- **Per-workflow sandbox profile.** `src/dashboard/sandbox.ts` builds
  one sandbox per worktree. Workflows that want different network or
  filesystem allowlists will extend `WorkflowDefinition` and branch
  in `sandboxForTarget`.
- **Per-workflow skills.** `installClaudeSkills` writes the same skills
  for every worker. Workflows wanting different skills add a `skills`
  field and branch in the installer.
- **Per-workflow rules injection.** Today, `buildRulesContext` includes
  global + project rules. Workflow-specific rules (e.g., "you are
  iterating on a design document") are injected by `buildWorktreeRules`
  for the trellis workflow.
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

## Trellis workflow

Spec for the **trellis** workflow: a feature-scoped, spec-driven loop in
which a worker iterates against a frozen design document until code,
tests, and documentation align. This section is the source of truth for
how the trellis workflow behaves. **If the code disagrees with this
section, the code is wrong.**

A trellis is the durable artifact across iterations; the worker, its
context window, and any individual commit are disposable side-effects.
The loop is bounded, the convergence criterion is computed (not
vibes-checked), and the asymmetry between trellis-as-authority and
implementation-as-experiment is preserved with one explicit escape valve
(see "Flagging the trellis").

### Why this exists, and why now

Garden already runs an event-driven review/merge cycle per project. With
the workflow refactor on main (the registry in `src/dashboard/workflows/`,
the generic verdict parser in `src/dashboard/verdict.ts`, the section-based
prompt composer in `src/dashboard/prompt-compose.ts`), the dispatcher is
no longer hard-coded to one lifecycle. Trellis is the second concrete
workflow registered against that surface. It does not replace the default
workflow — it sits beside it, used when the operator wants the agent to
loop against a stable design target rather than a one-shot task.

The pattern is adapted from the *ralph loop* literature (Huntley,
Horthy/HumanLayer, Anthropic's `/ralph-loop` plugin, snarktank/ralph,
SpecLoop). Garden already provides several of the load-bearing pieces
those projects had to bolt on: per-worktree isolation, automated review
with a structured verdict, an event-driven merge queue, an auto-continue
mechanism across the merge boundary, a global usage gate, and a
"the-code-is-wrong" spec convention. Trellis composes these into a loop;
it does not invent new primitives where existing ones suffice.

### Vocabulary

| Term            | Definition                                                                                       |
|-----------------|--------------------------------------------------------------------------------------------------|
| **Trellis**     | A markdown design document that describes a feature's intent, surface, behavior, tests, and docs. Lives in the project repo. Versioned in git. The reviewer treats it as the source of truth (same convention as `STATUS.md` / `TRACKS.md`). |
| **Vine**        | A worker bound to one trellis, looping until equilibrium. A project may have multiple vines active at once on different trellises. One worker per vine; one trellis per worker. |
| **Iteration**   | One full cycle of `working → reviewing → (merge or fail) → auto-continue`. Counted on the worker entry. |
| **Drift**       | A specific, named gap between the trellis and one of {code, tests, docs}. Produced by the reviewer as a list. |
| **Alignment**   | The state in which the reviewer reports zero drift items. The terminal happy path. |
| **Equilibrium** | Any terminal disposition: aligned, sentinel-set, budget-exhausted, stagnated, flagged-then-resolved. The loop has stopped. |
| **Flagging**    | The reviewer's third verdict: the trellis itself is contradictory, impossible, or incomplete. The loop pauses; only the operator can decide whether to amend the trellis or override the flag. |
| **Lessons**     | A worker-maintained file (`<worktree>/.garden/trellis-lessons.md`) summarizing what failed in past iterations. Loaded into the next iteration's context. The single channel of accumulated state across context resets. |

### The trellis document

A trellis is plain markdown. The convention is permissive on prose,
strict on a small machine-readable spine.

#### Required spine

1. **Title** (`# <Feature name>`) on the first line.
2. **Spec sentinel** somewhere in the first paragraph: the literal string
   `the code is wrong` (same convention as `STATUS.md` and `TRACKS.md`).
   The reviewer's `findSpecFiles()` already detects this.
   Without the sentinel, the reviewer treats the file as documentation,
   not authority.
3. **Trellis tag** (`<!-- trellis: v1 -->`) within the first 200 bytes
   of the file. Marks the document as a trellis (distinct from a
   system spec like STATUS.md or TRACKS.md). The matcher is the regex
   `<!--\s*trellis:\s*v\d+\s*-->`; future versions of the format will
   bump the version number, and tooling can branch on it. The CLI's
   `garden trellis list` filters by this tag, and the reviewer selects
   the trellis prompt branch on its presence.

#### Recommended sections

The reviewer reads the document as prose. Sections are not enforced —
the operator structures the trellis however the feature requires.
The following pattern is recommended because it makes the reviewer's
three-way diff (trellis ↔ code, ↔ tests, ↔ docs) tractable:

- **Intent** — one-paragraph summary of what the feature does and why.
  Mostly judgment-graded by the reviewer.
- **Surface** — the API/CLI/UI surface that must exist. Concrete.
  Reviewer can verify by grep + signature checks.
- **Behavior** — invariants the feature must satisfy. Mix of objective
  ("error path returns `{ok: false, reason}`") and judgment-graded
  ("errors should be specific and structured").
- **Tests** — test cases that should exist. Concrete: file path or test
  name expected. Reviewer can verify by grep on test files.
- **Docs** — documentation surface that should exist. Concrete: file
  paths + section titles or DESIGN.md/CLAUDE.md updates expected.
- **Out of scope** — explicit non-goals. Prevents the loop from chasing
  adjacent improvements.

The reviewer is told that a section's *absence* is not drift — only
contradictions and gaps named in the trellis are.

#### File location

Default: `<project-root>/.garden/trellises/<name>.md`. The directory is
configurable per project via the `trellisDir` config key (e.g.
`garden config <project> trellisDir docs/trellises` to surface them at
the top of the repo). The CLI's `garden trellis list <project>`
enumerates `*.md` files in that directory matching the trellis tag.

`.garden/` is the existing convention for garden-aware,
version-controlled project files (see `<project>/.garden/rules.md`).
Trellises are checked into git like the rules — they are not hidden
state. Operators are expected to read and edit them as ordinary design
documents.

A trellis that converged is a recorded design milestone; a trellis
amended mid-loop is a recorded conversation between intent and reality.
Both are valuable artifacts independent of the code they produced.

#### Authoring skill

Garden ships a `trellis-author` skill, bundled alongside `done` and
`handoff` and installed at
`<worktree>/.claude/skills/trellis-author/SKILL.md` for every worker
(not just trellis-workflow ones — an operator may want to formalize a
feature as a trellis from inside a default-workflow worker pane). The
skill triggers when the operator says they want to formalize a feature
as a trellis and walks the worker through:

1. Sizing scope (one feature, not a project; explicit "Out of scope").
2. Writing the spine (title, sentinel, trellis tag).
3. Filling the recommended sections (Intent, Surface, Behavior, Tests,
   Docs).
4. A self-review pass for ambiguity and contradiction before the
   trellis is committed.

Skills are more reliable triggers than instructions buried in a system
prompt because Claude Code uses skill descriptions as planning-time
selectors (see CLAUDE.md "skills.ts").

#### Retirement

A trellis whose feature has landed is still a valuable artifact — it
documents what the feature was supposed to do, and its git history
records the conversation between intent and reality. **Trellises are
never auto-deleted, never auto-archived, and never auto-anything on
vine equilibrium.** A vine reaching `ALIGNED` does not change the
trellis's status. The trellis can outlive one vine: the operator might
re-run it for verification, plant a competing vine on a different
approach, or reference it while building a related feature. The
"this is done, hide it" decision is the operator's, not the workflow's.

Retirement is manual via `garden trellis retire <project> <name>`. The
command appends a separate comment beneath the existing trellis tag:

```markdown
<!-- trellis: v1 -->
<!-- retired: 2026-05-05 — implementation in commits abc1234..def5678 -->
```

The retirement comment is a separate tag from the trellis tag (each
comment has one purpose — easier to grep, easier to diff). The matcher
is the regex `<!--\s*retired:\s*\d{4}-\d{2}-\d{2}\b.*?-->`; the date
is the only required field, the rest of the comment is operator-
freeform. The commit range is auto-filled from the most-recently-
aligned vine's commit history when `retire` is invoked; the operator
can hand-edit the line afterward to add prose context.

Retired trellises are filtered out of the **picker** (`⌥⇧n`) and the
CLI **refuses** to spawn a vine bound to a retired trellis — the
attempt errors with "trellis is retired; revive with
`garden trellis revive <name>` first." The trellis remains visible to
`garden trellis list` (in an "Archived" section beneath active ones)
and `garden trellis show` works unchanged. `garden trellis amend`
auto-revives on save (principle of least surprise: you don't edit a
tombstone; if you're touching it, it's alive again).

Reviving is symmetric: `garden trellis revive <project> <name>`
removes the retirement comment, returning the trellis to the picker.

A future archival sugar — `garden trellis archive` to *move* the file
to `.garden/trellises/archive/<name>.md` — is deferred. It only
matters if the file listing in `.garden/trellises/` itself becomes
cluttered enough to warrant directory separation. Sentinel-based
filtering covers the picker UX without the file move.

### The trellis workflow definition

A new `WorkflowDefinition` named `"trellis"`, registered in
`src/dashboard/workflows/index.ts` alongside `defaultWorkflow`.

#### Implementation entry points

For an implementer reading this spec to plan the work, the
load-bearing files are:

| File                                              | Purpose                                                                                                       |
|---------------------------------------------------|---------------------------------------------------------------------------------------------------------------|
| `src/dashboard/workflows/trellis.ts`              | New file. The `WorkflowDefinition` itself: validTransitions, stateHandlers, hookHandlers, `workerModel: "sonnet"`, `reviewerModel: "opus"`. |
| `src/dashboard/workflows/types.ts`                | Extend `WorkflowDefinition` with `workerModel?: "opus" \| "sonnet"` and `reviewerModel?: "opus" \| "sonnet"`. |
| `src/dashboard/workflows/index.ts`                | Register `trellisWorkflow` in the registry.                                                                  |
| `src/dashboard/registry.ts`                       | Extend `WorkerEntry` with the trellis fields and `failingReason` (see "Worker entry additions").             |
| `src/dashboard/poller-review.ts`                  | Branch on workflow in `handleReviewing`: trellis verdicts route to trellis-specific verdict parsing and disposition. |
| `src/dashboard/poller-merge.ts`                   | Branch on workflow in `finalizeMerge`: trellis ALIGNED writes `.garden-done`; trellis DRIFT calls `trellisAutoContinueAfterMerge`. |
| `src/dashboard/continue.ts`                       | New `trellisAutoContinueAfterMerge` (sibling of `continueWorkerAfterMerge`). Kills Claude, dispatches fresh seed.|
| `src/dashboard/prompts.ts` (or sibling)           | `trellisReviewSections` plus the new section primitives.                                                      |
| `src/rules.ts`                                    | Extend `buildWorktreeRules` with the three trellis paragraphs when `entry.workflow === "trellis"`.            |
| `src/dashboard/skills.ts`                         | Bundle `trellis-author` skill (description + body).                                                            |
| `src/commands/trellis.ts`                         | New file. `garden trellis` subcommand dispatch (list/show/new/status/amend/resume/budget/retire/revive).      |
| `src/commands/workers.ts`                         | Extend `garden workers new` with `--workflow`, `--trellis`, `--model`, `--max-iterations`. Pre-flight via `validateTrellisPlant`. |
| `src/dashboard/hotkeys.ts`                        | Bind `⌥⇧n` to the picker; the picker itself is a tmux popup invoking a new `dashboard _trellis-picker` internal subcommand. |
| `src/dashboard/usage.ts`                          | No changes — the Sonnet meter is already in the snapshot. The fallback logic reads the existing fields.       |
| `src/config.ts`                                   | Add `trellisDir`, `maxTrellisIterations`, `trellisOpusFallback` config keys.                                  |

Tests follow the patterns in `test/workflows.test.ts` (registry +
validTransitions equivalence) and `test/integration/workflow-default.real.test.ts`
(drive a vine through a real merge cycle). See "Phasing" for what
must be tested in v1 vs. later.

#### Reused state machine, no new `PrState` values

Trellis does **not** add states to the `PrState` union. The terminal
dispositions map onto existing states via fields on `WorkerEntry`:

- **Aligned** (reviewer-declared success) → write `.garden-done`,
  let `finalizeMerge` set `prState = "done"` via the existing path.
- **Flagged** (trellis itself contradictory) → `prState = "failing"` with
  `failingReason = "trellis-flagged"` (new field). The renderer
  decorates the row; the alert subsystem fires source `trellis`.
- **Budget exhausted** / **stagnation detected** → `prState = "failing"`
  with `failingReason = "iteration-budget"` or `"stagnation"`.
- **Sentinel-set** (operator stopped early) → `prState = "done"`,
  identical to default workflow.

This is a deliberate constraint. Every consumer of `PrState` (renderer,
plot aggregator, validator, status command, registry typings) is
unaffected. The trellis-specific decoration goes in additive fields
that workflow-aware renderers consult; default-workflow workers leave
those fields undefined and render exactly as today.

#### Valid transitions

Same shape as `defaultWorkflow.validTransitions`. The trellis workflow
adds no transitions and removes none. The only behavioral difference is
in the **state handlers**: `handleReviewing` parses a trellis-specific
verdict vocabulary, and the post-merge auto-continue dispatcher emits a
trellis-shaped prompt.

#### Hook handlers

Trellis wires `defaultHookHandlers` directly — `onSessionStart`,
`onPromptSubmitted`, `onBlockedOnOperator`, `onToolActivity`, and
`onTurnEnded` are all the default implementations (the trellis-specific
behavior lives in the state handlers, not in hook overrides). What
`onTurnEnded` does for a vine:

- **Stop with new commits ahead of base** — same as default: pokes the
  poller FIFO, sets `pendingReviewAt`. Triggers an iteration.
- **Stop with no new commits ahead and no `.garden-done` and a remaining
  drift list from the previous review** — counts toward the **stagnation
  counter**. Three consecutive Stops with no commits → `failing` with
  `failingReason = "stagnation"`. (See "Stagnation detection.")
- **Stop with no new commits ahead and `.garden-done` present** — same
  as default: `prState = "done"`.

#### Worker system prompt

The trellis-workflow worker's system prompt extends the default worker
rules with three trellis-specific paragraphs, injected by
`buildWorktreeRules` in `src/rules.ts` when `entry.workflow === "trellis"`:

1. **Concept.** A trellis is a frozen design document describing what
   the feature does. The path is `<resolved trellisPath>`. Read it
   before editing anything; it is your source of truth.

2. **Authority asymmetry.** You may edit code, tests, and
   documentation. You may **not** edit the trellis. If the trellis is
   wrong or impossible, do not silently rewrite it — push commits that
   reflect what the trellis says, and the reviewer will surface the
   contradiction as `FLAGGED`. The operator decides whether to amend.

3. **Iteration discipline.** You are operating inside a bounded loop.
   The reviewer's `DRIFT` report names priority-ordered gaps between
   the trellis and the artifact. Close the highest-priority gap first.
   Do not chase adjacent improvements. Do not redesign. The trellis's
   "Out of scope" section is the bound of your work.

Default-workflow workers are unaffected — the branch keys on the
workflow field.

#### Per-iteration context reset

The default workflow's post-merge auto-continue dispatches a prompt to
the worker's *existing* Claude session — conversation history compounds
across phases. **The trellis workflow does not.** Each iteration starts
with a fresh Claude process: after the merge transition, the workflow
handler kills the worker's Claude (same primitive `garden bounce` uses,
without `--resume`), and `claude` cold-starts in the same pane with the
trellis-shaped continue prompt as the first user message.

Why: ralph-loop literature is unanimous that compounding conversation
context across iterations produces drift, defensive patterns, and
rationalization of past dead-ends. Disk is the state. The lessons file
is the only intentional carry-over besides the trellis (read fresh from
git every iteration) and the code itself. Without this reset, a
30-iteration loop accumulates many phases of conversation that the
worker spends its tokens summarizing instead of closing drift.

Implementation: `trellisAutoContinueAfterMerge` in
`src/dashboard/continue.ts` (sibling of the default
`continueWorkerAfterMerge`). It stops the Claude process and dispatches
a fresh seed prompt via the same delayed-subprocess mechanism the
default uses. The pane stays alive throughout — only the Claude session
is reset, so tmux layout, environment variables, and the worktree's
`.claude/settings.json` are unchanged. The interrupt-recovery
auto-continue (default workflow's "continue from where you left off"
after a session crash) does not apply to trellis: an interrupted
vine restarts via the same fresh-context mechanism on the next push
event, seeded with the last drift list.

### The loop

```
       ┌────────────────────────────────────────────────────┐
       ▼                                                    │
   working ──Stop+commits──▶ reviewing ──ALIGNED──▶ merge   │
       ▲                          │                  │      │
       │                          │                  ▼      │
       │                          │             merge-pending
       │                          │                  │      │
       │                          ├──DRIFT──▶ merge ─┤      │
       │                          │                  ▼      │
       │                          │              merged     │
       │                          │                  │      │
       │                          │           auto-continue │
       │                          │           with drift list
       │                          │                  │      │
       │                          │                  └──────┘
       │                          │
       │                          ├──FAILED──▶ failing
       │                          │                │
       │                          │           worker fix + push
       │                          │                │
       │                          └──FLAGGED──▶ failing
       │                                       (trellis-flagged)
       │                                            │
       │                                       operator amends
       │                                       trellis or overrides
       └────────────────────────────────────────────┘
```

Reading the diagram: the `merged → auto-continue → working` shared
arrow above is *only* taken on `DRIFT`. On `ALIGNED`, the workflow
writes `.garden-done` before `merge-pending`, which causes
`finalizeMerge` to set `prState = "done"` and skip the auto-continue
dispatch entirely — the loop terminates. `FAILED` and `FLAGGED` skip
the merge transition altogether. Only `DRIFT` re-enters `working`.

#### One iteration, in detail

1. **Trigger.** Worker pushes commits and the Stop hook fires (or the
   pre-push hook fires before Stop on slower disks). Stop hook sees
   commits ahead of base, sets `pendingReviewAt`, pokes the poller.
2. **Review.** Poller transitions `working → reviewing`. Launches a
   reviewer via `launchHeadlessAgent` with the **trellis review prompt**
   (see "Reviewer prompt"). Reviewer: rebases worker's branch onto
   `origin/<base>`, runs `checks` if configured, and produces a verdict.
3. **Verdict parse.** Reviewer's last-line verdict is one of:
   - `ALIGNED` — code, tests, docs all match the trellis. No drift.
   - `DRIFT` — checks pass, code is mergeable, but trellis alignment
     incomplete. The body lists drift items.
   - `FAILED` — code is broken (checks failed, rebase failed, rules
     violated, reviewer couldn't fix). Same semantic as default
     workflow's FAILED.
   - `FLAGGED` — the trellis itself is contradictory, impossible, or
     internally inconsistent. The body lists the cited clauses and the
     contradiction.
   The reviewer's verdict vocabulary is declared `as const` and passed
   to `parseLastLineVerdict<TrellisVerdict>(...)`. Unparseable → re-queue
   path identical to default workflow.
4. **Branch on verdict.**
   - `ALIGNED` — write `.garden-done` to the worktree (workflow handler
     does this on the worker's behalf), force-push, transition to
     `merge-pending`. `finalizeMerge` later sets `done` and dispatches
     no auto-continue (sentinel present).
   - `DRIFT` — force-push, transition to `merge-pending`. `finalizeMerge`
     sets `merged`, then **resets the worker's Claude session to a
     fresh context** (see "Per-iteration context reset") and dispatches
     the trellis-shaped continue prompt with the drift list as the
     first user message.
   - `FAILED` — `prState = "failing"`, `failingReason = "code"`, alert.
     Worker resumes on push event + 30s debounce. Identical to default.
   - `FLAGGED` — `prState = "failing"`, `failingReason = "trellis-flagged"`.
     Alert source `trellis`, message includes cited clauses. The worker
     does NOT auto-resume on push; the operator must run
     `garden trellis resume <worker>` after editing the trellis or
     accepting an override (see "Flagging the trellis").
5. **Iteration counter.** On the `working → reviewing` transition,
   increment `entry.trellisIteration` *before* the budget check and
   *before* dispatching the review. After the increment, the counter
   reflects the iteration about to be reviewed (1 during the first
   review, 2 during the second, etc.). The continue prompt's "Iteration
   N of M" line is dispatched post-merge, *before* the next iteration's
   increment fires, so the prompt builder reads `entry.trellisIteration
   + 1` to label the upcoming iteration: the seed for iteration K is
   labeled "Iteration K." The poller transition logs at info with
   `iteration: N` in the data field, so `⌥l` makes the cadence visible.

#### No up-front phased plan

Garden's default workflow encourages multi-phase plans for complex
tasks: the worker proposes phases, the operator confirms, then phases
land in sequence. **Trellis explicitly does not.** The trellis itself
is the plan. The reviewer's `DRIFT` verdict is the per-iteration plan:
a priority-ordered list of gaps between trellis and reality. The worker
does not decide what to build next; the reviewer's drift list does.

A pre-baked phase list calcifies around early assumptions — assumptions
that the trellis itself may invalidate as implementation pressure
surfaces unstated constraints. Worse, a phase list is itself a
mini-spec the worker would then be tempted to "stay aligned with,"
splitting authority between trellis and plan. The trellis must be the
single source of truth.

Operator visibility is provided through `garden trellis status`
(iteration count, last verdict, drift list, lessons), not through a
frozen phase document. This is the structural difference between
trellis and the default multi-phase workflow.

#### Why merge on DRIFT

Merging incremental progress is the right tradeoff. The alternatives —
hold all commits until aligned, or let the worker accumulate dozens of
commits on a stale branch — both lead to merge conflicts that grow with
each iteration and block the rest of the project. The existing reviewer
already gates merges on tests/checks/rules; if those pass, the diff is
mergeable regardless of trellis-alignment status.

The cost is that `main` may carry partial implementations of the feature
during the loop. This is acceptable for two reasons:

1. The reviewer's existing rules-based check ensures partial code is
   *correct* even if not *complete* (no broken builds, no failing tests,
   no rule violations).
2. The trellis's "Out of scope" section explicitly bounds what the loop
   can touch. Iterations that add scope creep are caught as drift and
   bounce back.

### Equilibrium and termination

"Done" is plural. The trellis workflow recognizes five terminal
dispositions, and each has a distinct semantic and visual treatment:

| Disposition         | How reached                                                               | `prState` | Decoration                            | Operator action                        |
|---------------------|---------------------------------------------------------------------------|-----------|---------------------------------------|----------------------------------------|
| **Aligned**         | Reviewer outputs `ALIGNED`                                                | `done`    | `trellisAligned: true` field on the entry; status row uses the standard `done` icon and adds `✓ aligned, N iters` in the trellis bracket so reviewer-declared alignment reads distinctly from operator sentinel-set | Inspect, clean up, retire trellis      |
| **Sentinel-set**    | Operator (or worker) writes `.garden-done` mid-loop                       | `done`    | Default `done` rendering              | Inspect, clean up                      |
| **Budget-exhausted**| `trellisIteration` exceeds `maxIterations`                                | `failing` | `failingReason: "iteration-budget"`   | Inspect, decide: amend trellis & retry, raise budget, or kill |
| **Stagnated**       | Three consecutive iterations with no diff progress                        | `failing` | `failingReason: "stagnation"`         | Inspect, decide: amend trellis, hand-write next move, or kill |
| **Flagged**         | Reviewer outputs `FLAGGED`                                                | `failing` | `failingReason: "trellis-flagged"`    | Amend trellis, then `garden trellis resume`; OR override; OR kill |

The first two are happy-path equilibria. The last three are
operator-action equilibria. There is no fourth bucket: the loop either
converges, runs out of resources, or stops on a contradiction.

#### The iteration budget

Every vine has a `maxIterations` cap. Default: **30**.
Configurable per worker at plant time (`--max-iterations`) and per
project (`maxTrellisIterations` config key).

When `trellisIteration` reaches the cap, the next transition into
`reviewing` short-circuits to `failing` with
`failingReason = "iteration-budget"`. The alert text includes the
iteration count and the most recent drift list.

The cap is the *primary* safety net. The drift verdict (`ALIGNED`) is
the secondary signal — strings can fail open, especially under context
pressure or model regression. A loop that cannot stop is a money
incinerator and must always have a hard stop. This is the single most
emphasized lesson from the ralph-loop literature.

#### Stagnation detection

The drift list shrinking across iterations is the implicit signal of
progress. Stagnation is its absence. The trellis workflow defines
stagnation as one of these signatures, all of which trip the same
disposition:

1. **No diff between iterations.** SHA at end of iteration N equals SHA
   at end of iteration N-1 (the worker pushed nothing new). One
   iteration: tolerated. Three consecutive: stagnation.
2. **Oscillating drift list.** The set of drift items in iteration N is
   identical to N-2, with N-1 different. (Fix-A-breaks-B oscillation.)
   Detected over a 4-iteration window.
3. **Same top drift item across 5 iterations.** The reviewer keeps
   citing the same drift item as the highest priority, but the worker's
   commits don't address it. Different from #1 because the worker IS
   making commits, just not on the right thing.

Implementation-wise, stagnation tracking lives on the worker entry
(`trellisDriftHistory: string[][]`, `trellisShaHistory: string[]`,
bounded length 5). The poller's review handler appends after each
verdict parse and computes the signatures.

The stagnation signatures are heuristics, not proofs. False positives
are acceptable because the disposition is "ask the operator," not
"delete the work." False negatives are caught by the iteration budget
as a backstop.

#### Flagging the trellis

This is the load-bearing escape valve. Without it, an internally
inconsistent trellis loops forever (or to budget exhaustion) with no
diagnostic surfaced. The flag lets the reviewer say "I cannot satisfy
this" — without giving it permission to *change* the trellis. The
asymmetry is intentional: the trellis still wins by default; it is
just no longer infallible.

The reviewer's prompt instructs it to **bias against flagging**. The
phrasing matters: "assume the trellis is right; flag only when you can
articulate a specific contradiction with line references." Otherwise
the flag becomes the lazy default and the trellis loses its authority.

When `FLAGGED` fires:

1. `prState = "failing"`, `failingReason = "trellis-flagged"`.
2. Alert raised, source `trellis`, with a structured body containing
   the trellis path, the cited clauses (with line numbers), and the
   reviewer's contradiction prose.
3. Worker is paused: the `failing → working` push debounce does NOT
   apply to flagged vines. New commits the worker pushes do not
   trigger a re-review until the operator runs `garden trellis resume`.
4. Operator's choices:
   - **Amend trellis.** Edit the trellis file, commit it, then
     `garden trellis resume <worker>`. The next iteration's reviewer
     sees the updated trellis (no caching — always read at HEAD). The
     drift list is regenerated from scratch.
   - **Override.** `garden trellis resume <worker> --override
     "<rationale>"`. Writes a line to
     `<worktree>/.garden/trellis-overrides.md` recording the cited
     clause and the operator's rationale. Future reviewers receive the
     overrides file as part of their prompt and are instructed not to
     re-flag the same clause for the same reason.
   - **Kill.** `⌥x` or `garden workers kill`. The trellis lives on; a
     new vine can be planted later.

Override is meaningful but rare. The expected default is amend. An
override accumulates technical debt visible in the file —
`trellis-overrides.md` is the audit trail of "places we knowingly
diverge from the trellis."

### The drift loop in detail

A trellis vine sees two distinct prompt shapes during its lifetime:

- **Iteration 1 (seed).** Sent at vine-plant time via the worker
  bootstrap, not via auto-continue. There is no prior drift list
  (no review has run yet) and no lessons file. Structure: trellis
  content + a "you are implementing this trellis" instruction +
  the path to `trellis-lessons.md` with a note that the worker
  creates it. Defined alongside `buildWorktreeRules` extensions
  (see "Worker system prompt").

- **Iteration N ≥ 2 (continue).** Sent post-merge by
  `trellisAutoContinueAfterMerge` after the per-iteration context
  reset. Carries the priority-ordered drift list from the previous
  reviewer pass plus the inlined lessons file. Structure below.

The two prompts use the same Claude process surface (a fresh
cold-started `claude` reading from stdin) but diverge in content
because their preconditions differ. The default workflow has only
the iteration-1 shape (its "continue with the next phase" prompt is
sent into a still-live session, not a fresh cold-start, so it is a
different mechanism from this one).

#### Continue prompt structure

```
Your previous iteration was merged. The trellis at `<path>` is your
authority — read it before editing.

Iteration N of M.

Files that changed during review:
  - <list from `pendingContinueChangedFiles`>

Drift remaining:
  1. <highest-priority drift item>
  2. <next>
  ...

Lessons from previous iterations (`<worktree>/.garden/trellis-lessons.md`):
  <inlined>

Address the highest-priority drift item first. You may address others
in the same iteration if directly related, but do not chase adjacent
work — the trellis's "Out of scope" section bounds you. After your
changes, append a one-line entry to trellis-lessons.md describing what
you tried and what you learned. Commit and push when ready. The
reviewer will compare your work against the trellis; if all drift is
resolved, the loop ends.
```

#### One drift per iteration (recommended), all of them (allowed)

Ralph-loop wisdom is "one task per loop." The trellis loop softens this
to "one *priority* task per loop, others if directly related." Stricter
forms (one item only, even if trivial fixups remain) waste iterations
on trivially-bundle-able fixes. Looser forms (chase everything) drift
into adjacent work and lose context-window discipline.

The reviewer's drift list is **priority-ordered**. The worker is
expected to attack from the top down and stop when context utilization
hits the warn threshold (heuristic: when responses start summarizing
prior work). The reviewer doesn't enforce single-item iterations —
it just notes whether the worker addressed item #1.

#### The lessons file

`<worktree>/.garden/trellis-lessons.md`. Worker-maintained, append-only
within an iteration but rewriteable across iterations. Loaded into the
worker's continue prompt verbatim. Bounded by length: workflow handler
truncates the oldest entries when the file exceeds 4KB.

The lessons file is the explicit channel for accumulated state across
context resets. Without it, every iteration starts blank and re-discovers
the same dead ends. With it, the worker carries forward a tight,
worker-curated summary of what failed and why. This is the single most
effective ralph-loop guardrail, per the literature.

The reviewer is **not** prompted with the lessons file. Lessons are the
worker's notes to itself; the reviewer evaluates the artifact (code,
tests, docs) against the trellis, full stop.

### Reviewer prompt and verdict

#### Section composition

The trellis review prompt is built from `composePrompt(trellisReviewSections, ctx)`.
It reuses sections from the default review and adds three trellis-specific
ones:

```ts
export const trellisReviewSections: readonly PromptSection[] = [
  reviewIntroSection,             // generic intro
  reviewSpecWarningSection,       // "the code is wrong" preamble
  trellisAuthoritySection,        // NEW: trellis-specific authority statement
  reviewRebaseStepSection,        // numbered: "Rebase onto origin/<base>"
  reviewChecksStepSection,        // numbered: "Run checks"
  trellisAlignmentStepSection,    // NEW: numbered: "Three-way diff against trellis"
  reviewBranchInfoSection,
  reviewCommitsSection,
  reviewRulesSection,
  reviewDiffSection,
  reviewDocumentationSection,
  reviewTestFilesSection,
  trellisDocumentSection,         // NEW: inlines the trellis at HEAD
  trellisOverridesSection,        // NEW: inlines trellis-overrides.md if present
  trellisVerdictFormatSection,    // overrides: ALIGNED|DRIFT|FAILED|FLAGGED
];
```

The default review's `reviewVerdictFormatSection` is replaced with
`trellisVerdictFormatSection`, not appended after — section names are
unique within a list, and the trellis section's `name` matches the
default's so it overrides cleanly.

#### `trellisAuthoritySection`

Asserts the asymmetry. Verbatim text (not paraphrased — the prompt
matters here):

> The trellis is the source of truth for this feature. Your job is to
> compare the code, tests, and documentation against the trellis and
> report drift. You are not a general-purpose code reviewer in this
> mode — you do not propose stylistic changes, do not extend scope, do
> not improve adjacent code. You compare against the trellis.
>
> Bias toward DRIFT over FLAGGED. If a clause seems hard to satisfy,
> assume the implementer is at fault. Only emit FLAGGED if you can
> articulate a specific contradiction in the trellis, citing line
> numbers, that no implementation could satisfy.

#### `trellisAlignmentStepSection`

Step instruction, numbered via `ctx.nextStep()`:

> Step N: Three-way drift analysis.
>
> For each section of the trellis (Surface, Behavior, Tests, Docs):
> 1. List the trellis's claims in that section.
> 2. For each claim, locate the corresponding artifact (a function, a
>    test, a doc section). Use grep, file reads, or the test runner.
> 3. Mark each claim as `present`, `partial`, or `absent`.
>
> Output a structured drift list (see verdict format below). Drift
> items are priority-ordered: `absent` highest, `partial` next, prose
> mismatches lowest.

#### `trellisVerdictFormatSection`

Output contract:

> End your review with one of these verdicts on the final line:
>
> - `ALIGNED` — every trellis claim has a corresponding present
>   artifact, all checks pass, no drift remains.
> - `DRIFT` — the diff is otherwise mergeable (rules satisfied, checks
>   pass) but trellis alignment is incomplete. Above the verdict line,
>   list each drift item as a numbered bullet, priority-ordered, in
>   this format:
>
>       1. [surface] `foo()` exists but takes no `timeout` arg (trellis line 47)
>       2. [tests] no test for the timeout behavior (trellis line 91)
>       3. [docs] CLAUDE.md unchanged; trellis line 122 requires a section update
>
> - `FAILED` — the diff is not mergeable. Cause: tests failed, rebase
>   failed, rules violated, or reviewer could not fix. Identical
>   semantic to the default workflow's FAILED.
> - `FLAGGED` — the trellis itself is contradictory or impossible.
>   Above the verdict line, cite the clauses with line numbers and
>   describe the contradiction. Be specific.
>
> Use only one verdict. The verdict word must be the last non-empty
> line of your review.

#### Verdict parser

```ts
const TRELLIS_VERDICTS = ["ALIGNED", "DRIFT", "FAILED", "FLAGGED"] as const;
type TrellisVerdict = (typeof TRELLIS_VERDICTS)[number];

const result = parseLastLineVerdict<TrellisVerdict>(output, TRELLIS_VERDICTS);
```

Vocabulary is declared `as const` so the result is narrowly typed. The
parser primitive is unchanged. Unparseable verdicts flow through the
shared, workflow-agnostic `handleUnparseableReview`: if the reviewer
committed work, its commits are force-pushed and the review re-queues
once; if the reviewer committed nothing (a benign flake — prose instead
of a verdict token), the review re-queues on a short flat backoff up to
a bounded budget (`MAX_UNPARSEABLE_REVIEW_RETRIES`), then the worker
transitions to `failing` with `failingReason = "unparseable-verdict"`
(`garden kick`-recoverable). This matches the default workflow's
behavior on unparseable output; see `docs/STATUS.md` for the exact
backoff and budget.

### Model selection and budget

Trellis differs from the default workflow in defaulting workers to a
cheaper model. Reviewers stay at full quality. Both decisions are
encoded in the workflow definition; the worker model is overridable
per worker, the reviewer model is not.

#### Defaults

| Role     | Model       | Rationale                                                                                                            |
|----------|-------------|----------------------------------------------------------------------------------------------------------------------|
| Worker   | Sonnet 4.6  | Per-iteration tasks are mechanically narrow ("close the top drift item"). Sonnet handles them reliably; Opus's edge does not justify ~5x cost across 30 iterations. |
| Reviewer | Opus 4.x    | Single-shot, high-stakes verdict. The three-way diff is exactly the kind of judgment Opus does best. Cost is bounded — one call per iteration. |
| Resolver | Opus 4.x    | Reuses the default-workflow resolver. Conflict resolution is judgment-heavy. Inherits, not configured per-workflow. |

The defaults live on the workflow definition (`workerModel: "sonnet"`,
`reviewerModel: "opus"`). The default workflow leaves `workerModel`
unset, falling through to the project's existing model selection
(today: Opus). No behavior change for default-workflow workers.

#### Per-worker override

`--model` flag at plant time, persisted to `WorkerEntry.workerModel`:

```
garden workers new <project> --workflow trellis --trellis <name> --model opus
garden workers new <project> --workflow trellis --trellis <name> --model sonnet
```

Each iteration's spawn reads `entry.workerModel` first, falls back to
the workflow definition's `workerModel`, then to the project default.
Use `--model opus` for trellises whose per-iteration work is genuinely
hard (architectural changes, subtle invariants); leave the default for
mechanical convergence work.

#### Sonnet exhaustion fallback

The Sonnet meter is tracked separately in the usage snapshot
(`fiveHour.sonnet`, `weekly.sonnet`). The global auto-continue gate
(`autoContinueGateReason` in `poller.ts`) deliberately excludes Sonnet
today because Sonnet is unused. Trellis makes Sonnet load-bearing, so
exhaustion needs explicit handling — but **not** by extending the
global gate. The fallback is local to trellis spawn logic.

**Rule:** before spawning a Claude process for a trellis iteration,
check the Sonnet 5h and weekly meters against the project's
`usageThreshold` (default 95%). If either is at or above threshold,
fall back to **Opus** for that iteration. Two pass-through cases skip
the fallback entirely: a requested model other than the literal
"sonnet" alias (the fallback models Anthropic's Sonnet quota economy,
nothing else), and a project whose workers run on a provider
(`garden config <project> provider` — the Anthropic meter says nothing
about the backend the alias maps to there; see docs/MULTI-MODEL.md). Fire one alert per Sonnet
reset window (source `trellis-budget`, deduped via
`WorkerEntry.trellisModelFallbackAt`), so the operator knows the
quota stance has flipped.

The fallback is **per-iteration, not per-session**. Each iteration
starts cold (Invariant 8); the spawn picks the model fresh. Sonnet
recovers → next iteration switches back to Sonnet. No mid-session
model swapping (brittle, and Claude Code does not support it cleanly).

The global usage gate continues to ignore Sonnet — its job is "Opus
is exhausted, stop everything," and it gates only on Opus 5h/weekly.
If Sonnet is exhausted *and* Opus is also at threshold, the global
gate trips on Opus and auto-continue pauses (existing behavior). The
operator's `garden auto on` clears it.

#### Disabling the fallback

Some operators prefer "pause the loop rather than spend Opus tokens."
Configurable per project:

```yaml
projects:
  garden:
    trellisOpusFallback: false       # default: true
```

With `false`, Sonnet exhaustion routes through the existing usage-pause
mechanism (alert source `usage`, gate flipped, `pausedReason` set,
`pausedUntil` = Sonnet meter's `resetsAt`). The loop resumes when
Sonnet resets or the operator runs `garden auto on`.

#### The reviewer model is not negotiable

The reviewer always runs at the workflow's `reviewerModel`, regardless
of worker model or quota state. A reviewer on a degraded model produces
unreliable verdicts, which silently corrupts the convergence signal —
and a corrupted convergence signal is the worst possible failure for
this loop. If the reviewer's model is exhausted, the loop pauses via
the global gate. There is no reviewer fallback. Cost is bounded (one
call per iteration), so this is rarely binding.

### Status display

Trellis vines are visually distinct in three places: the worker row in
the status pane, the plot strip aggregation, and the bottom bar's
project line. The renderer reads `entry.workflow` and the trellis-specific
fields without changing how default-workflow workers render.

Trellis vines are interactive workers (tmux pane, attachable,
`⌥`-cyclable), not headless agents — only the *Claude process inside*
gets killed and respawned between iterations. They live in the same
status pane as default workers, sorted **below** default-workflow
workers within a project so the operator's eye lands on actively-
steered work first and on autonomous loops second. There is no
separate "type" field on worker entries; `entry.workflow` carries the
distinction and drives conditional decoration.

The long-term primitive — once a third workflow joins — is per-workflow
row rendering: a `WorkflowDefinition.renderRow(entry, ctx)` method that
each workflow owns. v1 inlines the trellis decoration in the existing
renderer; v2 graduates to per-workflow renderers. Out of scope for
this spec.

#### Worker row

A trellis-workflow row carries an iteration counter and (when relevant)
a drift count. Layout (using STATUS.md's icon vocabulary as placeholders;
real Unicode in `src/commands/status.ts`):

```
% swift-oak [trellis: auth-rewrite | 4/30 | 3 drift]
```

Components:

- **State icon** (`%` here = `reviewing`) — reused from existing
  `resolveWorkerStatus()` mapping. Trellis adds no new state icons.
- **Worker name** — unchanged.
- **Trellis tag** (`[trellis: <name>`) — the bound trellis. Truncated
  with ellipsis if the row is short.
- **Iteration counter** (`4/30`) — current/max. Color: white normally,
  yellow when ≥80% of budget, red when ≥95%.
- **Drift count** (`3 drift`) — non-zero only when the last verdict was
  `DRIFT`. Hidden on `ALIGNED` (zero), failed states (use failure
  reason instead), and pre-first-review iterations (no data).

Failed states show the failure reason instead of the iteration counter:

```
x swift-oak [trellis: auth-rewrite | flagged]
x swift-oak [trellis: auth-rewrite | budget exhausted]
x swift-oak [trellis: auth-rewrite | stagnated]
```

The aligned state shows a check decoration to distinguish reviewer-
declared success from operator sentinel-set:

```
= swift-oak [trellis: auth-rewrite | ✓ aligned, 7 iters]
```

#### Plot strip

The plot-state aggregator (`src/dashboard/plot-status.ts`) computes a
single icon per plot from the worst-priority worker state. Trellis
vines slot into the existing priority order with one addition:

```
failing > asking > working > done > idle
       │
       └─ within failing, trellis-flagged is the highest-priority
          alert source because it requires authoring decisions, not
          mechanical fixes
```

`failingReason = "trellis-flagged"` does not change the plot icon
(still `✖`); it changes the alert badge title that appears when
hovering / inspecting. The aggregator is unaware of trellis specifics
beyond reading `failingReason` to construct the badge text.

#### Bottom bar

When the active project has any trellis vine running, the bottom-bar
left segment appends a compact summary:

```
garden | main | trellises: auth-rewrite (4/30, drifting), session-cleanup (✓)
```

Vines listed in plant order. Aligned vines marked `✓`; drifting
shows iteration/budget; flagged shows `⚑`; budget-exhausted shows `!`.
Truncated with `…` if too wide.

#### Logs

Every iteration logs a single `info` line:

```
{"level":"info","source":"poller","msg":"trellis iteration","worker":"swift-oak",
 "data":{"trellis":"auth-rewrite","iteration":4,"verdict":"DRIFT","driftCount":3,
         "alignedCount":7,"projectName":"garden"}}
```

`alignedCount` is the running count of trellis claims marked `present`
by the reviewer (extracted from the structured drift list during
parsing — see "Verdict parser"). Together with `driftCount` it gives
the operator a numeric convergence trajectory in `⌥l`.

Stop hooks, push events, merge events, alerts: same logging surface as
default workflow. No trellis-specific events beyond the iteration line.

### CLI surface

Two new subcommand groups: `garden trellis ...` for trellis-document
management, and arguments to existing worker spawning for binding a
worker to a trellis.

#### `garden trellis`

```
garden trellis list <project> [--active]
                                          List trellises in the project's trellisDir. Active first, retired in an "Archived" section beneath. --active filters to non-retired only.
garden trellis show <project> <name>      Print a trellis's content (paged in TTY). Works on active or retired trellises.
garden trellis new <project> <name>       Scaffold a new trellis with the recommended sections.
garden trellis status <worker>            Show iteration count, last verdict, drift list, lessons file.
garden trellis amend <worker>             Open the worker's bound trellis in $EDITOR (resolved via entry.trellisPath). Commits to the project's main checkout, not the worker's branch — the trellis lives on main. Auto-revives a retired trellis on save (you don't edit a tombstone — if you're touching it, it's alive again).
garden trellis resume <worker> [--override "<rationale>"]
                                          Resume a flagged vine. With --override, records an override entry.
garden trellis budget <worker> <N>        Update maxIterations on the worker entry.
garden trellis retire <project> <name>    Mark a trellis as retired (adds the retirement comment, fills in the vine's commit range). Filters it out of the picker; CLI vine spawns refuse to bind to it.
garden trellis revive <project> <name>    Remove the retirement comment. Trellis returns to the picker.
```

`garden trellis status` is the operator's "where is this vine?"
command. Sample output:

```
$ garden trellis status swift-oak
worker:        swift-oak
project:       garden
trellis:       .garden/trellises/auth-rewrite.md
iterations:    4 / 30
last verdict:  DRIFT (2026-05-03T14:22:11Z)
drift items:
  1. [surface] AuthClient missing the timeout option
  2. [tests]   no test for token-refresh race
  3. [docs]    CLAUDE.md auth section unchanged
aligned items: 7
stagnation:    0/3 (no concerning pattern)         # post-v1.5: stagnation tracking
lessons:       <last 3 lines from trellis-lessons.md>
```

#### Spawning a trellis vine

Two paths: a hotkey-driven picker (the daily driver) and a flag-driven
CLI invocation (for scripts and automation).

**Hotkey: `⌥⇧n`** (sibling of `⌥n` for default workers) opens the
**workflow picker**; selecting the `(t)` row opens the trellis picker
described here. (When trellis was the only workflow option, `⌥⇧n` was
bound directly to this picker; the workflow picker was added when grow
shipped alongside.) The trellis picker overlays the active pane,
populated from the project's `trellisDir` and **filtered to non-retired
trellises** (see "Retirement"). Each row shows the trellis name and a one-line summary
so similar names disambiguate at a glance. Summary resolution order:

1. The first non-blank line under an `## Intent` heading, if present.
2. Otherwise, the first non-blank prose paragraph after the title and
   trellis tag — the trellis's de facto opening sentence.
3. Otherwise, an em dash placeholder. (Empty trellises shouldn't
   exist past `trellis new`, but the picker degrades gracefully.)

Summaries are truncated to the picker's row width with `…`. Arrow
keys to select, enter to plant. `maxIterations` defaults from project
config or 30.

The picker handles three population states (active trellises only —
retired ones are not counted):

| Active trellises | Behavior                                                                                                           |
|------------------|--------------------------------------------------------------------------------------------------------------------|
| Zero             | Empty-state with two actions: `[a] author one` (spawns a default worker pre-prompted to invoke the trellis-author skill) and `[n] scaffold blank` (runs `garden trellis new` with a name prompt). No dead-end. If retired trellises exist in the project, the empty state also shows `[r] revive a retired trellis` as a third action. |
| One              | Skip the picker entirely; plant immediately. The picker exists for choice — there is no choice here.              |
| Two or more      | Standard picker. Arrow-key navigation, type-to-filter, enter to plant.                                             |

The picker doubles as discovery: an operator who forgets what
trellises exist in a project can hit `⌥⇧n` and pick `(t)` to browse
without leaving the dashboard. There is no need to first run `garden trellis list`.

**CLI: `garden workers new <project> --workflow trellis --trellis <name> [--model opus] [--max-iterations N]`.**
Same machinery as the hotkey, just explicit. Required for scripts,
automation, and any path where typing the name is more convenient than
picking. The CLI does not invoke the picker — `--trellis <name>` is
the contract.

The worker is bootstrapped identically to a default worker — git
worktree, branch named after the worker, sandbox config, hooks
installed. The only difference is `entry.workflow = "trellis"` and the
trellis-specific fields are populated. The worker's *first* prompt
(seed) is the trellis content + a one-line "implement this" instruction
+ the path to `trellis-lessons.md` (which doesn't exist yet on
iteration 1; the worker creates it).

##### Plant-time pre-flight

Both the picker and the CLI run the same pre-flight checks before
spawning. The list, in order:

1. **Trellis exists.** The named trellis resolves to a file under
   `trellisDir`. Missing → error with the available list (CLI) or
   empty-state (picker; should not happen since the picker is built
   from the directory).
2. **Trellis is not retired.** Retirement comment absent. Retired →
   error with "trellis is retired; revive with `garden trellis revive
   <name>` first." (CLI only — the picker pre-filters retired
   trellises.)
3. **Spec sentinel present.** The literal `the code is wrong` appears
   in the first 2KB. Missing → warn but proceed; the reviewer's
   authority instructions degrade without it. The warning text
   suggests `garden trellis amend` to add the sentinel.
4. **`checks` configured.** The project's `checks` config key is set.
   Missing → tip (not error) suggesting `garden config <project>
   checks "<command>"`. Verdicts are stronger when the reviewer can
   run a test suite, but the loop functions without one.
5. **Base branch is fetchable.** Same as default workflow — fail-fast
   if `origin/<base>` is not present. Reused, not new.

The pre-flight is a single function (`validateTrellisPlant(project,
name)`) so the picker, CLI, and any future automation share the
behavior.

#### Pause and resume

The existing `garden pause <worker>` / `garden resume <worker>` (which
toggle `.garden-done`) work unchanged. Pausing a trellis vine
suppresses auto-continue; resume re-arms it. This is a different
mechanism than `garden trellis resume`:

| Command                               | Use                                                                                 |
|---------------------------------------|-------------------------------------------------------------------------------------|
| `garden pause <worker>`               | Stop the loop without escalating. Worker stays at last state. Operator sets aside. |
| `garden resume <worker>`              | Inverse of pause. Clears `.garden-done`.                                            |
| `garden trellis resume <worker>`      | Specifically resumes a flagged vine (clears the flagged state, dispatches a fresh review). |

### Storage and registry fields

#### Project config

```yaml
projects:
  garden:
    path: ~/code/keychange/garden
    # ... existing keys
    trellisDir: .garden/trellises  # default: .garden/trellises (relative to project root)
    maxTrellisIterations: 30       # default: 30
    trellisOpusFallback: true      # default: true; when false, Sonnet exhaustion pauses the loop
```

Both keys are optional. `trellisDir` is created on first
`garden trellis new` if it doesn't exist.

#### Worker entry additions

New optional fields on `WorkerEntry` (registry.ts), populated only when
`workflow === "trellis"`:

| Field                          | Type        | Meaning                                                              |
|--------------------------------|-------------|----------------------------------------------------------------------|
| `workflow`                     | `string`    | Workflow name. `"default"` or `"trellis"`. Absent → `"default"`.     |
| `trellisName`                  | `string`    | Filename (without extension) of the bound trellis.                   |
| `trellisPath`                  | `string`    | Resolved absolute path to the trellis at plant time (for stable lookup if `trellisDir` later changes). |
| `trellisIteration`             | `number`    | Iteration counter. Incremented on each `working → reviewing` transition *before* dispatch. Starts at 0; reads as 1 during the first review, 2 during the second, etc. The number reflects the iteration in progress, not the count of completed iterations. |
| `trellisMaxIterations`         | `number`    | Cap. Defaults from project config or 30.                             |
| `trellisLastVerdict`           | `TrellisVerdict` | Last reviewer verdict. Cleared on push that triggers a new iteration. |
| `trellisLastDrift`             | `string[]`  | Drift items from the last review. Used to seed the next continue prompt. |
| `trellisAlignedCount`          | `number`    | Running count of `present` claims (last reviewer pass).              |
| `trellisDriftHistory`          | `string[][]`| Bounded (length 5) history of drift lists for stagnation detection.  |
| `trellisShaHistory`            | `string[]`  | Bounded (length 5) history of HEAD SHAs at iteration boundaries.     |
| `trellisStagnationConfirmedAt` | `number`    | Epoch ms when stagnation was detected (clears on next push).         |
| `failingReason`                | `string`    | New field, multi-workflow. Allowed values: `"code"` (default-workflow failure; trellis FAILED), `"trellis-flagged"`, `"iteration-budget"`, `"stagnation"`, `"unparseable-verdict"`. Default workflow uses only `"code"`. |
| `trellisFlaggedClauses`        | `string[]`  | When flagged: cited clauses for the alert and resume command.        |
| `trellisAligned`               | `boolean`   | True when the terminal `done` was reached via reviewer `ALIGNED` (vs. operator-set `.garden-done`). Drives the `✓ aligned, N iters` row decoration. Set by `finalizeMerge` on the ALIGNED path; absent → operator-sentinel done. |
| `workerModel`                  | `string`    | Per-worker model override (set via `--model` at plant time). Opaque: an Anthropic alias ("opus"/"sonnet") or any concrete model id the backend accepts (docs/MULTI-MODEL.md "Layer 2"). Read by each iteration's spawn. Falls back to workflow definition's `workerModel`, then to project default. |
| `trellisModelFallbackAt`       | `number`    | Epoch ms of the most recent Sonnet → Opus fallback. Used to dedupe alerts within a single Sonnet 5h reset window. |

The fields are additive and optional. Existing default-workflow workers
write none of them; the renderer reads conditionally on
`entry.workflow === "trellis"`.

#### Worktree files

| Path                                            | Owner    | Purpose                                            |
|-------------------------------------------------|----------|----------------------------------------------------|
| `<worktree>/.garden/trellis-lessons.md`         | Worker   | Accumulated lessons across iterations.            |
| `<worktree>/.garden/trellis-overrides.md`       | Operator | Override rationale entries (one per override).     |
| `<worktree>/.garden-done`                       | Worker / poller / operator | Existing sentinel; reused unchanged. |

Neither lessons nor overrides are committed to the worker branch (they
are operator/worker collaboration artifacts, not part of the merge
target). The worker's `.gitignore` augmentation (added at plant time)
ensures this.

The trellis file itself lives on the project's main branch (or
wherever it was authored). The worker reads it at HEAD via the
worktree's git checkout — every iteration sees the latest version.
Trellis amendments by the operator land on main like any other commit
and are picked up on the next iteration's review.

### Guardrails — applied ralph-loop lessons

Each line below is a known ralph-loop failure mode with the specific
mechanism that mitigates it in the trellis design.

| Failure mode                                          | Mitigation                                                                                                                                                    |
|-------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Context poisoning across iterations                   | Per-iteration context reset (see workflow section): the Claude process is killed and respawned cold between iterations. Conversation history does not compound. The lessons file is the only intentional cross-iteration carry-over besides the trellis (read fresh from git) and the code itself. |
| Hallucination amplification (false fact gets locked in)| The reviewer's three-way diff is grounded in the actual filesystem (grep, file reads), not the worker's memory. False facts in the worker's context die at the next review. |
| Metric gaming (deletes failing tests; "Done!" without doing) | The reviewer enforces the "the code is wrong" rule against the trellis: deleted tests are themselves drift if the trellis named them. Existing rules + checks gate already catches deleted-tests-to-pass. |
| Cost explosion                                         | `maxIterations` cap (primary). Global usage gate (`autoContinueGateReason` / `usageThreshold`) inherited from default workflow (secondary). Stagnation detection (tertiary). |
| Spec rot — agent edits the spec to match buggy code   | The spec sentinel (`the code is wrong`) is preserved. The reviewer's prompt explicitly tells it not to edit the trellis. The trellis lives on main, not in the worker's branch — the worker's commits don't even reach the trellis file. |
| Premature commit on a wrong path, dug deeper           | Stagnation detection (oscillation signature: drift list at N matches N-2). FLAGGED verdict for trellis contradictions. Operator can `git reset --hard` to a pre-loop SHA (existing tooling). |
| Multiple tasks per loop bleeds context window          | The continue prompt's drift list is priority-ordered; the worker is told to attack from the top. Not strict one-task — but the priority encoding gives the same effect when the worker respects it. |
| Stagnation: same fail 3× / file thrashing             | Three signatures (no-diff, oscillation, top-item-stuck) all map to one disposition. Detection lives in workflow-handler-side code, not in Claude prompts (mechanical, not vibe-checked). |
| Declared-victory wrongly (model says aligned when not) | The reviewer's verdict format requires it to enumerate present/partial/absent claims. An `ALIGNED` with no enumeration is treated as unparseable. (Future hardening: a separate verifier agent — see "Phasing.") |
| Loop document accreting changelog cruft (e.g. ralph practitioners reporting `AGENTS.md` swelling into a journal) | The trellis is a fixed design document; it is not appended to mid-loop. The lessons file is bounded to 4KB with eviction (v1.5). Both are visible to the operator at any moment via `garden trellis status`. |

The single most important guardrail is **the iteration cap**. Every
other mitigation can fail without catastrophe; the cap cannot. It is
the only safety net that fails closed.

### Edge cases

- **Trellis amended mid-loop.** Operator commits a change to the
  trellis file on main while the worker is in `working`. The worker's
  worktree's view of the file lags until the worker pulls. The next
  review fetches origin and rebases, so the reviewer sees the new
  trellis content. The worker's continue prompt for *this* iteration
  is still based on the old drift list; the next iteration after that
  reflects the new trellis. This is intentional — amendments take one
  iteration to fully propagate, which is faster than killing and
  re-planting and avoids losing in-flight work.

- **Trellis deleted mid-loop.** The reviewer's `findSpecFiles()` no
  longer finds the trellis. The reviewer prompt's
  `trellisDocumentSection` returns `null` (file missing). The verdict
  format section instructs it to emit `FLAGGED` with reason "trellis
  document missing or unreadable." Operator decides: restore, or kill
  the vine.

- **Trellis retired mid-loop.** Allowed. The retirement comment is
  metadata on the document; it does not prevent an already-bound vine
  from continuing. The reviewer reads the trellis content as before,
  the workflow runs as before. Retirement only affects future
  bindings (the picker filters retired trellises; CLI vine spawn
  refuses them). The operator's intent in retiring mid-loop is
  typically "the in-flight vine is the last one I'll plant on this
  trellis"; nothing more.

- **Two vines on the same trellis.** Permitted but discouraged. Each
  worker has its own worktree so they don't collide on disk; their
  branches are independent. They will converge on similar code (same
  trellis), and the second to merge will likely produce a no-op
  diff or a merge conflict. There's no exclusion check — the operator
  can plant duplicates if they want a competitive bake-off.

- **Trellis on a project with no `checks` configured.** The reviewer
  skips the checks step (existing behavior). Trellis alignment falls
  back to grep + file-read evidence only. The verdict is less reliable
  but the loop still works. `garden workers new --workflow trellis`
  prints a tip to configure `checks` (via `garden config <project>
  checks ...`) when the project has none — verdicts are stronger when
  the reviewer can run a test suite.

- **Worker crashes mid-iteration.** `pane-died` hook fires,
  `agentStatus = "exited"`. The trellis fields are preserved on the
  registry entry. Unlike default workflow, the interrupt-recovery
  prompt does not fire — see "Per-iteration context reset." When the
  pane is restored (`garden bounce`, dashboard reattach), Claude
  cold-starts via the fresh-context mechanism and is seeded with the
  last drift list. In-flight uncommitted edits are lost; this is the
  intentional tradeoff for never compounding a poisoned context across
  iteration boundaries.

- **Operator amends `trellis-overrides.md` directly.** Allowed.
  Reviewers always re-read the file at the start of their prompt
  composition. Overrides take effect on the next iteration.

- **`pendingContinueChangedFiles` is empty (no diff between worker's
  pre-review and post-review SHA).** The continue prompt drops the
  changed-files preamble (existing behavior in default workflow).
  Drift list still drives the loop.

- **Iteration budget hit on iteration N where the previous iteration
  was `ALIGNED`.** Cannot happen — `ALIGNED` writes `.garden-done`,
  which terminates before the next review fires. If it ever does (bug),
  treat as `done`, not `failing`: the sentinel takes priority over the
  budget check.

- **Worker pushes nothing but the lessons file.** That counts as no-diff
  for stagnation purposes (the lessons file is not committed). The
  Stop hook's "no commits ahead" branch fires, stagnation counter
  increments. After three: `failing` with `failingReason = "stagnation"`.

- **Trellis with no spec sentinel.** Reviewer treats the file as
  ordinary documentation, not authority. The trellisAuthoritySection's
  bias-against-flagging instruction is not applied with full force.
  This is a foot-gun. `garden trellis new` always inserts the
  sentinel, and `garden workers new --workflow trellis` warns at plant
  time if the target trellis lacks it.

### Phasing (trellis)

A minimum viable v1 ships the loop end-to-end on one feature, with the
guardrails that fail catastrophically without them. Bells and whistles
defer.

#### v1 (the minimum loop)

- `WorkerEntry.workflow` field added; default `"default"`.
- `WorkerEntry.failingReason` field added; default workflow sets `"code"`.
- Trellis workflow registered (`src/dashboard/workflows/trellis.ts`).
- Trellis verdict vocabulary, parser usage, and prompt sections.
- Trellis-specific worker system prompt branch in `buildWorktreeRules`
  (concept, authority asymmetry, iteration discipline).
- **Per-iteration context reset** (`trellisAutoContinueAfterMerge`):
  Claude process killed and respawned cold between iterations. This
  is load-bearing, not a polish item.
- Iteration counter, max-iterations cap, budget-exhaustion → `failing`.
- Trellis-aware continue prompt with drift list (used as the seed
  message of the freshly respawned Claude).
- Trellis-aware reviewer prompt with three-way diff instruction.
- `FLAGGED` verdict and `garden trellis resume` command.
- `garden workers new --workflow trellis --trellis <name>`.
- `garden trellis list` / `show` / `new` / `status` / `amend` /
  `resume` / `retire` / `revive` commands.
- Picker (`⌥⇧n`) filters out retired trellises; CLI vine spawn refuses
  to bind to a retired trellis.
- `trellis-author` skill bundled and installed alongside `done` and
  `handoff`.
- Worker-row decoration in status pane (iteration counter, drift count).
- Logging of iteration events at info.
- **Model selection:** vines default to Sonnet; reviewers
  always run on Opus. `--model` flag at plant time overrides the
  worker model (not the reviewer).
- **Sonnet exhaustion fallback:** before each iteration's spawn,
  check the Sonnet 5h and weekly meters; if either ≥ `usageThreshold`,
  fall back to Opus and fire one alert per Sonnet reset window
  (deduped via `trellisModelFallbackAt`). Reviewer never falls back.
- `trellisOpusFallback` project config (default `true`); when `false`,
  Sonnet exhaustion routes through the existing usage-pause mechanism.

#### v1.5 (hardening)

- Stagnation detection (no-diff, oscillation, top-item-stuck signatures).
- `trellis-overrides.md` mechanism + `--override` flag.
- Lessons file size cap with eviction.
- `garden trellis budget` to raise/lower the cap mid-loop.
- Bottom-bar trellis summary.
- `⌥⇧n` picker for trellis spawn (fzf-style, with empty-state and
  one-trellis shortcuts).

#### v2 (separate verifier)

- Optional separate verifier agent (a second headless Claude) that
  audits the reviewer's verdict before the merge transition. Catches
  the "declared aligned wrongly" failure mode that no single-agent
  setup can fully prevent. Configurable per-trellis
  (`verifier: strict | default | off`) — strict mode runs the verifier
  every iteration, default only on `ALIGNED`, off skips entirely.
- Cross-iteration reviewer carry-over (a small reviewer-maintained
  `trellis-review-notes.md`) so the reviewer doesn't re-discover the
  same project conventions every iteration.
- Trellis-as-test-suite: a structured spine in the trellis (YAML
  frontmatter or a fenced block) the reviewer can parse mechanically
  for stricter alignment checks. Optional opt-in per trellis.

#### Out of scope, indefinitely

- Multi-worker per trellis (cooperative). The branch model and the
  reviewer's serial nature don't support it cleanly. Operators who
  want parallelism plant separate trellises, decomposed by feature.
- Auto-amending the trellis. The asymmetry is the feature. If the
  operator wants the agent to propose trellis edits, that is a
  separate workflow (a "trellis editor") and not a mode of this one.
- A graphical trellis UI. Markdown is enough.

### Open questions (trellis)

These are deliberately left open for v1 implementation to settle.
Listed here so that whoever picks up the implementation surfaces them
as decisions, not assumptions.

1. **Default `maxIterations`.** This spec proposes 30. Real cost data
   from the first few trellis runs may push this lower (10–15) or
   higher (50). Should be tuned empirically; the field is operator-
   configurable.

2. **What does the worker's *first* prompt look like?** The spec says
   "trellis content + 'implement this' + path to lessons file." The
   exact phrasing — and whether it should mention the iteration
   budget, the verdict vocabulary, or the FLAGGED escape valve —
   needs prompt-engineering iteration during v1 implementation.

3. **Should the reviewer have access to the lessons file?** This spec
   says no (lessons are worker-private). An argument for yes: the
   reviewer can sanity-check whether the worker is learning. An
   argument for no: the reviewer should evaluate the artifact, not
   the process. v1 implements the no path; v2 may revisit.

4. **Stagnation window length.** Three iterations is a guess. The
   right number depends on the typical cost of an iteration vs. the
   risk of false positives. Make it operator-configurable
   (`trellisStagnationWindow`) defaulting to 3.

5. **Flagged-state alert deduplication.** If the same trellis-flagged
   state persists across operator inattention, do we keep firing
   alerts? Probably one alert per FLAGGED transition, not per poll.
   Existing alert dedup mechanism in `src/dashboard/alerts.ts` should
   be reused.

6. **Cross-trellis dependencies.** Two trellises in the same project
   that touch overlapping files. The conflict-notification mechanism
   (existing, between siblings) extends naturally. But the priority
   when both want to merge: first-come-first-served via the existing
   merge queue. No special handling.

7. **Trellis as a track concept.** `TRACKS.md` introduces tracks
   (multi-base per project). A trellis workflow on a non-default
   track is permitted in principle. The base-branch-pinning
   contract is unchanged. v1 may punt on testing this combination
   formally; the architecture allows it.

### Invariants (the spec's bottom line)

1. **Equilibrium is plural.** Aligned, sentinel-set, budget-exhausted,
   stagnated, and flagged are five distinct equilibria. Three are
   happy-path-ish, two are operator-action. None is silent — every
   equilibrium produces either a `done` state, an alert, or both.

2. **The trellis wins by default.** The reviewer compares
   implementation against the trellis and treats the trellis as
   authoritative. The reviewer does not edit the trellis. Only the
   operator can amend it.

3. **The reviewer can flag but cannot edit.** The asymmetry is
   maintained at all costs. A loop that auto-mutates its convergence
   target produces uninterpretable green lights and is the worst
   failure mode.

4. **The iteration cap fails closed.** Every other guardrail is a
   heuristic. The cap is the contract. It is mandatory and
   enforced before the verdict is even read.

5. **No new `PrState` values.** Trellis disposition lives in additive
   fields on `WorkerEntry`; the renderer decorates conditionally.
   Default-workflow code paths are unaffected.

6. **The trellis file is the durable artifact.** Workers, branches,
   and individual commits are disposable. The trellis itself, and its
   git history of amendments, is the design record of the feature.

7. **Every iteration is event-triggered.** Same as STATUS.md
   invariant 6: no recurring tick. The loop advances on Stop hooks,
   push events, and merge-queue completions, exactly as the default
   workflow does. Trellis adds no timers.

8. **Each iteration starts cold.** The Claude session is killed and
   respawned between iterations; conversation history does not compound.
   Disk (the trellis read at git HEAD, the code, the lessons file) is
   the only state that crosses iteration boundaries. Compounding
   conversation context is the most common ralph-loop failure mode and
   is structurally prevented here. This is the deliberate divergence
   from the default workflow's continue mechanism.

9. **DRIFT drives the next task.** The worker does not decide what to
   build next — the reviewer's priority-ordered drift list does. Per
   iteration, the worker's job is "close the highest-priority gap from
   the list," not "plan the next phase." There is no up-front phased
   plan; the trellis itself is the plan. This is the structural
   difference between trellis and the default multi-phase workflow.

10. **Reviewer quality is non-negotiable.** The reviewer always runs
    at the workflow's `reviewerModel` (Opus) regardless of worker
    model, quota state, or operator overrides. A reviewer on a
    degraded model produces unreliable verdicts, which silently
    corrupts the convergence signal. The worker model can fall back
    to a smaller model on quota pressure; the reviewer cannot. If the
    reviewer's model is exhausted, the loop pauses via the global
    usage gate.

## Loop primitive

Workflow-agnostic iteration mechanics shared by every workflow that
respawns the worker with fresh Claude context after each merge. Lives
in `src/dashboard/loop.ts`. Two consumers today: trellis (long
spec-driven loop, ~30 iterations, terminal-on-budget = `failing`) and
grow (short hardening loop, ~5 iterations, terminal-on-budget = `done`).

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
  /** Tag for log lines and seed-file naming ("trellis", "grow"). */
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
2. Refresh `.claude/settings.json` via the worker's harness adapter (`getHarness(entry.harness).installRuntimeConfig`).
3. Generate a fresh `sessionId` and persist before respawn (concurrent
   reads see the new value).
4. Build the worker command via `buildWorktreeWorkerCommand` with the
   caller-supplied `WorktreeCommandOptions` (trellis passes
   `trellisRelativePath` + `model`; grow passes `grow: { iteration,
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
   `dispatchDelayedSeed`. The seed-file name uses `hooks.logTag` so
   trellis files (`trellis-seed-*.txt`) and grow files
   (`grow-seed-*.txt`) don't collide.

Workflow-specific bookkeeping (model resolution, trellis-relative-path
computation, validation guards) stays at the caller; the primitive is
mechanism, not policy.

### Why the extraction

Trellis was the first iteration-loop consumer and the cold-respawn
lived in `trellis-continue.ts`. When grow shipped, the cold-respawn
dance was unchanged — only the prompt content, sub-object field path,
and budget mechanism differed. Lifting the shared mechanics into
`loop.ts` made grow a thin caller (~150 lines including the prompt
builder and the iter-1 seed) instead of a fork of `trellis-continue.ts`.

The two workflows still diverge in two places that `loop.ts`
deliberately does not unify:

- **Budget enforcement site.** Trellis fires the budget check at
  preflight (`launchReview`, before the Nth review dispatches) and
  transitions to `failing/iteration-budget`. Grow fires post-merge in
  `maybeAutoContinue` and transitions to `done`. The difference
  reflects intent: trellis "ran out of iterations to converge"
  (failure) vs grow "did the work we said we'd do" (success).
- **Continue prompt content.** Trellis inlines the drift list and the
  lessons file. Grow inlines the seed verbatim, the changed-files
  list, and the grow-log. Same shape (`LoopHooks.buildContinuePrompt`),
  different content.

## Grow workflow

Spec for the **grow** workflow: a bounded hardening loop **without** a
frozen design document. The operator's seed prompt anchors the loop
across iterations; convergence is worker-declared via `.garden-done` or
forced by hitting the iteration cap. **If the code disagrees with this
section, the code is wrong.**

Grow is the second workflow registered against the foundation
(`workflows/index.ts`). It reuses default's verdict vocabulary
(CLEAN/FIXED/FAILED), default's `hookHandlers`, and default's
state handlers — only the post-merge dispatch and the iteration counter
diverge.

### Why this exists

Garden has two endpoints on the iteration spectrum:

- **Default workflow** — one-shot worker. Implements the operator's
  request, gets reviewed, merges. No subsequent iterations.
- **Trellis workflow** — feature-scoped, design-doc-driven loop.
  ~30 iterations against a frozen artifact, with structured drift
  verdicts and a FLAGGED escape valve.

Grow fills the gap: "do task X and harden the area around it for
~5 passes." Use cases:

- Implement a feature, then add edge-case tests, error handling, and
  doc updates as cascading polish.
- Fix a bug, then add a regression test, audit nearby code, update
  CLAUDE.md.
- Pre-ship pass on a PR — multiple polish iterations before merging
  to main.

The metaphor: workers grow the codebase. Trellis-bound workers grow
*along* a structure (the doc); grow workers grow without one.

### Vocabulary

| Term         | Definition                                                                                       |
|--------------|--------------------------------------------------------------------------------------------------|
| **Seed**     | Operator-supplied task description set at plant time. Persisted both on `entry.grow.seed` (registry fallback) and on disk at `<worktree>/.garden/grow-goal.md` (durable, operator-editable). Iter ≥ 2 continue prompts read the file first and fall back to the registry value. The durable goal across context resets. |
| **Iteration**| One full cycle of `working → reviewing → merge → cold respawn`. Counted on `entry.grow.iteration`. |
| **Cascade**  | Polishing the previous iteration's diff. Iter 2 hardens what iter 1 did; iter 3 hardens iter 2; etc. Termination is natural — by the Kth pass, "nothing material remains" becomes true and the worker writes `.garden-done`. |
| **Grow log** | A worker-maintained file (`<worktree>/.garden/grow-log.md`). Append-only, one line per iteration: `iter K: <one-line summary>`. Inlined into the next iteration's continue prompt so the worker doesn't re-do work. Encouraged, not enforced. |

### How it differs from trellis

| Aspect                  | Trellis                                  | Grow                                                          |
|-------------------------|------------------------------------------|---------------------------------------------------------------|
| Anchor                  | Frozen markdown doc (versioned in git)   | Seed string captured at plant time (persisted on the entry)   |
| Reviewer verdict vocab  | ALIGNED / DRIFT / FAILED / FLAGGED       | CLEAN / FIXED / FAILED (default)                              |
| Convergence criterion   | Reviewer-declared (ALIGNED)              | Worker-declared (`.garden-done`)                              |
| Budget exhaustion       | `failing/iteration-budget`               | `done`                                                        |
| Default budget          | 30                                       | 5                                                             |
| Worker model            | Sonnet (with Opus fallback)              | Account default                                               |
| Reviewer model          | Opus (pinned)                            | Account default                                               |
| FLAGGED escape valve    | Yes (trellis is contradictory)           | No                                                            |
| Stagnation detection    | v1.5                                     | No                                                            |
| Per-iteration data file | `.garden/trellis-lessons.md` (lessons)   | `.garden/grow-log.md` (changelog)                             |

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

`done` has two paths: worker-declared (sentinel set during iter K) or
budget-exhausted (iter K = max, sentinel auto-written by
`maybeAutoContinue`). Both land on the same terminal state — both are
"the loop completed cleanly."

### Workflow definition

`src/dashboard/workflows/grow.ts` registers `growWorkflow` alongside
`defaultWorkflow` and `trellisWorkflow`. State handlers and hook
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

`updateWorkerFields` deep-merges the `grow` sub-object the same way as
`trellis` — passing `{ grow: { iteration: 3 } }` updates only that
field without clobbering `seed` or `maxIterations`.

### Worker system prompt

Three paragraphs appended to the baseline by `buildWorktreeRules` when
`options.grow` is set (mutually exclusive with `options.trellis`):

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
Empty seeds are rejected. `--trellis` is not allowed on grow workflow;
`--model <alias-or-id>` pins the loop's model (persisted to
`WorkerEntry.model`, threaded through every cold respawn — absent means
the account default). `--max-iterations` overrides
`project.maxGrowIterations` (default 5). The cold-plant path produces
the goal artifact via the iter-1 seed prompt instructing the worker to
write `<seed verbatim>` to `.garden/grow-goal.md`.

The `⌥⇧N` workflow picker offers a `(g) grow` row that opens a tmux
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
of a worker already on grow or trellis is rejected — operators amend
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

Garden ships a `grow` skill, bundled alongside `done`, `handoff`, and
`trellis-author` and installed at
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
- **Stagnation detection.** Trellis's drift-list-shrinking heuristic
  doesn't apply to grow (no drift list). A grow-flavored heuristic
  (e.g., "iteration K and K-1 changed the same files with identical
  diffs") could fire a `failing/stagnation` alert. Deferred — the
  iteration cap is the primary safety net.

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
  trellis in one clause. Both legitimately reach `mergeCount >= 2` via normal
  merges; only this gate keeps the whole-task review to default workers, AND
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

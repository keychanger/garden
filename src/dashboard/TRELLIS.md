# Trellis

Spec for the **trellis** workflow: a feature-scoped, spec-driven loop in
which a worker iterates against a frozen design document until code,
tests, and documentation align. This document is the source of truth for
how the trellis workflow behaves. **If the code disagrees with this
document, the code is wrong.**

A trellis is the durable artifact across iterations; the worker, its
context window, and any individual commit are disposable side-effects.
The loop is bounded, the convergence criterion is computed (not
vibes-checked), and the asymmetry between trellis-as-authority and
implementation-as-experiment is preserved with one explicit escape valve
(see "Flagging the trellis").

## Why this exists, and why now

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

## Vocabulary

| Term            | Definition                                                                                       |
|-----------------|--------------------------------------------------------------------------------------------------|
| **Trellis**     | A markdown design document that describes a feature's intent, surface, behavior, tests, and docs. Lives in the project repo. Versioned in git. The reviewer treats it as the source of truth (same convention as `STATUS.md` / `TRACKS.md`). |
| **Thread**      | A worker bound to one trellis, looping until equilibrium. A project may have multiple threads active at once on different trellises. One worker per thread; one trellis per worker. |
| **Iteration**   | One full cycle of `working → reviewing → (merge or fail) → auto-continue`. Counted on the worker entry. |
| **Drift**       | A specific, named gap between the trellis and one of {code, tests, docs}. Produced by the reviewer as a list. |
| **Alignment**   | The state in which the reviewer reports zero drift items. The terminal happy path. |
| **Equilibrium** | Any terminal disposition: aligned, sentinel-set, budget-exhausted, stagnated, flagged-then-resolved. The loop has stopped. |
| **Flagging**    | The reviewer's third verdict: the trellis itself is contradictory, impossible, or incomplete. The loop pauses; only the operator can decide whether to amend the trellis or override the flag. |
| **Lessons**     | A worker-maintained file (`<worktree>/.garden/trellis-lessons.md`) summarizing what failed in past iterations. Loaded into the next iteration's context. The single channel of accumulated state across context resets. |

## The trellis document

A trellis is plain markdown. The convention is permissive on prose,
strict on a small machine-readable spine.

### Required spine

1. **Title** (`# <Feature name>`) on the first line.
2. **Spec sentinel** somewhere in the first paragraph: the literal string
   `the code is wrong` (same convention as `STATUS.md` and `TRACKS.md`).
   The reviewer's `findSpecFiles()` already detects this.
   Without the sentinel, the reviewer treats the file as documentation,
   not authority.
3. **Trellis tag** (`<!-- trellis: v1 -->`) on the second or third line.
   Marks the document as a trellis (distinct from a system spec). The
   CLI's `garden trellis list` filters by this tag, and the reviewer
   selects the trellis prompt branch on its presence.

### Recommended sections

The reviewer reads the document as prose. Sections are not enforced —
the operator structures the trellis however the feature wants. The
following pattern is recommended because it makes the reviewer's
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

### File location

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

### Authoring skill

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

## The trellis workflow

A new `WorkflowDefinition` named `"trellis"`, registered in
`src/dashboard/workflows/index.ts` alongside `defaultWorkflow`.

### Reused state machine, no new `PrState` values

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

### Valid transitions

Same shape as `defaultWorkflow.validTransitions`. The trellis workflow
adds no transitions and removes none. The only behavioral difference is
in the **state handlers**: `handleReviewing` parses a trellis-specific
verdict vocabulary, and the post-merge auto-continue dispatcher emits a
trellis-shaped prompt.

### Hook handlers

Identical to default for `onSessionStart`, `onUserPromptSubmit`,
`onNotification`, `onPreToolUse`, `onPostToolUse`. The only override is
`onStop`:

- **Stop with new commits ahead of base** — same as default: pokes the
  poller FIFO, sets `pendingReviewAt`. Triggers an iteration.
- **Stop with no new commits ahead and no `.garden-done` and a remaining
  drift list from the previous review** — counts toward the **stagnation
  counter**. Three consecutive Stops with no commits → `failing` with
  `failingReason = "stagnation"`. (See "Stagnation detection.")
- **Stop with no new commits ahead and `.garden-done` present** — same
  as default: `prState = "done"`.

### Worker system prompt

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

### Per-iteration context reset

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
trellis worker restarts via the same fresh-context mechanism on the
next push event, seeded with the last drift list.

## The loop

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

### One iteration, in detail

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
5. **Iteration counter.** On every transition into `reviewing` from
   `working` (the start of each iteration), increment
   `entry.trellisIteration`. The poller transition logs at info, with
   `iteration: N` in the data field, so `⌥l` logs make the cadence
   visible.

### No up-front phased plan

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

### Why merge on DRIFT

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

## Equilibrium and termination

"Done" is plural. The trellis workflow recognizes five terminal
dispositions, and each has a distinct semantic and visual treatment:

| Disposition         | How reached                                                               | `prState` | Decoration                            | Operator action                        |
|---------------------|---------------------------------------------------------------------------|-----------|---------------------------------------|----------------------------------------|
| **Aligned**         | Reviewer outputs `ALIGNED`                                                | `done`    | `aligned: true` field; bold green icon decorated with `✓` | Inspect, clean up, retire trellis      |
| **Sentinel-set**    | Operator (or worker) writes `.garden-done` mid-loop                       | `done`    | Default `done` rendering              | Inspect, clean up                      |
| **Budget-exhausted**| `trellisIteration` exceeds `maxIterations`                                | `failing` | `failingReason: "iteration-budget"`   | Inspect, decide: amend trellis & retry, raise budget, or kill |
| **Stagnated**       | Three consecutive iterations with no diff progress                        | `failing` | `failingReason: "stagnation"`         | Inspect, decide: amend trellis, hand-write next move, or kill |
| **Flagged**         | Reviewer outputs `FLAGGED`                                                | `failing` | `failingReason: "trellis-flagged"`    | Amend trellis, then `garden trellis resume`; OR override; OR kill |

The first two are happy-path equilibria. The last three are
operator-action equilibria. There is no fourth bucket: the loop either
converges, runs out of resources, or stops on a contradiction.

### The iteration budget

Every trellis worker has a `maxIterations` cap. Default: **30**.
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

### Stagnation detection

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

### Flagging the trellis

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
   apply to flagged threads. New commits the worker pushes do not
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
     new thread can be planted later.

Override is meaningful but rare. The expected default is amend. An
override accumulates technical debt visible in the file —
`trellis-overrides.md` is the audit trail of "places we knowingly
diverge from the trellis."

## The drift loop in detail

The post-merge auto-continue prompt is the body of the loop. Default
workflow's continue prompt is generic ("your changes were merged,
continue with the next phase"). Trellis workflow's continue prompt is
specific: it carries the drift list as the work to do.

### Continue prompt structure

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

### One drift per iteration (recommended), all of them (allowed)

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

### The lessons file

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

## Reviewer prompt and verdict

### Section composition

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

### `trellisAuthoritySection`

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

### `trellisAlignmentStepSection`

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

### `trellisVerdictFormatSection`

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

### Verdict parser

```ts
const TRELLIS_VERDICTS = ["ALIGNED", "DRIFT", "FAILED", "FLAGGED"] as const;
type TrellisVerdict = (typeof TRELLIS_VERDICTS)[number];

const result = parseLastLineVerdict<TrellisVerdict>(output, TRELLIS_VERDICTS);
```

Vocabulary is declared `as const` so the result is narrowly typed. The
parser primitive is unchanged. Unparseable verdicts re-queue once
(matching default behavior); after one re-queue the worker transitions
to `failing` with `failingReason = "unparseable-verdict"`.

## Status display

Trellis threads are visually distinct in three places: the worker row in
the status pane, the plot strip aggregation, and the bottom bar's
project line. The renderer reads `entry.workflow` and the trellis-specific
fields without changing how default-workflow workers render.

### Worker row

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

### Plot strip

The plot-state aggregator (`src/dashboard/plot-status.ts`) computes a
single icon per plot from the worst-priority worker state. Trellis
threads slot into the existing priority order with one addition:

```
failing > asking > done > working > idle
       │
       └─ within failing, trellis-flagged is the highest-priority
          alert source because it requires authoring decisions, not
          mechanical fixes
```

`failingReason = "trellis-flagged"` does not change the plot icon
(still `✖`); it changes the alert badge title that appears when
hovering / inspecting. The aggregator is unaware of trellis specifics
beyond reading `failingReason` to construct the badge text.

### Bottom bar

When the active project has any trellis thread running, the bottom-bar
left segment appends a compact summary:

```
garden | main | trellises: auth-rewrite (4/30, drifting), session-cleanup (✓)
```

Threads listed in plant order. Aligned threads marked `✓`; drifting
shows iteration/budget; flagged shows `⚑`; budget-exhausted shows `!`.
Truncated with `…` if too wide.

### Logs

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

## CLI surface

Two new subcommand groups: `garden trellis ...` for trellis-document
management, and arguments to existing worker spawning for binding a
worker to a trellis.

### `garden trellis`

```
garden trellis list <project>            List trellises in the project's trellisDir.
garden trellis show <project> <name>     Print a trellis's content (paged in TTY).
garden trellis new <project> <name>      Scaffold a new trellis with the recommended sections.
garden trellis status <worker>           Show iteration count, last verdict, drift list, lessons file.
garden trellis amend <worker>            Open the bound trellis in $EDITOR. Commits with a default message on save.
garden trellis resume <worker> [--override "<rationale>"]
                                          Resume a flagged thread. With --override, records an override entry.
garden trellis budget <worker> <N>       Update maxIterations on the worker entry.
```

`garden trellis status` is the operator's "where is this thread?"
command. Sample output:

```
$ garden trellis status swift-oak
worker:        swift-oak
project:       garden
trellis:       trellises/auth-rewrite.md
iterations:    4 / 30
last verdict:  DRIFT (2026-05-03T14:22:11Z)
drift items:
  1. [surface] AuthClient missing the timeout option
  2. [tests]   no test for token-refresh race
  3. [docs]    CLAUDE.md auth section unchanged
aligned items: 7
stagnation:    0/3 (no concerning pattern)
lessons:       <last 3 lines from trellis-lessons.md>
```

### Spawning a trellis worker

Two paths:

1. **CLI:** `garden workers new <project> --workflow trellis --trellis <name> [--max-iterations N]`.
2. **Hotkey:** `⌥⇧n` opens a tmux command prompt asking for a trellis
   name (autocomplete from the project's trellisDir). Default
   `maxIterations` from project config or 30. (`⌥n` continues to spawn
   a default-workflow worker.)

The worker is bootstrapped identically to a default worker — git
worktree, branch named after the worker, sandbox config, hooks
installed. The only difference is `entry.workflow = "trellis"` and the
trellis-specific fields are populated. The worker's *first* prompt
(seed) is the trellis content + a one-line "implement this" instruction
+ the path to `trellis-lessons.md` (which doesn't exist yet on
iteration 1; the worker creates it).

### Pause and resume

The existing `garden pause <worker>` / `garden resume <worker>` (which
toggle `.garden-done`) work unchanged. Pausing a trellis thread
suppresses auto-continue; resume re-arms it. This is a different
mechanism than `garden trellis resume`:

| Command                               | Use                                                                                 |
|---------------------------------------|-------------------------------------------------------------------------------------|
| `garden pause <worker>`               | Stop the loop without escalating. Worker stays at last state. Operator sets aside. |
| `garden resume <worker>`              | Inverse of pause. Clears `.garden-done`.                                            |
| `garden trellis resume <worker>`      | Specifically resumes a flagged thread (clears the flagged state, dispatches a fresh review). |

## Storage and registry fields

### Project config

```yaml
projects:
  garden:
    path: ~/code/keychange/garden
    # ... existing keys
    trellisDir: .garden/trellises  # default: .garden/trellises (relative to project root)
    maxTrellisIterations: 30       # default: 30
```

Both keys are optional. `trellisDir` is created on first
`garden trellis new` if it doesn't exist.

### Worker entry additions

New optional fields on `WorkerEntry` (registry.ts), populated only when
`workflow === "trellis"`:

| Field                          | Type        | Meaning                                                              |
|--------------------------------|-------------|----------------------------------------------------------------------|
| `workflow`                     | `string`    | Workflow name. `"default"` or `"trellis"`. Absent → `"default"`.     |
| `trellisName`                  | `string`    | Filename (without extension) of the bound trellis.                   |
| `trellisPath`                  | `string`    | Resolved absolute path to the trellis at plant time (for stable lookup if `trellisDir` later changes). |
| `trellisIteration`             | `number`    | Count of iterations completed (incremented on each `working → reviewing` transition). Starts at 0. |
| `trellisMaxIterations`         | `number`    | Cap. Defaults from project config or 30.                             |
| `trellisLastVerdict`           | `TrellisVerdict` | Last reviewer verdict. Cleared on push that triggers a new iteration. |
| `trellisLastDrift`             | `string[]`  | Drift items from the last review. Used to seed the next continue prompt. |
| `trellisAlignedCount`          | `number`    | Running count of `present` claims (last reviewer pass).              |
| `trellisDriftHistory`          | `string[][]`| Bounded (length 5) history of drift lists for stagnation detection.  |
| `trellisShaHistory`            | `string[]`  | Bounded (length 5) history of HEAD SHAs at iteration boundaries.     |
| `trellisStagnationConfirmedAt` | `number`    | Epoch ms when stagnation was detected (clears on next push).         |
| `failingReason`                | `string`    | New field, multi-workflow: `"code"`, `"trellis-flagged"`, `"trellis-stagnation"`, `"trellis-budget"`, `"unparseable-verdict"`. Default workflow uses only `"code"`. |
| `trellisFlaggedClauses`        | `string[]`  | When flagged: cited clauses for the alert and resume command.        |

The fields are additive and optional. Existing default-workflow workers
write none of them; the renderer reads conditionally on
`entry.workflow === "trellis"`.

### Worktree files

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

## Guardrails — applied ralph-loop lessons

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
| `AGENTS.md` becomes a changelog, polluting context     | The trellis is a fixed design document; it is not appended to mid-loop. The lessons file is bounded to 4KB. Both are visible to the operator at any moment via `garden trellis status`. |

The single most important guardrail is **the iteration cap**. Every
other mitigation can fail without catastrophe; the cap cannot. It is
the only safety net that fails closed.

## Edge cases

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
  the thread.

- **Two threads on the same trellis.** Permitted but discouraged. Each
  worker has its own worktree so they don't collide on disk; their
  branches are independent. They will converge on similar code (same
  trellis), and the second to merge will likely produce a no-op
  diff or a merge conflict. There's no exclusion check — the operator
  can plant duplicates if they want a competitive bake-off.

- **Trellis on a project with no `checks` configured.** The reviewer
  skips the checks step (existing behavior). Trellis alignment falls
  back to grep + file-read evidence only. The verdict is less reliable
  but the loop still works. A warning at plant time:
  `garden plant ... --workflow trellis` without `checks` configured
  prints a tip to add tests.

- **Worker crashes mid-iteration.** `pane-died` hook fires,
  `claudeStatus = "exited"`. The trellis fields are preserved on the
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
  sentinel, and `garden plant --workflow trellis` warns at plant time
  if the target trellis lacks it.

## Phasing

A minimum viable v1 ships the loop end-to-end on one feature, with the
guardrails that fail catastrophically without them. Bells and whistles
defer.

### v1 (the minimum loop)

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
  `resume` commands.
- `trellis-author` skill bundled and installed alongside `done` and
  `handoff`.
- Worker-row decoration in status pane (iteration counter, drift count).
- Logging of iteration events at info.

### v1.5 (hardening)

- Stagnation detection (no-diff, oscillation, top-item-stuck signatures).
- `trellis-overrides.md` mechanism + `--override` flag.
- Lessons file size cap with eviction.
- `garden trellis budget` to raise/lower the cap mid-loop.
- Bottom-bar trellis summary.
- `⌥⇧n` hotkey for trellis spawn.

### v2 (separate verifier)

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

### Out of scope, indefinitely

- Multi-worker per trellis (cooperative). The branch model and the
  reviewer's serial nature don't support it cleanly. Operators who
  want parallelism plant separate trellises, decomposed by feature.
- Auto-amending the trellis. The asymmetry is the feature. If the
  operator wants the agent to propose trellis edits, that is a
  separate workflow (a "trellis editor") and not a mode of this one.
- A graphical trellis UI. Markdown is enough.

## Open questions

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

## Invariants (the spec's bottom line)

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

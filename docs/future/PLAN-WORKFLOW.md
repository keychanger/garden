# Plan Workflow

> This document lives under `docs/future/` — it describes an unshipped
> design. Workers must not act on it (no `bd` commands, no bead filing,
> no `~/.beads/`). See `rules.md` § Specifications and documentation.

> **Sequencing update (2026-07-24).** The substrate fork went plan's way:
> beads is the committed work-graph substrate (AUTONOMY-PROGRAM.md §5,
> Fork 1). But the consumption side ships first — the board→garden
> delegation loop specced in board's `docs/future/DELEGATION.md` — and its
> Phase 4 "planner workflow" is a deliberately scaled-down first
> instantiation of this design (read a pinned doc, emit wisps + an
> integration bead, `bd dep cycles`, stop). When plan proper ships, it
> should absorb or supersede that planner rather than coexist with it.
> Plan is **not** superseded by botanist — they are siblings by design:
> botanist produces the approved design *document*; plan decomposes an
> approved document into the executable beads *graph*. One line item here
> is already free: the `.garden-awaiting-input` human-gate sentinel
> shipped with botanist.

Design document for `plan`, garden's planned fourth workflow. Plan would
convert a human-described feature into a graph of beads with dependencies,
ready for parallel execution by other workflows. The phased delivery section
is forward-looking; current implementation status is called out per phase.

This document is the design for plan. It will fold into `WORKFLOWS.md` §
"Plan workflow" once Phase 1 ships, mirroring how `TRELLIS-PLAN.md` lived
separately while trellis was being designed and now coexists with the
authoritative trellis section in `WORKFLOWS.md`.

## Status

- **Phase 1** (skeleton + single-reviewer happy path): not started. No
  code, no CLI surface, no worker integration.
- **Phase 2** (dimensional fan-out): designed below, not started.
- **Phase 3** (verification + bead ingestion wiring): out of scope for this
  document. Captured under "Out of scope" with pointers.

## Intent

Garden today is excellent at "execute one task autonomously." The unit of
input is an operator-composed seed — a sentence, a trellis spec, a goal
file. The operator carries the burden of decomposing intent into tasks
small enough for a worker to run end-to-end. As soon as a feature is
larger than a single worker can hold in context, the operator becomes
the bottleneck.

Plan is the workflow that converts intent to graph. The operator describes
a feature in natural language; the plan worker drafts a spec, runs
dimensional review, asks clarifying questions, refines, and emits a beads
graph (`bd create` plus `bd dep add`) with a tracking epic. From that
point, garden's existing workflows (default, trellis, grow) consume from
the graph rather than from operator-composed seeds.

The single biggest leverage of this design is **converting "what should I
work on next?" from an operator decision into a database query**. Every
piece of subsequent infrastructure (the Mayor pattern, autonomous
dispatch, capability-based routing) is downstream of having a queryable
work graph. Plan is the producer; everything else consumes.

The shape is borrowed from gastown's `mol-idea-to-plan` formula but
deliberately scaled down: garden runs ~10 concurrent workers, not 50,
and is operated by one human. Multi-round, multi-dimensional review is
a Phase 2 luxury, not a Phase 1 requirement.

## Pipeline (authoritative — for the worker's user-visible behavior)

The plan worker walks through seven phases inside the `working` state.
The phase boundary is internal to the worker; the poller never sees it.

```
[1 intake]          Worker drafts a structured spec from the operator's seed.
                    Output: <worktree>/.garden/plan/<id>/draft.md
       v
[2 prd-review]      N reviewers run in parallel, one dimension each.
                    Output: <worktree>/.garden/plan/<id>/reviews/<dim>.md
                    Worker synthesizes consolidated questions for the operator.
       v
[3 human-gate]      Worker emits questions to its tmux pane and ends the turn.
                    Operator types answers as the next user message.
                    Worker incorporates answers into draft.md.
       v
[4 plan]            Worker generates implementation plan from the refined draft.
                    Output: <worktree>/.garden/plan/<id>/plan.md
       v
[5 plan-review]     N reviewers run in parallel, one dimension each.
                    Output: <worktree>/.garden/plan/<id>/plan-reviews/<dim>.md
                    Worker applies must-fix changes to plan.md.
       v
[6 to-beads]        Worker writes a script of bd commands.
                    Output: <worktree>/.garden/plan/<id>/beads.sh
                    Worker executes the script, creating an epic + children.
       v
[7 verify]          Worker re-reads plan.md against the created beads,
                    files any gaps, validates the dependency graph
                    (no cycles, ready frontier non-empty).
       v done
```

Phase 3 (human-gate) is the only step that requires operator attention.
All other phases run autonomously. A typical plan run terminates in
15-30 minutes wall clock for a medium-scope feature. Token cost is
bounded: 2 + 2N model invocations where N is the reviewer count per
fan-out (Phase 1: N=1; Phase 2: N=3).

### Phase semantics

| Phase | Triggered by | Reads | Writes | Ends turn? |
|---|---|---|---|---|
| 1 intake | worker prompt | seed (file or text) | draft.md | no |
| 2 prd-review | draft.md exists | draft.md | reviews/*.md, questions.md | no |
| 3 human-gate | questions.md exists | -- | `.garden-awaiting-input` | yes |
| 4 plan | operator response received | draft.md (refined) | plan.md | no |
| 5 plan-review | plan.md exists | plan.md | plan-reviews/*.md | no |
| 6 to-beads | plan.md (post-review) | plan.md | beads.sh, executes it | no |
| 7 verify | beads exist | plan.md, `bd list` | gap beads (if any) | no |

The worker never moves to a non-`working` poller state during the run.
Phase boundaries are tracked by file existence in the artifacts
directory, not by the registry. This keeps the workflow definition
tiny and avoids bespoke state machine entries.

## Architecture (authoritative)

### Workflow definition

A new file `src/dashboard/workflows/plan.ts` declares the workflow as a
data record:

```typescript
export const planWorkflow: WorkflowDefinition = {
  name: "plan",
  validTransitions: planValidTransitions,  // identical to default
  stateHandlers: {
    working: handleWorking,
    reviewing: handleReviewing,
    "merge-pending": handleMergePending,
    resolving: handleResolving,
    failing: handleFailing,
    merged: handleMerged,
    done: handleDone,
  },
  hookHandlers: defaultHookHandlers,  // until Phase 2 needs divergence
  workerModel: "opus",       // orchestration is judgment-heavy
  reviewerModel: "sonnet",   // dimensional fan-out, lots of invocations
};
```

`planValidTransitions` is a copy of `defaultValidTransitions`, kept
separate (matching the trellis/grow pattern) so it can diverge later
without breaking the type system.

The plan worker walks the same default review/merge pipeline because
its branch contains real artifacts (the `<worktree>/.garden/plan/<id>/`
directory committed to the branch as provenance). The reviewer reads
that provenance and grants approval if the artifacts are coherent;
the merge integrates them into the project's history.

The state machine is unchanged. All seven plan-internal phases happen
inside `working`. The worker advances itself by reading file existence
in the artifacts directory; the poller sees a single long-running
working state and reacts only when the worker writes `.garden-done`.

### Reviewer fan-out

Phase 2 and Phase 5 launch N reviewers in parallel via a new helper:

```typescript
// src/dashboard/plan-reviewers.ts (new file, ~80 lines)
export interface ReviewerSpec {
  dimension: string;       // "gaps" | "scope" | "ambiguity" | ...
  prompt: string;          // dimension-specific reviewer prompt
}

export interface ReviewerResults {
  dimension: string;
  reportPath: string;
  exitCode: number;
}

// Fires N headless reviewers, awaits all FIFO completions, returns
// per-dimension result paths. Reuses launchHeadlessAgent.
export async function launchReviewers(
  worktree: string,
  planId: string,
  phase: "prd-review" | "plan-review",
  specs: ReviewerSpec[],
): Promise<ReviewerResults[]>
```

Each reviewer is one `claude -p` shot in a hidden tmux window. The
worker writes the reviewer's prompt to a file, fires
`launchHeadlessAgent`, and `await`s a Promise that resolves when the
FIFO is poked. Per-reviewer timeout is enforced by the caller via
`onLaunched` and a delayed wake-up, mirroring how
`poller-review.ts` does it today.

Reviewer prompts are dimension-specific. Phase 1 uses a single
"general" reviewer (no fan-out). Phase 2 introduces three dimensions
per phase:

- **PRD-review dimensions**: gaps, scope, ambiguity
- **Plan-review dimensions**: completeness, sequencing, testability

These six dimensions are the highest-leverage subset of gastown's
twelve. Adding more is a prompt-only change in Phase 3+.

### Worker prompt composition

A new file `src/dashboard/plan-prompts.ts` (mirroring
`trellis-prompts.ts`) composes the orchestrator's system prompt. The
prompt teaches the orchestrator:

- The seven-phase pipeline and how to detect which phase it's in
- Where to write artifacts (`<worktree>/.garden/plan/<id>/...`)
- How to invoke reviewers (it does NOT call `launchReviewers`
  directly — the worker uses a `garden plan-review <phase>` CLI
  shim that internally calls the helper; see "CLI surface")
- How to format the human gate (write questions to `questions.md`,
  touch `.garden-awaiting-input`, end the turn)
- How to construct `beads.sh` (the script of `bd create` and
  `bd dep add` calls with hash IDs and project labels)
- When to write `.garden-done`

The orchestrator runs as a normal worker session. Its prompt is
loaded by `bootstrap.ts` via the workflow's prompt-composition
hook, the same mechanism trellis uses today.

### Artifacts directory

Every plan run owns a directory under the worktree:

```
<worktree>/.garden/plan/<plan-id>/
+-- draft.md             # Phase 1 output, refined by Phase 3
+-- questions.md         # Phase 2 -> Phase 3 handoff
+-- answers.md           # Phase 3 operator response, captured by worker
+-- reviews/
|   +-- gaps.md          # Phase 2 reviewer output
|   +-- scope.md
|   `-- ambiguity.md
+-- plan.md              # Phase 4 output, refined by Phase 5
+-- plan-reviews/
|   +-- completeness.md
|   +-- sequencing.md
|   `-- testability.md
+-- beads.sh             # Phase 6 script (logged for provenance)
`-- summary.md           # Phase 7 final report
```

`<plan-id>` is a short hash (8 chars from a sha of seed + timestamp).
Artifacts are committed to the worker's branch. The eventual merge
preserves them in the project's history; reviewers reading the
branch can audit how the beads came to be.

The artifacts directory is the worker's working memory across phase
boundaries. The orchestrator can crash and restart; the new session
detects which phase to resume by checking which files exist (e.g.,
`plan.md` exists but `plan-reviews/` empty -> resume at Phase 5).

## Beads integration (authoritative)

### Database location

Beads lives at `~/.beads/`. This is the beads-native convention and
the path that `bd` resolves with no `BEADS_DIR` override and no
project-local `.beads/` directory in cwd. Garden, board, and clio
all see the same store with no special wiring.

**Garden sets `BEADS_DIR=~/.beads/` in every worker's tmux env**,
alongside the existing `GARDEN_WORKER` / `GARDEN_PROJECT` /
`GARDEN_BRANCH` / `GARDEN_BASE_BRANCH` injection. This is
authoritative: every garden worker — not just plan — inherits the
override, so any `bd` invocation from any worker hits the user-level
store regardless of cwd. The cwd-resolution path is bypassed
entirely; no `cd` dance, no silent project-local-store pollution.

Project-local beads stores remain possible for projects that
genuinely want them (board's own dev workflow is the obvious
example — board's `.beads/` lives at its repo root today). Per-
project override becomes a future `garden config <project>
beads-dir <path>` flag that wins over the env injection. Out of
scope for Phase 1.

Rejected: per-project DBs as the default. The medium-term vision
(garden + board + clio with cross-cutting human/agent dependency
mapping) requires a single graph. Per-project DBs would force every
tool to aggregate, and cross-project dependencies become awkward.
Two-level (gastown's town + rig pattern) adds complexity that solves
problems garden doesn't have.

### Labels and IDs

Every bead created by plan gets:

- `project:<name>` — the rig/project this work targets. The plan
  worker is launched against a primary project; that's the default
  label. Children may have other project labels if the plan spans
  rigs.
- `plan:<plan-id>` — **mandatory invariant**. Groups all beads
  created in one plan run. This is the recovery primitive: a bad
  plan run is cleaned up via `bd close $(bd list --label
  "plan:<plan-id>" --json | jq -r '.[].id')`. Without this label,
  bad-plan recovery becomes forensics. The script-generation
  prompt enforces it; the pre-execution validator (see "Execution
  safeguards" below) hard-fails if any `bd create` line in
  `beads.sh` lacks it.
- `garden:source` — marks the bead as garden-created (vs.
  operator-typed in board). Useful for audit and for clio later.

Bead IDs are beads' default hash format (`<prefix>-a1b2`). Garden
does not invent IDs.

### Epic and children

The plan worker creates one epic bead per plan run, then children
hung off it via `bd dep add --type=parent-child`. Children that
block other children get explicit `bd dep add --type=blocks` edges.

```bash
# Conceptual; real script lives at <worktree>/.garden/plan/<id>/beads.sh
EPIC=$(bd create --title="Add notification levels" --type=epic \
       --description="See <worktree>/.garden/plan/<id>/plan.md" \
       --label "project:garden,plan:abc12,garden:source" --json | jq -r .id)

T1=$(bd create --title="Schema migration for level column" --type=task \
     --label "project:garden,plan:abc12,garden:source" --json | jq -r .id)
bd dep add --type=parent-child $T1 $EPIC

T2=$(bd create --title="Migration runner CLI flag" --type=task ...)
bd dep add --type=parent-child $T2 $EPIC
bd dep add --type=blocks $T2 $T1   # T2 needs T1 first
```

The script is generated by the orchestrator from `plan.md` and
written to `beads.sh` before execution. **Auto-execute is the
default**, gated by the safeguards below. The committed `beads.sh`
is the audit artifact; operator can review post-hoc, and recovery
is one shell command away (label-based cleanup, see above).

### Execution safeguards (authoritative)

Three invariants enforced before `beads.sh` runs. All three ship
in Phase 1, not later — they are the price of auto-execute.

1. **Hard cap of 50 beads per run.** The orchestrator aborts and
   ends its turn with `.garden-awaiting-input` if `beads.sh`
   contains more than 50 `bd create` lines. Cap is configurable
   per-run via `--max-beads N`; the default kills runaway LLM
   behavior without operator-tunable knobs.
2. **Mandatory `plan:<plan-id>` label on every `bd create`.**
   Pre-execution validation: every `bd create` line must include
   `--label "...plan:<plan-id>..."` or the worker hard-fails and
   ends its turn with `.garden-awaiting-input`. This is the
   recovery primitive; it is non-negotiable.
3. **`--dry-run` flag available from Phase 1.** When set,
   `beads.sh` is generated and committed to the branch but not
   executed. The worker writes a summary of what *would* have
   been created and ends its turn with `.garden-awaiting-input`
   for operator review. Default is auto-execute; this is the
   opt-in safety net for risky-feeling seeds.

## Worker shape (authoritative)

### Orchestrator-as-worker

The plan orchestrator runs as a normal `garden workers new` worker
in a normal worktree. It is visible in the dashboard like any other
worker. It uses the standard sandbox, hooks, account resolution,
and lifecycle.

The orchestrator owns:

- Drafting (Phase 1) and re-drafting (Phase 3 incorporation) the spec
- Synthesizing reviewer output (Phases 2, 5)
- Generating the plan (Phase 4)
- Generating and executing `beads.sh` (Phase 6)
- Verification (Phase 7)

The orchestrator delegates:

- Per-dimension review (Phases 2, 5) -> headless reviewers via
  `launchReviewers`

The orchestrator does NOT:

- Spawn other workers
- Modify code outside `<worktree>/.garden/plan/<id>/`
- Push to remote during phases 1-6 (commits-to-remote happens at
  the end via the standard merge pipeline, with all artifacts
  bundled into the merge commit)

### Worker worktree

Plan workers run in the project's worktree, like default workers.
The branch contains only `.garden/plan/<id>/` artifacts and the
`beads.sh` log. The merge integrates these into the project's
history as provenance.

Future evolution: a dedicated `~/.garden/plan-worktrees/<id>/`
worktree shared across projects, useful when a plan creates beads
spanning multiple rigs. Out of scope for this document.

### Concurrency

Multiple plan workers can run simultaneously, one per project. Each
operates on its own worktree and its own `<plan-id>` directory.
They all write to the same `~/.beads/` store; bd's hash IDs prevent
collisions.

A single plan worker runs reviewers concurrently within itself
(N=3 in Phase 2). The dashboard sees those as transient hidden
windows (`<worker>-plan-review-<dim>`), not as registry-tracked
workers.

## Human gate mechanics (authoritative)

The single human gate is Phase 3. The orchestrator must end its turn
cleanly to surrender control to the operator. The challenge is that
garden's auto-continue (`continue.ts`) re-prompts a worker that ends
its turn — fine for default workers, hostile to a worker waiting on
human input.

### Sentinel: `.garden-awaiting-input`

A new sentinel file `<worktree>/.garden-awaiting-input` flags
"this worker is mid-task but waiting on operator input."
`continue.ts` checks for it before issuing an auto-continue
prompt and skips when present.

```
+-- .garden-done            existing: "I am finished, do not continue me"
+-- .garden-awaiting-input  new:      "I am paused for operator input"
```

The two sentinels are mutually exclusive in semantics. Auto-continue
logic:

```
if .garden-done exists:        skip (worker is finished)
if .garden-awaiting-input:     skip (worker is waiting)
otherwise:                     auto-continue per existing rules
```

The plan orchestrator writes the sentinel before ending Phase 2
output, deletes it at the start of Phase 4 (when it begins
incorporating the operator's answer). If the orchestrator crashes
between write and delete, the sentinel remains; on restart, the
new session sees `questions.md` + `.garden-awaiting-input` and
correctly resumes by waiting (or, if it already has the operator's
answer in conversation history, deleting the sentinel and proceeding).

### Operator interaction

The orchestrator outputs questions to its tmux pane via standard
prose output. The operator sees them in the dashboard worker pane,
types answers as the next user message, and the orchestrator
resumes. No new dashboard UI, no new commands. The interaction
shape is "Claude asks you a question, you answer in chat" — already
how every Claude Code session works.

The orchestrator captures the operator's answers to
`<worktree>/.garden/plan/<id>/answers.md` so subsequent phases can
read them deterministically (without depending on conversation
history that may compact).

### Status-pane integration

The dashboard status pane displays plan workers with a new icon
in the `working` state when `.garden-awaiting-input` exists.
Suggested glyph: `?` (question mark) — it visually signals
"waiting on you" and matches the existing `?` for "asking" mid-turn.
The plan-asking variant is distinguished by the worker still being
in poller state `working`, not by a separate status entry.

This is a Phase 1 nice-to-have. Phase 1 may ship without the
glyph and just show the standard `working` icon. Phase 2 adds
the visual cue.

## CLI surface (authoritative)

### Triggering

Mirroring grow's pattern:

```bash
# Direct
garden workers new <project> --workflow plan --seed "Add notification levels..."
garden workers new <project> --workflow plan --seed-file path/to/idea.md

# Via picker
# Shift-Opt-N opens the workflow picker; (p) row selects plan and prompts
# for a single-line seed. Multi-line seeds require --seed-file.
```

`<project>` is the primary project. Beads created get
`project:<project>` by default; the orchestrator can label children
differently if the plan spans rigs.

Optional flags:

- `--dry-run` (Phase 1) — generate and commit `beads.sh` but skip
  execution; worker ends turn with `.garden-awaiting-input` for
  operator review
- `--max-beads <n>` (Phase 1) — override default 50-bead cap
- `--reviewers <n>` (Phase 2) — override default fan-out (default: 3)
- `--no-fan-out` (Phase 2) — fall back to single reviewer per phase

### Reviewer launch shim

The orchestrator does not call `launchReviewers` directly (it's a
TypeScript function inside the dashboard process, not accessible
from a worker session). Instead, a thin CLI command wraps it:

```bash
garden plan-review <phase> --plan <plan-id> --worker <worker-name>
```

The orchestrator runs this command from its session; the dashboard
process receives an IPC, fires `launchReviewers`, waits, and
returns the consolidated reviewer reports. The command blocks
until all reviewers complete.

Implementation: a new file `src/commands/plan-review.ts`. Mirrors
the trellis CLI shims that already exist for verdict parsing.

## Phased delivery (forward-looking)

### Phase 1 — skeleton + happy path (1-2 days)

**Deliverable**: end-to-end plan run for a small feature, no fan-out,
single reviewer per phase, auto-execute with safeguards.

- `src/dashboard/workflows/plan.ts` — workflow definition
- `src/dashboard/plan-prompts.ts` — orchestrator prompt
- `src/dashboard/plan-reviewers.ts` — `launchReviewers` helper
  (used with N=1 in Phase 1)
- `src/dashboard/plan-validate.ts` — pre-execution validator
  (50-bead cap + mandatory-label check)
- `src/commands/plan-review.ts` — CLI shim
- `src/dashboard/continue.ts` — `.garden-awaiting-input` sentinel
  check
- Worker env injection — set `BEADS_DIR=~/.beads/` alongside
  existing `GARDEN_*` vars (one-line addition to the existing
  injection site)
- `WORKFLOWS.md` — register plan workflow, add `(p)` row to picker
- `CLAUDE.md` — add plan to workflow list under "CLI surface"

Acceptance: `garden workers new garden --workflow plan
--seed "Add a 'reviewers' flag to plan workers that overrides the
fan-out count"` produces an epic + 3-5 child beads in `~/.beads/`,
viewable in board, with correct project labels and at least one
parent-child dependency. The plan worker self-completes via
`.garden-done` and its branch merges cleanly.

### Phase 2 — dimensional fan-out (1 day)

**Deliverable**: reviewers run in parallel, one per dimension, per
phase.

- Update `plan-reviewers.ts` to support N>1 with concurrent FIFOs
- Author six reviewer prompts (3 PRD + 3 plan dimensions) in
  `plan-prompts.ts`
- Add `--reviewers` and `--no-fan-out` CLI flags
- Update orchestrator prompt to synthesize multi-dimensional
  reports
- Status-pane glyph for `.garden-awaiting-input`

Acceptance: a non-trivial seed produces an epic + 8-15 children
with multi-edge dependencies. The dimensional reviews catch issues
the single-reviewer Phase 1 misses (concrete benchmark: a known
ambiguous seed surfaces an "ambiguity" finding that the operator
must resolve at the human gate).

### Phase 3 — verification + bead ingestion (out of scope, separate doc)

This phase encompasses two distinct but related questions:

1. **Verification passes**: the gastown approach runs three sequential
   "verify the beads cover the plan" passes. Phase 1 does one. Adding
   more is a prompt-loop change in `plan-prompts.ts`.

2. **Bead ingestion**: how do garden's *consuming* workflows (default,
   trellis, grow) actually read from `~/.beads/`? Today they read from
   operator-composed seeds. The next evolution: `garden workers new
   <project> --bead <id>` pulls the bead's title, description, and
   labels into the worker's seed. Or auto-dispatch from a plan epic
   (sling-equivalent). This is a substantial design in its own right
   and gets its own document — `INGEST.md` or similar.

Phase 3 unblocks the autonomous-Mayor pattern: once garden can both
produce graphs (via plan) and consume them (via ingest), the
operator's role shrinks to the human gate and any escalations.

## Out of scope

- **Auto-Mayor**: a long-running orchestrator that spawns plan
  workers without operator invocation. Requires bead ingestion
  (Phase 3) plus an escalation primitive (separate doc).
- **Multi-round refinement**: gastown's 3+3 rounds of PRD-align and
  plan-review. Phase 1 does one round; adding more is a prompt
  change but increases token cost ~3x. Defer until quality demands
  it.
- **Capability-based routing**: assigning beads to specific worker
  pools based on demonstrated skill. Requires bead ingestion plus
  an attribution model. Future doc.
- **Cross-rig plan workers**: a single plan run that creates beads
  in multiple projects. Possible today via the `project:<name>`
  label override; out of scope for the *worker placement* design
  (the worker still lives in one project's worktree).
- **Bead update from execution**: when a worker closes a bead via
  `bd close`, what propagates back to the plan epic? Phase 3
  concern.
- **board integration tests**: verifying that plan-created beads
  appear correctly in board's TUI. Manual verification for now;
  automated when both projects stabilize.

## Open questions

These are unresolved decisions that affect Phase 1 implementation
or Phase 2 scoping. Listed in priority order.

1. **Human-gate UX when the operator is AFK**. The worker holds
   `.garden-awaiting-input` and waits indefinitely. No timeout,
   no escalation. For now this is fine (operator notices via
   dashboard glyph), but as autonomy increases we'll want a
   stale-detection patrol (gastown's escalation pattern). Out
   of scope for Phase 1; flag for future.

2. **Plan-author skill: needed for Phase 1?** Trellis has a
   `trellis-author` skill for elaborate seed composition. Plan
   could mirror this. Recommended: ship Phase 1 *without* the
   skill (CLI-only via `--seed`/`--seed-file`); add the skill in
   Phase 2 once we know what seed-composition pain looks like.
   The picker's `(p)` row prompts for a single-line seed; complex
   seeds use `--seed-file`.

3. **Handling seed inputs that are too small for plan to add
   value**. If the operator types `garden workers new ... --seed
   "fix the typo in convert.ts"`, plan will dutifully run a
   PRD review and reviewers and produce one bead — wildly
   over-engineered. We should detect this. Options: (a) the
   orchestrator detects "this is trivial" and short-circuits to
   a single bead with no review; (b) operator selects the right
   workflow (default for typos, plan for features); (c) a
   `garden plan triage <seed>` pre-check that recommends a
   workflow. Recommended: (b) for Phase 1, document the
   sweet-spot in CLAUDE.md. (c) is a nice future addition.

## Failure modes

| Failure | Detection | Recovery |
|---|---|---|
| Reviewer times out | `launchHeadlessAgent` `onLaunched` timer | Worker proceeds with available reviews; logs partial-fan-out warning |
| All reviewers fail | All FIFOs return non-zero | Worker escalates: writes `escalation.md`, ends turn with `.garden-awaiting-input` |
| `bd create` fails mid-script | non-zero exit on a `bd` line | Worker captures failure, writes `beads.sh.failed` with the failing line, ends turn with `.garden-awaiting-input` for operator decision |
| Operator never answers human gate | indefinite wait | No automated recovery; status-pane glyph is the only signal. Future: stale escalation. |
| Crash between phases | session dies mid-orchestration | Restart resumes by checking which artifact files exist; the artifacts directory is the resume oracle |
| Plan epic created but children fail | partial graph in `~/.beads/` | Phase 7 verify catches the gap and either retries or files an alert; Phase 1 may simply leave the partial graph and surface the discrepancy in `summary.md` |

## File layout summary

New files:

- `src/dashboard/workflows/plan.ts` (~50 lines) — workflow definition
- `src/dashboard/plan-prompts.ts` (~250 lines) — orchestrator + reviewer prompts
- `src/dashboard/plan-reviewers.ts` (~80 lines) — `launchReviewers` helper
- `src/dashboard/plan-validate.ts` (~50 lines) — pre-execution
  safeguards (50-bead cap + mandatory-label check)
- `src/commands/plan-review.ts` (~50 lines) — CLI shim for orchestrator-driven reviewer launch
- `docs/future/PLAN-WORKFLOW.md` (this file)

Modified files:

- `src/dashboard/workflows/index.ts` — register `planWorkflow`
- `src/dashboard/workflows/types.ts` — add `planValidTransitions`
- `src/dashboard/continue.ts` — `.garden-awaiting-input` sentinel check
- worker env injection site (wherever `GARDEN_WORKER` etc. are set)
  — add `BEADS_DIR=~/.beads/`
- `src/cli.ts` — register `plan-review` command, add `plan` to
  `workers new --workflow` help, add `--dry-run` and `--max-beads` flags
- `src/commands/workers.ts` (or wherever the picker lives) — add `(p)` row
- `WORKFLOWS.md` — add "Plan workflow" section after Phase 1 ships (this doc folds in)
- `CLAUDE.md` — list `plan` under "CLI surface" workflows

Approximate Phase 1 scope: ~480 lines of new code across 5 files,
plus prompts, env-injection, and doc updates. Comparable to the
trellis Phase 1 landing.

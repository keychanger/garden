# Botanist Workflow

> This document lives under `docs/future/` — it describes an unshipped
> design. Workers must not act on it (no botanist workflow exists in the
> registry, no `garden botanist` command, no skill bundle). See
> `rules.md` § Specifications and documentation.

Design document for `botanist`, a proposed garden workflow whose unit of
output is a **design artifact, not a commit** — and whose deeper purpose is to
put a *strong* model in the design seat, in the loop with the operator, then
hand the approved design off to a *builder* that can be a different, cheaper, or
simply different-blind-spots model. Where default, trellis, and grow workers
fuse design and build into one worker on one model, a botanist splits them: the
botanist designs, an implementing worker builds, a strong reviewer checks. Each
of those three seats is independently selectable and freely swappable.

## Status

- **Phase 1** (workflow skeleton, docs-only writes, operator-gated
  completion, operator-driven handoff): not started. No code, no CLI surface,
  no skill bundle.
- **Phase 2** (crew-parameterized assisted handoff, artifact-type awareness):
  designed below, not started.
- **Phase 3** (design-role-in-crew, optional design-review fan-out): sketched,
  deferred.

This revision (2026-07-16) is a **synthesis**. It absorbs the design-artifact
lifecycle this doc already carried, folds in the transferable machinery from
[`PLAN-WORKFLOW.md`](PLAN-WORKFLOW.md), builds on the now-shipped **crew** axis
from [`CREWS.md`](CREWS.md), and incorporates a design conversation whose new
contribution is the load-bearing idea below: **the designer is a role, not a
model — pick who fills it per run.**

### What this doc absorbs

- **From this doc's prior self:** the four-phase design pipeline, the
  design-posture rules inversion, the `.garden-awaiting-input` human gate, the
  artifacts-directory-as-resume-oracle, no-reviewer-on-the-botanist-branch.
- **From [`PLAN-WORKFLOW.md`](PLAN-WORKFLOW.md) (its sibling, not its rival):**
  the file-existence phase tracking, the shared `.garden-awaiting-input`
  sentinel, and the *optional* dimensional-review fan-out as a way to sharpen
  the questions the operator sees. Plan converts intent → a **beads graph** for
  execution; botanist converts intent → a **design doc** for human approval.
  They stay siblings (see "Relationship to plan and crews").
- **From [`CREWS.md`](CREWS.md) (shipped 2026-07-10):** the load-bearing thesis
  that *who runs each role* is an axis orthogonal to *which lifecycle runs* —
  and the crew infrastructure (`resolveReviewRole`, member-based crews, the
  reviewer-strong safety invariant) that this design reuses rather than
  reinvents. CREWS explicitly named "a real plan/design role" as a deliberately
  unbuilt future, with the warning that "a crew selector must not be designed
  around a role that isn't wired." This doc is where that role gets wired.
- **From the design conversation:** that the ROI concentrates in three specific
  places (the cognitive-mode split, the operator checkpoint, and
  model/harness *diversity* across design→build→review) and evaporates if the
  botanist and the builder are the same strong model with no gate — so the
  design makes the checkpoint and the crew-diversity first-class, not
  incidental.

## Intent

Garden's workers are biased toward action: commit, push, merge. Their
`rules.md` preamble tells them "make your best judgment and proceed" and
"never produce partial work and stop." That posture is correct for
implementation but actively harmful for design — a worker told to "make the
call and move on" will pick the first plausible approach and start writing code
before the operator has had a chance to redirect.

Botanists invert that posture. Their explicit job is to think out loud, propose
alternatives, surface tradeoffs, and ask clarifying questions. Their
deliverable is a document the operator reads, edits, and either approves or
sends back for another round. When the operator approves, the botanist's last
act is to hand off to a worker that will build it.

The leverage is two compounding splits:

1. **Cognitive mode.** Design and build are different cognitive modes, and
   forcing them through the same prompt produces worse outputs in both
   directions. Workers under-design; trellis workers can't redesign mid-flight;
   default workers ship the first approach. A dedicated design mode lets the
   operator iterate cheaply on intent before any code is written.

2. **Model.** Once design and build are separate *seats*, they no longer have
   to be the same *model*. The operator's instinct — *"I like to have these
   conversations with a strong model before we commit, then imagine handing it
   off to a Sonnet worker, or a Codex worker, and flipping that around freely"*
   — is the whole point. A botanist run is the front of a **model-diverse
   pipeline**: a strong model designs with you in the loop, a builder crew (as
   cheap or as different as you like) implements, a strong reviewer catches what
   the builder missed. Diversity across the three seats is a correctness
   multiplier (different training, different blind spots), not just a cost play.

## The core idea: design is a role, botanist is the lifecycle

The single most important design decision, inherited straight from
[`CREWS.md`](CREWS.md)'s thesis, is to keep two axes orthogonal:

| Axis | What it selects | Concretely |
|---|---|---|
| **Workflow** | The *lifecycle* — how many gates, does it merge code, who dispatches next. | `botanist` (this doc): frame → options → converge → publish → handoff. |
| **Crew** | *Who* fills each seat — designer / builder / reviewer — each a `(harness, model[, provider])`. | `codex` designs, `claude` builds, `claude` reviews. |

A botanist run therefore has **three seats**, and each resolves independently:

- **Designer** — the botanist worker itself. Judgment-heavy, so it defaults to
  a strong model (Opus), overridable per run.
- **Builder** — the implementing worker spawned at handoff. This is the seat
  the operator flips freely: Sonnet for cheap, Codex for a different lens,
  DeepSeek-behind-Claude for the long tail.
- **Reviewer** — the builder's reviewer, and it stays *strong* by default. This
  is the shipped safety invariant (`CREWS.md`): a cheap or experimental builder
  is only safe because a strong first-party reviewer gates its output.

Crucially, **"design is a role" needs no new resolution mechanism — only the
small generalization CREWS already scoped.** CREWS shipped
`resolveReviewRole(project, workflow, role)` for the review family and named the
follow-on — a role-agnostic `resolveRole` that resolves the worker/designer seat
too — as its own next step; the botanist worker is simply a `designer` role
resolving its harness/model through that generalized path. And like the worker
role — but unlike any review role — the designer is **worker-class**: any member
(including a provider-backed one) may design, because a design is checked
downstream twice (by the operator at the gate, and by a strong reviewer of the
builder's code).
Only review roles are member-restricted.

The practical consequence, and the answer to "flip it around easily": the two
knobs a botanist run exposes are **its own model/harness** (the designer seat)
and a **handoff crew** (the builder + reviewer seats). See "Multi-model" and
"CLI surface" below.

## Pipeline (authoritative — for the worker's user-visible behavior)

A botanist session walks through four phases inside the `working` state. Phase
boundaries are internal; the poller never sees them. Phase membership is tracked
by **file existence** in the artifacts directory (the PLAN pattern), so a
crashed botanist resumes by reading which files exist.

```
[1 frame]           Botanist reads the seed, scans the repo, and writes a
                    problem-framing doc: what is the operator trying to
                    accomplish, what constraints exist, what is out of scope.
                    Output: <worktree>/.garden/botanist/<id>/framing.md
       v
[2 options]         Botanist drafts 2-3 distinct approaches with tradeoffs.
                    Not pros/cons lists — short narrative sketches of how each
                    would work end-to-end, with the load-bearing decisions
                    called out. Emits clarifying questions and ends the turn.
                    Output: options.md, questions.md   (+ .garden-awaiting-input)
       v
[3 converge]        Operator responds in chat. Botanist incorporates answers,
                    picks an approach (or the operator does), drafts the
                    artifact. LOOPS as needed — the operator can request
                    another round of options or refinement.
                    Output: artifact.md   (may loop through options-v2.md ...)
       v
[4 publish]         On operator approval, botanist moves the artifact to its
                    final home (trellis dir, docs/), writes a handoff briefing,
                    and writes .garden-done. The merge integrates the artifact
                    into history. Handoff spawns the builder crew (Phase 2) or
                    prints the command for the operator to run (Phase 1).
                    Output: <final artifact location> + handoff-brief.md
       v done
```

Phase 3 (converge) is the human gate and **loops** — the botanist re-enters it
each time the operator says "try again" or "explore another option." This is the
central difference from plan, which has exactly one human gate. Auto-continue
stays *off* for the entire run; the botanist only re-engages when the operator
types.

### Phase semantics

| Phase | Triggered by | Reads | Writes | Ends turn? |
|---|---|---|---|---|
| 1 frame | botanist prompt | seed (file or text) | framing.md | no |
| 2 options | framing.md exists | framing.md, repo state | options.md, questions.md | yes (gate) |
| 3 converge | operator response | options.md, answers.md | artifact.md, possibly options-v2.md | yes (gate, loops) |
| 4 publish | operator approval | artifact.md | final artifact location, handoff-brief.md | no |

## Multi-model: the three seats are independently selectable (the synthesis)

This is the new spine. It builds entirely on shipped crew infrastructure and
adds no new resolution mechanism.

### The two knobs

A botanist run exposes exactly two model choices, mapping onto the three seats:

1. **The designer seat = the botanist worker's own harness/model.** Resolves
   like any worker: `--harness` / `--model` / project default, with a
   **botanist-workflow default of Opus** (design is judgment-heavy). So `garden
   workers new <p> --workflow botanist --harness codex` gives you a Codex
   designer; the default gives you Opus.

2. **The builder + reviewer seats = a handoff crew.** The botanist carries a
   crew forward to its handoff. `--handoff-crew <name>` selects the implementing
   worker's build member and its reviewer; it defaults to the project's current
   crew. This is the seat the operator flips: `--handoff-crew all-codex`,
   `--handoff-crew claude-codex` (Claude builds, Codex reviews), etc. Because
   crews are *data generated from members* (`CREWS.md`), every provider/harness
   you configure expands the flip-set for free — no botanist code changes.

"Flip Sonnet or Codex freely" is therefore two independent dials the operator
already understands: **who designs** (the botanist's own model) and **which
crew builds** (the handoff crew). The design→build→review pipeline becomes
model-diverse by construction.

### The safety invariant carries unchanged

The builder crew's *reviewer* stays strong first-party Opus by default, exactly
as CREWS guarantees. A cheap Sonnet builder or an experimental Codex builder is
safe precisely because its code is reviewed by a strong reviewer. Botanist does
not relax this; a crew that assigns a weaker reviewer is an explicit,
per-role operator choice. The designer being cheap is likewise safe — a design
is gated by the operator *and* its eventual implementation is reviewed.

### Why not fold the designer into the crew name (yet)

The tempting next step is a **crew triple** — `<designer>-<builder>-<reviewer>`,
e.g. `codex-claude-claude` — extending today's `<builder>-<reviewer>` pair. It
is clean in principle (count disambiguates: pair = build/review, triple =
design/build/review) and it makes "who designs" a standing project default like
any crew member.

**Recommendation: defer to Phase 3.** For v1, keep crews a pair (the builder
crew) and make the designer's model a *per-run* choice (`--harness` / `--model`
on the botanist spawn), because:

- The designer's model is naturally a per-run decision ("this one's a hard
  design, use Opus"), not a standing project default.
- It leaves the shipped crew parser and the `⌥⇧C` picker byte-unchanged.
- It avoids a reader having to know whether `codex-claude` means design/build or
  build/review.

Promote to the triple only if the operator finds themselves setting a standing
designer default project-wide — at which point it is *data*, not a fork (once
the review-family `resolveReviewRole` is generalized to the role-agnostic
`resolveRole` CREWS scoped, an arbitrary `designer` role is a slot a triple crew
just fills). Named here so the door stays open.

### Cross-harness diversity as a correctness multiplier

The strongest case for mixed seats is not cost — it is that a Codex builder over
a Claude design, reviewed by a Claude reviewer, spreads the pipeline across
different training and different blind spots. For high-stakes work the rule
might deliberately become *designer harness ≠ builder harness ≠ reviewer
harness*, breaking the single-model monoculture. This is the botanist realization
of `CREWS.md`'s "cross-harness review as a correctness multiplier" future — and
it is free here, because the seats are already separate.

## Architecture (authoritative)

### Workflow vs. new entity type

Is a botanist a new workflow variant (alongside default / trellis / grow), or a
separate entity type with its own state machine and CLI surface (`garden
botanists new …`)?

**Recommendation: workflow.** A workflow reuses the registry, dashboard slots,
hooks, `workers new` plumbing, sandbox, and worktree lifecycle. The cost is one
piece of awkwardness — botanists short-circuit the review/merge state machine —
and the trellis precedent shows it is tractable: trellis already overrides
reviewer prompts, verdict vocab, and model pinning. Botanist extends the
override pattern with a workflow flag `skipsReviewMerge: true` that the poller
honors: on `.garden-done`, the branch still merges (botanist artifacts are real
commits) but no reviewer is invoked, because there is no code to critique.

A plain *preset* (the conversation's "MVP: just a prompt + handoff") is
tempting but insufficient, and this is the one place the workflow earns its
keep: botanist genuinely needs three things a preset cannot provide — the
**rules-posture inversion** (design, don't build), the **human gate** that
suppresses auto-continue, and **skip-review merge**. A preset can pin a model
and seed a handoff; it cannot invert the worker's rules or hold the pipeline
open for the operator. So: workflow, but keep Phase 1 minimal.

Promote to a separate entity type only if v0.1 grows behaviors that don't fit:
multi-botanist collaboration on one doc, a botanist watching several worker
branches, or a botanist whose deliverable is a beads graph (which belongs to
plan, not botanist).

### Workflow definition

A new file `src/dashboard/workflows/botanist.ts`:

```typescript
export const botanistWorkflow: WorkflowDefinition = {
  name: "botanist",
  validTransitions: botanistValidTransitions,
  stateHandlers: {
    working: handleWorkingBotanist,       // honors .garden-awaiting-input
    "merge-pending": handleMergePending,  // skips reviewer, merges directly
    merged: handleMerged,
    done: handleDone,
  },
  hookHandlers: defaultHookHandlers,
  workerModel: "opus",      // the designer seat: design is judgment-heavy
  reviewerModel: undefined, // no reviewer on the botanist branch
  autoContinue: false,      // operator-driven; no post-turn re-prompt
  skipsReviewMerge: true,   // merge happens, but no review
};
```

`botanistValidTransitions` drops `reviewing`, `resolving`, and `failing` — they
are unreachable in a no-reviewer workflow. `workerModel: "opus"` is the designer
default and is overridden by `--model` on the spawn.

### Rules preamble inversion

The worker preamble assembled by `buildWorktreeRules` (`src/rules.ts`) is
heavily action-biased. Botanists need the inverse. Implementation:
workflow-aware preamble selection — the composer checks the workflow name and
selects from `rules-worker.md` (default, today's behavior) vs. a new
`rules-botanist.md`. Key inversions:

- **Surface alternatives, don't pick the first plausible one.** Before
  committing to an approach, sketch at least two and name the load-bearing
  tradeoff.
- **Ask clarifying questions when scope is genuinely ambiguous.** A round-trip
  with the operator costs far less than a worker building the wrong thing.
- **Write artifacts, not code.** Edits to `src/`, tests, configs, or build
  files are out of scope. The writeable surface is
  `<worktree>/.garden/botanist/<id>/` plus, at publish time, the artifact's
  final location.
- **Operator-in-the-loop is the default.** Auto-continue is off. End your turn
  with `.garden-awaiting-input` whenever you need direction, not just when
  you're stuck.

The remaining rules (sandbox, branch trap, atomic writes, commit discipline)
carry over unchanged. On a Codex designer, these ride the worktree `AGENTS.md`
exactly as the composed rules do for a Codex worker today (`CREWS.md`).

### Permissions and write scope

Worktree layout is identical to other workers. Write scope is constrained by
convention in the preamble, not by the sandbox. The merge-pending handler
enforces the boundary: it inspects the diff and refuses to merge a botanist
branch that touches anything outside the allowed paths, surfacing an alert and
parking in `failing` for the operator. Allowed paths for Phase 1:

- `<worktree>/.garden/botanist/<id>/**`
- `<worktree>/.garden/trellises/**` (publish target for trellis artifacts)
- `<worktree>/docs/future/**` (publish target for design memos)
- `<worktree>/docs/**/*.md` for files that already exist (refinement passes)

### Artifacts directory

```
<worktree>/.garden/botanist/<id>/
+-- framing.md          # Phase 1
+-- options.md          # Phase 2; may be regenerated as options-v2.md, etc.
+-- questions.md        # Phase 2/3 -> operator
+-- answers.md          # operator response, captured for replay
+-- artifact.md         # the draft; the publish step moves it
+-- handoff-brief.md    # Phase 4 output for the implementing worker
+-- summary.md          # Phase 4 final report
```

`<id>` is a short hash (8 chars from a sha of seed + timestamp), the same
convention plan uses. The directory is the botanist's working memory across
phase boundaries: a crashed session detects which phase to resume by which files
exist (e.g. `artifact.md` exists but no `.garden-done` → resume at publish).

## Human gate mechanics

Botanist relies on the `.garden-awaiting-input` sentinel shared with plan. (If
plan ships first, botanist inherits it; if botanist ships first, it carries the
sentinel and plan picks it up.) The sentinel tells `continue.ts` not to
auto-prompt the worker when its turn ends:

```
+-- .garden-done            existing: "I am finished, do not continue me"
+-- .garden-awaiting-input  new:      "I am paused for operator input"
```

Auto-continue logic: `.garden-done` → skip; `.garden-awaiting-input` → skip;
otherwise auto-continue per existing rules.

The interaction shape is "Claude asks you a question, you answer in chat" — the
same affordance every Claude Code session has. No new dashboard UI in Phase 1.
The botanist holds the sentinel by default during Phases 2 and 3 and captures
the operator's answers to `answers.md` so later phases read them deterministically
(without depending on conversation history that may compact). It clears the
sentinel when transitioning to Phase 4, triggered either by an approval phrase
the botanist recognizes ("approve", "ship it", "publish") or by `garden botanist
publish <worker>`.

### Status-pane integration

In Phase 2, the status pane can grow a `?` glyph in the `working` state when
`.garden-awaiting-input` exists — signaling "waiting on you," distinguished from
the existing mid-turn `asking` state by the worker still being in poller state
`working`. Phase 1 may ship without it.

## Handoff to implementing workers

The natural endpoint of a botanist run is: the operator approves, and an
implementing worker starts building — on the crew the operator chose.

### Phase 1: operator-driven handoff

The botanist's `summary.md` and `handoff-brief.md` include a suggested handoff
command carrying the design as the seed and the chosen crew, e.g.:

```bash
garden workers new garden --workflow trellis \
  --trellis .garden/trellises/notification-levels.md \
  --crew all-codex
```

The operator copies and runs it. Safest default — the operator stays in control
of the design→build transition, no runaway auto-spawn. This is also the
**Phase 0 validation** of the whole multi-model idea: before any auto-handoff
plumbing, prove that a botanist-authored artifact + a `--crew` choice produces a
correctly-configured builder through the *existing* `handoff` skill.

### Phase 2: assisted handoff via the `handoff` skill, crew-parameterized

The botanist invokes the existing `handoff` skill at the end of Phase 4, which
spawns the implementing worker with the artifact pre-loaded as its seed and the
handoff crew applied to the builder + reviewer seats:

```bash
garden botanist publish [<worker>] --handoff <workflow> --handoff-crew <name>
```

The `handoff` skill already spawns named workers into the normal review/merge
flow with a composed briefing (`CREWS.md`, `handoff-dispatch.ts`), so the only
new surface is threading `--handoff-crew` into the spawn (which writes
`entry.crew` on the child, applied live by `resolveReviewRole`). Botanist must
invoke `handoff` only after operator approval; the publish command is the gate.

Phase 2 is optional and deferrable indefinitely without blocking the rest of the
design.

## CLI surface

### Triggering

```bash
# Direct
garden workers new <project> --workflow botanist --seed "Help me think about notification levels..."
garden workers new <project> --workflow botanist --seed-file path/to/idea.md

# Designer-seat model/harness (defaults to Opus / claude-code)
garden workers new <project> --workflow botanist --harness codex
garden workers new <project> --workflow botanist --model opus

# Via picker
# Opt-Shift-N opens the workflow picker; (b) row selects botanist and prompts
# for a single-line seed. Multi-line seeds require --seed-file. The picker's
# crew composer row stages the --handoff-crew (reusing the spawn-draft override).
```

Optional flags:

- `--handoff-crew <name>` — the builder + reviewer crew applied to the spawned
  implementing worker. Defaults to the project's current crew. This is the
  "flip Sonnet/Codex freely" dial.
- `--artifact-type <kind>` (Phase 2) — `trellis` (publish to
  `.garden/trellises/`), `memo` (publish to `docs/future/`), or `freeform`.
  Default: operator decides at publish.
- `--handoff <workflow>` (Phase 2) — after approval, auto-spawn the implementing
  worker with the given workflow (`trellis`, `default`, `grow`). Default: print
  the command, don't auto-spawn.

### Publish command

```bash
garden botanist publish [<worker>] [--handoff <workflow>] [--handoff-crew <name>] [--dry-run]
```

Self-resolves via `$GARDEN_WORKER` when invoked from inside the botanist's pane.
`--dry-run` prints what would be published and where.

### Convert active worker

Following the grow precedent (`garden workers grow`), a default worker deep in a
confusing problem can be converted to a botanist mid-run:

```bash
garden workers botanist [<worker>] --seed "Stop building, help me think about this first"
```

This pauses the current task, captures state in a `framing.md` draft, and flips
the workflow to botanist. Out of scope for Phase 1; flagged for future.

## Skill bundle

A new `botanist` skill bundled into botanist worktrees via
`src/dashboard/skills.ts` (the same mechanism as `done` / `handoff` /
`trellis-author` / `grow`). It documents the four-phase pipeline and how to
detect the current phase, how to format `options.md` (narrative sketches, not
pro/con lists), how to format `questions.md` (numbered, specific, each naming
the decision it affects), how to format the final artifact per `--artifact-type`,
and when and how to invoke `garden botanist publish` (including the handoff
crew). It lives at `src/dashboard/skills/botanist/SKILL.md` and is copied into
`.claude/skills/botanist/` at worktree creation.

## Relationship to plan and crews

- **Plan and botanist are siblings, not rivals.** Plan converts intent into a
  **beads graph** for parallel execution (`bd create` + dependency edges);
  botanist converts intent into a **design doc** for human approval. A future
  combined flow reads naturally: botanist designs → operator approves → plan
  decomposes the artifact into beads → default/trellis/grow workers (each on
  their chosen crew) execute. Botanist does not produce beads; if it wants to,
  that is plan's job, invoked at handoff.
- **Crews are shipped; botanist consumes them.** The crew axis,
  `resolveReviewRole`, the member model, the reviewer-strong invariant, and the
  `⌥⇧C` picker all exist today. Botanist's Phase 1/2 seats reuse them directly —
  the designer seat is the worker's own model/harness (worker-path resolution)
  and `--handoff-crew` writes `entry.crew`, resolved live by `resolveReviewRole`
  — so it invents no new resolution mechanism. The one open crew *extension* — a
  designer member in the crew name (the triple) — is deferred, and it is the one
  piece that needs `resolveReviewRole` generalized to the role-agnostic
  `resolveRole` CREWS scoped (see "Why not fold the designer into the crew name
  yet").

## Phased delivery (forward-looking)

### Phase 0 — prove the multi-model handoff (hours, no new workflow)

Before writing `botanist.ts`, validate the spine with existing tools: run a
normal default worker on Opus in "design-first" mode, have it author a trellis,
and hand off via the `handoff` skill with an explicit `--crew`. Confirms that a
design artifact + a crew choice produces a correctly-configured builder through
the shipped path. De-risks Phase 1 and directly exercises the operator's
"flip it freely" requirement.

### Phase 1 — skeleton + happy path + operator-driven handoff (1-2 days)

**Deliverable**: end-to-end botanist run that produces a trellis doc on a strong
model, the operator approves it, the artifact lands in `.garden/trellises/` on a
clean merge, and `summary.md` carries a crew-parameterized handoff command the
operator runs by hand.

- `src/dashboard/workflows/botanist.ts` — workflow definition
- `src/dashboard/botanist-prompts.ts` — designer system prompt
- `src/dashboard/botanist-publish.ts` — publish handler (artifact move +
  writeable-path enforcement + write `.garden-done`)
- `src/commands/botanist.ts` — `publish` subcommand
- `src/dashboard/continue.ts` — honor `.garden-awaiting-input` (shared with plan)
- `src/dashboard/skills/botanist/SKILL.md` + `skills.ts` bundling
- `rules-botanist.md` + `src/rules.ts` workflow-aware preamble selection
- Designer-seat wiring: `--harness` / `--model` already flow through
  `workers new`; the workflow default `workerModel: "opus"` supplies the design
  default
- `WORKFLOWS.md` / `CLAUDE.md` — register botanist, add `(b)` picker row

Acceptance: `garden workers new garden --workflow botanist --seed "Let's
redesign how the dashboard surfaces worker errors"` produces `framing.md` and
`options.md`, ends its turn with `.garden-awaiting-input`, and after a couple of
rounds of operator chat produces a trellis at `.garden/trellises/<name>.md` that
a subsequent `garden workers new garden --workflow trellis --trellis <path>
--crew all-codex` consumes unmodified.

### Phase 2 — crew-parameterized assisted handoff + artifact types (1 day)

**Deliverable**: one command kicks off a botanist that, after approval,
auto-spawns the builder on the chosen crew.

- `--artifact-type` (trellis / memo / freeform)
- `--handoff <workflow>` + `--handoff-crew <name>` threaded into the `handoff`
  skill invocation on publish (writes `entry.crew` on the child)
- Picker crew composer row for `--handoff-crew` (reuse the `spawn-draft`
  override)
- Dashboard `?` glyph for `.garden-awaiting-input`
- `garden workers botanist` to convert an active default worker

Acceptance: after operator approval, a trellis worker on `all-codex`
auto-spawns with the new artifact as its spec — the operator never types the
handoff command.

### Phase 3 — design-role-in-crew + optional design review (out of scope, later)

- **Designer member in the crew name** (the triple), once a standing
  project-wide designer default is wanted. The work is generalizing the
  review-family `resolveReviewRole` to the role-agnostic `resolveRole` CREWS
  scoped, plus the crew parser + picker.
- **Optional design-review fan-out** (the PLAN pattern, scaled to design): a
  cheap `garden botanist review <artifact>` pass that surfaces ambiguity / gaps
  / scope-creep *before* the operator reads the questions, sharpening the human
  gate. The operator remains the primary reviewer; this only pre-filters.

## Out of scope

- **Botanists that write code.** The whole point is the cognitive-mode split.
  A botanist editing `src/` is misbehaving; the merge handler refuses it.
- **Reviewer fan-out as a requirement.** Botanist produces prose the operator
  reads directly; the operator *is* the reviewer. The optional pre-pass above is
  a Phase 3 sharpener, not a gate.
- **Auto-handoff without operator approval.** Phase 2's `--handoff` is gated by
  explicit publish approval. There is no path from "botanist drafted an
  artifact" to "implementing worker is running" that skips the operator.
- **A provider on any review seat.** Even in a diverse pipeline, the builder's
  reviewer stays strong first-party — the shipped safety invariant.
- **Botanist as the planner.** Beads decomposition is plan's job.

## Open questions

1. **Designer default: Opus, or the account default?** Trellis and plan pin
   Opus. Design is judgment-heavy, so Opus seems right — but design is also
   iterative, so per-run cost is higher. Recommended: Opus default, `--model`
   override, measure, revisit.
2. **Handoff-crew default: project crew, or explicit-only?** Defaulting to the
   project's current crew is least-surprise, but a botanist run is exactly when
   an operator might want a *different* crew than the project standard.
   Recommended: default to project crew, make the picker surface it prominently
   so an override is one keystroke.
3. **Workflow flag vs. new state for the no-merge case.** `skipsReviewMerge:
   true` handled by the existing `merge-pending` path (less invasive, adds a
   special case) vs. a new `awaiting-publish` state (cleaner, adds a
   state-machine entry only one workflow uses). Recommended: (a) for Phase 1,
   revisit if a second no-merge workflow appears.
4. **Where the artifact lives after publish.** Worker branch merged to main (i)
   vs. a shared `~/.garden/trellises/` (ii) vs. uncommitted (iii). Recommended:
   (i) — least resistance, and trellis already reads project-local paths.
5. **Should the designer read the codebase by default?** Recommended: rely on
   the `rules-botanist.md` preamble to encourage reading-before-drafting; add a
   `--scan <glob>` flag only if that proves under-effective.
6. **Does the triple crew earn its place?** Track whether operators set a
   standing designer default. If they do, wire the triple; if the per-run
   `--harness`/`--model` suffices, leave crews as pairs.

## Failure modes

| Failure | Detection | Recovery |
|---|---|---|
| Botanist edits files outside allowed paths | Diff inspection in publish handler | Refuse to publish, alert, park in `failing` |
| Operator never responds at the human gate | indefinite wait | No automated recovery; status glyph (Phase 2) is the signal. Future: stale escalation |
| Botanist publishes without operator approval | rules preamble + publish command is the gate | The publish command cannot be invoked without the operator; if run from the pane, the operator sees and can interrupt |
| Botanist drifts into building | rules-botanist.md preamble | Operator interrupts; no automated detection in Phase 1 |
| Approved artifact underspecified → builder bounces | builder's normal review cycle | `garden workers botanist` against the failing builder to revise the spec, then re-handoff |
| Handoff crew misconfigured (unknown crew) | validated at `workers new` / publish against the crew presets | Fails loudly at the operator surface, not in production |

## File layout summary

New files:

- `src/dashboard/workflows/botanist.ts` (~60 lines) — workflow definition
- `src/dashboard/botanist-prompts.ts` (~200 lines) — designer prompt
- `src/dashboard/botanist-publish.ts` (~140 lines) — publish handler +
  writeable-path enforcement + handoff-crew threading
- `src/commands/botanist.ts` (~90 lines) — `publish` subcommand
- `src/dashboard/skills/botanist/SKILL.md` (~150 lines) — design-posture skill
- `rules-botanist.md` (~80 lines) — design-posture preamble fragment
- `docs/future/BOTANIST-WORKFLOW.md` (this file)

Modified files:

- `src/dashboard/workflows/index.ts` — register `botanistWorkflow`
- `src/dashboard/workflows/types.ts` — add `botanistValidTransitions`, optional
  `skipsReviewMerge` and `autoContinue` fields on `WorkflowDefinition`
- `src/dashboard/continue.ts` — honor `.garden-awaiting-input` (shared with plan)
- `src/dashboard/poller-merge.ts` — skip reviewer when
  `workflow.skipsReviewMerge`; enforce writeable-path boundary
- `src/dashboard/skills.ts` — bundle `botanist` skill
- `src/rules.ts` — workflow-aware preamble selection
- `src/cli.ts` — register `botanist` command group; `botanist` in `--workflow`
  help; `--handoff-crew` flag
- the workflow picker — add `(b)` row + crew composer row
- `WORKFLOWS.md` — add "Botanist workflow" section after Phase 1 ships
- `CLAUDE.md` — list `botanist` under "CLI surface" workflows

Approximate Phase 1 scope: ~620 lines of new code across 6 files, plus prompts,
rules fragment, and doc updates. Comparable to grow's Phase 1 landing, with most
of the bulk in the skill and prompt files rather than dashboard plumbing.

## Cross-references

- [`PLAN-WORKFLOW.md`](PLAN-WORKFLOW.md) — the sibling that produces a beads
  graph. Shares the `.garden-awaiting-input` sentinel and the
  artifacts-as-resume-oracle pattern; the future combined flow (botanist designs
  → plan decomposes) lives at both docs' edges.
- [`CREWS.md`](CREWS.md) — the shipped crew axis this design consumes: role
  resolution, member-based crews, the reviewer-strong invariant, and the
  explicitly-deferred "plan/design role" this doc wires as the `designer` seat.
- [`MODEL-SELECTION.md`](MODEL-SELECTION.md) — the model dimension of the seat
  choices and the metering-gate future for cheap/foreign builders.
- [`WORKFLOWS.md`](../../WORKFLOWS.md) — the workflow axis botanist joins; the
  home this doc folds into once Phase 1 ships.

# Botanist Workflow

> This document lives under `docs/future/` — it describes an unshipped
> design. Workers must not act on it (no botanist workflow exists in the
> registry, no `garden botanists` command, no skill bundle). See
> `rules.md` § Specifications and documentation.

Design document for `botanist`, a proposed garden workflow whose unit of
output is a **design artifact**, not a commit. Where default, trellis,
and grow workers produce code that gets reviewed and merged, a botanist
produces a markdown spec — most naturally a trellis — that the operator
approves and then hands off to an implementing worker via the existing
`handoff` skill.

The shape borrows nothing from gastown; it is a direct response to a
gap the operator named: today, drafting a trellis is high-friction, so
operators either compose one by hand (slow) or skip it and seed a
default worker with a vague brief (low rigor). Botanist fills that gap.

## Status

- **Phase 1** (workflow skeleton, docs-only writes, operator-gated
  completion): not started. No code, no CLI surface, no skill bundle.
- **Phase 2** (handoff-on-approval, plot-aware artifact placement):
  designed below, not started.

## Intent

Garden's workers are biased toward action: commit, push, merge. Their
rules.md preamble tells them "make your best judgment and proceed" and
"never produce partial work and stop." That posture is correct for
implementation but actively harmful for design — a worker told to "make
the call and move on" will pick the first plausible approach and start
writing code before the operator has had a chance to redirect.

Botanists invert that posture. Their explicit job is to think out loud,
propose alternatives, surface tradeoffs, and ask clarifying questions.
Their deliverable is a document the operator reads, edits, and either
approves or sends back for another round. When the operator approves,
the botanist's last act is to hand off to a worker that will build it.

The intended pipeline:

```
operator idea
     v
[botanist]   designs, proposes, refines
     v
trellis doc (or design memo, or phased plan)
     v
operator approves
     v
[handoff]    spawns an implementing worker (default / trellis / grow)
     v
[worker]     builds, reviewed and merged as today
```

The leverage: **design and build are different cognitive modes, and
forcing them through the same prompt produces worse outputs in both
directions.** Workers under-design; trellis workers can't redesign mid-
flight; default workers ship the first approach. A dedicated design
mode lets the operator iterate cheaply on intent before any code is
written.

## Pipeline (authoritative — for the worker's user-visible behavior)

A botanist session walks through four phases inside the `working`
state. Phase boundaries are internal; the poller never sees them.

```
[1 frame]           Botanist reads the seed, scans the repo, and writes
                    a problem-framing doc: what is the operator trying
                    to accomplish, what constraints exist, what is out
                    of scope.
                    Output: <worktree>/.garden/botanist/<id>/framing.md
       v
[2 options]         Botanist drafts 2-3 distinct approaches with
                    tradeoffs. Not pros/cons lists — short narrative
                    sketches of how each would work end-to-end, with
                    the load-bearing decisions called out.
                    Output: <worktree>/.garden/botanist/<id>/options.md
       v
[3 converge]        Botanist emits clarifying questions to its pane
                    and ends the turn with `.garden-awaiting-input`.
                    Operator responds in chat. Botanist incorporates
                    answers, picks an approach (or the operator does),
                    and drafts the artifact.
                    Output: <worktree>/.garden/botanist/<id>/artifact.md
                    Loops as needed (operator can request another
                    round of options or refinement).
       v
[4 publish]         Botanist moves the approved artifact to its final
                    home (trellis dir, docs/, or wherever the artifact
                    type lives) and writes `.garden-done`. The merge
                    integrates the artifact into the branch's history.
                    Optionally: emit a handoff briefing for the
                    implementing worker.
                    Output: <project>/.garden/trellises/<name>.md (or
                    equivalent) + optional handoff-brief.md
       v done
```

Phase 3 (converge) is the human gate and may loop multiple times — the
botanist re-enters Phase 3 each time the operator says "try again" or
"explore another option." This is the central difference from plan,
which has exactly one human gate.

### Phase semantics

| Phase | Triggered by | Reads | Writes | Ends turn? |
|---|---|---|---|---|
| 1 frame | botanist prompt | seed (file or text) | framing.md | no |
| 2 options | framing.md exists | framing.md, repo state | options.md, questions.md | yes (gate) |
| 3 converge | operator response received | options.md, answers.md | artifact.md, possibly options-v2.md | yes (gate, loops) |
| 4 publish | operator types "approve" / `garden botanist publish` | artifact.md | final artifact location, handoff-brief.md | no |

Phases 2 and 3 both surrender to the operator via
`.garden-awaiting-input` — the design loop is inherently
operator-collaborative. Auto-continue stays off for the entire run;
the botanist only re-engages when the operator types.

## Architecture (authoritative)

### Workflow vs. new entity type

The chief architectural fork: is a botanist a new workflow variant
(alongside default / trellis / grow), or a separate entity type with
its own state machine and CLI surface (`garden botanists new …`)?

**Recommendation: workflow for v0.1.** A workflow reuses the registry,
dashboard slots, hooks, `workers new` plumbing, sandbox, and worktree
lifecycle. The cost is one piece of awkwardness: botanists short-
circuit the review/merge state machine, so we need a way to express
"this workflow does not merge through the standard pipeline."

The trellis precedent shows this is tractable. Trellis already
overrides reviewer prompts, verdict vocab, and the workflow's
`workerModel` / `reviewerModel` pinning. Botanist extends the override
pattern one step further: a workflow flag `skipsReviewMerge: true` that
the poller honors. On `.garden-done`, the poller transitions the
botanist directly to a new state `awaiting-publish` (or just
`merge-pending` with a workflow-specific handler that performs the
artifact move and trivially merges the branch without invoking the
reviewer). The branch still merges — botanist artifacts are real
commits — but no reviewer is invoked, because there is no code to
critique.

Promote to a separate entity type only if v0.1 grows behaviors that
don't fit: multi-botanist collaboration on one doc, a botanist that
watches several worker branches and writes a meta-design, or a
botanist whose deliverable is not a markdown file (e.g., a graph of
beads — which would arguably belong to plan, not botanist).

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
  workerModel: "opus",      // design is judgment-heavy
  reviewerModel: undefined, // no reviewer
  autoContinue: false,      // operator-driven; no post-turn re-prompt
  skipsReviewMerge: true,   // new field; merge happens but no review
};
```

`botanistValidTransitions` drops `reviewing`, `resolving`, and
`failing` — they are not reachable in a no-reviewer workflow.

### Rules.md preamble inversion

The worker preamble assembled by `buildWorktreeRules` in `src/rules.ts`
is heavily action-biased. Botanists need the inverse. The simplest
implementation: workflow-specific rules.md fragments. The composer
checks the workflow name and selects from:

- `rules-worker.md` (default — today's behavior; rename for clarity)
- `rules-botanist.md` (new — design posture)

Key inversions in `rules-botanist.md`:

- **Surface alternatives, don't pick the first plausible one.** Before
  committing to an approach, sketch at least two and name the
  load-bearing tradeoff between them.
- **Ask clarifying questions when scope is genuinely ambiguous.** The
  cost of an extra round-trip with the operator is far less than the
  cost of a worker building the wrong thing.
- **Write artifacts, not code.** Edits to `src/`, tests, configs, or
  build files are out of scope. The botanist's writeable surface is
  `<worktree>/.garden/botanist/<id>/` plus, at publish time, the
  artifact's final location (e.g., `.garden/trellises/`, `docs/`).
- **Operator-in-the-loop is the default.** Auto-continue is off. End
  your turn with `.garden-awaiting-input` whenever you need direction,
  not just when you're stuck.

The remaining rules (sandbox, branch trap, atomic writes, commit
discipline) carry over unchanged.

### Permissions and write scope

Worktree layout is identical to other workers. Write scope is
constrained by convention in the preamble, not by the sandbox — a
botanist that decides to edit `src/foo.ts` is misbehaving but not
prevented. The merge-pending handler enforces the boundary: it
inspects the diff and refuses to merge a botanist branch that touches
anything outside the allowed paths, surfacing an alert and parking
the branch in `failing` for the operator to inspect.

Allowed paths for Phase 1:

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
+-- handoff-brief.md    # optional Phase 4 output for the implementing worker
+-- summary.md          # Phase 4 final report
```

`<id>` is a short hash (8 chars from a sha of seed + timestamp), same
convention as the plan workflow uses.

## Human gate mechanics

Botanist relies on the same `.garden-awaiting-input` sentinel proposed
in PLAN-WORKFLOW.md. (If plan ships first, botanist inherits it for
free; if botanist ships first, it carries the sentinel and plan picks
it up later.) The sentinel tells `continue.ts` not to auto-prompt the
worker when its turn ends.

The interaction shape is "Claude asks you a question, you answer in
chat" — the same affordance every Claude Code session has. No new
dashboard UI in Phase 1. The dashboard status pane can grow a `?`
glyph in Phase 2 to flag "this worker is waiting on you."

Botanists hold the sentinel by default during Phases 2 and 3. They
clear it when transitioning to Phase 4 (publish). The operator
triggers the transition either by typing an approval phrase the
botanist recognizes ("approve", "ship it", "publish") or by running a
CLI command (`garden botanist publish <worker>`), which writes a
sentinel file the botanist reads on its next turn.

## Handoff to implementing workers

The natural endpoint of a botanist run is: the operator approves the
artifact and an implementing worker starts on it. Two implementations:

### Phase 1: operator-driven handoff

The botanist's `summary.md` includes a suggested handoff command, e.g.:

```bash
garden workers new garden --workflow trellis \
  --trellis .garden/trellises/notification-levels.md
```

The operator copies and runs it. This is the safest default — the
operator stays in control of the transition from design to build, and
there's no risk of a botanist auto-spawning a runaway worker.

### Phase 2: assisted handoff via the `handoff` skill

The botanist invokes the existing `handoff` skill at the end of
Phase 4. The skill spawns the implementing worker with the artifact
pre-loaded as its seed. Botanist must invoke `handoff` only after the
operator approves; the gate is enforced by the rules-botanist.md
preamble plus the publish CLI requiring explicit confirmation.

Phase 2 is optional and depends on operator comfort with auto-handoff.
It's deferrable indefinitely without blocking the rest of the design.

## CLI surface

### Triggering

Mirroring trellis and grow:

```bash
# Direct
garden workers new <project> --workflow botanist --seed "Help me think about notification levels..."
garden workers new <project> --workflow botanist --seed-file path/to/idea.md

# Via picker
# Shift-Opt-N opens the workflow picker; (b) row selects botanist and
# prompts for a single-line seed. Multi-line seeds require --seed-file.
```

Optional flags:

- `--artifact-type <kind>` — Phase 2. Hints what shape the deliverable
  should take: `trellis` (publish to `.garden/trellises/`), `memo`
  (publish to `docs/future/`), or `freeform` (operator chooses at
  publish time). Default: operator decides at publish.
- `--handoff <workflow>` — Phase 2. After approval, auto-spawn the
  implementing worker with the given workflow (`trellis`, `default`,
  `grow`). Default: print the suggested command, don't auto-spawn.

### Publish command

```bash
garden botanist publish [<worker>] [--handoff <workflow>] [--dry-run]
```

Self-resolves via `$GARDEN_WORKER` when invoked from inside the
botanist's pane. `--dry-run` prints what would be published and where.

### Convert active worker

Following the grow precedent (`garden workers grow`), a default worker
deep in a confusing problem can be converted to a botanist mid-run:

```bash
garden workers botanist [<worker>] --seed "Stop building, help me think about this first"
```

This pauses the worker's current task, captures its state in a
framing.md draft, and flips its workflow to botanist. Out of scope for
Phase 1; flag for future.

## Skill bundle

A new `botanist-author` skill (or just `botanist`) bundled into
botanist worktrees via `src/dashboard/skills.ts`. The skill documents:

- The four-phase pipeline and how to detect which phase the botanist
  is in
- How to format options.md (narrative sketches, not pro/con lists)
- How to format questions.md (numbered, specific, each with the
  decision it affects)
- How to format the final artifact for each `--artifact-type`
- When and how to invoke `garden botanist publish`

The skill replaces the worker's default-action posture with the
design posture. It lives at
`src/dashboard/skills/botanist/SKILL.md` and is copied into
`.claude/skills/botanist/` at worktree creation, the same way `done` /
`handoff` / `trellis-author` / `grow` are bundled today.

## Phased delivery (forward-looking)

### Phase 1 — skeleton + happy path (1-2 days)

**Deliverable**: end-to-end botanist run that produces a trellis doc,
the operator approves it, and the artifact lands in
`.garden/trellises/` on a clean merge.

- `src/dashboard/workflows/botanist.ts` — workflow definition
- `src/dashboard/botanist-prompts.ts` — orchestrator system prompt
- `src/dashboard/botanist-publish.ts` — publish handler (artifact move
  + writeable-path enforcement + write `.garden-done`)
- `src/commands/botanist.ts` — `publish` subcommand
- `src/dashboard/continue.ts` — honor `.garden-awaiting-input` (shared
  with plan; whichever ships first carries the change)
- `src/dashboard/skills/botanist/SKILL.md` — design-posture skill
- `src/dashboard/skills.ts` — bundle the new skill into botanist
  worktrees
- `src/rules.ts` — workflow-aware preamble selection
  (`rules-botanist.md` vs `rules-worker.md`)
- `WORKFLOWS.md` — register botanist workflow, add `(b)` row to picker
- `CLAUDE.md` — add botanist to workflow list under "CLI surface"

Acceptance: `garden workers new garden --workflow botanist --seed
"Let's redesign how the dashboard surfaces worker errors"` produces a
framing.md and options.md, ends its turn with
`.garden-awaiting-input`, and after a couple of rounds of operator
chat produces a trellis at `.garden/trellises/<name>.md` that a
subsequent `garden workers new garden --workflow trellis --trellis
.garden/trellises/<name>.md` can consume without modification.

### Phase 2 — handoff integration and artifact-type awareness (1 day)

**Deliverable**: smoother transition from approved design to running
implementation.

- `--artifact-type` flag with trellis / memo / freeform variants
- `--handoff <workflow>` flag that invokes the handoff skill on publish
- Dashboard status-pane glyph for `.garden-awaiting-input`
- `garden workers botanist` to convert an active default worker

Acceptance: a single command kicks off a botanist that, after operator
approval, auto-spawns a trellis worker with the new artifact as its
spec. The operator never types the handoff command manually.

### Phase 3 — operator-feel improvements (out of scope, separate doc)

Things that probably matter eventually but don't block Phase 1/2:

- Botanist-to-botanist collaboration on one artifact (two perspectives
  on the same design)
- A `garden botanist review <artifact>` command that runs a
  headless-reviewer pass on an existing trellis/memo, surfacing
  ambiguity / gaps / scope creep before the operator commits to it
- Persistent botanist sessions that span multiple operator
  conversations (a "design partner" that remembers the last week of
  back-and-forth)

These belong in a future doc once Phase 1/2 has shipped and we know
which of them the operator actually wants.

## Out of scope

- **Botanists that write code.** The whole point is the cognitive-mode
  split. If a botanist starts editing `src/`, it is misbehaving.
- **Reviewer fan-out.** Plan needs dimensional review because it
  produces a graph that's hard to audit by reading. Botanist produces
  prose the operator reads directly; the operator IS the reviewer.
- **Auto-handoff without operator approval.** Phase 2's `--handoff`
  flag is gated by explicit publish approval. There is no path from
  "botanist drafted an artifact" to "implementing worker is running"
  that skips the operator.
- **Botanist as the planner.** Plan and botanist are siblings, not
  rivals. Plan converts intent into a beads graph for execution.
  Botanist converts intent into a design doc for human approval.
  When both ship, a typical flow might be: botanist designs the
  feature, operator approves, plan decomposes the artifact into beads,
  trellis/default/grow workers execute the beads.

## Open questions

These are unresolved decisions that affect Phase 1 implementation or
Phase 2 scoping. Listed in priority order.

1. **Workflow flag or new state name for the no-merge case?** Two
   designs: (a) `skipsReviewMerge: true` on the workflow definition,
   handled by the existing `merge-pending` state via a workflow-
   specific path; (b) a new state `awaiting-publish` that botanist
   transitions through instead of `merge-pending`. (a) is less
   invasive but adds a special case to the merge handler; (b) is
   cleaner but adds a state-machine entry that only one workflow
   uses. Recommended: (a) for Phase 1, revisit if a second
   no-merge workflow appears.

2. **Where should the artifact actually live after publish?** Three
   plausible homes for a trellis artifact: (i) the worker's branch,
   merged into main like any other change; (ii) a dedicated
   `~/.garden/trellises/` directory shared across the system; (iii)
   uncommitted in the worktree, operator copies it manually.
   Recommended: (i) for Phase 1 — it's the path of least resistance
   and trellis already reads from project-local paths. Reconsider if
   trellises start spanning projects.

3. **Does the botanist read the codebase by default?** A design memo
   for a frontend redesign should probably scan `src/dashboard/`
   first; a design memo for a new project might not need any reading.
   Recommended: rely on the rules-botanist.md preamble to encourage
   reading-before-drafting, no special mechanism. If this proves
   under-effective, add a `--scan <glob>` flag in Phase 2.

4. **Should `done` and `botanist publish` be the same skill?** Today
   `done` writes `.garden-done` when the operator's full request is
   complete. Botanist's publish also writes `.garden-done`. The
   difference: publish moves the artifact and optionally fires
   handoff. Recommended: separate. `done` stays generic; publish is
   botanist-specific.

5. **Should botanist runs be cheaper / use a faster model?** Trellis
   and plan pin opus. Design is judgment-heavy too, so opus seems
   right — but design is also iterative, so the per-run cost is
   higher. Recommended: opus for Phase 1, measure, revisit.

## Failure modes

| Failure | Detection | Recovery |
|---|---|---|
| Botanist edits files outside the allowed paths | Diff inspection in publish handler | Refuse to publish, surface alert, park in `failing` for operator to inspect |
| Operator never responds at the human gate | indefinite wait | No automated recovery; status-pane glyph (Phase 2) is the only signal. Future: stale escalation. |
| Botanist decides the artifact is "good enough" and publishes without operator approval | rules-botanist.md preamble + publish command requiring explicit invocation | The publish command itself is the gate — botanist cannot publish without it being invoked. If invoked from inside the worker session, the operator sees the command in the pane and can interrupt. |
| Botanist drifts into building instead of designing | rules-botanist.md preamble | Operator interrupts and redirects; no automated detection in Phase 1 |
| Operator approves an underspecified artifact and the implementing worker bounces back | Implementing worker's normal review cycle | The trellis/default worker fails review on the bad artifact. Recovery: operator runs `garden workers botanist` against the failing worker to revise the spec, then re-handoff. |

## File layout summary

New files:

- `src/dashboard/workflows/botanist.ts` (~60 lines) — workflow definition
- `src/dashboard/botanist-prompts.ts` (~200 lines) — orchestrator prompt
- `src/dashboard/botanist-publish.ts` (~120 lines) — publish handler +
  writeable-path enforcement
- `src/commands/botanist.ts` (~80 lines) — `publish` subcommand
- `src/dashboard/skills/botanist/SKILL.md` (~150 lines) — design-posture skill
- `rules-botanist.md` (~80 lines) — design-posture preamble fragment
- `docs/future/BOTANIST-WORKFLOW.md` (this file)

Modified files:

- `src/dashboard/workflows/index.ts` — register `botanistWorkflow`
- `src/dashboard/workflows/types.ts` — add `botanistValidTransitions`,
  optional `skipsReviewMerge` and `autoContinue` fields on
  `WorkflowDefinition`
- `src/dashboard/continue.ts` — honor `.garden-awaiting-input` (shared
  with plan)
- `src/dashboard/poller-merge.ts` (or wherever merge-pending is
  handled) — skip reviewer invocation when
  `workflow.skipsReviewMerge`; enforce writeable-path boundary
- `src/dashboard/skills.ts` — bundle `botanist` skill into botanist
  worktrees
- `src/rules.ts` — workflow-aware preamble selection
- `src/cli.ts` — register `botanist` command group, add `botanist` to
  `workers new --workflow` help
- `src/commands/workers.ts` (or wherever the picker lives) — add `(b)` row
- `WORKFLOWS.md` — add "Botanist workflow" section after Phase 1 ships
  (this doc folds in)
- `CLAUDE.md` — list `botanist` under "CLI surface" workflows

Approximate Phase 1 scope: ~600 lines of new code across 6 files,
plus prompts, rules fragment, and doc updates. Comparable to grow's
Phase 1 landing, with most of the bulk in the skill and prompt files
rather than dashboard plumbing.

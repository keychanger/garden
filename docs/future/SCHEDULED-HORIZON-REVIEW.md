# Scheduled horizon review: catching drift a week after merge

> This document lives under `docs/future/` — it describes an unshipped
> design. Workers must not act on it (no horizon-review command exists, no
> schedule file convention is live, no new tick has been added). See
> `rules.md` § Specifications and documentation.

Design for a **deferred, longer-horizon review**: after a multi-phase task
completes, garden wakes a fresh worker some days later (think a week) to
check whether a decision that looked correct at merge has since drifted —
using a week of accumulated git history, CI history, and sibling activity
that the merge-time review could not have seen because the evidence did
not exist yet.

This is the longer-horizon sibling of the **holistic review** feature
currently being designed in conversation. The holistic review is a
point-in-time snapshot taken at merge: when a default-workflow worker
finishes a task spanning two or more merge cycles, garden spawns one
headless reviewer over the whole-task cumulative diff to catch cross-phase
incoherence (an abstraction introduced in phase 1 that phase 4
invalidated, dead code a later phase orphaned, a shared-registry collision
papered over by "keep every entry"). The holistic review is not yet in the
codebase; this document references it as assumed-near-future context and
positions horizon review as its time-delayed complement, not its
replacement.

## Status

Speculative. No code, no CLI surface, no config keys, no new tick. This
document resolves the four questions that make horizon review an
exploration rather than a build, states a critical verdict on whether it
is worth building at all, and proposes a phased rollout whose first slice
is deliberately the cheapest thing that could prove or kill the idea.

The headline finding is a reframe (see "The reframe" below): the naive
version — schedule every multi-phase merge, wake a worker, point it at the
logs — is a noise machine and should not be built. There is a narrow,
defensible version, and the difference between them is entirely in the
trigger.

## What only time can reveal

The merge-time pipeline already has three gates: the per-phase reviewer
(`poller-review.ts`), the CI gate (`poller-ci.ts`), and the proposed
holistic review over the cumulative diff. All three run against the state
of the world *at merge*. There is a fourth class of defect that none of
them can catch, because the evidence is not present at merge:

- A **deliberate deferral** that was correct in isolation and wrong in
  aggregate. "Do not ratchet the mypy baseline this phase." "Keep every
  registry entry rather than resolve the collision now." "Leave the old
  code path in; a later task will remove it." Each is a reasonable local
  call. Whether it was *right* depends on what happens next — and "next"
  has not happened yet at merge.
- A **shared-surface collision realized later.** Phase 3 of task A touched
  `registry.ts`. A week later, an unrelated sibling worker also built on
  `registry.ts`. The merge-time review of task A could not see the sibling
  work; only hindsight can tell whether the two compose or quietly fight.
- A **decision the codebase grew away from.** An abstraction that fit the
  shape of the code at merge, but three merges of sibling work later is
  now the awkward special case everyone routes around.

A future agent with a week of hindsight has git history, CI history, and
sibling commits the merge-time review never had. That is the genuine value
on the table. Everything below is about extracting that value without
producing the noise the operator is explicitly wary of.

## The reframe: the trigger must carry the hypothesis

The failure mode of any scheduled review is well known and the operator
named it directly: it wakes up, finds nothing actionable, and burns
tokens. A review with no concrete failure hypothesis becomes a fishing
expedition, and most multi-phase tasks merge clean and never regress, so
the catch rate of "review the last week of logs for problems" is close to
zero per run and the false-positive rate is not.

The reframe that makes the feature defensible: **do not schedule a review
that goes looking for problems. Schedule the verification of a specific,
pre-registered hypothesis that became checkable with time.**

Concretely, the producer of horizon work is not "a multi-phase merge
happened." It is "someone — the holistic review, the worker, or the
operator — recorded a named claim of the form *this decision is fine now
but should be re-checked in N days, and here is the exact signal that would
show it went wrong*." That record is a **revisit hypothesis**. If no
hypothesis is recorded for a task, nothing is scheduled and nothing fires.
The horizon worker is never fishing; it is checking one registered claim
against accumulated evidence and answering confirmed / refuted /
superseded.

This single inversion answers the trigger question (Q1) and the
anti-noise half of the output question (Q2) at the same time, and it is
the spine of every recommendation that follows.

## Q1 — Trigger: which completions schedule a future review

**Rejected: every multi-phase merge.** A daily-driver fleet merges
multi-phase tasks routinely. One horizon worker per task per week is a
standing flood that grows with throughput, and it spawns workers to verify
nothing in particular. This is the noise machine; do not build it.

**Recommended: schedule iff a revisit hypothesis was recorded for the
task.** The trigger is the *presence of a hypothesis record*, not the
shape of the merge. Three possible producers, in increasing order of how
much they should be trusted to fire automatically:

1. **The holistic review (preferred, deferred to a later phase).** When
   the merge-time holistic review notices a deferral it judges worth
   re-checking, it emits a hypothesis record as a side output. This closes
   the loop — the point-in-time review hands its uncertainty to its
   time-delayed sibling — but it should be gated and default-conservative,
   because an over-eager holistic reviewer becomes an over-eager horizon
   scheduler.
2. **The worker, via a small skill.** A worker that knowingly defers a
   decision ("not ratcheting the baseline this phase") records the
   hypothesis explicitly before it ends its turn, the same way it writes
   `.garden-done`. This is the highest-signal producer — the agent that
   made the call is best placed to say what would prove it wrong — and the
   cheapest to ship first, because it needs no holistic review to exist.
3. **The operator.** A `garden` subcommand to register a revisit
   hypothesis by hand. Always available; the manual escape hatch and the
   way to dogfood the feature before any automatic producer is trusted.

**Prerequisite gap — there is no merge-cycle counter today.** "Multi-phase
= two or more merge cycles" is not currently detectable for a default
worker. `WorkerEntry` carries `mergedAt` (a timestamp of the last merge),
not a count; only `trellis` and `grow` workers carry an `iteration`
counter (`registry.ts`). Detecting "this task spanned ≥2 merges" requires
adding a per-worker merge counter — incremented in `finalizeMerge`
(`poller-merge.ts`) on each clean merge. This same counter is what the
holistic review needs to decide it should run at all, so it is a shared
prerequisite, not horizon-specific work. Under the recommended trigger the
counter is not even strictly required for phase 1 (a hypothesis can be
recorded against a single-phase task too), but it is the right gate for
the automatic producers, and it is named here so the dependency is
explicit.

**Hard caps regardless of producer.** A per-project ceiling on outstanding
horizon schedules (a config key, small default) so a misbehaving producer
cannot queue an unbounded fleet of future workers. When the cap is hit,
new hypotheses are dropped with a logged warning rather than silently
queued — silent truncation reads as "we are watching everything" when we
are not.

## Q2 — Concrete review target and actionable output

A scheduled review is only worth running if "review the logs" has been
reduced to "look for X in signal Y, and if found and not superseded, do
Z." The revisit hypothesis is exactly that reduction, captured at schedule
time.

### The revisit hypothesis record

A self-contained JSON record (schema illustrative, not final):

```jsonc
{
  "id": "…",                       // uuid
  "project": "garden",
  "task": "auth-rewrite",          // human label
  "claim": "Phase 2 kept both registry entries rather than resolving the collision; this is safe only while no sibling writes the same key.",
  "signal": "git log over src/dashboard/registry.ts since the merge SHA shows a sibling commit writing the duplicated key, OR a CI failure mentioning the key.",
  "paths": ["src/dashboard/registry.ts"],
  "mergeRange": "abc1234..def5678", // base..task-tip across all phases
  "rationale": "…",                 // copied commit messages + final summary (see Q4)
  "transcript": { "path": "…", "sessionId": "…" }, // best-effort pointer
  "checkAfter": "2026-06-24",       // absolute date, N days from merge
  "recordedBy": "worker|holistic|operator"
}
```

The record is the contract between the producer and the horizon worker.
Everything the worker needs to reconstruct context lives in it (Q4),
because a week later the registry entry, worktree, and branch are gone.

### What the horizon worker reads

Spawned in a fresh worktree off current base (an ordinary `newWorker`), it
reads only what the hypothesis points it at — not "the logs" in general:

- **Git history over `paths` since `mergeRange`** — `git log`, `git blame`,
  `git diff` scoped to the named files. Who touched them after the merge,
  and did a sibling build on the same surface.
- **CI history on the base branch since merge** — `gh run list` /
  `gh run view --log-failed` filtered to the window, for failures that
  mention the `signal`. (Gracefully degrades to nothing on projects
  without a GitHub remote or `gh`, same as the CI gate.)
- **The recorded `rationale`** — the original decision's reasoning, copied
  into the record so it survives worker cleanup.
- **Dashboard logs** for the project over the window, only if the signal
  references them — and only as corroboration, never as the primary fish.

### What a finding is, and the supersession gate

A finding is the registered hypothesis **confirmed by its own named
signal**, and only after a supersession check passes. The worker's first
step is always: *is the concerning decision still present?* If later
commits already removed or revised the code/decision the claim is about,
the hypothesis is moot — close it `superseded`, no action. This is the
primary defense against "fixing something already fixed" (Q4) and it runs
before any analysis, so a moot hypothesis costs one `git log` and exits.

Three terminal dispositions, every run logged with which one fired (so the
feature is measurable from day one):

- `superseded` — the decision is gone or already revised. No action. Expected to be common.
- `refuted` — decision survives, signal absent. The deferral held. No action.
- `confirmed` — decision survives **and** the named signal is present.

### Output, tiered by confidence, report-first by default

Only a `confirmed` finding produces output, and the action is tiered:

1. **Operator alert with evidence (phase 1 default).** An `addAlert`
   (`alerts.ts`) at warn level naming the claim, the confirming signal, the
   commits, and the files — with a stable `dedupKey` so a re-run does not
   re-alert. No mutation. This is the conservative default and matches the
   operator's noise-aversion: a confirmed-and-evidenced alert is a high
   signal, a speculative auto-fix is not.
2. **Corrective worker through the normal flow (phase 2, gated).** For a
   confirmed, supersession-clear, *mechanical* fix, spawn an ordinary
   default worker via `newWorker` with a seed briefing. Crucially this
   worker participates in the normal review/merge pipeline — its fix is
   reviewed by the same reviewer and CI gate — so a bad horizon "fix" is
   caught downstream, bounding blast radius. Gate hard: high confidence +
   supersession clear + concrete fix only.

Phase 1 is report-only on purpose. The cheapest way to learn whether
horizon review finds anything real is to have it tell the operator, watch
for a month, and only then earn the right to mutate.

## Q3 — Mechanism: native vs reuse existing scheduling

Garden has no "spawn a worker in N days" primitive. Workers are live
tmux-pane sessions; the only recurring tick is the liveness watchdog
(`watchdog.ts`). Three options.

### Option A — Native, piggybacking an existing tick (recommended)

Persist the hypothesis records to a schedule file under
`~/.garden/sessions/` (atomic write + shape guard, the standard pattern).
Have an already-running long-lived loop scan it each tick for records whose
`checkAfter` has passed, and on a due record, spawn the horizon worker via
the existing `newWorker({ seedMessageFile, background: true })` path —
exactly the mechanism `handoff-dispatch.ts` already uses to spawn workers
from outside a pane. No new primitive; the spawn path is proven.

Where the scan runs: the watchdog loop (`runWatchdogLoop`) already ticks
every 60s and already does bounded per-tick work. A horizon resolution of
*days* means even an hourly scan is ample, so the scan is a cheap addition
to an existing cadence — no new tmux window, no new process. If separation
of concerns is later preferred (keeping the watchdog's contract pristine —
see the invariant tension below), the scan moves to its own slow
`_garden-horizon` window mirroring the usage-poller lifecycle. Start
piggybacked; promote to a dedicated window only if the watchdog's story
demands it.

**The STATUS.md invariant-6 tension, addressed directly.** Invariant 6 and
the watchdog spec are emphatic: the system is event-driven, the watchdog is
the *one* sanctioned recurring tick, and it "discovers nothing and
transitions nothing." A date-based wake looks, at first glance, exactly
like the "let's check just in case" clock the spec rejects. It is not, for
two reasons:

1. **A due-date is not expressible as any other event.** "N days have
   elapsed since the merge that recorded this hypothesis" has no
   representation except a clock. STATUS.md already carves out a category
   for precisely this — "Scheduled wake-ups (deliberate, finite,
   event-tied)" — and a horizon schedule fits it: it is tied to a specific
   recorded event (the merge + the hypothesis), it fires **once** per
   record (the record is consumed when the worker spawns), and it is not a
   fallback poll that re-derives status on a clock.
2. **It transitions no existing worker.** Spawning a horizon worker is a
   *creation* (the same category as `newWorker` from a handoff), not a
   `prState` transition of any worker the state machine tracks. The
   periodic scan is a delivery mechanism for a one-shot wake — structurally
   identical to the watchdog re-poke — not a discoverer of state.

The honest framing: this is the one legitimately timer-driven thing,
because the triggering condition genuinely is the passage of time. Shipping
it requires adding a row to STATUS.md's "Scheduled wake-ups" list and
saying so explicitly. It does not require relaxing invariant 6, because the
scan discovers and transitions nothing — it consumes a pre-registered,
event-tied, fire-once schedule.

### Option B — The operator's `/schedule` cloud routines

The operator's environment has a `/schedule` skill (cloud cron routines)
and `/loop`. Tempting, because it is zero garden code. It fails on the
*action* side: a cloud routine runs detached from the local tmux
dashboard, the local git checkouts, the registry, the sandbox, and the
poller. A horizon review that wants to read local-only branches, consult
the registry, or — the load-bearing case — spawn a corrective garden
worker that participates in the local review/merge flow simply cannot, from
the cloud. It could reach GitHub-hosted CI and git, so it is viable *only*
for a pure-report variant against remote data, and even then it fragments
scheduling state into a second system the operator must manage per task. It
also cannot honor garden's per-project caps or dedup.

There is one legitimate use: **a zero-code v0 spike.** Before garden builds
anything, the operator can manually `/schedule` a one-week-out cloud review
of a specific GitHub-hosted hypothesis to test whether the value is real.
That is the cheapest possible experiment and is recommended *as a
pre-build probe*, not as the mechanism.

### Option C — OS cron

Same "outside garden" problem as Option B with strictly less integration
(no structured record, no dashboard, no registry, no sandbox) and an extra
moving part on the host. Rejected.

### Recommendation

Native, Option A, piggybacked on the watchdog tick. Garden's value is in
owning its orchestration foundation, and the action side of horizon review
(spawn a reviewing worker, optionally open a corrective fix through the
pipeline) is intrinsically local to garden — it cannot be outsourced
without losing exactly the integration that makes it worth doing. The cost
of native is small precisely because the recurring tick and the spawn path
already exist; horizon review is a schedule file plus a due-scan plus a
seed briefing, not a new engine. Use Option B once, manually, as a probe
before committing the code.

## Q4 — State drift: reconstructing context without a live worktree

A week out, the task's branch is deleted, the base has advanced
significantly, and — because garden never auto-cleans workers, but the
operator does via `opt-x` / `garden reset` — the worker's registry entry
and worktree may be gone entirely. The design must assume **none of the
live worker state survives** and must not depend on the registry still
holding the entry.

**The schedule record is self-contained by construction.** Everything the
horizon worker needs is captured into the hypothesis record *at schedule
time* (Q2 schema): the `mergeRange` (base..task-tip across all phases), the
touched `paths`, the `claim` and `signal`, and — critically — the
`rationale`, which is the original decision's reasoning copied verbatim
from the commit messages and the worker's final summary. Rationale is
copied, not referenced, because the source may not survive: the transcript
under `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`
(`conversation.ts`) outlives worktree cleanup since it lives outside the
worktree, but it does not survive a Claude profile reset and is not
guaranteed. The record therefore stores a best-effort transcript pointer
for *extra color* if it happens to still be readable, but never relies on
it for correctness.

**Reconstruction procedure.** The horizon worker spawns in a fresh worktree
off current base — an ordinary default worker — and:

1. Reads the self-contained record (claim, signal, rationale, range,
   paths).
2. Runs the **supersession check first** (Q2): for each path/decision,
   `git log mergeRange..HEAD -- <paths>` and inspect whether the concerning
   code/decision still exists. If gone or already revised → `superseded`,
   exit. This is the primary guard against "fixing what later work already
   fixed."
3. Only if the decision survives: checks the named `signal` against git/CI
   history over the window.
4. Reads the transcript pointer opportunistically for additional rationale,
   if still present.

**Avoiding superseded fixes — defense in depth.** Three layers, not one:
the supersession check runs before analysis (cheap exit); a `confirmed`
finding in phase 1 produces only an alert, never a mutation, so even a
wrong confirmation costs the operator a glance, not a bad commit; and a
phase-2 corrective worker goes through the full reviewer + CI pipeline, so
its fix is independently checked against current reality before it can
land. The horizon worker is never trusted to mutate main on the strength of
a week-old hypothesis alone.

## Is it worth building? An honest verdict

**The naive version is not worth building.** Scheduling every multi-phase
merge to wake a worker that reads the logs looking for problems is a
standing token cost with a near-zero catch rate and a non-zero
false-positive rate, against a class of defect that the existing reviewer,
CI gate, and merge-time holistic review already cover at merge. It is the
exact "wake up, find nothing, burn tokens" pattern the operator warned
against, and it would erode trust in garden's autonomy faster than it would
catch bugs.

**The hypothesis-gated version is worth a small, instrumented first slice —
but only after, or alongside, a producer of hypotheses exists.** The value
is real and genuinely unreachable at merge: a deferral that drifted, a
collision a sibling later realized, a decision the codebase grew away from.
The reframe (trigger carries the hypothesis) converts the review from
fishing to verification, and the supersession-first / report-first design
keeps the noise floor near zero by construction. The honest caveat: its
value is bounded by the quality of the hypotheses it is fed, so the worker-
recorded and operator-recorded producers (which know what they deferred)
matter more than the holistic-review producer (which infers it).

**Build the off-ramp in from the start.** Every horizon run logs its
disposition (`superseded` / `refuted` / `confirmed`). If, over a month of
real use, the feature fires a handful of times and produces zero
`confirmed`-and-acted findings, it has earned deletion — and the
instrumentation makes that call evidence-based rather than aesthetic. A
speculative feature that cannot be measured into the grave should not be
built; this one can.

## Phased rollout

Each phase is independently shippable and leaves a working system. The
ordering front-loads the cheapest de-risking.

**Phase 0 — Probe (no garden code).** The operator manually uses the
`/schedule` cloud skill to defer one real GitHub-hosted hypothesis a week
out and judges whether the result was worth the wake. If even the
hand-curated probe finds nothing useful, stop here — the idea is
disconfirmed for free.

**Phase 1 — Manual hypothesis, native schedule, report-only.** The
smallest useful garden slice and the one that proves the wake → spawn →
reconstruct loop end to end:
- A `garden` subcommand to register a revisit hypothesis by hand (operator
  producer only).
- A schedule file (atomic write + shape guard) and a due-scan on the
  watchdog tick.
- On due, spawn a horizon worker via `newWorker` with a self-contained seed
  briefing.
- The worker runs supersession-first, checks the signal, and on `confirmed`
  raises an operator alert. No mutation.
- A STATUS.md "Scheduled wake-ups" row documenting the new wake.
- Disposition logging from day one.

**Phase 2 — Worker-recorded hypotheses + gated corrective worker.**
- A small skill (sibling of `done`) letting a worker register a hypothesis
  before ending its turn — the highest-signal producer.
- Allow a `confirmed`, supersession-clear, mechanical finding to open a
  corrective worker through the normal review/merge flow, behind a hard
  confidence gate. Everything it does is independently reviewed.

**Phase 3 — Holistic-review producer (closes the loop, default-conservative).**
- The merge-time holistic review emits hypotheses for deferrals it judges
  worth re-checking, gated and conservative.
- Requires the shared per-worker merge-cycle counter (Phase 0 of the
  holistic review work).
- Per-project outstanding-schedule cap enforced and surfaced.

Phases 2 and 3 are independent; either can follow Phase 1. Phase 2 is the
higher-value next step because worker-recorded hypotheses are the ones most
likely to be real.

## What to NOT build

- A review that wakes without a registered hypothesis and "looks for
  problems." This is the whole anti-pattern; the trigger reframe exists to
  forbid it.
- A new always-on tmux window in phase 1. Reuse the watchdog tick; promote
  to a dedicated window only if the watchdog's "transitions nothing"
  contract is judged worth protecting by separation.
- Auto-mutation in phase 1. Report first; earn mutation with evidence.
- Any dependency on the live worker (registry entry, worktree, branch,
  transcript) surviving to schedule-fire time. The record is self-contained
  or the feature is broken.
- A second scheduler outside garden (cloud cron, OS cron) as the mechanism.
  Acceptable only as the manual Phase 0 probe.
- Silent caps. When the outstanding-schedule ceiling drops a hypothesis,
  log it.

## Open questions

1. **Hypothesis quality control.** Worker- and operator-recorded
   hypotheses are only as good as their `signal`. A vague signal ("check if
   anything broke") collapses the feature back into fishing. The recording
   skill/command should refuse or flag a hypothesis whose signal is not a
   concrete, checkable predicate over named paths or CI. How strictly to
   enforce this is unresolved.
2. **Default `checkAfter` horizon.** "A week" is the working assumption.
   The right delay may differ by signal kind (a sibling-collision
   hypothesis becomes checkable as soon as a sibling touches the file,
   which could be a day or never; a "codebase grew away from it" hypothesis
   needs more elapsed merges). A per-hypothesis horizon, defaulting to a
   week, is probably right; whether to also support "fire when paths are
   next touched" as an event rather than a date is open — and notably that
   variant *would* be event-expressible (a push hook on the paths), sliding
   it back under invariant 6 without a clock.
3. **Interaction with the holistic review's own scope.** If the holistic
   review already caught the cross-phase issue at merge, the horizon
   hypothesis for it is redundant. The producers should avoid recording a
   hypothesis for something the merge-time review already resolved; the
   coordination contract between the two features is unresolved and depends
   on the holistic review's final shape.
4. **Schedule persistence across `garden reset`.** A reset clears worktrees
   and the registry. Should pending horizon schedules survive it? They are
   operator-registered intentions, not worker state, which argues for
   keeping them in a file outside the reset blast radius — but that file
   then points at a `mergeRange` whose context the operator may have
   deliberately wiped. Unresolved.

## Relationship to sibling designs

- **Holistic review** (in-conversation, not yet in the codebase) — the
  point-in-time merge-time sibling and the preferred eventual hypothesis
  producer (Phase 3). Horizon review depends on it for the automatic
  trigger but not for phases 0–2.
- **`docs/future/SPRIG.md`** — shares the core discipline that the scarce
  resource is operator review attention and codebase coherence, not tokens.
  Horizon review's report-first, supersession-gated stance is the same
  instinct: do not spend cheap tokens to consume expensive attention.
- **`docs/future/MODEL-SELECTION.md`** — its "measurement, not prediction"
  reframe and escalate-safe/de-escalate-conservative asymmetry are the same
  shape as horizon review's instrumented off-ramp and report-before-mutate
  default.

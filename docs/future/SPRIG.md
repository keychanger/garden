# Sprig: latent self-improvement on idle quota

> This document lives under `docs/future/` — it describes an unshipped
> design. Workers must not act on it (no sprig commands exist, no
> `.garden/sprigs.md` convention is live). See `rules.md`
> § Specifications and documentation.

> **Partially superseded (2026-07-24).** The backlog-substrate fork was
> resolved against this design's flat `.garden/sprigs.md` store: beads is
> the committed substrate (AUTONOMY-PROGRAM.md §5, Fork 1). If sprig is
> built, its backlog becomes beads (a label or tier field on beads, drained
> through the same ready-frontier the delegation loop consumes). The parts
> that survive unchanged: the scarce-resource reframe, the three risk
> tiers and their reviewer enforcement (`OUT-OF-TIER`), the autoplant gate
> chain, and the premature-`.garden-done` prerequisite.

Design for **sprig**: a way for garden to turn idle token quota into
bounded self-improvement work on registered projects, at operator-chosen
risk levels, without spending the resources that are actually scarce.

This is the synthesis of a multi-angle design exploration (four
independent designs — minimal-extension, budget economics, idea-generation
pipeline, risk-tier enforcement — plus a dedicated adversarial skeptic and
a three-judge review). The judges converged on the minimal-extension
backbone with specific grafts; this document records the surviving shape,
the verified constraints that forced it, and what was deliberately cut.

## Status

Not started. No code, no CLI surface, no config keys. One prerequisite
is independent of this design and worth fixing regardless (the
premature-`.garden-done` bug, Phase 4 below).

## Intent and the reframe

The originating idea: when garden detects unused token quota within a
configurable budget, it should generate ideas for improving its projects
and execute them — from ultra-safe hardening passes through refactors to
speculative ideas.

The exploration's central finding is a reframe: **tokens are not the
scarce resource. Operator review attention and codebase coherence are.**
The merge pipeline has zero human gates between a worker's push and main
(`poller-review.ts` → `poller-merge.ts`: reviewer verdict → CI gate →
force-push, no operator sign-off). Every autonomous merge is a diff the
operator never conceived and must absorb into their mental model of a
daily-driver tool. A design that maximizes tokens-burned spends the cheap
resource to consume the expensive ones.

The shape that survives the reframe:

- The operator stays at the **intent step**: ideas come from an
  operator-curated backlog file, never from autonomous generation
  (generation survives only as suggestion-mode, appending proposals for
  human review).
- A self-improvement worker is **not a new kind of worker** — it is a
  grow worker whose seed came from a file instead of a keystroke. Grow
  already is the bounded hardening loop; review + CI already is the
  safety net.
- Risk tiers are **enforced at the reviewer**, not hoped for in the
  worker prompt, for any autonomously planted work.
- The speculative tier **never writes code** — it produces trellis
  drafts for morning triage.
- Autonomy (auto-planting on quota surplus) is the last, least, and
  most heavily gated phase — default off, severable indefinitely without
  losing the feature's value.

## Verified constraints

These were checked against the code during the exploration and are
load-bearing for the design.

1. **Surplus is barely measurable.** `UsageMeter` is `{pct, resetsAt}`
   only (`src/dashboard/usage.ts:31-34`) — no absolute tokens, no burn
   rate. "Surplus" can only ever be `100 - pct` weighted by
   time-to-reset. The `/api/oauth/usage` endpoint is strictly
   rate-limited (observed 50-minute Retry-After), so surplus checks must
   ride the existing 5-minute usage-poller cadence, never poll harder.
2. **Per-profile quota blindness.** The usage poller calls
   `resolveCredential()` with no profile argument — it meters the
   default account only. A project configured with its own
   `claudeProfile` draws from a quota the surplus math cannot see.
   Autoplant must therefore be ineligible for profile-overridden
   projects (or this gap must be closed first).
3. **The premature-`.garden-done` bug is live** and prompt-level in
   exactly the loop machinery this feature amplifies
   (`src/dashboard/grow-continue.ts:148-153` instructs "write
   `.garden-done` when nothing material remains"). Fixing it is a hard
   prerequisite for any autonomous planting. Operator-triggered phases
   do not need to wait: a human choosing each plant bounds the damage.
4. **The terminal-state chokepoint is `transitionState`**
   (`src/dashboard/poller-state.ts`), not `maybeFireHandoffCallback` —
   the latter early-returns unless handoff-callback linkage is set and
   never fires for plain grow workers. Sprig claim-resolution hooks the
   former.
5. **The `.garden/` file convention is split.** `.garden/grow-goal.md`
   is gitignored (per-worker scratch); `.garden/rules.md` is tracked
   (durable steering). `sprigs.md` is operator-local steering state
   whose claim-flips are written by the dispatcher into the project's
   main checkout — committing it would dirty that checkout on every
   claim. It stays untracked (grow-goal precedent). Revisit only if
   multi-machine sharing becomes real.
6. **No per-worker concurrency cap exists today** anywhere in the
   codebase. The caps below are net-new enforcement (registry scans).
7. **Revert-detection feedback is likely unbuildable.** Merges land via
   fast-forward/force-push, not merge commits — there is no stable merge
   SHA to detect operator reverts of. Outcome feedback is limited to
   what the registry already knows (merged / done / failing /
   done-with-no-commits).
8. **Away-weeks paradox.** Autonomy is most valuable when the operator
   is away — and that is exactly when unreviewed merges are most
   dangerous. A per-quota-window rate limit alone still accumulates ~3
   unreviewed merge cycles over a three-week absence. The autoplant gate
   chain includes an operator-recency check that stands down after long
   absence, not just during active hours.
9. **Prompt-injection surface.** An autonomous worker reads repo
   contents (READMEs, fixtures, dependency code) and merges unreviewed.
   Tier-0 allowlists plus reviewer enforcement narrow the surface; it is
   another reason the autonomous path is tier-0-only.

## The backlog: `.garden/sprigs.md`

Per-project, operator-authored, untracked. A flat Markdown task list
parsed by a small regex — no YAML, no schema:

```markdown
# Sprigs — improvement directives garden may plant when quota is idle.
# `[ ]` available, `[~]` in flight, `[x]` done, `[rejected]` never replant.
# Optional leading tier tag: (harden) default, (refactor), (speculative).

- [ ] (harden) Audit poller-merge.ts error paths for swallowed exceptions; logs only, no behavior change.
- [ ] (harden) Find state-file reads missing an is<Shape> guard; add them.
- [ ] (refactor) The three poller-{review,resolve,ci-fix} budgets share a shape; extract iff it dedupes >30 lines.
- [ ] (speculative) Per-worker token telemetry — draft a design, don't build.
```

The file is the per-project opt-in: no file (or no `[ ]` lines) means
the project is ineligible for everything in this design. It is also the
"goals for this codebase" input the original idea asked for — steering
is a first-class operator artifact, and its absence means "be inert",
not "invent a mission".

Line lifecycle: `[ ]` → `[~]` (claimed atomically via `atomicWriteFile`
*before* planting, worker name stamped in a trailing comment) → `[x]` on
clean terminal state, or back to `[ ]` when the worker abandoned
(done-with-no-commits), or `[rejected]` set by the operator — a
permanent negative memory the picker skips forever.

## The command and hotkey

`garden sprig [project] [--tier harden|refactor|speculative]
[--directive "<text>"] [--dry-run] [--max-iterations N]`

1. Resolve the project (`resolveProjectFromArgs`).
2. `--directive` uses the text verbatim (one-off escape hatch);
   otherwise claim the first `[ ]` line from `sprigs.md`.
3. Compose the seed: tier framing prefix + the directive, then delegate
   to the existing `buildGrowIteration1Seed` so the worker inherits
   grow's pacing, goal-file, grow-log, and done contract.
4. Plant via the existing path:
   `newWorker({ projectName, workflow: "grow", grow: { seed, maxIterations }, seedMessageFile })`
   (`src/dashboard/workers.ts`). From here the worker is byte-identical
   to a grow worker — review, CI gate, serial merge queue, iteration
   budget, interrupt recovery all inherited.
5. `--dry-run` prints the chosen line and composed seed, plants nothing.

`⌥s` plants a sprig on the focused project from the dashboard,
mirroring `⌥n`'s dispatch pattern.

This operator-triggered surface is the 80%: the operator already sees
idle quota in the header meters daily; the missing piece was never
detection, it was that turning "idle quota + vague intent" into a
planted hardening loop costs a thought. A curated backlog plus one
keystroke removes that cost while keeping the human at the intent step.

## Risk tiers

Two enforcement layers, matched to who initiated the work.

**Operator-triggered sprigs: tier = seed framing.** Three prompt
prefixes, not three code paths:

- *harden* (default): smallest correct improvements only — tests, edge
  cases, error tightening, logging. No refactors, no behavior change.
  If the directive turns out to need either, write `.garden-done`
  immediately and note why in the grow-log.
- *refactor*: behavior-preserving restructuring; prefer deletion. If it
  would cross a subsystem boundary or touch more than a handful of
  files, stop and propose a trellis instead — that is a success.
- *speculative*: never runs as a grow loop at all — routes to a
  headless `trellis-author` pass (the `launchHeadlessAgent` primitive)
  that writes a draft spec under the project's `trellisDir` and fires
  an alert. Structurally incapable of landing code. Out-there ideas
  become documents triaged over coffee, not commits discovered on main.

**Autonomously planted sprigs: tier = reviewer-enforced contract.**
Prompt framing is unenforced hope, and the default reviewer's
fix-directly latitude could launder an out-of-scope diff into a clean
merge. For autonomous plants (harden tier only), a `PromptSection`
slotted into `reviewSections` hands the reviewer the tier's allowlist
(test files, docs, dead-code deletions, no behavior lines elsewhere)
plus the actual `changedFiles`/`diff` already in `PromptData`, with an
explicit instruction: out-of-tier means OUT-OF-TIER regardless of
whether the change is correct — the reviewer may not bring a violation
into compliance by fixing it. One new verdict token (`OUT-OF-TIER`,
extending `parseLastLineVerdict`'s caller-supplied vocabulary), one
dispatch branch to `failing` with `failingReason: "out-of-tier"`. Tier
semantics live in code as constants, not config — a config typo cannot
widen the blast radius.

## The autoplant trigger (last, least, default off)

One guarded call inside the existing usage-poller loop
(`src/dashboard/usage-poller.ts`) — the single sanctioned wall-clock
loop in the system. No new clock, no new process, zero hook-firehose
load, and it physically cannot outpace the rate-limited snapshot it
reads. Gate chain, stop at first failure:

1. `sprig.autoplant` is true (global config block mirroring
   `AutoContinueConfig`, default **false**).
2. Snapshot is fresh (existing staleness gate) and has data.
3. Operator-recency: a `UserPromptSubmit` from any non-sprig worker
   within a recent window means stand down (operator active); none for
   a multi-week window also means stand down (operator away — the
   paradox above). Autoplant runs in the band between.
4. Deep headroom: the higher of the 5h/weekly Opus meters is below
   ~40% — a wide dead-band below the 95% auto-continue pause threshold,
   so the two gates can never thrash.
5. Global in-flight cap: at most 1 autonomous sprig across all projects
   (registry scan for non-terminal entries carrying the sprig tag), so
   autonomous work can never saturate a serial merge queue against
   operator-planted work.
6. Rate limit: at most one autoplant per project per weekly quota
   window (`lastPlantedAt` map in the sprig config block, keyed off
   `weekly.resetsAt`).
7. Eligibility: project has a `[ ]` harden-tier line, is not the
   focused project, and has no `claudeProfile` override (constraint 2).
8. Plant exactly one, with `maxIterations` 2 (lower than grow's default
   5 — short loops bound a misaligned seed's blast radius), stamp the
   ledger, fire a warn-level alert with a stable dedupKey. One plant
   per cycle, always.

Every autonomous plant and every terminal transition fires an alert.
Nothing the operator did not initiate happens silently.

`garden sprig auto status|on|off` mirrors `garden auto`; `status`
prints the full gate-chain evaluation (which gate would stop a plant
right now). The dry-run discipline is mandatory: run the gate chain
observably against real usage for days before enabling — this also
answers whether the weekly meter ever actually idles low enough for
"surplus" to exist. If it does not, phases 6+ are dead weight and
should not ship.

## Phases

Each independently mergeable; value front-loaded, risk back-loaded.

1. **`garden sprig` command** — parser, claim-flip, tier framing,
   `--directive`, `--dry-run`. Operator-triggered, fully valuable
   alone, zero autonomy.
2. **`⌥s` hotkey** — one-key plant on the focused project.
3. **Claim resolution** — sprig metadata on the `entry.grow` sub-object
   (per-workflow-data convention); `transitionState` flips `[~]` → `[x]`
   on first terminal state, or back to `[ ]` on done-with-no-commits.
4. **Fix premature-`.garden-done`** — independent prerequisite, worth
   doing regardless of this design.
5. **`OUT-OF-TIER` reviewer enforcement** for tier-tagged workers.
6. **Autoplant** — config block, gate chain, `garden sprig auto`,
   default off. Gated on Phase 4 being verified fixed.
7. *(Optional, data permitting)* **`garden sprig suggest`** — one
   headless pass that appends `[ ]` proposals to `sprigs.md` for the
   operator's review. Machine proposes, human disposes; suggestions
   never auto-plant.

## Deliberately cut

- **Autonomous idea generation that executes** — the slop magnet. An
  LLM asked "what should I improve?" with no human anchor produces the
  median improvement; the operator backlog is the design's spine, not a
  fallback. Generation survives only as Phase 7 suggestion-mode.
- **Autonomous speculative or refactor-tier code** — unreviewed
  speculative change merging to a daily driver is net-negative
  regardless of how much surplus exists. Speculative work produces
  trellis drafts; refactor-tier runs only when an operator typed it.
- **A budget governor with spend windows, reserve floors, and a plant
  ledger** — six knobs solving "when to spend" where one inverted
  threshold inside an existing loop suffices. The gate chain keeps the
  two genuinely load-bearing pieces (dead-band, operator-recency).
- **A committed idea ledger with rejection hashes and auto-fallow** —
  the heaviest design's centerpiece. Its negative-memory insight is
  kept as the `[rejected]` line state; the rest (scout subsystem,
  evidence gatherer, feedback closer, fallow detection) is machinery
  ahead of evidence.
- **Revert-detection outcome feedback** — unbuildable against
  force-push merges (constraint 7).

## Open questions

- Should type-tightening count as harden-tier? A narrowed type can
  change behavior; leaning refactor-tier to be safe.
- Does autoplant need a minimum-iterations floor (ignore `.garden-done`
  before iteration 2) as belt-and-suspenders even after Phase 4, or is
  the budget of 2 with claim-flip-back-on-abandon enough?
- The weekly rate-limit keys off `weekly.resetsAt` (aligned to the real
  quota window but requires a fresh snapshot) vs a wall-clock 7-day
  stamp (robust to missing snapshots but drifts). Leaning `resetsAt`
  with wall-clock fallback.
- Where does the operator see sprig state at a glance — a status-pane
  badge per autonomous worker, a `garden sprig status` summary, or
  both? The skeptic's "surface, don't act" framing suggests a low-key
  "idle quota, N sprigs queued" hint in the status pane may deliver
  much of autoplant's value with none of its risk; worth prototyping
  before Phase 6.

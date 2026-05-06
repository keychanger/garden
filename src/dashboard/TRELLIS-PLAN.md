# Trellis implementation plan

Phased plan for shipping the v1 trellis workflow described in
`src/dashboard/TRELLIS.md`. The spec is the design target — this document is
not itself a spec; if it disagrees with TRELLIS.md, the spec wins and the
plan should be updated. (The literal source-of-truth marker phrase is
deliberately avoided in this opening paragraph so `findSpecFiles()` does
not classify this planning doc as a spec.) The plan exists to sequence the
work so each phase is reviewable,
mergeable, and leaves the codebase passing `npx tsc --noEmit` and the full
test suite. Five phases. Foundation primitives → end-to-end loop → cost
controls → operator visibility → daily-driver UX. After phase 2 a vine can
actually run end-to-end on the CLI; phases 3–5 add cost-bounded model
selection, status visibility, and the picker hotkey on top of a working loop.
Each phase builds on the merged base of the previous one — later phases
assume earlier ones are in main.

The spec's "Implementation entry points" table (TRELLIS.md, "The trellis
workflow" section) is the authoritative file map; this plan repeats only
what's needed to schedule each piece. When in doubt, re-read the spec.

Vocabulary: a **trellis** is the markdown design document; a **vine** is a
worker bound to one trellis. "Thread" was renamed to "vine" — use vine.

---

## Phase 1 — Foundation primitives

**Deliverable.** The data plumbing for trellis exists in the registry, the
config layer, and the workflow registry. No vine can be planted yet; no
trellis-specific code paths fire. Existing default-workflow workers are
unaffected.

**Files touched.**

- `src/dashboard/workflows/types.ts` — extend `WorkflowDefinition` with
  optional `workerModel?: "opus" | "sonnet"` and
  `reviewerModel?: "opus" | "sonnet"`. The default workflow leaves both unset
  (falls through to today's project-default model selection).
- `src/dashboard/workflows/trellis.ts` — **new file.** A skeletal
  `WorkflowDefinition` named `"trellis"` with `workerModel: "sonnet"`,
  `reviewerModel: "opus"`, `validTransitions` deep-equal to default's,
  `stateHandlers` reusing default's handlers (imports from `poller-state`,
  `poller-review`, `poller-merge`, `poller-resolve`), `hookHandlers`
  reusing `defaultHookHandlers`. The data-only skeleton — phase 2 swaps in
  trellis-specific reviewing/merge handlers.
- `src/dashboard/workflows/index.ts` — `registerWorkflow(trellisWorkflow)`
  alongside default.
- `src/dashboard/registry.ts` — extend `WorkerEntry` with the optional
  fields enumerated in the spec's "Worker entry additions" table:
  `trellisName`, `trellisPath`, `trellisIteration`, `trellisMaxIterations`,
  `trellisLastVerdict`, `trellisLastDrift`, `trellisAlignedCount`,
  `trellisDriftHistory`, `trellisShaHistory`, `trellisStagnationConfirmedAt`,
  `failingReason`, `trellisFlaggedClauses`, `trellisAligned`, `workerModel`,
  `trellisModelFallbackAt`. Add a `TrellisVerdict` type alias
  (`"ALIGNED" | "DRIFT" | "FAILED" | "FLAGGED"`) used by `trellisLastVerdict`.
  All fields optional, additive — no migration required. Update
  `isWorkerRegistry` only if a stricter shape check on `failingReason`'s
  enum is desired (recommendation: leave loose, like the existing optional
  fields).
- `src/config.ts` — extend `ProjectConfig` with `trellisDir?: string`,
  `maxTrellisIterations?: number`, `trellisOpusFallback?: boolean`. Add to
  `SETTABLE_KEYS` in `src/commands/config.ts` and accept in
  `isValidConfigKey`. Default behavior is unchanged: keys are read but not
  consulted by any workflow yet.

**Tests added.**

- `test/workflows.test.ts` — assert `getWorkflow("trellis").name === "trellis"`,
  assert `validTransitions` is deep-equal to default's,
  assert `workerModel === "sonnet"` and `reviewerModel === "opus"`,
  assert exhaustive `stateHandlers` for every `PrState`.
- `test/registry.test.ts` — round-trip a `WorkerEntry` carrying the new
  fields through `addWorker`/`readRegistry` and confirm they survive.
- `test/config.test.ts` — verify `trellisDir`, `maxTrellisIterations`,
  `trellisOpusFallback` are accepted and persisted.

**Not in this phase.** No trellis-specific reviewer prompts, no verdict
parsing, no trellis CLI commands, no rules-prompt branch, no model selection
logic, no skill bundling, no picker, no status pane decoration. The phase
is data-shape only.

**Phase boundary.**
`tsc --noEmit` clean, `npm test` green. `getWorkflow("trellis")` resolves
to the new definition. `WorkerEntry.workflow = "trellis"` round-trips. The
default workflow's `workflow-default.real.test.ts` is untouched and still
passes — exhaustively guards against the registration accidentally shadowing
default.

---

## Phase 2 — End-to-end vine loop

**Deliverable.** A vine can be planted via `garden workers new --workflow
trellis --trellis <name>`, will iterate (working → reviewing → merge →
fresh-context auto-continue → working) on `DRIFT`, terminate with `done`
on `ALIGNED`, fail with the right `failingReason` on `FLAGGED`, `FAILED`,
or budget exhaustion. Per-iteration context reset works — Claude is killed
and respawned cold between iterations, conversation history does not
compound (Invariant 8). All workers run on Opus in this phase; model
selection lands in phase 3.

This is the load-bearing phase. The deliberate divergence from default
workflow's auto-continue (Invariant 8) is structural; shipping a trellis
loop without it would compound poisoned context across iterations and
undermine the entire design. Do not split this phase.

**Files touched.**

- `src/dashboard/trellis-prompts.ts` — **new file.** Section primitives
  declared per the spec's "Reviewer prompt and verdict" section:
  - `trellisAuthoritySection` (verbatim text from the spec — do not
    paraphrase).
  - `trellisAlignmentStepSection` (uses `ctx.nextStep()`).
  - `trellisDocumentSection` — inlines the trellis content at the worker's
    HEAD. Returns `null` when the file is missing (per spec edge case
    "Trellis deleted mid-loop").
  - `trellisOverridesSection` — inlines `<worktree>/.garden/trellis-overrides.md`
    if present (file mechanism only; v1 has no CLI to write to it — see
    phase 4 / open question 5).
  - `trellisVerdictFormatSection` (output contract for ALIGNED/DRIFT/FAILED/
    FLAGGED).
  - `trellisReviewSections` list, mixing default sections (`reviewIntroSection`,
    `reviewSpecWarningSection`, `reviewRebaseStepSection`,
    `reviewChecksStepSection`, `reviewBranchInfoSection`,
    `reviewCommitsSection`, `reviewRulesSection`, `reviewDiffSection`,
    `reviewDocumentationSection`, `reviewTestFilesSection`) with the new
    trellis-specific ones in the order the spec lays out.
  - `buildTrellisReviewPrompt(projectName, projectPath, baseBranch, entry)`
    — wraps `gatherPromptContext` and reads `entry.trellisPath` to load
    the trellis content, then `composePrompt(trellisReviewSections, ctx)`.
- `src/dashboard/trellis-verdict.ts` — **new file.** `TRELLIS_VERDICTS = ["ALIGNED",
  "DRIFT", "FAILED", "FLAGGED"] as const` plus a `parseTrellisVerdict(output)`
  wrapper that calls `parseLastLineVerdict<TrellisVerdict>(output, TRELLIS_VERDICTS)`.
  Also exports a parser for the structured drift list (`[surface] foo() …
  (trellis line N)` → `{tag, body, line}` objects, used to populate
  `trellisLastDrift`, `trellisAlignedCount`, and the iteration log line).
- `src/dashboard/trellis-tag.ts` — **new file.** Two regexes used by the
  reviewer (to resolve the trellis file at plant time and on each rebuild)
  and by the CLI: trellis tag matcher (`<!--\s*trellis:\s*v\d+\s*-->`) and
  retirement matcher (`<!--\s*retired:\s*\d{4}-\d{2}-\d{2}\b.*?-->`).
  Plus `findTrellisFiles(projectPath, trellisDir)` which lists `*.md` in
  the configured directory, filtered by tag, returning `{name, path,
  retired, summary}` (summary resolution per spec section "Hotkey: ⌥⇧n").
  The picker (phase 5) and the CLI (phase 4) both consume this.
- `src/dashboard/poller-review.ts` — branch on `entry.workflow` in
  `handleReviewing` and `launchReview`:
  - `launchReview` builds the trellis review prompt (via
    `buildTrellisReviewPrompt`) and bumps `entry.trellisIteration` *before*
    the review dispatch, *after* the budget check. The increment writes
    via `updateWorkerFields`. If the new value exceeds
    `entry.trellisMaxIterations`, short-circuit: skip the review,
    transition to `failing` with `failingReason = "iteration-budget"`,
    raise an alert (source `trellis`, message includes the iteration count
    and last drift list, dedup key
    `trellis-budget:${project}:${worker}`).
  - `handleReviewing` parses the verdict via `parseTrellisVerdict`. Branch
    on result:
    - `ALIGNED` → write `.garden-done` at `entry.worktreePath` (workflow
      handler does it, not the worker), set `trellisAligned: true`, force-
      push, transition to `merge-pending` (the `finalizeMerge` path picks
      `done` because the sentinel is present).
    - `DRIFT` → store `trellisLastDrift`, `trellisAlignedCount`,
      `trellisLastVerdict = "DRIFT"`, force-push, transition to
      `merge-pending`. The post-merge handler does the context reset.
    - `FLAGGED` → store `trellisFlaggedClauses` (extracted from the
      verdict body's cited-clauses block), transition to `failing` with
      `failingReason = "trellis-flagged"`. Raise alert (source `trellis`,
      stable `dedupKey`). The `failing → working` push debounce in
      `handleFailing` does NOT apply to flagged vines — see below.
    - `FAILED` → existing path, but with `failingReason = "code"`.
    - Unparseable → re-queue once (matches default; second unparseable
      sets `failingReason = "unparseable-verdict"`).
  - `handleFailing` (in `poller-state.ts`): if
    `entry.failingReason === "trellis-flagged"`, refuse the
    `failing → working` transition on push — only `garden trellis resume`
    (phase 4) clears the flag. Until phase 4 lands, this means a flagged
    vine sits at `failing` until the operator kills it; that's acceptable
    for the phase boundary.
- `src/dashboard/poller-merge.ts` — branch on `entry.workflow` in
  `finalizeMerge`. Trellis branch:
  - On `ALIGNED` (`trellisAligned: true`, sentinel was written by the
    workflow handler): `finalizeMerge`'s existing sentinel-aware path picks
    `done`, no auto-continue dispatched.
  - On `DRIFT`: skip the default `dispatchDelayedAutoContinue`; instead
    call `trellisAutoContinueAfterMerge(projectName, workerName)` (new in
    `continue.ts`).
- `src/dashboard/continue.ts` — **new export** `trellisAutoContinueAfterMerge`
  and its detached-subprocess form `dispatchDelayedTrellisContinue`. The
  detached subprocess invokes a new internal subcommand
  `dashboard _trellis-continue-after-merge <project> <worker>` (registered
  in `src/dashboard/index.ts`). The handler:
  1. Reads the worker's pane, kills the Claude process via
     `tmux respawn-pane -k -t <paneId> sh -c '<fresh-claude-cmd>'` — same
     primitive `bounceWorker` uses, but the inline command is
     `claude --rc --session-id <new-uuid> --append-system-prompt-file
     <contextFile>` (no `--resume`). The new sessionId is persisted via
     `updateWorkerFields(..., { sessionId: newId, claudeStatus: "loading" })`
     so subsequent `garden bounce` uses the latest. Reuse
     `buildWorktreeWorkerCommand` for the cold-start invocation; rewrite
     `.claude/settings.json` first via `installClaudeHooks` so a rebuilt
     garden's hook config takes effect.
  2. Builds the trellis seed prompt via a new
     `buildTrellisContinuePrompt(entry)` that reproduces the spec's
     "Continue prompt structure": iteration N of M (using
     `entry.trellisIteration + 1` because the increment hasn't fired
     yet for the upcoming iteration), files changed during review (from
     `pendingContinueChangedFiles`), priority-ordered drift list (from
     `trellisLastDrift`), inlined lessons file
     (`<worktree>/.garden/trellis-lessons.md` if present — file size cap
     is v1.5, no eviction yet).
  3. Sends the prompt via the same `seedWorker` polling primitive
     (`poll until claudeStatus !== "loading"`, then send keys, deadline
     90s). Reuse the existing `seedWorker` function in `continue.ts` —
     write the message to a temp file and call it.
- `src/dashboard/skills.ts` — bundle the `trellis-author` skill alongside
  `done` and `handoff`. Skill is installed for *every* worker (operator
  may want to author a trellis from inside a default-workflow pane). The
  skill body walks: scope sizing, spine (title + sentinel + tag), the
  recommended sections, self-review pass. Description triggers on operator
  intent to formalize a feature as a trellis.
- `src/rules.ts` — extend `buildWorktreeRules` with the three trellis
  paragraphs (concept, authority asymmetry, iteration discipline) when
  the caller passes a flag indicating trellis. Plumb the flag through
  `writeWorktreeContextFile` (in `create.ts`) which already takes the
  branch and base — add an optional `workflow` parameter and the trellis
  path. Default-workflow context files are byte-identical to today.
- `src/commands/workers.ts` — **new file** if it doesn't exist, otherwise
  extend `garden workers new`. Surface: `garden workers new <project>
  --workflow trellis --trellis <name> [--max-iterations N]`. Pre-flight
  via `validateTrellisPlant(project, name)` (lives in `trellis-tag.ts`):
  trellis exists, not retired, sentinel present (warn if missing),
  `checks` configured (tip if missing), `origin/<base>` fetchable.
  Populates `entry.workflow = "trellis"`, `entry.trellisName`,
  `entry.trellisPath`, `entry.trellisMaxIterations` (project config or
  spec default 30), `entry.trellisIteration = 0`. Bootstraps via the
  existing `newWorker()` flow (worktree + branch + sandbox + skills +
  rules with the trellis flag set), but seeds the worker's *first* prompt
  via `dispatchDelayedSeed` with a "seed iteration 1" message: trellis
  content, "you are implementing this trellis", path to lessons file (which
  the worker creates on iteration 1), the verdict vocabulary, and a
  pointer to FLAGGED escape valve. Exact phrasing is open question 2 of
  the spec — start simple, iterate during phase 2.
- `src/commands/trellis.ts` — **new file.** `garden trellis new <project>
  <name>` only in this phase (other subcommands ship in phase 4). Scaffolds
  `<trellisDir>/<name>.md` with the recommended sections and the spine
  (title + spec sentinel + trellis tag). Refuses overwrite. Creates
  `trellisDir` if absent.
- `src/commands/index.ts` and `src/cli.ts` — register `workers` and
  `trellis` commands; help text covers `workers new --workflow trellis`
  and `trellis new`.

**Tests added.**

- `test/trellis-prompts.test.ts` — composes `trellisReviewSections` with a
  fixture context and asserts the trellis-authority text is verbatim, the
  alignment step renders with `## Step N`, the trellis document section
  inlines the file content, the verdict format section lists all four
  verdicts. Snapshot the full prompt for stability.
- `test/trellis-verdict.test.ts` — round-trips ALIGNED/DRIFT/FAILED/FLAGGED
  through `parseTrellisVerdict`; tests the structured-drift parser on the
  format the spec specifies (`[surface] foo() … (trellis line N)`); asserts
  unparseable returns null.
- `test/trellis-tag.test.ts` — tag matcher recognizes `v1`, rejects no
  version, recognizes future versions; retirement matcher recognizes the
  date format; `findTrellisFiles` filters retired and resolves summaries
  per the spec's three-rule fallback.
- `test/integration/workflow-trellis.real.test.ts` — analogue of
  `workflow-default.real.test.ts`. Sets up a real git repo with a trellis
  file at `.garden/trellises/test.md`, plants a vine, simulates the
  reviewer producing `DRIFT`, asserts the worktree state after merge
  (Claude was respawned cold in the pane; `entry.trellisIteration === 1`
  before review dispatch and `entry.sessionId` advanced; lessons file is
  a no-op when absent). Then a second cycle simulating `ALIGNED` and
  asserts `prState === "done"`, `trellisAligned: true`, `.garden-done`
  written. Then a budget-exhaustion path: set `trellisMaxIterations: 1`,
  ensure the second `working → reviewing` transition short-circuits to
  `failing` with `failingReason = "iteration-budget"`. Then a `FLAGGED`
  path: assert the alert is raised, `failingReason = "trellis-flagged"`,
  and `handleFailing` refuses to advance on push.
- `test/rules.test.ts` — assert the three trellis paragraphs are present
  when `workflow === "trellis"` and absent when `workflow === "default"`.
- `test/skills.test.ts` — assert `installClaudeSkills` writes
  `.claude/skills/trellis-author/SKILL.md` alongside `done` and `handoff`.

**Not in this phase.**

- No `--model` flag; vines run on the project's existing model selection
  (Opus) until phase 3. The workflow definition still declares
  `workerModel: "sonnet"` from phase 1, but the worker bootstrap doesn't
  read it yet — Sonnet routing is phase 3's concern.
- No Sonnet exhaustion fallback.
- No CLI surface beyond `workers new --workflow trellis` and
  `trellis new` (`list`, `show`, `status`, `amend`, `resume`, `retire`,
  `revive` are phase 4).
- No status pane decoration; trellis vines render as default rows.
- No bottom-bar trellis summary.
- No picker hotkey; CLI is the only spawn path.
- No iteration log line beyond the existing `working -> reviewing`
  transition log; the structured `trellis iteration` log line lands in
  phase 4 with the rest of the visibility surface.

**Phase boundary.**
`tsc --noEmit` clean, `npm test` green including the new integration test.
A vine planted via CLI completes a full ALIGNED cycle (terminates with
`done`), completes a multi-iteration DRIFT cycle with per-iteration context
reset (verified by integration test asserting fresh sessionId between
iterations), terminates with `failing` + `iteration-budget` on cap exhaustion,
and terminates with `failing` + `trellis-flagged` on FLAGGED. Reviewer
verdicts always arrive on Opus (no model selection yet). The default
workflow remains bit-for-bit identical — `workflow-default.real.test.ts`
unchanged.

---

## Phase 3 — Model selection and Sonnet fallback

**Deliverable.** Vines run on Sonnet by default; reviewers always run on
Opus regardless of worker model or quota state (Invariant 10). Per-iteration
spawn checks Sonnet meters and falls back to Opus when exhausted. Per-worker
override via `--model`. Per-project disable of fallback via
`trellisOpusFallback: false`.

**Files touched.**

- `src/dashboard/create.ts` — extend `buildWorktreeBootstrapScript`,
  `buildWorktreeWorkerCommand`, and `buildWorktreeResumeCommand` to accept
  an optional `model` parameter that injects `--model sonnet` or
  `--model opus` into the `claude` invocation. Default (no flag) preserves
  today's behavior. Plumb the model resolution through worker spawn paths.
  The trellis context-reset path in `continue.ts` (phase 2) also needs to
  pass the resolved model — extend its respawn command builder to call
  through the same helper.
- `src/dashboard/poller-review.ts` — `launchReview` always passes
  `model: "opus"` to `launchHeadlessAgent` for trellis workflows
  (`workflow.reviewerModel`). Resolver inherits — no change. Default
  workflow leaves `model` unset and the reviewer Claude picks the
  account's default (Opus today).
- `src/dashboard/headless-agent.ts` — extend `HeadlessAgentLaunchOptions`
  with optional `model: "opus" | "sonnet"`. When set, the inline command
  becomes `claude -p --model <model> < prompt > result`. Existing callers
  (default reviewer, resolver) leave it unset; trellis reviewer sets
  `model: "opus"` explicitly so a future change to the user's CLAUDE
  default model doesn't silently degrade trellis reviews.
- `src/dashboard/trellis-model.ts` — **new file.** `resolveVineModel(entry,
  projectConfig, workflow)`: returns `"sonnet"` or `"opus"`, factoring in
  `entry.workerModel` (per-worker override), `workflow.workerModel`
  (workflow default), and the Sonnet exhaustion fallback. The fallback
  reads the existing usage snapshot via `readUsageSnapshot()`, checks
  Sonnet meters against the project's `usageThreshold` (default 95%), and
  if exhausted:
  - When `trellisOpusFallback !== false`: returns `"opus"` for this
    iteration. Fires one alert per Sonnet reset window — dedup using
    `entry.trellisModelFallbackAt` (set to `Date.now()` on first
    fallback, cleared when Sonnet recovers). Alert source `trellis-budget`,
    stable dedup key.
  - When `trellisOpusFallback === false`: returns `null` (caller should
    pause via the existing usage-pause mechanism). Set `pausedReason` and
    `pausedUntil` to Sonnet's `resetsAt`. Alert source `usage`.
- `src/dashboard/poller-review.ts` and `src/dashboard/continue.ts`
  (trellis paths only) — call `resolveVineModel` before spawning. If null,
  defer the iteration via the global pause path. If a model is returned,
  pass it to the spawn helpers above.
- `src/commands/workers.ts` — add `--model opus|sonnet` flag to
  `garden workers new --workflow trellis ...`, populating
  `entry.workerModel`. Validation: only accept `opus` or `sonnet`.
- See open question 1 below regarding the spec's `fiveHour.sonnet`
  reference — the Sonnet meter shape in `usage.ts` needs verification
  before this phase can wire correctly.

**Tests added.**

- `test/trellis-model.test.ts` — unit tests for `resolveVineModel`. Cover:
  per-worker override beats workflow default; workflow default beats
  project default; Sonnet at 95% triggers Opus fallback when
  `trellisOpusFallback !== false`; Sonnet at 95% returns null when
  `trellisOpusFallback === false`; alert is fired once per fallback
  occurrence (dedup via `trellisModelFallbackAt`); alert is `usage` source
  vs. `trellis-budget` source per the configured fallback mode. Mock
  `readUsageSnapshot()` to control the meters.
- `test/integration/workflow-trellis.real.test.ts` — extend existing test
  with: (a) a vine planted with `--model sonnet` writes
  `entry.workerModel = "sonnet"` and the spawn command includes
  `--model sonnet`; (b) Sonnet meter at 99% routes the next iteration
  through Opus and sets `trellisModelFallbackAt`; (c) reviewer command
  always includes `--model opus` regardless of worker model.

**Not in this phase.**

- No CLI surface beyond `workers new --model` (other `garden trellis`
  subcommands still land in phase 4).
- No bottom-bar or status pane decoration.

**Phase boundary.**
`tsc --noEmit` clean, `npm test` green. A vine spawned with `--workflow
trellis` runs on Sonnet; `--model opus` overrides; Sonnet exhaustion routes
through Opus with one alert; setting `trellisOpusFallback: false` pauses
the loop instead. Reviewer always Opus.

---

## Phase 4 — CLI surface and operator visibility

**Deliverable.** The full `garden trellis ...` subcommand surface. Status
pane shows trellis-aware decoration on vine rows. Bottom-bar appends a
trellis summary when vines are running. Iteration logging.

**Files touched.**

- `src/commands/trellis.ts` — extend with the rest of the spec's
  "garden trellis" surface:
  - `garden trellis list <project> [--active]` — uses `findTrellisFiles`,
    groups active vs. archived, JSON when piped.
  - `garden trellis show <project> <name>` — reads the file and pages
    in a TTY.
  - `garden trellis status <worker>` — reads the worker's registry entry
    and prints iteration count, last verdict, drift list,
    `trellisAlignedCount`, last 3 lessons-file lines. (Stagnation field
    placeholder — true stagnation tracking is v1.5.) JSON when piped.
  - `garden trellis amend <worker>` — opens `entry.trellisPath` in
    `$EDITOR`. On save: `git add` + `git commit` to the project's *main
    checkout* (not the worker's branch — the trellis lives on main per
    Invariant 6). Auto-revives a retired trellis (removes the retirement
    comment). Refuses if the main checkout is dirty (consistent with the
    bootstrap-fail-fast pattern); see open question 4.
  - `garden trellis resume <worker> [--override "<rationale>"]` — clears
    the `trellis-flagged` failing state and dispatches a fresh review.
    Without `--override`, requires the operator to have already amended
    the trellis (best-effort: warn if `git log -1 -- <trellisPath>` shows
    no recent edits, but proceed). With `--override`, appends a line to
    `<worktree>/.garden/trellis-overrides.md` recording the cited clauses
    and the rationale. Implementation flips
    `failingReason = undefined`, `pendingReviewAt = Date.now()`, and pokes
    the project poller. See open question 5 for whether `--override`
    fully ships in v1 vs. only the file mechanism.
  - `garden trellis retire <project> <name>` — appends the retirement
    comment to the trellis file. The commit range is auto-filled from
    the most-recently-aligned vine's commit history (consult the registry
    for vines with `trellisAligned: true` and `trellisName === name`,
    use their merged-from/to SHAs; degrade gracefully if no aligned
    vine exists yet).
  - `garden trellis revive <project> <name>` — removes the retirement
    comment.
- `src/commands/index.ts` and `src/cli.ts` — add subcommand dispatch and
  help text.
- `src/dashboard/poller-state.ts` — `handleFailing` consults
  `entry.failingReason` and skips the push-debounce → working transition
  for `"trellis-flagged"`. The flagged vine waits for `garden trellis
  resume` to flip `failingReason` and set `pendingReviewAt`. The other
  failing reasons (`code`, `iteration-budget`, `stagnation`,
  `unparseable-verdict`) follow today's behavior.
- `src/commands/status.ts` (and / or `src/dashboard/header.ts`) — extend
  `renderQuickStatus` and the worker-row builder. When `entry.workflow ===
  "trellis"`, append the spec's bracket: `[trellis: <name> | <iter>/<max>
  | <drift> drift]`. Hide drift count when last verdict was ALIGNED or
  failed states. Failed states render `[trellis: <name> | flagged|budget
  exhausted|stagnated]`. Aligned terminal renders `[trellis: <name> | ✓
  aligned, N iters]` (uses `trellisAligned: true` + `trellisIteration`).
  Iteration counter color thresholds (white / yellow at ≥80% / red at
  ≥95%).
- `src/dashboard/plot-status.ts` — no behavior change for v1 per spec
  ("`failingReason = "trellis-flagged"` does not change the plot icon").
  Confirm via test that `failingReason` doesn't perturb plot aggregation.
- `src/dashboard/header.ts` — bottom-bar status-line builder. When the
  active project has any trellis vine, append
  `| trellises: <name1> (<state>), <name2> (<state>), …`. State strings:
  `<iter>/<max>, drifting`, `✓` for aligned, `⚑` for flagged, `!` for
  budget-exhausted. Truncate with `…` when too wide.
- `src/dashboard/log.ts` (or wherever poller logs) — the trellis review
  handler logs a structured `info` line per iteration: source `poller`,
  msg `trellis iteration`, data fields per spec ("Logs" subsection).
  Add the log call inside the verdict-parse branch in `handleReviewing`.
- `src/dashboard/alerts.ts` — confirm the new alert sources
  (`trellis`, `trellis-budget`) don't need bespoke handling. They route
  through existing dedup machinery; document the dedup keys used.

**Tests added.**

- `test/trellis-cli.test.ts` — unit tests for each subcommand:
  `list`/`show`/`status` produce expected output (TTY-pretty + JSON);
  `new` scaffolds a file with the spine; `amend` round-trips an edit and
  bumps a commit on main; `resume` clears the flagged state and pokes the
  poller; `retire`/`revive` add and remove the retirement comment.
- `test/trellis-status-row.test.ts` — render tests for the trellis bracket
  on the worker row. Covers DRIFT iteration counter, color thresholds,
  failed-state badges, ALIGNED check decoration.
- `test/integration/workflow-trellis.real.test.ts` — extend with a flagged
  → resume cycle, asserting `garden trellis resume` resets the failing
  state and a fresh review fires.
- `test/poller.test.ts` — `handleFailing` skip on `failingReason ===
  "trellis-flagged"`.

**Not in this phase.**

- No picker (`⌥⇧n` hotkey) — phase 5.
- No stagnation detection (spec defers to v1.5).
- No lessons-file size cap (v1.5).
- No `garden trellis budget <worker> <N>` — v1.5 per spec.

**Phase boundary.**
`tsc --noEmit` clean, `npm test` green. Operator can drive a trellis vine
fully via CLI: list trellises, plant, status, amend, resume on flagged,
retire, revive. Status pane and bottom bar reflect trellis state.

---

## Phase 5 — Picker hotkey and spawn UX

**Deliverable.** `⌥⇧n` opens an fzf-style picker over the active pane,
populated from the project's non-retired trellises with one-line summaries.
Empty-state with [a] author / [n] scaffold / [r] revive actions. One-trellis
shortcut. Pre-flight via the same `validateTrellisPlant` used by the CLI.

**Files touched.**

- `src/dashboard/hotkeys.ts` — bind `⌥⇧n` (capital N, tmux key `M-N`)
  to a new internal subcommand
  `dashboard _trellis-picker`. Add the binding alongside `⌥n`.
- `src/dashboard/index.ts` (subcommand dispatch) — register
  `_trellis-picker`. Resolves the active project from dashboard state,
  calls `findTrellisFiles`, and depending on the count:
  - Zero active trellises → opens a tmux popup with the empty-state
    actions ([a] author = spawn a default-workflow worker pre-prompted
    to invoke the `trellis-author` skill; [n] scaffold = run
    `trellis new <name>` with a name prompt; [r] revive = sub-picker
    over retired trellises if any exist, otherwise omit this action).
  - One → skip the picker and plant immediately (the picker exists for
    choice; there's no choice here).
  - Two or more → opens a picker popup. Lines are
    `<name> — <summary>`, sorted alphabetically. Arrow-key + type-to-
    filter, enter to plant, Esc to cancel.
- `src/dashboard/trellis-picker.ts` — **new file.** The picker
  implementation. Use `tmux display-popup` with a Node helper script
  (avoids requiring `fzf` binary on the system). The popup writes the
  selected trellis name to a temp file the dispatcher reads after the
  popup closes. Plant via the same `newWorker()` flow as the CLI, with
  the trellis-workflow options pre-set.
- `src/commands/keys.ts` and `src/cli.ts` — help text shows `⌥⇧n` as
  the trellis spawn hotkey.

**Tests added.**

- `test/trellis-picker.test.ts` — unit tests for the picker logic:
  empty-state action set; one-trellis short-circuit; multi-trellis lists
  alphabetically and includes summaries; retired trellises are filtered;
  selection round-trips through the temp file; pre-flight refusal on
  retired (defensive — the picker should never have surfaced it, but the
  `validateTrellisPlant` shared with the CLI gates this).
- `test/hotkeys.test.ts` — assert `⌥⇧n` is bound and dispatches to
  `_trellis-picker`.

**Not in this phase.**

- No mid-loop trellis editing (`amend` already shipped in phase 4).
- No improvements to default `⌥n` worker spawn.

**Phase boundary.**
`tsc --noEmit` clean, `npm test` green. Operator can hit `⌥⇧n` on any
project pane and pick a trellis to plant. v1 ships when this lands.

---

## Decisions baked in

The eight ambiguities surfaced during planning have been resolved by
the operator. The decisions are integrated above; this section records
them in one place for cross-reference.

1. **Sonnet meter source (phase 3).** Read `data.sonnet` (the seven-day
   Sonnet bucket already in `UsageData`). The spec's `fiveHour.sonnet` /
   `weekly.sonnet` notation is loose; the real meter is `data.sonnet`.
   The spec-side notation fix is owned outside this plan.

2. **Worker's first-iteration prompt phrasing (phase 2).** Ship a
   best-effort first cut and iterate during real-vine usage. Not a
   blocker.

3. **Picker in v1 (phase 5).** Full picker — empty-state actions,
   one-trellis shortcut, retired filter — ships in v1. The spec's
   residual v1-vs-v1.5 inconsistency is owned outside this plan.

4. **`garden trellis amend` on a dirty main checkout (phase 4).**
   Refuse with a remediation message ("commit/stash and retry"). No
   interactive prompt.

5. **`trellis-overrides.md` scoping.** File mechanism in v1: the
   reviewer's `trellisOverridesSection` reads the file when present,
   no-op when absent. `--override` CLI flag deferred to v1.5.
   `garden trellis resume` ships in v1 *without* `--override`.

6. **Per-iteration sessionId (phase 2).** Regenerate UUID per iteration
   and persist to `entry.sessionId`. Subsequent `garden bounce`
   `--resume`s the latest iteration's session.

7. *(removed — spec edge-case clarification, not a question.)*

8. **Default workflow `failingReason: "code"` retrofit (phase 1).**
   Land in phase 1. Additive write, no observable behavior change
   today.

9. **Default workflow `failingReason: "unparseable-verdict"` retrofit
   (phase 2).** Land in phase 2 alongside the trellis path's same
   write. Additive, no observable behavior change today.

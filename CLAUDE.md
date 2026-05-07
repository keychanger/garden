# Garden

Garden is a CLI orchestrator for managing interactive Claude Code sessions across multiple projects via a tmux dashboard. Read DESIGN.md for the full architecture.

## Build and run

```bash
npm install
npm run build          # esbuild -> dist/cli.js
npm run dev -- help    # run via tsx during development
```

`npm link` makes `garden` available globally. The symlink points to `dist/cli.js`, so `npm run build` is all you need after changes.

## Source layout

- `src/cli.ts` — entry point, command dispatch, aliases, help text
- `src/commands/` — one file per command, registered in `index.ts`
- `src/dashboard/` — dashboard implementation, split by concern:
  - `index.ts` — entry point, subcommand dispatch
  - `create.ts` — dashboard creation, worker command building, terminal resize
  - `runner.ts` — `resolveGardenRunner()`: absolute command line for spawning garden's CLI from a child process. Leaf module so hooks/default.ts can import it without forming a cycle.
  - `hook-dispatcher.ts` — `handleClaudeHook(event)`: thin top-level dispatcher that resolves the worker's workflow and routes Claude Code hook events to its `hookHandlers` methods. Extracted from `header.ts` to keep `header.ts` free of `workflows/index.ts` imports.
  - `workers.ts` — worker lifecycle (create, kill, bounce)
  - `continue.ts` — auto-continue prompts (interrupt-recovery and post-merge) and `.garden-done` sentinel helpers used by the poller and pause/resume commands.
  - `skills.ts` — installs garden-bundled Claude Code skills under `<worktree>/.claude/skills/<name>/SKILL.md` at worker creation and on every refresh/bounce. Currently ships `done` (worker self-declares completion), `handoff` (pass task to a fresh worker via `garden handoff`), and `trellis-author` (operator-prompted authoring of trellis design documents).
  - `navigate.ts` — project switching, pane focus, worker cycling
  - `state.ts` — DashboardState type, atomic read/write to `dashboard.state.json`
  - `registry.ts` — worker registry, atomic read/write to `dashboard.registry.json`
  - `layout.ts` — pane parking/restoring via tmux swap-pane
  - `hotkeys.ts` — Alt/Option keybinding setup
  - `header.ts` — tmux status bar (active project, build version) and top-of-status-pane plot strip with per-plot status icons.
  - `plot-status.ts` — aggregates worker states across a plot's projects into a single `PlotState` (`failing` > `asking` > `done` > `working` > `idle`).
  - `tmux.ts` — low-level tmux helpers (shared by dashboard and status command)
  - `validate.ts` — state/tmux consistency validation and self-healing
  - `git.ts` — git CLI wrappers for worktree and merge operations
  - `poller.ts` — poller coordinator: per-project event-driven dispatcher. `pollWorker` dispatches on `prState` through `workflow.stateHandlers` from the `workflows/` registry — no hard-coded switch.
  - `poller-state.ts` — state machine: `transitionState` (validates against the worker's `WorkflowDefinition.validTransitions`) plus terminal-state handlers (failing, merged, done).
  - `workflows/` — workflow registry. `types.ts` defines `WorkflowDefinition`; `default.ts` is the standard review/merge pipeline; `trellis.ts` is the trellis workflow definition (reuses default's state handlers — trellis behavior diverges only in `handleReviewing` / `finalizeMerge` branches that key on `entry.workflow === "trellis"`); `index.ts` is the lookup. Design target: `WORKFLOWS.md`; trellis spec: `TRELLIS.md`.
  - `trellis-tag.ts` — trellis file discovery: tag/retirement regexes, `findTrellisFiles`, `findTrellisByName`, `validateTrellisPlant` (plant-time pre-flight shared by the CLI and the picker).
  - `trellis-verdict.ts` — trellis verdict vocabulary (`ALIGNED`/`DRIFT`/`FAILED`/`FLAGGED`), `parseTrellisVerdict`, structured drift-list parser, FLAGGED clause extractor.
  - `trellis-prompts.ts` — trellis-flavored review prompt sections (authority, alignment step, document inline, overrides, verdict format) and `buildTrellisReviewPrompt`. Reuses default sections for intro/rebase/checks/diff/docs/tests; replaces the verdict format and adds three trellis-specific sections.
  - `trellis-continue.ts` — per-iteration context reset for trellis vines (Invariant 8). `trellisAutoContinueAfterMerge` regenerates sessionId, respawns the worker pane with `claude --session-id <fresh-uuid>` (no `--resume`), and seeds the trellis continue prompt via the existing `seedWorker` polling primitive.
  - `trellis-model.ts` — model selection for trellis vines. `resolveVineModel` (pure) returns "opus" | "sonnet" | null based on entry override → workflow default → Sonnet exhaustion fallback (per `usageThreshold`). `resolveAndApplyVineModel` (side-effecting) reads the live snapshot + autoContinue config, fires the dedup'd `trellis-budget` alert on Sonnet → Opus fallback (or the `usage`-source alert + global pause when `trellisOpusFallback === false`).
  - `hooks/default.ts` — default workflow's Claude Code hook handlers, dispatched from `hook-dispatcher.ts`'s `handleClaudeHook`.
  - `poller-review.ts` — review lifecycle: launchReview, handleWorking, handleReviewing, verdict parsing, timeout handling, killReviewWindow
  - `poller-merge.ts` — merge queue + finalization: handleMergePending, finalizeMerge, autoContinueGateReason, runPostMerge, sibling notification
  - `poller-resolve.ts` — resolver lifecycle: launchResolver, handleResolving, escalateResolveBudget, programmatic verification (STATUS.md invariant 7)
  - `poller-fifo.ts` — FIFO-poke primitives shared across the four lifecycle modules without forming a cycle through the coordinator
  - `prompts.ts` — review prompt building for the reviewer Claude session
  - `window-names.ts` — centralized tmux window naming conventions (construction, parsing, classification)
  - `alerts.ts` — persistent operator alerts (review failures, merge errors, repeated failures)
  - `log.ts` — structured JSON logger to `~/.garden/sessions/dashboard.log`
  - `names.ts` — worker name generation (adjective-noun pairs)
  - `credentials.ts` — reads/captures Claude Code OAuth credentials from macOS Keychain and file slots
  - `claude-env.ts` — resolves `CLAUDE_CONFIG_DIR` env var/prefix for per-project Claude profiles
  - `sandbox.ts` — builds Claude sandbox config (filesystem allowWrite + network allowedDomains) for each worker and reviewer
  - `usage.ts` — Claude quota fetcher/renderer for the top-left title pane. Undocumented Anthropic endpoint, strictly rate-limited; `garden login` and `garden usage refresh` heal the meter early.
  - `usage-poller.ts` — singleton `_garden-usage-poller` refreshing the quota snapshot every 5 min. Also kicked from the `Stop` hook with a 60s cooldown so the meter updates after each end-of-turn.
  - `STATUS.md` — **spec** for the worker status tracking and display system. Source of truth: the code follows this document, not the other way around. See "Specification files" below.
- `src/dashboard-claude.ts` — internal command: launches claude with rules context
- `src/commands/config.ts` — `garden config` command: view/set project config
- `src/commands/plot.ts` — `garden plot`: list/activate/create/delete/rename/add/remove/reorder/show; drives the dashboard view
- `src/commands/focus.ts` — `garden focus` / `garden unfocus`: toggle whether a plot is in the ⌥p cycle
- `src/commands/reorder.ts` — `garden reorder`: reorder plots within the ⌥p cycle
- `src/commands/claude-profile.ts` — `garden claude-profile` command: manage alternate Claude config dirs (per-project plan)
- `src/commands/login.ts` — `garden login [profile]`: re-authenticate Claude (personal or profile)
- `src/commands/auth.ts` — `garden auth status`: credential diagnostic (presence, expiry, displacement)
- `src/config.ts` — reads/writes `~/.garden/config.yml`, project resolution, Claude profile resolution
- `src/session.ts` — tmux session management (create, kill, attach, list)
- `src/rules.ts` — assembles global + project rules for Claude sessions
- `src/output.ts` — TTY detection for JSON vs pretty output
- `src/version.ts` — build version constant (injected by esbuild, falls back to "dev")

## Project management

Projects are added by directory path. The project name is always the directory basename.

```bash
garden add [path]      # defaults to cwd
garden create <path>   # scaffold new dir + git init -b main + private GitHub repo (under the gh-authed account) + add to active plot
garden remove <name>   # name = directory basename (also purges from all plots)
garden config <project> [key] [value]  # view or set project config
```

`register`/`unregister` are kept as aliases for backward compatibility.

### Plots

A **plot** is a named, ordered subset of projects (max 9). Plots drive what the dashboard shows: ⌥1–⌥9 index into the active plot, ⌥p cycles focused plots. Projects can appear in any number of plots. Plots themselves have a `focused` flag that gates inclusion in the ⌥p cycle, so you can keep a large catalogue of plots while hot-cycling only a few.

```bash
garden plot                              # list plots (active marked with *)
garden plot <name>                       # activate a plot
garden plot create <name> [project...]   # one-liner; auto-activates if none active
garden plot delete <name>                # refuses if the plot is active
garden plot rename <old> <new>
garden plot add <plot> <project> [at N]  # append by default; enforces 9-cap
garden plot remove <plot> <project>
garden plot reorder <plot> <project> <N> # move a project within a plot
garden plot show <name>                  # print a plot's ordered contents
garden focus <plot>                      # include plot in the ⌥p cycle
garden unfocus <plot>                    # exclude plot from the ⌥p cycle
garden reorder <plot> <N>                # move plot within the ⌥p cycle
```

`p` is a shortcut alias for `plot`. Removing a project (`garden remove`) purges it from every plot.

Plot storage lives in `~/.garden/config.yml` under the `plots` key; the active plot (runtime UI state) lives in `dashboard.state.json`. A one-shot migration runs on first `loadConfig()` post-upgrade: it synthesizes `plots.all` from the currently focused projects and drops the deprecated per-project `focused` flag.

### Project configuration

Per-project settings can be viewed and set via `garden config`:

```bash
garden config garden                      # show all config for project
garden config garden checks               # get a single key
garden config garden checks "npm test"    # set a key
garden config garden checks unset         # clear a key
```

Available keys:
- `checks` — command run by the reviewer (e.g. `npm test`).
- `postMerge` — command run after a successful merge (e.g. `npm run build`).
- `sandboxDomains` — comma-separated extra hosts added to the worker/reviewer sandbox allowlist on top of garden-wide defaults.
- `claudeProfile` — opts the project into an alternate Claude Code config dir; see `garden claude-profile` below.
- `logColor` — pins the project's color in `garden logs`. Auto-assigned at `add`/`create`; `green` is reserved for `garden`.

Workers pin their base branch (`WorkerEntry.baseBranch`) to the main checkout's current branch at creation time and never retarget. Dashboard visibility is controlled by plots (see above), not a per-project flag.

### Claude profiles

Each project's workers and reviewers default to your personal `~/.claude` credentials. To run a project on a different plan (e.g. a client's Enterprise workspace) without disturbing the default, register a profile and assign it:

```bash
garden claude-profile add imp                  # creates ~/.claude-imp and registers the profile
garden claude-profile login imp                # interactive: claude /login pointed at ~/.claude-imp
garden config <project> claudeProfile imp      # opt the project in
garden claude-profile list                     # shows profiles and which projects use each
garden claude-profile remove imp               # refuses while any project still references it
```

A project's claudeProfile is injected as `CLAUDE_CONFIG_DIR` whenever its worker, reviewer, resolver, or `_dashboard-claude` session spawns. The dashboard usage meter is not split per-profile (Anthropic's `/api/oauth/usage` aggregates by user identity).

### Auth recovery

OAuth tokens expire roughly weekly. When a worker hits an expired token it'll prompt for `/login`. Use `garden login` rather than typing `claude /login` directly — `garden login` strips `CLAUDE_CONFIG_DIR` from the spawned env, so it's safe to invoke from anywhere (including inside a profile-tagged worker pane, where a raw `claude /login` would be routed at the wrong config dir).

```bash
garden login            # personal expired — re-auths the default account
garden login imp        # profile expired — re-auths imp, captures the macOS Keychain
                        # entry to ~/.claude-imp/.credentials.json, and reminds you to
                        # follow up with 'garden login' so the Keychain holds personal again
garden auth status      # diagnostic table: shows where each credential lives, when it
                        # expires, and detects Keychain displacement (keychain matching a
                        # profile's file means a profile login displaced the personal token)
```

`garden claude-profile login <name>` is kept as an alias for `garden login <name>`.

The macOS Keychain footgun: Claude Code on macOS persists every login to one shared Keychain entry (`Claude Code-credentials`), regardless of `CLAUDE_CONFIG_DIR`. The capture-keychain-to-file step inside `garden login <profile>` is the only way to keep two distinct credential sets — without it, every profile login silently overwrites the personal token in the Keychain.

## Adding a new command

1. Create `src/commands/<name>.ts` exporting an async function that takes `args: string[]`
2. Register it in `src/commands/index.ts`
3. Add it to the help text in `src/cli.ts`
4. Use `output()` / `outputLines()` from `src/output.ts` for data output
5. Use `resolveProject()` or `resolveProjectFromArgs()` for project resolution

## Adding a new workflow

A **workflow** is a `WorkflowDefinition` (state machine + state handlers + hook handlers) that drives a worker's lifecycle. The default workflow reproduces the standard "review and merge" pipeline; alternate workflows are introduced as data, not as forks of the dispatcher. Background and design rationale: `WORKFLOWS.md`.

1. Create `src/dashboard/workflows/<name>.ts` exporting a `WorkflowDefinition` (see `src/dashboard/workflows/types.ts` for the shape). Reuse the default's pieces wherever possible:
   - **State machine**: declare `validTransitions` (per-workflow). The default's table is in `workflows/default.ts` and is the literal copy of the pre-refactor `VALID_TRANSITIONS`.
   - **State handlers**: import from `poller-state/review/merge/resolve` and slot into `stateHandlers`. Workflows that diverge define their own. `stateHandlers` is `Record<PrState, StateHandler>` — every PrState must have a handler (TypeScript enforces this at compile time). Workflows that don't use a particular state should still register a no-op handler that returns `false`; this keeps the dispatcher in poller.ts free of defensive runtime guards and surfaces incomplete workflows as build errors instead of silent runtime warnings.
   - **Hook handlers**: reuse `defaultHookHandlers` from `src/dashboard/hooks/default.ts`, or write a new `WorkflowHookHandlers` object (one method per Claude Code event). Helpers in `hooks/default.ts` (`workerFromCwd`, `readHookInput`, `routeStopHookEnd`) are reusable.
2. Register it in `src/dashboard/workflows/index.ts` by calling `registerWorkflow(def)` alongside the default. `getWorkflow(name)` resolves it; unknown names warn once and fall back to default. `registerWorkflow` warns if the name is already registered (catches plug-ins shadowing the default by mistake).
3. **Workflow-specific prompts (if any)**: declare new `PromptSection` instances in `src/dashboard/prompts.ts` (or a sibling file) and a section list. Build via `composePrompt(sections, ctx)` from `src/dashboard/prompt-compose.ts`. Reuse `gatherPromptContext` for review-shaped I/O, or `makeContext` for workflows that don't need the full diff/rules/docs/tests gather.
4. **Headless agent launches (if any)**: use `launchHeadlessAgent` from `src/dashboard/headless-agent.ts` — same primitive the reviewer and resolver call. Verdict parsing via `parseLastLineVerdict` from `src/dashboard/verdict.ts` with a typed-const vocabulary tuple.
5. **Assigning the workflow to a worker**: set `WorkerEntry.workflow` (string field on the registry entry). `newWorker()` in `src/dashboard/workers.ts` accepts an `opts.workflow` field; when set to `"trellis"` it also stamps the trellis-specific entry fields from `opts.trellis`. CLI surface: `garden workers new <project> --workflow <name>`.
6. **Tests**: follow the patterns in `test/workflows.test.ts` (registry behavior + deep-equal `validTransitions` + exhaustiveness) and `test/integration/workflow-default.real.test.ts` (drive a real worker through the workflow's state machine on real fs/git).

The `default` workflow stays the source of bit-for-bit equivalence with pre-refactor behavior. Alternate workflows that change behavior must own their own snapshot/integration tests; do not loosen the default's invariants to accommodate them.

## Trellis workflow

The **trellis** workflow runs a feature-scoped, spec-driven loop where a worker (a "vine") iterates against a frozen design document until code, tests, and documentation align. Spec: `src/dashboard/TRELLIS.md`. Implementation plan: `src/dashboard/TRELLIS-PLAN.md`.

Day-to-day operator surface (v1, partial):

- `garden trellis new <project> <name>` — scaffold a trellis at `<project>/.garden/trellises/<name>.md` with the required spine (title, spec sentinel, trellis tag) and recommended sections (Intent, Surface, Behavior, Tests, Docs, Out of scope). Edit the scaffold to fill in feature-specific content, then commit to main.
- `garden workers new <project> --workflow trellis --trellis <name> [--model opus|sonnet] [--max-iterations N]` — plant a vine bound to the named trellis. Pre-flight via `validateTrellisPlant` (refuses unknown/retired trellises; warns on missing spec sentinel or `checks` config). `--model` overrides the trellis default (Sonnet).

The `trellis-author` skill (bundled into every worker's `.claude/skills/trellis-author/SKILL.md`) walks an operator-prompted worker through scope sizing, the required spine, recommended sections, and a self-review pass before saving. Triggers on operator intent ("formalize this as a trellis", "let's spec this as a trellis").

Lifecycle (v1, in `src/dashboard/poller-review.ts` / `poller-merge.ts`):

- `handleReviewing` parses the trellis verdict vocabulary (`ALIGNED`/`DRIFT`/`FAILED`/`FLAGGED`). ALIGNED writes `.garden-done` (workflow handler does it on the worker's behalf) and goes to merge-pending — `finalizeMerge`'s sentinel-aware path then picks `done`. DRIFT goes to merge-pending and `finalizeMerge` dispatches `trellisAutoContinueAfterMerge` (see below). FLAGGED goes to `failing` with `failingReason: "trellis-flagged"` — `handleFailing` refuses the push debounce, so only `garden trellis resume` (phase 4) clears it. FAILED uses the same path as default's FAILED with `failingReason: "code"`.
- `launchReview` increments `trellisIteration` *before* the budget check and *before* dispatch. Exceeding `trellisMaxIterations` short-circuits to `failing` with `failingReason: "iteration-budget"` and an alert (source `trellis`).
- `trellisAutoContinueAfterMerge` (in `src/dashboard/trellis-continue.ts`) is the per-iteration context reset (Invariant 8). It regenerates the worker's sessionId, respawns the pane via `tmux respawn-pane -k` with `claude --session-id <fresh-uuid>` (no `--resume`), and seeds the trellis continue prompt (drift list + lessons file inline) via the existing `seedWorker` polling primitive. Each iteration starts cold; conversation history does not compound.

Worker prompt: `buildWorktreeRules(branch, base, { trellis: { relativePath } })` appends three trellis-specific paragraphs (concept, authority asymmetry, iteration discipline) to the baseline rules. Default workers leave `options` undefined and get the baseline only.

Reviewer prompt: `buildTrellisReviewPrompt` in `src/dashboard/trellis-prompts.ts`. Composes `trellisReviewSections` — reuses default sections for intro/rebase/checks/diff/docs/tests, adds three trellis-specific sections (authority, alignment step, document inline), replaces the verdict format. Verdict parsing via `parseTrellisVerdict` in `src/dashboard/trellis-verdict.ts`.

Model selection (phase 3): vines default to Sonnet (set on `trellisWorkflow.workerModel`); reviewer pins to Opus via `workflow.reviewerModel` (Invariant 10 — never falls back). Each iteration's spawn — initial plant *and* per-iteration respawn — calls `resolveAndApplyVineModel`, which reads the Sonnet meter against the project's `usageThreshold`. When Sonnet ≥ threshold:

- `trellisOpusFallback !== false` (default): fall back to Opus for that iteration; fire one `trellis-budget` alert per fallback occurrence (deduped via `entry.trellisModelFallbackAt`).
- `trellisOpusFallback === false`: refuse the spawn. Initial plant rolls back the registry entry; per-iteration respawn flips the global auto-continue gate (`pausedUntil` = Sonnet `resetsAt`) and fires a `usage`-source alert. Loop resumes when Sonnet resets or operator runs `garden auto on`.

Per-worker override via `garden workers new ... --model opus|sonnet`; persists to `entry.workerModel` and beats the workflow default. Bounce preserves the in-flight session's model (no `--model` flag passed; `claude --resume` inherits the session's stored model).

Out of scope for v1: full `garden trellis ...` CLI surface (only `new` ships through phase 3; list/show/status/amend/resume/retire/revive land in phase 4), status pane decoration, picker hotkey, stagnation detection, lessons file size cap, `--override` flag.

## Internal commands

Some commands are not user-facing — they're dispatched by the dashboard via tmux hotkeys or status bar. These are handled in `cli.ts` before normal command lookup:

- `_dashboard-claude` — launches claude with project rules context (used by dashboard workers)

The dashboard also has internal subcommands (e.g., `dashboard _switch 1`, `dashboard _new-worker`) called by hotkeys. These are dispatched inside `src/dashboard/index.ts`.

## Dashboard internals

The dashboard uses a permanent tmux layout with content swapped in and out of pane slots. This is the key architectural pattern:

- **Pane slots are never removed.** Content is moved via `tmux swap-pane` between visible slots and hidden tmux windows. This preserves the layout tree. Both the right pane and the growhouse pane (lower-left) are swappable.
- **Left column** stacks three panes top-to-bottom: the "garden" title pane (fixed height, Claude quota meters with a bold green `garden` label on the pane border), the "status" pane (dynamic height, per-project worker list), and the growhouse pane (remainder). The title and status panes each run their own SIGUSR1-driven refresh loop that re-displays a pre-baked file (`usage.rendered` / `status.rendered`) written atomically by `writeUsageRendered()` / `writeQuickStatus()` in `src/dashboard/header.ts`.
- **Growhouse pane** (lower-left) cycles between three views: growhouse (bold green `garden>` prompt with auto-dispatch via zsh `command_not_found_handler`), root (general-purpose shell), and logs. `⌥g` jumps to growhouse, `⌥r` jumps to root, `⌥l` jumps to logs.
- **Hidden windows** use underscore-prefixed names: `_<project>-worker-N`, `_<project>-shell`, `_<project>-poller`, `_<project>-review-<worker>`, `_garden-growhouse`, `_garden-root`, `_garden-logs`. The underscore marks them as garden-managed.
- **Parking/restoring** (`src/dashboard/layout.ts`): To swap content, we create a temp hidden window, swap the current pane into it, then swap the target pane from its hidden window into the slot, and kill the temp window. Separate functions handle the right pane (`parkToHidden`/`restoreFromHidden`) and growhouse pane (`gardenParkToHidden`/`gardenRestoreFromHidden`).
- **State** (`src/dashboard/state.ts`): Tracks which project is active, which pane is visible, and pane IDs. Written atomically (write-tmp-then-rename) to `dashboard.state.json` after every operation.
- **Status writers**: The registry is the single source of truth (see `src/dashboard/STATUS.md`). Claude Code hooks write `claudeStatus`; the poller writes `prState`; the tmux `pane-died` hook writes `claudeStatus="exited"`. Every transition is event-triggered — there is no fallback poll.
- **Bottom bar** (`src/dashboard/header.ts`): Two-sided tmux status line. Left: active project name and branch. Right: build version, prefixed with a red `⚠ N alerts — ⌥l to clear` badge when unread alerts exist.
- **State validation** (`src/dashboard/validate.ts`): On every attach, validates pane IDs against tmux reality and heals stale state. Cleans orphaned registry entries and context files.
- **Logging** (`src/dashboard/log.ts`): Structured JSON log to `~/.garden/sessions/dashboard.log`. Levels are a semantic contract: `error` = operator must act, `warn` = possibly wrong, `info` = lifecycle state transition, `debug` = events/heartbeats/no-op cycles. Default is info; `GARDEN_LOG_LEVEL=debug` brings back the firehose.
- **Health check**: `garden health` diagnoses state/tmux divergence. `garden health --fix` runs the self-healing validator.
- **Kick**: `garden kick <worker>` re-arms a worker stranded in `working` for review (sets `pendingReviewAt` and pokes the project poller). Use when a reviewer-push race or a crashed poller has left a worker with no event to wake it. Refuses workers whose `prState` is set to a lifecycle state (reviewing, merge-pending, etc.), whose `claudeStatus` is `working` or `asking` (Claude is mid-turn — launching a reviewer would race live commits), or with no commits ahead of base.
- **Bounce**: `garden bounce <worker>` (or `⌥b` on an active worker pane) kills the Claude process and restarts it via `claude --resume <sessionId>` in the same pane. The conversation history is preserved, but transient session state is dropped — fresh read of `.claude/settings.json` (hook config, `permissions.defaultMode`), new permission-mode cycle. Use when a worker is stuck in plan/acceptEdits with no way back to auto, when hook config was changed by a new build, or when Claude has wedged into a bad state. Writes `claudeStatus = "idle"` afterwards (`--resume` skips SessionStart).
- **Pause/Resume**: `garden pause <worker>` writes the `.garden-done` sentinel at the worker's worktree root; `garden resume <worker>` deletes it. The sentinel suppresses the post-merge auto-continue (see below). Use pause to stop a running phase chain without killing the worker; use resume to re-arm auto-continue after a pause or after the worker self-declared done.
- **Auto-continue on resume** (`src/dashboard/continue.ts`): When a worker is interrupted mid-turn (dashboard kill, tmux server crash, bounce while `claudeStatus === "working"`), the resume path auto-sends a "continue from where you left off" prompt a few seconds after the pane comes back. Skips silently if the operator started typing.
- **Auto-continue across the merge boundary** (`src/dashboard/continue.ts`, `poller.ts:maybeAutoContinue`): After a clean merge, `finalizeMerge` syncs the worktree to the merged tip (`git fetch && git reset --hard origin/<branch>`), then sends a "continue with the next phase" prompt enriched with the list of files that changed during review. Worker opts out by writing `.garden-done` in its worktree root before ending its turn (covered in the worker's system prompt). `garden pause` / `garden resume` toggle the sentinel.
- **Global auto-continue gate** (`src/config.ts:getAutoContinueConfig`): A global gate in `~/.garden/config.yml` under `autoContinue` (`enabled`, `usageThreshold`, `resumeAfterReset`) controls auto-continue across projects. Defaults: enabled, 95% threshold, no auto-resume. Tripping the threshold pauses with `pausedUntil` set to the latest meter `resetsAt` and fires a `usage`-source alert. CLI: `garden auto [on|off|status|threshold N|resume-on-reset on|off]`.
- **`done` vs `merged`**: two visually distinct terminal states — `merged` is the transient post-merge beat (neutral); `done` is the operator-actionable "worker self-declared finished" signal (bold green). Picked from `.garden-done` presence at merge time. Spec: STATUS.md invariant 4.

## Worker isolation (worktrees)

Every worker runs in its own git worktree, isolated from the main checkout and other workers:

1. `opt-n` creates a worktree at `~/.garden/worktrees/<project>/<worker-name>/` on a branch named after the worker. The worktree branches directly off `origin/<base>` (fetched as the first bootstrap step), so worker freshness never depends on the main checkout being clean or up-to-date. If the main checkout cannot be fast-forwarded, the bootstrap still proceeds and an alert (source `bootstrap`) is raised so the operator can clean the drift.
2. The worker's system prompt includes instructions to commit incrementally and push when done. Each worktree's `.claude/settings.json` configures Claude's OS-level sandbox (Seatbelt on macOS, bubblewrap on Linux) and starts every Claude process in `permissions.defaultMode: "auto"`. The sandbox allowlist is built in `src/dashboard/sandbox.ts` from garden-wide defaults plus the project's `sandboxDomains` config key. Reviewers inherit the same config by running inside the worktree.
3. Each project gets its own **poller** (`src/dashboard/poller.ts`) running in a hidden tmux window (`_<project>-poller`), driving the review/merge lifecycle using local git (no GitHub PRs). Projects never block each other.
   - Wakes only on FIFO pokes from event sources: Claude Code Stop hooks (when commits exist ahead of base), pre-push hooks installed in worktrees, merge-queue completion. There is no fallback poll. See `src/dashboard/STATUS.md` for the full state machine.
   - When the worker's Stop hook fires with commits ahead of base, the hook marks the worker for review (`pendingReviewAt`) and pokes the poller, which transitions `working → reviewing` and launches a Claude reviewer asynchronously in a hidden tmux window (`_<project>-review-<worker>`). Multiple reviews can run in parallel within a project. The reviewer rebases onto the base branch, resolves conflicts, runs optional `checks` command (configured per project in `~/.garden/config.yml`), fixes check failures, and reviews code against project rules.
   - If code is clean or reviewer fixed all issues: force-pushes and transitions to `merge-pending`. A serial merge queue processes one merge at a time per project. If the rebase onto current base branch has conflicts (because the base branch advanced), a dedicated resolver is launched (state `resolving`) — its verdict is verified programmatically (rebase actually landed, `origin/<base>` is an ancestor of HEAD, HEAD advanced past `preResolveSha`) and is retried up to a budget of 2 before escalating to `failing` with an operator alert. If the rebase is clean: fast-forwards the remote base branch via direct refspec push (no local checkout needed).
   - After merge, fast-forwards the local base branch checkout and runs optional `postMerge` command (e.g., `npm run build` to rebuild the CLI). If the fast-forward fails, postMerge is skipped and an alert is raised — the alert fires regardless of whether postMerge was configured, since local-checkout drift breaks manual workflow on its own. When the garden project itself rebuilds successfully, the poller spawns a detached `_post-rebuild-refresh` via the freshly-built binary; it respawns the status and logs panes, calls `restartLongLivedPollers()` so the usage-poller and per-project pollers reload the new bundle (they cache JS in memory at spawn time), and refreshes the dashboard.
   - Notifies live sibling workers with overlapping files so they can rebase.
   - Debounces commits (30s quiet period) before retrying.
4. Workers are killed on manual `opt-x` or `garden reset`.
5. Worktrees are cleaned up when the worker is killed.

The project shell (`opt-s`) stays on the main checkout for manual work.

## Specification files

A specification file is a markdown document that is the source of truth for a system: the code is expected to follow it, not the other way around. Specs are identified by the marker phrase **"the code is wrong"** in their opening paragraph (the spec convention is "if the code disagrees with this document, the code is wrong"). The reviewer detects this marker via `findSpecFiles()` in `src/dashboard/prompts.ts` and prepends a strong warning to the review prompt instructing it to never edit a spec file to match the current implementation.

When working with a spec file:

- The spec drives the code. If the code does X but the spec says Y, the code is wrong — fix the code, not the spec.
- A spec may describe behavior the current code does not yet implement. That is intentional — it is the design target. Do not "fix" the spec by removing the description, and do not silently update prose to match the legacy code.
- Treat spec changes the way you would treat user instructions: review for clarity, internal consistency, and grammar. Never rewrite design intent.
- If you genuinely believe a spec change is wrong, raise it explicitly rather than editing the spec.

Current specs in this project:

- `src/dashboard/STATUS.md` — worker status tracking and display system
- `src/TRACKS.md` — multi-track projects and the promotion pipeline (design target; no code yet)
- `src/dashboard/TRELLIS.md` — feature-scoped, spec-driven loop workflow ("trellis"); ralph-loop pattern adapted to garden's review/merge cycle (phase 2 implements the end-to-end vine loop; full `garden trellis ...` operator surface lands in phase 4)

## Conventions

- All read commands: JSON when piped, pretty in TTY. Use `src/output.ts`.
- tmux sessions are named `garden-dashboard`.
- `GARDEN_PROJECT` env var scopes commands inside sessions. Worker panes also export `GARDEN_WORKER`, `GARDEN_BRANCH`, `GARDEN_BASE_BRANCH` so workers can self-identify; `garden whoami` reads these to print the current worker's registry entry, and `garden logs -w $GARDEN_WORKER` filters to the worker's own history.
- Project name is auto-detected from cwd when inside a registered project.
- Dashboard workers are interactive Claude sessions in isolated git worktrees, launched with project rules via `--append-system-prompt-file` and Claude Code's Remote Control flag (`--rc`) so each worker surfaces in the Claude app's remote sessions list — operator can check in or steer from their phone. Reviewers and resolvers run headless via `claude -p` and intentionally do not get `--rc`. Workers operate autonomously — they commit and push without asking for confirmation, since each worktree is fully isolated. The poller handles review and merge automatically.
- **Bash escaping**: route every value that gets interpolated into a generated shell command through `shellEscape` (`src/dashboard/tmux.ts`). It returns a fully single-quoted bash literal — use the result without surrounding `'...'`. Do not write inline `.replace(/'/g, "'\\''")`.
- **Atomic file writes**: every persisted state file (`dashboard.state.json`, `dashboard.registry.json`, `dashboard.alerts.json`, `~/.garden/config.yml`, `.claude/settings.json`, rendered status caches) goes through `atomicWriteFile` (`src/dashboard/atomic-write.ts`), which writes to a UUID-suffixed temp path then renames. New persisted files must use this helper, not raw `fs.writeFileSync`. Readers should pair this with an inline `is{ShapeName}` type guard before trusting the parsed JSON — see `readDashState`, `readRegistry`, `readAlerts` for the pattern.
- **Alert deduplication**: `addAlert` (`src/dashboard/alerts.ts`) suppresses identical-key alerts within a 1-hour window. The default key is `${level}:${source}:${project}:${worker}:${message[:200]}`. When an alert message embeds time-varying detail (commit SHA, error string, file list, etc.) that would defeat the default truncation, supply an explicit stable `dedupKey` so repeating failure modes collapse to one alert per window. See the four call sites in `poller-merge.ts`, `poller-review.ts`, `poller-resolve.ts`, `dashboard/index.ts` for examples.
- **Tests**: `npm test` runs both unit tests and integration tests under `test/integration/**` (the bundled hook test in particular catches module-init cycles that vitest's source-level resolver cannot — see Phase 3 of the foundation hardening). Do not move integration tests back behind a separate flag.

## Rules system

Claude sessions get a system prompt built from:
1. Global rules (`<garden-repo>/rules.md`) — version-controlled in the garden repo itself, resolved at runtime relative to `dist/cli.js` / `src/rules.ts`. Override with `GARDEN_RULES_PATH` (used by tests).
2. Project rules (`<project>/.garden/rules.md`)

Rules are plain markdown. They control commit behavior, testing requirements, PR workflow, and scope discipline.

## Git workflow

Feature branches, PRs, no direct commits to main. See `rules.md` for full details.

## Keeping docs current

If your task changes commands, architecture, file layout, or conventions, update DESIGN.md and CLAUDE.md as part of the task. Docs that disagree with code are worse than no docs.

# Garden

A minimal CLI orchestrator for managing Claude Code sessions across multiple projects.

Garden is a personal tool — opinionated toward a single developer managing many projects from one place. It is not a team tool, not a CI system, and not a framework. It's a thin, extensible layer over Claude Code.

## Core Concepts

### Project
A named reference to a directory on disk where Claude Code can operate. Projects are added with `garden add [path]` (name is derived from the directory basename).

### Dashboard
A tmux session (`garden-dashboard`) that serves as the primary interface. The dashboard is a left/right split: garden title and usage meters (top), project status (middle), and a growhouse pane (bottom) on the left; an active pane (worker or shell) on the right with a header bar. The growhouse pane cycles between three views: the growhouse (`⌥g`) with a bold green `garden>` prompt and auto-dispatch for garden commands, the root shell (`⌥r`) for general-purpose terminal use, and a logs view (`⌥l`). The same swap-pane mechanism as the right pane is used. You never interact with tmux directly — garden sets up the layout, keybindings, and pane management.

### Workers
Interactive Claude Code sessions running inside the dashboard. Each project can have multiple workers (e.g., one for a feature, one for a review). Workers persist when you switch between projects — they're parked in hidden tmux windows and swapped back in when you return.

### Rules System
Claude sessions are configured with layered rules files injected via `--append-system-prompt-file`:

1. **Global rules** (`<garden-repo>/rules.md`) — methodology, testing, git workflow. Lives in the garden repo itself (version-controlled). Resolved at runtime relative to `dist/cli.js` (or `src/rules.ts` in dev). Override via `GARDEN_RULES_PATH` env var.
2. **Project rules** (`<project>/.garden/rules.md`) — project-specific conventions

Rules are plain markdown. Edit them directly.

## Dashboard Layout

```
┌─────────────────────┬─────────────────────────────┐
│  garden (title)     │                             │
│  + usage meters     │                             │
│  (fixed height)     │                             │
├─────────────────────┤                             │
│  Project Status     │                             │
│  (auto-sized)       │                             │
│                     │  Active Pane                │
│  garden ◄           │  (worker or shell)          │
│  ● ⠋ worker-1 working │                             │
│  ○ ◆ worker-2 idle    │                             │
│  api                │                             │
│    (no workers)     │                             │
├─────────────────────┤                             │
│                     │                             │
│  Growhouse          │                             │
│  (garden> prompt)   │                             │
│                     │                             │
├─────────────────────┴─────────────────────────────┤
│ garden  main                       garden a1b2c3d│
└───────────────────────────────────────────────────┘
```

### Panes

- **Garden title + Usage Meters** (top-left) — Dedicated pane with a bold green `garden` title label on the pane border and three Claude quota bars inside (5-hour rolling window, weekly total, Sonnet-specific weekly meter). Fixed height (5 rows). Refreshed via SIGUSR1 from a pre-baked `usage.rendered` file.
- **Project Status** (mid-left) — Live-updating display of all projects and their workers. Shows which project is active (`◄`), each worker's lifecycle state via status icons (braille spinner for working, Unicode symbols for other states), a focus indicator (filled/empty circle) showing which worker is active, and aligned columns for name/status/activity. Auto-sizes to the number of projects.
- **Growhouse Pane** (lower-left) — Cycles between three views: growhouse (bold green `garden>` prompt with auto-dispatch for garden commands), root (general-purpose shell), and logs. `⌥g` jumps to growhouse, `⌥r` jumps to root, `⌥l` jumps to logs.
- **Bottom bar** (tmux status line) — Two-sided display. Left side shows the active project name (bold) and its current git branch. Right side shows the garden build version (git short SHA, or "dev" when running via tsx); when unread alerts exist it is prefixed with a red `⚠ N alerts — ⌥l to clear` badge.
- **Active Pane** (right) — The currently visible pane for the active project. Either a worker (Claude session) or the project shell. Only one is visible at a time; others are parked in hidden tmux windows.

### Right-side pane model

Each project has:
- **One shell** (always exists, created on first project switch, protected from kill)
- **Zero or more workers** (spawned on demand with `⌥n`)

Only one pane is visible at a time. `⌥]`/`⌥[` cycles through all of them. `⌥w` jumps to the first worker, `⌥s` jumps to the shell.

## Plots

A **plot** is a named, ordered subset of projects (max 9) that drives what the dashboard shows. `⌥1`–`⌥9` index into the *active* plot. `⌥p` / `⌥P` cycle through focused plots. Projects can appear in any number of plots.

Plots scale past the nine-project hotkey ceiling: you can register as many projects as you want in `~/.garden/config.yml`, group them into purpose-specific plots (`client`, `lab`, `imp`, …), and swap views with a single keystroke. Each plot has a `focused` flag controlling whether it appears in the `⌥p` cycle — unfocused plots are still reachable by name (`garden plot <name>`) but don't clutter the hot-cycle.

**Storage**:
- Plot definitions live in `~/.garden/config.yml` under `plots:`. Order is semantic: plot insertion order drives `⌥p` cycle position, project order inside a plot drives `⌥1`–`⌥9`.
- Active plot is runtime UI state in `~/.garden/sessions/dashboard.state.json` (`activePlot` field). A user who runs `garden plot imp` before the dashboard is open will still land on `imp` when it launches — `ensureDashboard` preserves the pre-existing `activePlot` across fresh-creation of the state file.

**Migration**: The first `loadConfig()` after upgrading synthesizes `plots.all = [currently-focused projects]` (preserving pre-plot visibility) and drops the deprecated per-project `focused` flag. Idempotent once migrated.

**Hotkey behavior**:
- `⌥1`–`⌥9` resolves against `getFocusedProjectNames(config, state.activePlot)` — the active plot's projects, filtered to those still registered. Indices beyond the plot's length show a "No project at index N" hint.
- `⌥p` / `⌥P` (`cyclePlot` in `src/dashboard/navigate.ts`) iterates only focused plots. `⌥o` is an alias for `⌥P` (cycle previous), for ergonomic left/right cycling with `⌥p`. If the active plot isn't focused, the next press lands on the first focused plot. When cycling, `activeProject` is clamped to the new plot's membership so the hotkey grid updates immediately. The leaving plot's `activeProject` is stashed in `state.lastActiveProjectByPlot`, so cycling back restores the prior selection instead of re-clamping to the first project.

**Header rendering**: `formatLeft` prefixes the active-project string with the plot name (e.g., `imp › garden • main`). The status pane's border renders a plot strip — one segment per focused plot, showing a filled circle on the active one and an empty circle on the others (mirroring the worker focus marker below it) — by writing the formatted string into `@garden_name` on the status pane (`buildPlotStrip` in `src/dashboard/header.ts`). Unfocused plots are omitted. `@garden_plot` is unused on that pane.

**Plot status indicators**: Each plot segment also carries a status icon derived from the aggregated state of all workers across the plot's projects (`resolvePlotStatus` in `src/dashboard/plot-status.ts`). Priority order: `failing` (red ✖) > `asking` (yellow ⚑) > `done` (green ✓) > `working` (braille spinner) > `idle` (no icon). Only `done` is green — `merged` (transient post-merge beat), `reviewing`, `merge-pending`, and `resolving` fall through to `working`, since none of those are operator-actionable. Colors override the active/inactive styling for non-working states; working plots keep the bold/dim active/inactive distinction and add a bright spinner. The spinner animates at the same 120ms cadence as worker rows by piggybacking on the status pane's existing SIGUSR1-driven tick: `buildPlotStrip` writes a template file (`~/.garden/sessions/plot-strip.template`) with a `__GSP__` sentinel where the spinner frame goes, and the status pane's bash loop substitutes the current frame and rewrites `@garden_name` each tick. The loop enters animation mode if either `$cur` has a braille char or the template file contains the sentinel.

**Project removal** (`garden remove <project>`) also calls `purgeProjectFromPlots` to strip the project from every plot's project list. Empty plots are kept — delete explicitly with `garden plot delete`.

## Hotkeys

All hotkeys use Alt/Option with no prefix — single keypress, instant.

Requires terminal setup: iTerm2 → Profiles → Keys → Left Option key → "Esc+" (sends Meta).

| Key | Action |
|-----|--------|
| `⌥1` – `⌥9` | Switch to project by index within the active plot |
| `⌥p` / `⌥P` | Cycle to next/previous focused plot (`⌥o` also cycles previous) |
| `⌥n` | New worker (Claude session) |
| `⌥w` | Jump to first worker |
| `⌥s` | Jump to project shell |
| `⌥]` / `⌥[` | Cycle workers and shell |
| `⌥x` | Kill current worker (shell is protected) |
| `⌥b` | Bounce current worker (restart Claude via `--resume`, preserve history) |
| `⌥g` | Focus growhouse (lower-left) |
| `⌥r` | Focus root shell (lower-left) |
| `⌥l` | Focus logs view (lower-left); also acknowledges the alert badge |

## Pane Management

### Swapping Mechanism
Each project's workers and shell live in hidden tmux windows when not active. When you switch projects:

1. A temporary hidden window is created, and the current active pane is swapped into it via `swap-pane`
2. The target project's pane is swapped from its hidden window into the right slot via `swap-pane`, then the hidden window is killed
3. The status pane and header update to reflect the new state

This preserves both the layout tree (the right pane slot is never destroyed) and all worker state across switches.

### Hidden Window Naming
Hidden windows follow the convention: `_<project>-worker-<N>`, `_<project>-shell`, `_<project>-poller`, `_<project>-review-<worker>`, `_garden-growhouse`, `_garden-root`, `_garden-logs`, and `_garden-usage-poller`. When switching projects, the visible pane is parked as `_<project>-active`. The underscore prefix marks them as managed by garden — not user-facing.

### Worker Lifecycle
1. `⌥n` creates a git worktree at `~/.garden/worktrees/<project>/<worker-name>/`, with a branch named after the worker that points at `origin/<base>` directly. Worker freshness does not depend on the main checkout being clean or fast-forwarded — a stale main checkout raises an alert but does not infect the worker
2. Claude launches in the worktree with project rules and worktree workflow instructions
3. The worker is interactive — you work with it directly
4. `⌥]`/`⌥[` cycles between workers and shell
5. `⌥x` kills the focused worker, removes its worktree and branch. Kills unconditionally — no confirmation, even on dirty worktrees — so a worker stuck in loading or otherwise unresponsive can always be torn down
6. Switching projects parks everything in hidden windows; switching back restores

### Poller and Auto-Merge
Each project gets its own background poller (`_<project>-poller`) running in a hidden tmux window. Pollers are independent — one project's reviews never block another. Each poller watches its project's worker branches for new commits and drives the review/merge lifecycle using local git operations (no GitHub PRs). Pollers start when a project's first worker is created and stop when the last worker is killed.

**State machine per worker:**
```
working -> reviewing -> merge-pending -> merged --(UserPromptSubmit)--> working
               |              |              \
               v              v               +-(.garden-done set)-> done
           failing        resolving (auto-resolver on rebase conflict)
                              |
                              +-> merge-pending (verified) or failing (budget exhausted)
```

1. **working**: Worker is active. When the worker's Claude Code Stop hook fires and the worktree has commits ahead of base, the hook marks the worker for review (`pendingReviewAt`) and pokes the poller, which transitions to reviewing. Multiple workers per project can transition independently.
2. **reviewing**: Poller launches a Claude reviewer (`claude -p`) asynchronously in a hidden tmux window (`_<project>-review-<worker>`). The reviewer runs inside the worker's worktree, so it inherits the worktree's `.claude/settings.json` sandbox config (auto-allow for bash within the configured filesystem/network allowlist). The reviewer rebases onto the base branch, resolves conflicts, runs optional checks, fixes check failures, and reviews code against project rules. The poller polls for review completion by checking if the review window still exists. On completion: if clean or fixed, force-pushes and transitions to merge-pending. If the reviewer cannot fix the issues, transitions to failing. If the review process fails (Claude unavailable, timeout, unparseable output), transitions to failing. Unreviewed code is never auto-merged.
4. **merge-pending**: Review passed, waiting to merge. A serial merge queue processes one merge at a time per project (ordered by timestamp). The merge sequence: rebase onto current base branch, force-push, then ff-merge. If the rebase has conflicts (because the base branch advanced while waiting), the poller launches a dedicated resolver and transitions to `resolving`. If the rebase is clean, the merge proceeds.
5. **resolving**: A dedicated resolver Claude session is running in a hidden tmux window with a single narrow job: complete `git rebase origin/<base>` and commit any conflict resolutions. The resolver does not push and does not re-review code — the code was already approved. On Stop, the poller verifies the rebase actually landed (no `.git/rebase-merge` or `.git/rebase-apply` present; `origin/<base>` is an ancestor of HEAD; HEAD differs from `preResolveSha`). On pass, force-pushes and returns to `merge-pending`. On fail, retries up to `resolveAttempts = 2`; on budget exhaustion, transitions to `failing` with an operator alert that names the unmerged files. Any worker push during `resolving` aborts and resets budget — the worker's new state is the new ground truth.
6. **failing**: Unfixable review issues, failed review process, or exhausted resolver budget. Poller watches for new commits via SHA tracking. After 30s debounce with no new pushes, state transitions back to working for retry. Each failure increments a `failCount` on the worker entry; after 3 consecutive failures, an alert is surfaced. The count resets on successful merge.
7. **merged**: Transient post-merge beat — code just landed on the base branch. Renders neutral (not green) in the status pane; not an operator-actionable signal. Cleared the moment the auto-continue prompt's `UserPromptSubmit` fires, returning the worker to `working` for the next phase. If `claudeStatus` is `working` at the moment `finalizeMerge` runs (a prompt landed mid-merge race), the poller clears `merged` immediately to `working`.
8. **done**: Worker self-declared finished via the `.garden-done` sentinel and the merge cycle has settled. Renders bold green ✓ in the status pane — the operator's "this work is complete, the worker can be cleaned up" signal. Two paths in: `finalizeMerge` sets `done` directly when the sentinel was set before the final push (skipping the transient `merged` beat); the Stop hook sets `done` when the worker writes the sentinel after auto-continue and ends with no commits ahead. Cleared on `UserPromptSubmit` (operator nudges the worker back to work).

### Project Configuration
Projects can define settings in `~/.garden/config.yml`, either by editing the file directly or via `garden config <project> <key> <value>`:

```yaml
projects:
  garden:
    path: /Users/joshua/code/keychange/garden
    checks: npx tsc --noEmit && npx vitest run
    postMerge: npm install && npm run build
```

**Base branch**: Workers branch from and merge into the current branch of the main checkout at creation time. Resolution falls through to `origin/HEAD` symref, then `"main"`, when the checkout has no useful HEAD (e.g., detached). There is no config override — if you need a different base, switch the main checkout before creating the worker.

The resolved value is validated against the local `refs/remotes/origin/<base>` ref (no network call, so the ⌥n hotkey stays snappy on slow links) and pinned to the worker in the registry (`WorkerEntry.baseBranch`). A worker targeting a branch with no local origin ref is rejected at creation with a clear error, because every `origin/<base>..HEAD` check in the Stop hook and poller would fail silently and the review cycle would never start. The bootstrap script's fresh `git fetch origin <base>` is the backstop: if the branch has since been deleted from origin, the fetch fails and a `bootstrap` alert fires. Once pinned, all consumers (poller, Stop hook, kick, resume) use `getWorkerBaseBranch(entry, ...)` — they never re-resolve from the main checkout, so switching the main checkout's branch after a worker is spawned does not retarget that worker.

If the Stop hook still fails to count commits ahead of `origin/<pinned-base>` (e.g., the base branch was deleted from origin after creation), it raises a one-per-hour `base-drift` alert (`source: worker`, `level: warn`) rather than silently swallowing the error.

**checks**: Command the reviewer runs in the worker's worktree after rebasing onto the base branch, so checks validate the combined state of the branch plus latest base. If checks fail, the reviewer fixes the issues and re-runs. No checks configured means the reviewer only does the code review.

**postMerge**: Command that runs on the main checkout after merging, but only when the local checkout successfully fast-forwards to the newly merged code. If the fast-forward fails (dirty working tree, checkout on wrong branch), postMerge is skipped and an alert is raised so the operator can clean the checkout. An alert also fires when the fast-forward fails even without a postMerge configured — stale main rots manual operator workflow and must be surfaced either way. This is essential for projects like garden itself, where the poller runs the compiled CLI. When the garden project itself rebuilds successfully, the poller spawns a detached `_post-rebuild-refresh` via the freshly-built binary; it respawns the status and logs panes, calls `restartLongLivedPollers()` so the usage-poller and per-project pollers reload the new bundle (they cache JS in memory at spawn time), and refreshes the dashboard.

**sandboxDomains**: Comma-separated list of extra network domains added to each worker/reviewer's sandbox allowlist. Use for private registries, internal services, or other hosts beyond the garden-wide defaults (Anthropic, GitHub, npm, the project's git remote host). Set via `garden config <project> sandboxDomains foo.com,bar.com`.

**claudeProfile**: Name of an alternate Claude Code config dir to use for this project's workers and reviewers. Profiles are registered globally under `claudeProfiles:` in `~/.garden/config.yml` (each entry has a `configDir` and optional display `label`). When set, every `claude` invocation for the project — workers, reviewers, resolvers, the prefix-`C` ad-hoc launcher — runs with `CLAUDE_CONFIG_DIR=<configDir>`, so Claude reads its credentials, settings, and history from that dir instead of `~/.claude`. Projects without `claudeProfile` use the personal default. Manage profiles with `garden claude-profile {list,add,remove,login}`. The usage meter is not split per profile: `/api/oauth/usage` aggregates by user identity, so two workspace tokens tied to one email return identical data. Per-workspace quota for the alternate plan, if any, is only visible from the org owner's admin dashboard.

### Merge Handling
After a review passes, workers enter the `merge-pending` state. The merge queue processes one worker at a time per project (ordered by `mergePendingAt` timestamp):

1. Fetch latest base branch
2. Clear any leftover rebase state from a prior crashed resolver (`ensureNoRebaseInProgress`)
3. Rebase onto current base branch
4. If rebase conflicts: abort rebase, launch a dedicated resolver in the worktree and transition to `resolving`. The resolver completes the rebase and commits the resolution; the poller verifies and pushes. Budget is 2 attempts per merge; exhaustion transitions to `failing` with an operator alert naming the unmerged files.
5. If rebase is clean: force-push the rebased branch, fast-forward the remote base branch via direct refspec push (no local checkout needed)
6. Notify live sibling workers with overlapping files (see below)
7. Fast-forward the local base branch checkout; run postMerge command (if configured) only when the checkout actually advanced. If the fast-forward fails (dirty working tree, divergent branch), postMerge is skipped and an alert is raised — always, regardless of whether postMerge was configured, because a stuck main checkout silently drifts out of sync with the remote
8. Mark the worker as `merged` (or `done` if `.garden-done` is present at the worktree) in the registry

The worker and its worktree are not automatically cleaned up on merge. Cleanup happens only when the user kills the worker with `opt-x` or runs `garden reset`. This allows inspecting merged work before disposal.

Projects don't block each other — each project has its own poller and merge queue.

### Auto-Continue Across the Merge Boundary
Multi-phase work (build → review → merge → keep building) used to require the operator to type "please proceed" after every merge. Garden eliminates that step: `finalizeMerge` ends with a call to `maybeAutoContinue`, which dispatches a delayed `_continue-worker-after-merge` subprocess that sends a "previous changes were merged, continue with the next phase" prompt to the worker pane.

The worker opts out by writing the sentinel file `<worktree>/.garden-done` before ending its turn. The worktree system prompt instructs every worker to write this file once the operator's full request is complete; if the file is missing on merge, garden assumes there is more to do. False positives are cheap (the worker says "nothing left" and ends the turn); false negatives — the historical state — are exactly what this removes.

Workers are nudged to invoke the sentinel-write via the `done` skill installed under `<worktree>/.claude/skills/done/SKILL.md` (see `src/dashboard/skills.ts`). Claude Code requires the directory + `SKILL.md` layout for project-skill discovery — a flat `done.md` at `.claude/skills/` is silently invisible to the planner. Skill descriptions act as Claude's trigger condition during planning — Claude evaluates "should I invoke this?" alongside its other tools when deciding the next action — which is more reliable than instructions buried in the system prompt. The skill body (when, when-not, mechanics, recovery) lives only in the skill file, not the main worktree-rules block, so the prompt stays scannable. The bootstrap script inlines the skill content at worker creation; `installClaudeHooks` rewrites it on every refresh/bounce so workers from rebuilds pick up content changes. Older workers created before the skill existed do not get it retroactively without a refresh — bouncing or recreating them is the only way to install it.

A second skill, `handoff`, lives alongside `done` and lets the operator pass a task to a fresh worker on another (or the same) project. Triggered when the operator instructs the worker to hand off; the skill body teaches the heredoc recipe `garden handoff <project> <<'EOF' ... EOF`. The CLI command writes the briefing to `~/.garden/sessions/seeds/seed-*.txt` and calls `newWorker({ projectName, seedMessageFile })` — a normal named worker is created and participates in the standard review/merge/poller flow. The new worker's pane swaps into view via the same park/restore path as a ⌥n hotkey, so the operator's view follows the handoff; for cross-project handoff the dashboard's active project (and active plot, if the target is outside the current plot) is updated first so ⌥1-9 navigation stays in sync with the visible pane. A delayed `_seed-worker` subprocess polls until the worker's `claudeStatus` leaves `loading` and then sends the seed prompt prefixed with `[handoff from <source-project>/<source-worker>]`. The source worker writes `.garden-done` itself (per the skill recipe) rather than having the CLI command do it implicitly, mirroring the `done` skill's recipe-style instructions and leaving room for a final commit before handoff. The source pane is parked at the moment of handoff, but its Claude process is still alive long enough to receive the CLI's stdout, write the sentinel, and end the turn cleanly — pane parking is purely a tmux-level swap, not a process kill.

The sentinel lives at the worktree root because that is the only path satisfying all three constraints: (1) writable by Claude Code's harness sandbox, which blocks raw `/tmp` writes — only `$TMPDIR` works there; (2) writable by the OS-level Seatbelt sandbox (`src/dashboard/sandbox.ts` `DEFAULT_ALLOW_WRITE`), which permits the worktree, `~/.npm`, `~/.cache`, and `/tmp`; (3) reconstructible by the poller from the registry entry's `worktreePath`. `$TMPDIR` falls out on (3) because it is per-Claude-session. `~/.garden/sessions` falls out on (2). The worktree is the intersection. As a side effect, `killPane` no longer needs explicit sentinel cleanup — `git worktree remove --force` in `backgroundGitCleanup` removes the file along with the worktree. Workers are instructed not to commit the file (it is per-worker state, not project state).

Skip conditions (logged at `debug`):
- The `.garden-done` sentinel exists for this worker.
- `claudeStatus` is `working` or `asking` — the operator is already typing, same guard the interrupt-recovery path uses.
- `lastAutoContinueAt` is within the last 10 seconds (idempotency guard against any merge-event replay).

A successful dispatch logs at `info` (`auto-continued worker after merge`) so the operator sees the lifecycle transition in `⌥l` logs alongside the `merged` line. The 5s subprocess delay (longer than the 3s interrupt-recovery delay) lets postMerge and the reviewer's force-push settle before keys land in the pane.

`garden pause <worker>` writes the sentinel; `garden resume <worker>` deletes it. Killing a worker (`opt-x`) removes the worktree entirely, so the sentinel goes with it.

A second, *global* opt-out lives alongside the per-worker sentinel: a gate in `~/.garden/config.yml` under `autoContinue` (`enabled`, `usageThreshold`, `resumeAfterReset`). Defaults are enabled, 95% threshold, no auto-resume. The gate is consulted on every `maybeAutoContinue` after the per-worker checks. The threshold check evaluates the `5h` and `weekly` meters from the latest usage snapshot; sonnet is intentionally excluded since the workhorse is Opus. When any included meter is at or above `usageThreshold`, the gate flips `enabled=false`, persists `pausedUntil` (the latest `resetsAt` among tripped meters, so re-enabling does not immediately re-trip on the slower-resetting meter) and `pausedReason`, and fires a warn-level alert (source `usage`). With `resumeAfterReset: true`, the next call past `pausedUntil` flips `enabled` back on automatically; with it off (the default), the operator must run `garden auto on`. Manage with `garden auto [on|off|status|threshold <N>|resume-on-reset on|off]` (alias `auto-continue`).

### Sibling Merge Notification
When code merges, the poller compares the changed files against every other active worker's branch in the same project. If files overlap and the sibling has a live Claude session, it is notified via `tmux send-keys` with the merged worker's commit summary and overlapping file list so it can review and avoid reverting the merged work. Dead workers are skipped — they will hit rebase conflicts naturally on their next review cycle.

### Claude Usage Meter
Three quota bars render in the top-left "garden" title pane sitting above the status pane: the 5-hour rolling window, the weekly total, and the Sonnet-specific weekly meter (shown as `—` on plans that don't track it separately). Bars are colored by utilization — green <60%, yellow <85%, red at or above — with a bright `│` marker overlaid at the current time position in the window (so you can see whether usage is ahead of or behind the clock) and the reset countdown next to each. The third bar is Sonnet rather than Opus because on Max plans the API returns `seven_day_opus: null` (Opus usage is rolled into the weekly total) while `seven_day_sonnet` is the populated model-specific bucket.

Data comes from `GET https://api.anthropic.com/api/oauth/usage`, authenticated with the OAuth token Claude Code already writes to the macOS Keychain under service `Claude Code-credentials`. The endpoint is undocumented and strictly rate-limited (observed `Retry-After` of ~50 minutes after three rapid probes), so the fetch cadence is deliberately conservative. Credential discovery probes the `GARDEN_CLAUDE_SESSION_KEY` env var first, then the macOS Keychain, then `~/.claude/.credentials.json`. On any failure the snapshot records a short error and the pane renders a single dim "claude usage: …" line instead of bars — the meter is a progressive enhancement, not a dependency. Fetched snapshots live in `~/.garden/sessions/claude-usage.json`.

Refresh is event-driven first, timer-driven as a fallback. A singleton poller (`_garden-usage-poller`) refreshes every 5 minutes (honoring `Retry-After` on 429), which keeps idle dashboards current. On top of that, every Claude Code `Stop` hook calls `maybeRefreshUsage()` — a fire-and-forget detached fetch gated by a 60-second cooldown, so the meter updates shortly after each end-of-turn (when quota has just advanced) without hammering the rate-limited endpoint. The Retry-After window is also honored by the hook path: if the server is actively throttling, hook calls short-circuit until the window expires.

### Alerts
The dashboard surfaces important events as alerts — persistent messages that require operator attention. Alerts are stored atomically in `~/.garden/sessions/dashboard.alerts.json` (same write-tmp-then-rename pattern as other state files), capped at 100 entries.

**Events that generate alerts:**
- Worker bootstrap could not fast-forward main checkout (stale main, dirty worktree)
- Review process failure (Claude unavailable, timeout, unparseable output)
- Reviewer or resolver exceeded the 30-minute wall-clock cap and was killed (typically a hung subprocess — e.g. tests with no timeout blocked by the sandbox — wedging the state machine)
- Reviewer could not fix issues (FAILED verdict)
- Merge failure
- Local checkout did not fast-forward after merge (regardless of postMerge config)
- Repeated failures (3+ consecutive failures on the same worker)
- Base-branch drift after worker creation (Stop hook cannot count commits against `origin/<pinned-base>`; deduped to one firing per worker per hour)
- Auto-continue auto-disabled by usage threshold (source: `usage`, level: `warn`)

Worker "needs operator input" events (AskUserQuestion, ExitPlanMode, auto-mode permission prompts) do **not** fire alerts — they flip the worker to `asking` (yellow row in the status pane), which is the visual signal. The alert channel is reserved for failures and errors.

**Visibility:**
- Bottom bar shows a red `⚠ N alerts — ⌥l to clear` badge on the right when unread alerts exist. The badge appears instantly on `addAlert()` via `tmux set-option @garden_right` + `refresh-client -S`.
- Every alert is also streamed to `dashboard.log` at its declared level (`warn` or `error`), so it appears live in the `garden logs --follow` pane (the `_garden-logs` window) with the `[!]` prefix.
- Pressing `⌥l` focuses the logs view **and** acknowledges all current alerts, clearing the badge. Acknowledgement is explicit — an alert that fires while the logs pane is already focused still lights the badge, so autonomous failures aren't silently missed when the user is away.
- `garden alerts` lists full history (read and unread); `garden alerts clear` wipes the store.

### Worker Isolation Model
- Every worker operates in its own git worktree — no shared working directory
- The project shell (`⌥s`) stays on the main checkout for manual work
- Branch name equals the worker name (e.g., `swift-oak`)
- Worktrees persist until the worker is killed, enabling the review cycle and manual inspection
- Each worktree's `.claude/settings.json` configures Claude's OS-level sandbox (Seatbelt on macOS, bubblewrap on Linux) — auto-allow mode approves sandboxed bash without prompts while blocking out-of-allowlist filesystem writes and network calls at the kernel. Workers and reviewers run without `--dangerously-skip-permissions` but remain autonomous inside the sandbox. Allowlist defaults (Anthropic, GitHub, npm, the project's git remote host, plus worktree + standard subprocess caches) are built in `src/dashboard/sandbox.ts` and extended per-project via the `sandboxDomains` config key. The config lives in `settings.json` (not `settings.local.json`) because Claude Code writes permission approvals to `settings.local.json` and can clobber our keys; keeping hooks/sandbox in `settings.json` isolates them from that churn.
- The same `settings.json` sets `permissions.defaultMode: "auto"`, so every Claude process in the worktree (worker, reviewer, resolver, resume) starts in Anthropic's built-in auto mode. The classifier auto-approves low-risk tool calls and only prompts the operator for the rest. `permissions.allow` also pre-approves `Bash(tmux:*)` plus read-only tail utilities (`echo`, `head`, `tail`, `cat`, `grep`, `wc`) since workers routinely query pane/window state and pipe or chain the output — Claude Code checks each subcommand of a compound bash call against the allow list independently, so without the tails a command like `tmux list-keys -T root | head -40` still escalates. Garden wires a `PermissionRequest` hook (no matcher — all tools) that fires **only** when a prompt is actually being shown; it flips `claudeStatus` to `asking`, which renders the worker row bold-yellow in the status pane. A catch-all `PostToolUse` hook (no matcher — all tools) flips `asking` back to `working` once the operator approves, regardless of which tool the classifier escalated

## Worker Status Detection

Each worker has two independent status axes:

**Process status** — what Claude is doing, written by Claude Code hooks:
- ⏳ **loading** — worker pane started, bootstrap script running, Claude not yet launched
- ◇ **ready** — Claude launched but not yet tasked
- ⠋ **working** — Claude is processing a submitted prompt (braille spinner animation)
- ⚑ **asking** — Claude is blocked mid-turn on operator input (plan approval, question, permission escalation); row is highlighted bold-yellow in the status pane
- ◆ **idle** — turn has ended, Claude is at the prompt waiting for the next message
- ○ **exited** — process has terminated

**Lifecycle status** — where the worker's code is in the review pipeline, written by the poller:
- ◎ **reviewing** — automated reviewer is checking the worker's commits
- ◷ **merge-pending** — review passed, in the merge queue
- ◔ **resolving** — automated resolver is fixing a merge-queue rebase conflict
- ✖ **failing** — review failed, waiting for worker to fix; row is highlighted bold-red in the status pane
- ✓ **merged** — transient post-merge beat; row is uncolored (not actionable; cleared by the next auto-continue prompt)
- ✓ **done** — worker self-declared finished via `.garden-done`; row is highlighted bold-green in the status pane (operator cleanup signal)

The display combines both axes: lifecycle state takes priority when present, otherwise the process state is shown. A worker that is "reviewing" shows the reviewing bullseye regardless of what Claude is doing. Only workers in the "working" display state get the animated braille spinner.

The full specification for status tracking and display lives in `src/dashboard/STATUS.md`. The registry is the single source of truth: Claude Code hooks (`SessionStart`, `UserPromptSubmit`, `Stop`) write `claudeStatus`; the poller writes `prState`; the tmux `pane-died` hook writes `claudeStatus="exited"`. There is no pgrep, no marker file, no fallback poll. Every transition is event-triggered.

## Commands

### Projects
```
garden init                        # Initialize ~/.garden, check for tmux
garden add [path]                  # Add a project (defaults to cwd, name = basename)
garden create <path>               # Scaffold a new project: mkdir, git init -b main, private GitHub repo under the gh-authed account, add to active plot
garden remove <name>               # Remove a project
garden list                        # List all projects
garden config <project> [key] [val]  # View or set project config
garden plot [name]                 # List plots (no arg) or activate a plot
garden plot create <name> [proj...]# Create a plot (auto-activates if none active)
garden plot add <plot> <project>   # Add a project to a plot (append)
garden plot remove <plot> <project># Remove a project from a plot
garden plot reorder <plot> <proj> <N> # Move project within a plot
garden focus <plot>                # Include plot in the ⌥p cycle
garden unfocus <plot>              # Exclude plot from the ⌥p cycle
garden reorder <plot> <position>   # Move plot within the ⌥p cycle
garden claude-profile [list|add|remove|login]
                                   # Manage alternate Claude config dirs (per-project plan)
garden login [profile]             # Re-authenticate Claude (personal, or a profile)
garden auth status                 # Show credential presence, expiry, and displacement
garden usage [refresh]             # Show or force-refresh the Claude usage meter
```

### Dashboard
```
garden dashboard                   # Open the dashboard (creates if needed)
garden dashboard exit              # Close the dashboard
garden keys                        # Show dashboard keybindings
garden status                      # Show all projects and their workers
garden whoami [worker]             # Show the current worker's registry entry (uses $GARDEN_WORKER)
garden alerts                      # View dashboard alerts
garden alerts clear                # Dismiss all alerts
garden logs [options]              # View dashboard logs (pretty-printed)
garden kick <worker>               # Re-arm a stranded 'working' worker for review
garden bounce <worker>             # Restart a worker's Claude process (preserves session history)
garden pause <worker>              # Suppress post-merge auto-continue (writes the .garden-done sentinel)
garden resume <worker>             # Re-arm post-merge auto-continue (clears the .garden-done sentinel)
garden handoff <project> [-m ...]  # Spawn a fresh worker on <project> seeded with a briefing (stdin or -m)
garden auto [on|off|status]        # Toggle the global auto-continue gate
garden auto threshold <N>          # Set the usage-threshold percent (auto-disable above this)
garden auto resume-on-reset on|off # Re-enable automatically after the usage window resets
garden rebuild                     # Rebuild garden and relaunch dashboard
```

Project name is auto-detected from cwd when inside a project directory. `GARDEN_PROJECT` env var overrides. Worker panes also export `GARDEN_WORKER`, `GARDEN_BRANCH`, and `GARDEN_BASE_BRANCH` so workers can self-identify via `garden whoami` and filter their own log history with `garden logs -w $GARDEN_WORKER`.

## Output Format

All read commands detect whether stdout is a TTY:
- **TTY:** pretty-printed for humans
- **Non-TTY:** JSON, one object per line

## File Layout

```
~/.garden/
  config.yml              # Project registry
  sessions/
    dashboard.state.json  # Dashboard pane state
    dashboard.registry.json  # Worker registry (persists across restarts)
    dashboard.alerts.json # Operator alerts (review failures, merge errors)
    dashboard-<project>.context  # System prompt for project's Claude sessions
    dashboard-<project>-<branch>.context  # Worktree worker context
    dashboard.log           # Structured JSON log
    <project>-poll-signal   # FIFO for waking project pollers
    growhouse-init.zsh            # Garden growhouse init (custom prompt + auto-dispatch)
    bootstrap-<project>-<branch>.sh       # Transient worktree bootstrap script
    <project>-<worker>-review-prompt.txt  # Transient review prompt
    <project>-<worker>-review-result.txt  # Transient review output
    status.rendered           # Pre-rendered status snapshot for instant display
    usage.rendered            # Pre-rendered usage meter snapshot for the usage pane
    claude-usage.json         # Claude quota snapshot (5h / weekly / sonnet)
  worktrees/
    <project>/
      <worker-name>/      # Git worktree for each worker

<project-root>/
  .garden/
    rules.md              # Project-specific rules (optional)

<garden-repo>/
  rules.md                # Global rules (version-controlled)
```

## Technology

- TypeScript, compiled via esbuild to a single `dist/cli.js`
- tmux for session persistence and pane management
- `js-yaml` for config parsing
- No CLI framework — lightweight `process.argv` dispatch with aliases

## Principles

1. **Human-first.** The dashboard is for a human operator. Everything is driven by keyboard shortcuts and CLI commands.
2. **Files over databases.** YAML, JSON. All human-inspectable.
3. **Shell out, don't abstract.** Call `claude` directly. Don't wrap the API.
4. **Hotkeys over commands.** Inside the dashboard, keyboard shortcuts are the primary interface. CLI commands are for setup and scripting.
5. **Grow by adding, not changing.** New commands, new pane types, new hotkeys — avoid breaking what works.

## Example Workflow

```bash
# One-time setup
garden init
cd ~/code/keychange/website && garden add
cd ~/code/keychange/api && garden add
cd ~/code/keychange/garden && garden add

# Launch
garden dashboard

# Inside the dashboard:
#   ⌥1        → switch to website (starts on project shell)
#   ⌥n        → start a worker (Claude session)
#   ⌥2        → switch to api (website worker keeps running)
#   ⌥n        → start a worker for api
#   ⌥n        → start a second worker for api
#   ⌥[/⌥]    → cycle between api's workers and shell
#   ⌥s        → jump to project shell for running tests
#   ⌥w        → jump back to first worker
#   ⌥1        → switch back to website (api workers keep running)
#   ⌥x        → kill website's worker when done
```

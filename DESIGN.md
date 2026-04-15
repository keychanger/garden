# Garden

A minimal CLI orchestrator for managing Claude Code sessions across multiple projects.

Garden is a personal tool — opinionated toward a single developer managing many projects from one place. It is not a team tool, not a CI system, and not a framework. It's a thin, extensible layer over Claude Code.

## Core Concepts

### Project
A named reference to a directory on disk where Claude Code can operate. Projects are added with `garden add [path]` (name is derived from the directory basename).

### Dashboard
A tmux session (`garden-dashboard`) that serves as the primary interface. The dashboard is a left/right split: project status and garden pane on the left, an active pane (worker or shell) on the right with a header bar. The garden pane (lower-left) cycles between three views: the garden view (`⌥g`) with a bold green `garden>` prompt and auto-dispatch for garden commands, the root shell (`⌥r`) for general-purpose terminal use, and a logs view (`⌥l`). The same swap-pane mechanism as the right pane is used. You never interact with tmux directly — garden sets up the layout, keybindings, and pane management.

### Workers
Interactive Claude Code sessions running inside the dashboard. Each project can have multiple workers (e.g., one for a feature, one for a review). Workers persist when you switch between projects — they're parked in hidden tmux windows and swapped back in when you return.

### Rules System
Claude sessions are configured with layered rules files injected via `--append-system-prompt-file`:

1. **Global rules** (`~/.garden/rules.md`) — methodology, testing, git workflow
2. **Project rules** (`<project>/.garden/rules.md`) — project-specific conventions

Rules are plain markdown. Edit them directly.

## Dashboard Layout

```
┌─────────────────────┬─────────────────────────────┐
│  Usage Meters       │                             │
│  (fixed 4 rows)     │                             │
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
│  Garden Shell       │                             │
│  (garden commands)  │                             │
│                     │                             │
├─────────────────────┴─────────────────────────────┤
│ garden  main                       garden a1b2c3d│
└───────────────────────────────────────────────────┘
```

### Panes

- **Usage Meters** (top-left) — Dedicated pane (fixed 4 rows) showing three Claude quota bars: the 5-hour rolling window, the weekly total, and the Sonnet-specific weekly meter. Refreshed via SIGUSR1 from a pre-baked `usage.rendered` file.
- **Project Status** (mid-left) — Live-updating display of all projects and their workers. Shows which project is active (`◄`), each worker's lifecycle state via status icons (braille spinner for working, Unicode symbols for other states), a focus indicator (filled/empty circle) showing which worker is active, and aligned columns for name/status/activity. Auto-sizes to the number of projects.
- **Garden Pane** (lower-left) — Cycles between three views: garden (bold green `garden>` prompt with auto-dispatch for garden commands), root (general-purpose shell), and logs. `⌥g` jumps to garden, `⌥r` jumps to root, `⌥l` jumps to logs.
- **Bottom bar** (tmux status line) — Two-sided display. Left side shows the active project name (bold) and its current git branch. Right side shows the garden build version (git short SHA, or "dev" when running via tsx); when unread alerts exist it is prefixed with a red `⚠ N alerts — ⌥l to clear` badge.
- **Active Pane** (right) — The currently visible pane for the active project. Either a worker (Claude session) or the project shell. Only one is visible at a time; others are parked in hidden tmux windows.

### Right-side pane model

Each project has:
- **One shell** (always exists, created on first project switch, protected from kill)
- **Zero or more workers** (spawned on demand with `⌥n`)

Only one pane is visible at a time. `⌥]`/`⌥[` cycles through all of them. `⌥w` jumps to the first worker, `⌥s` jumps to the shell.

## Hotkeys

All hotkeys use Alt/Option with no prefix — single keypress, instant.

Requires terminal setup: iTerm2 → Profiles → Keys → Left Option key → "Esc+" (sends Meta).

| Key | Action |
|-----|--------|
| `⌥1` – `⌥9` | Switch to project by registration order |
| `⌥n` | New worker (Claude session) |
| `⌥w` | Jump to first worker |
| `⌥s` | Jump to project shell |
| `⌥]` / `⌥[` | Cycle workers and shell |
| `⌥x` | Kill current worker (shell is protected) |
| `⌥g` | Focus garden view (lower-left) |
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
Hidden windows follow the convention: `_<project>-worker-<N>`, `_<project>-shell`, `_<project>-poller`, `_<project>-review-<worker>`, `_garden-garden`, `_garden-root`, `_garden-logs`, and `_garden-usage-poller`. When switching projects, the visible pane is parked as `_<project>-active`. The underscore prefix marks them as managed by garden — not user-facing.

### Worker Lifecycle
1. `⌥n` creates a git worktree at `~/.garden/worktrees/<project>/<worker-name>/`, with a branch named after the worker that points at `origin/<base>` directly. Worker freshness does not depend on the main checkout being clean or fast-forwarded — a stale main checkout raises an alert but does not infect the worker
2. Claude launches in the worktree with project rules and worktree workflow instructions
3. The worker is interactive — you work with it directly
4. `⌥]`/`⌥[` cycles between workers and shell
5. `⌥x` kills the focused worker, removes its worktree and branch. If the worktree has uncommitted changes, the first `⌥x` shows a warning and a second `⌥x` within 5 seconds confirms the kill — guarding against silently losing work that the poller never saw because it was never committed
6. Switching projects parks everything in hidden windows; switching back restores

### Poller and Auto-Merge
Each project gets its own background poller (`_<project>-poller`) running in a hidden tmux window. Pollers are independent — one project's reviews never block another. Each poller watches its project's worker branches for new commits and drives the review/merge lifecycle using local git operations (no GitHub PRs). Pollers start when a project's first worker is created and stop when the last worker is killed.

**State machine per worker:**
```
working -> reviewing -> merge-pending -> merged
               |              |
               v              v
           failing        resolving (auto-resolver on rebase conflict)
                              |
                              +-> merge-pending (verified) or failing (budget exhausted)
```

1. **working**: Worker is active. When the worker's Claude Code Stop hook fires and the worktree has commits ahead of base, the hook marks the worker for review (`pendingReviewAt`) and pokes the poller, which transitions to reviewing. Multiple workers per project can transition independently.
2. **reviewing**: Poller launches a Claude reviewer (`claude -p`) asynchronously in a hidden tmux window (`_<project>-review-<worker>`). The reviewer runs inside the worker's worktree, so it inherits the worktree's `.claude/settings.local.json` sandbox config (auto-allow for bash within the configured filesystem/network allowlist). The reviewer rebases onto the base branch, resolves conflicts, runs optional checks, fixes check failures, and reviews code against project rules. The poller polls for review completion by checking if the review window still exists. On completion: if clean or fixed, force-pushes and transitions to merge-pending. If the reviewer cannot fix the issues, transitions to failing. If the review process fails (Claude unavailable, timeout, unparseable output), transitions to failing. Unreviewed code is never auto-merged.
4. **merge-pending**: Review passed, waiting to merge. A serial merge queue processes one merge at a time per project (ordered by timestamp). The merge sequence: rebase onto current base branch, force-push, then ff-merge. If the rebase has conflicts (because the base branch advanced while waiting), the poller launches a dedicated resolver and transitions to `resolving`. If the rebase is clean, the merge proceeds.
5. **resolving**: A dedicated resolver Claude session is running in a hidden tmux window with a single narrow job: complete `git rebase origin/<base>` and commit any conflict resolutions. The resolver does not push and does not re-review code — the code was already approved. On Stop, the poller verifies the rebase actually landed (no `.git/rebase-merge` or `.git/rebase-apply` present; `origin/<base>` is an ancestor of HEAD; HEAD differs from `preResolveSha`). On pass, force-pushes and returns to `merge-pending`. On fail, retries up to `resolveAttempts = 2`; on budget exhaustion, transitions to `failing` with an operator alert that names the unmerged files. Any worker push during `resolving` aborts and resets budget — the worker's new state is the new ground truth.
6. **failing**: Unfixable review issues, failed review process, or exhausted resolver budget. Poller watches for new commits via SHA tracking. After 30s debounce with no new pushes, state transitions back to working for retry. Each failure increments a `failCount` on the worker entry; after 3 consecutive failures, an alert is surfaced. The count resets on successful merge.
7. **merged**: Code merged to the base branch. This is a sticky state — it persists even if Claude is actively responding to questions, since conversational activity alone doesn't indicate a new work cycle. Only transitions back to working when new commits appear on the branch, starting a new review cycle.

### Project Configuration
Projects can define settings in `~/.garden/config.yml`, either by editing the file directly or via `garden config <project> <key> <value>`:

```yaml
projects:
  garden:
    path: /Users/joshua/code/keychange/garden
    baseBranch: main
    checks: npx tsc --noEmit && npx vitest run
    postMerge: npm install && npm run build
```

**baseBranch**: The branch that workers branch from and merge into. Resolution order: explicit config > current branch of main checkout > `origin/HEAD` symref > `"main"` as last resort. Most repos work without setting this.

**checks**: Command the reviewer runs in the worker's worktree after rebasing onto the base branch, so checks validate the combined state of the branch plus latest base. If checks fail, the reviewer fixes the issues and re-runs. No checks configured means the reviewer only does the code review.

**postMerge**: Command that runs on the main checkout after merging, but only when the local checkout successfully fast-forwards to the newly merged code. If the fast-forward fails (dirty working tree, checkout on wrong branch), postMerge is skipped and an alert is raised so the operator can clean the checkout. An alert also fires when the fast-forward fails even without a postMerge configured — stale main rots manual operator workflow and must be surfaced either way. This is essential for projects like garden itself, where the poller runs the compiled CLI. Without a post-merge rebuild, the poller continues executing stale code even after merging fixes.

**focused**: Controls whether the project appears in the dashboard status display and gets a hotkey assignment. Default is focused (field absent = focused). Set to `false` to hide a project from the dashboard without losing its config. Workers and pollers for unfocused projects continue running. Managed via `garden focus`/`garden unfocus` or `garden config <project> focused false`.

**sandboxDomains**: Comma-separated list of extra network domains added to each worker/reviewer's sandbox allowlist. Use for private registries, internal services, or other hosts beyond the garden-wide defaults (Anthropic, GitHub, npm, the project's git remote host). Set via `garden config <project> sandboxDomains foo.com,bar.com`.

**claudeProfile**: Name of an alternate Claude Code config dir to use for this project's workers and reviewers. Profiles are registered globally under `claudeProfiles:` in `~/.garden/config.yml` (each entry has a `configDir` and optional display `label`). When set, every `claude` invocation for the project — workers, reviewers, resolvers, the prefix-`C` ad-hoc launcher — runs with `CLAUDE_CONFIG_DIR=<configDir>`, so Claude reads its credentials, settings, and history from that dir instead of `~/.claude`. Projects without `claudeProfile` use the personal default. Manage profiles with `garden claude-profile {list,add,remove,login}`. The dashboard usage meter renders one extra bar per registered profile, labeled with the profile's name and showing the most-utilized populated bucket (5h / weekly / sonnet) in the response.

### Merge Handling
After a review passes, workers enter the `merge-pending` state. The merge queue processes one worker at a time per project (ordered by `mergePendingAt` timestamp):

1. Fetch latest base branch
2. Clear any leftover rebase state from a prior crashed resolver (`ensureNoRebaseInProgress`)
3. Rebase onto current base branch
4. If rebase conflicts: abort rebase, launch a dedicated resolver in the worktree and transition to `resolving`. The resolver completes the rebase and commits the resolution; the poller verifies and pushes. Budget is 2 attempts per merge; exhaustion transitions to `failing` with an operator alert naming the unmerged files.
5. If rebase is clean: force-push the rebased branch, fast-forward the remote base branch via direct refspec push (no local checkout needed)
6. Notify live sibling workers with overlapping files (see below)
7. Fast-forward the local base branch checkout; run postMerge command (if configured) only when the checkout actually advanced. If the fast-forward fails (dirty working tree, divergent branch), postMerge is skipped and an alert is raised — always, regardless of whether postMerge was configured, because a stuck main checkout silently drifts out of sync with the remote
8. Mark the worker as merged in the registry

The worker and its worktree are not automatically cleaned up on merge. Cleanup happens only when the user kills the worker with `opt-x` or runs `garden reset`. This allows inspecting merged work before disposal.

Projects don't block each other — each project has its own poller and merge queue.

### Sibling Merge Notification
When code merges, the poller compares the changed files against every other active worker's branch in the same project. If files overlap and the sibling has a live Claude session, it is notified via `tmux send-keys` with the merged worker's commit summary and overlapping file list so it can review and avoid reverting the merged work. Dead workers are skipped — they will hit rebase conflicts naturally on their next review cycle.

### Rules Evolution
Every reviewer catches the same class of issue eventually — stale tests after a refactor, missing error handling, overly broad scope — and today that signal is thrown away once the merge lands. The rules evolution loop closes that gap.

When the reviewer emits a FIXED or FAILED verdict, its prompt now requires a fenced `findings` JSON block listing each distinct issue it intervened on, tagged with a short kebab-case category (the *class* of issue) and a one-sentence summary. The poller parses that block in `handleReviewing` and appends each finding to `~/.garden/sessions/rules-findings.json` (atomic write, capped at 1000 entries, same conventions as `dashboard.alerts.json`).

A category becomes a *pending suggestion* once it has accumulated ≥3 findings across ≥2 distinct workers within the last 30 days. On the first crossing, a single alert is emitted via the normal `addAlert` path (source: `rules`, level: `warn`) — the nudge piggybacks on the existing alerts surface, so there's no new UI. Subsequent findings accumulate silently.

**Commands:**
- `garden rules` / `garden rules suggest` — list pending categories, counts, projects, example summaries
- `garden rules accept <category> [--rule "..."] [--global | --project <name>] [--confirm]` — synthesize a markdown rule block and, after confirmation, append it to the inferred `rules.md` (project if one project is affected, global if multiple)
- `garden rules dismiss <category>` — mark so the suggestion won't re-surface
- `garden rules findings [--project <name>]` — raw findings log

Every accepted suggestion permanently raises the review bar for every future worker across every project.

### Claude Usage Meter
Three quota bars render in a dedicated "usage" pane sitting above the status pane in the left column: the 5-hour rolling window, the weekly total, and the Sonnet-specific weekly meter (shown as `—` on plans that don't track it separately). Bars are colored by utilization — green <60%, yellow <85%, red at or above — with the reset countdown next to each. The third bar is Sonnet rather than Opus because on Max plans the API returns `seven_day_opus: null` (Opus usage is rolled into the weekly total) while `seven_day_sonnet` is the populated model-specific bucket.

Data comes from `GET https://api.anthropic.com/api/oauth/usage`, authenticated with the OAuth token Claude Code already writes to the macOS Keychain under service `Claude Code-credentials`. The endpoint is undocumented and strictly rate-limited (observed `Retry-After` of ~50 minutes after three rapid probes), so the fetch cadence is deliberately conservative. Credential discovery probes the `GARDEN_CLAUDE_SESSION_KEY` env var first, then the macOS Keychain, then `~/.claude/.credentials.json`. On any failure the snapshot records a short error and the usage pane renders a single dim "claude usage: …" line instead of bars — the meter is a progressive enhancement, not a dependency. Fetched snapshots live in `~/.garden/sessions/claude-usage.json`.

Refresh is event-driven first, timer-driven as a fallback. A singleton poller (`_garden-usage-poller`) refreshes every 5 minutes (honoring `Retry-After` on 429), which keeps idle dashboards current. On top of that, every Claude Code `Stop` hook calls `maybeRefreshUsage()` — a fire-and-forget detached fetch gated by a 60-second cooldown, so the meter updates shortly after each end-of-turn (when quota has just advanced) without hammering the rate-limited endpoint. The Retry-After window is also honored by the hook path: if the server is actively throttling, hook calls short-circuit until the window expires.

### Alerts
The dashboard surfaces important events as alerts — persistent messages that require operator attention. Alerts are stored atomically in `~/.garden/sessions/dashboard.alerts.json` (same write-tmp-then-rename pattern as other state files), capped at 100 entries.

**Events that generate alerts:**
- Worker bootstrap could not fast-forward main checkout (stale main, dirty worktree)
- Review process failure (Claude unavailable, timeout, unparseable output)
- Reviewer could not fix issues (FAILED verdict)
- Merge failure
- Local checkout did not fast-forward after merge (regardless of postMerge config)
- Repeated failures (3+ consecutive failures on the same worker)
- Rule suggestion ready (a category crossed the findings threshold)

**Visibility:**
- Bottom bar shows a red `⚠ N alerts — ⌥l to clear` badge on the right when unread alerts exist. The badge appears instantly on `addAlert()` via `tmux set-option @garden_right` + `refresh-client -S`.
- Every alert is also streamed to `dashboard.log` at `error` level, so it appears live in the `garden logs --follow` pane (the `_garden-logs` window) with the `[!]` prefix.
- Pressing `⌥l` focuses the logs view **and** acknowledges all current alerts, clearing the badge. Acknowledgement is explicit — an alert that fires while the logs pane is already focused still lights the badge, so autonomous failures aren't silently missed when the user is away.
- `garden alerts` lists full history (read and unread); `garden alerts clear` wipes the store.

### Worker Isolation Model
- Every worker operates in its own git worktree — no shared working directory
- The project shell (`⌥s`) stays on the main checkout for manual work
- Branch name equals the worker name (e.g., `swift-oak`)
- Worktrees persist until the worker is killed, enabling the review cycle and manual inspection
- Each worktree's `.claude/settings.local.json` configures Claude's OS-level sandbox (Seatbelt on macOS, bubblewrap on Linux). Auto-allow mode approves sandboxed bash without prompts while blocking out-of-allowlist filesystem writes and network calls at the kernel, and `permissions.defaultMode: "acceptEdits"` auto-approves file edits so workers proceed without stopping to ask. Workers and reviewers run without `--dangerously-skip-permissions` but remain autonomous inside the sandbox. Allowlist defaults (Anthropic, GitHub, npm, the project's git remote host, plus worktree + standard subprocess caches) are built in `src/dashboard/sandbox.ts` and extended per-project via the `sandboxDomains` config key

## Worker Status Detection

Each worker has two independent status axes:

**Process status** — what Claude is doing, written by Claude Code hooks:
- ⏳ **loading** — worker pane started, bootstrap script running, Claude not yet launched
- ◇ **ready** — Claude launched but not yet tasked
- ⠋ **working** — Claude is processing a submitted prompt (braille spinner animation)
- ◆ **idle** — Claude is at the prompt, waiting for input
- ○ **exited** — process has terminated

**Lifecycle status** — where the worker's code is in the review pipeline, written by the poller:
- ◎ **reviewing** — automated reviewer is checking the worker's commits
- ◷ **merge-pending** — review passed, in the merge queue
- ◔ **resolving** — automated resolver is fixing a merge-queue rebase conflict
- ✖ **failing** — review failed, waiting for worker to fix
- ✓ **merged** — code merged to base branch

The display combines both axes: lifecycle state takes priority when present, otherwise the process state is shown. A worker that is "reviewing" shows the reviewing bullseye regardless of what Claude is doing. Only workers in the "working" display state get the animated braille spinner.

The full specification for status tracking and display lives in `src/dashboard/STATUS.md`. The registry is the single source of truth: Claude Code hooks (`SessionStart`, `UserPromptSubmit`, `Stop`) write `claudeStatus`; the poller writes `prState`; the tmux `pane-died` hook writes `claudeStatus="exited"`. There is no pgrep, no marker file, no fallback poll. Every transition is event-triggered.

## Commands

### Projects
```
garden init                        # Initialize ~/.garden, check for tmux
garden add [path]                  # Add a project (defaults to cwd, name = basename)
garden remove <name>               # Remove a project
garden list                        # List all projects
garden config <project> [key] [val]  # View or set project config
garden focus <name>                # Show project in dashboard
garden unfocus <name>              # Hide project from dashboard
garden reorder <name> <position>   # Move project to position (1-based)
```

### Dashboard
```
garden dashboard                   # Open the dashboard (creates if needed)
garden dashboard exit              # Close the dashboard
garden keys                        # Show dashboard keybindings
garden status                      # Show all projects and their workers
garden alerts                      # View dashboard alerts
garden alerts clear                # Dismiss all alerts
garden rules                       # View pending rule suggestions from reviewer findings
garden rules accept <category>     # Append a synthesized rule to rules.md (use --confirm)
garden rules dismiss <category>    # Dismiss a rule suggestion
garden rules findings              # Raw reviewer-findings log
garden logs [options]              # View dashboard logs (pretty-printed)
garden kick <worker>               # Re-arm a stranded 'working' worker for review
garden rebuild                     # Rebuild garden and relaunch dashboard
```

Project name is auto-detected from cwd when inside a project directory. `GARDEN_PROJECT` env var overrides.

## Output Format

All read commands detect whether stdout is a TTY:
- **TTY:** pretty-printed for humans
- **Non-TTY:** JSON, one object per line

## File Layout

```
~/.garden/
  config.yml              # Project registry
  rules.md                # Global rules
  sessions/
    dashboard.state.json  # Dashboard pane state
    dashboard.registry.json  # Worker registry (persists across restarts)
    dashboard.alerts.json # Operator alerts (review failures, merge errors)
    rules-findings.json   # Reviewer findings tally + suggestion status
    dashboard-<project>.context  # System prompt for project's Claude sessions
    dashboard-<project>-<branch>.context  # Worktree worker context
    dashboard.kill-confirm.json  # Transient double-tap kill confirmation
    dashboard.log           # Structured JSON log
    <project>-poll-signal   # FIFO for waking project pollers
    console-init.zsh              # Garden console init (custom prompt + auto-dispatch)
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

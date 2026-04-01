# Garden

A minimal CLI orchestrator for managing Claude Code sessions across multiple projects.

Garden is a personal tool — opinionated toward a single developer managing many projects from one place. It is not a team tool, not a CI system, and not a framework. It's a thin, extensible layer over Claude Code.

## Core Concepts

### Project
A named reference to a directory on disk where Claude Code can operate. Projects are added with `garden add [path]` (name is derived from the directory basename).

### Dashboard
A tmux session (`garden-dashboard`) that serves as the primary interface. The dashboard is a left/right split: project status and garden pane on the left, an active pane (worker or shell) on the right with a header bar. The garden pane (lower-left) cycles between three views using `⌥[`/`⌥]` (when focused): the garden console (`⌥g`) with auto-dispatch for garden commands, a regular shell, and a logs view (`⌥l`). The same swap-pane mechanism as the right pane is used. You never interact with tmux directly — garden sets up the layout, keybindings, and pane management.

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
│  Project Status     │  Header                     │
│  (auto-sized)       │  garden · 1/2 worker (idle) │
│                     ├─────────────────────────────┤
│  garden ◄           │                             │
│  ● 🌱 worker-1 working│  Active Pane               │
│  ○ 🌿 worker-2 waiting│  (worker or shell)         │
│  api                │                             │
│    (no workers)     │                             │
├─────────────────────┤                             │
│                     │                             │
│  Garden Shell       │                             │
│  (garden commands)  │                             │
│                     │                             │
└─────────────────────┴─────────────────────────────┘
```

### Panes

- **Project Status** (upper-left) — Live-updating display of all projects and their workers. Shows which project is active (`◄`), each worker's lifecycle state via plant-themed icons, a focus indicator (filled/empty circle) showing which worker is active, and aligned columns for name/status/activity. Auto-sizes to the number of projects.
- **Garden Pane** (lower-left) — Cycles between three views: the garden console (bold green `garden>` prompt with auto-dispatch for garden commands), a regular shell, and a logs view. `⌥[`/`⌥]` cycle when focused; `⌥g` jumps to console, `⌥l` jumps to logs.
- **Header** (top-right, 1-2 lines) — Shows current project, active pane type, worker count, and hotkey hints. Auto-refreshes.
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
| `⌥]` / `⌥[` | Context-aware: cycle workers (right pane) or views (garden pane) |
| `⌥x` | Kill current worker (shell is protected) |
| `⌥g` | Focus garden console (lower-left) |
| `⌥l` | Focus logs view (lower-left) |

## Pane Management

### Swapping Mechanism
Each project's workers and shell live in hidden tmux windows when not active. When you switch projects:

1. A temporary hidden window is created, and the current active pane is swapped into it via `swap-pane`
2. The target project's pane is swapped from its hidden window into the right slot via `swap-pane`, then the hidden window is killed
3. The status pane and header update to reflect the new state

This preserves both the layout tree (the right pane slot is never destroyed) and all worker state across switches.

### Hidden Window Naming
Hidden windows follow the convention: `_<project>-worker-<N>`, `_<project>-shell`, `_<project>-poller`, `_<project>-review-<worker>`, `_garden-console`, `_garden-shell`, and `_garden-logs`. When switching projects, the visible pane is parked as `_<project>-active`. The underscore prefix marks them as managed by garden — not user-facing.

### Worker Lifecycle
1. `⌥n` creates a git worktree at `~/.garden/worktrees/<project>/<worker-name>/` and a branch named after the worker
2. Claude launches in the worktree with project rules and worktree workflow instructions
3. The worker is interactive — you work with it directly
4. `⌥]`/`⌥[` cycles between workers and shell
5. `⌥x` kills the focused worker, removes its worktree and branch
6. Switching projects parks everything in hidden windows; switching back restores

### Poller and Auto-Merge
Each project gets its own background poller (`_<project>-poller`) running in a hidden tmux window. Pollers are independent — one project's reviews never block another. Each poller watches its project's worker branches for new commits and drives the review/merge lifecycle using local git operations (no GitHub PRs). Pollers start when a project's first worker is created and stop when the last worker is killed.

**State machine per worker:**
```
working -> pushed -> reviewing -> merge-pending -> merged
                        |              |
                        v              v
                    failing        reviewing (re-review on rebase conflict)
```

1. **working**: Worker is active. Poller compares branch HEAD SHA against last-seen SHA. When new commits are detected, transitions to pushed immediately (even if Claude is still working). Multiple workers per project can transition independently.
2. **pushed**: Commits detected, awaiting review launch. If Claude is actively working and pushes new commits, reverts to working. Once Claude is idle, launches the review.
3. **reviewing**: Poller launches a Claude reviewer (`claude -p --dangerously-skip-permissions`) asynchronously in a hidden tmux window (`_<project>-review-<worker>`). The reviewer rebases onto the base branch, resolves conflicts, runs optional checks, fixes check failures, and reviews code against project rules. The poller polls for review completion by checking if the review window still exists. On completion: if clean or fixed, force-pushes and transitions to merge-pending. If the reviewer cannot fix the issues, transitions to failing. If the review process fails (Claude unavailable, timeout, unparseable output), transitions to failing. Unreviewed code is never auto-merged.
4. **merge-pending**: Review passed, waiting to merge. A serial merge queue processes one merge at a time per project (ordered by timestamp). The merge sequence: rebase onto current base branch, force-push, then ff-merge. If the rebase has conflicts (because the base branch advanced while waiting), the poller launches a scoped re-review — a new reviewer session focused on rebase conflict resolution, provided with the previous review's output and the worker's task description for context. If the rebase is clean, the merge proceeds.
5. **failing**: Unfixable review issues or review process failure. Poller watches for new commits via SHA tracking. After 30s debounce with no new pushes, state transitions back to working for retry. Each failure increments a `failCount` on the worker entry; after 3 consecutive failures, an alert is surfaced. The count resets on successful merge.
6. **merged**: Code merged to the base branch. If the worker pushes new commits after merge, or Claude is still actively working (even before committing), the poller transitions back to working for a new review cycle.

### Project Configuration
Projects can define settings in `~/.garden/config.yml`, either by editing the file directly or via `garden config <project> <key> <value>`:

```yaml
projects:
  garden:
    path: /Users/joshua/code/keychange/garden
    baseBranch: main
    checks: npx tsc --noEmit && npx vitest run
    postMerge: npm run build
```

**baseBranch**: The branch that workers branch from and merge into. Resolution order: explicit config > auto-detected from `git symbolic-ref refs/remotes/origin/HEAD` > `"main"` as last resort. Most repos work without setting this.

**checks**: Command the reviewer runs in the worker's worktree after rebasing onto the base branch, so checks validate the combined state of the branch plus latest base. If checks fail, the reviewer fixes the issues and re-runs. No checks configured means the reviewer only does the code review.

**postMerge**: Command that runs on the main checkout after merging. This is essential for projects like garden itself, where the poller runs the compiled CLI. Without a post-merge rebuild, the poller continues executing stale code even after merging fixes.

### Merge Handling
After a review passes, workers enter the `merge-pending` state. The merge queue processes one worker at a time per project (ordered by `mergePendingAt` timestamp):

1. Fetch latest base branch
2. Rebase onto current base branch
3. If rebase conflicts: abort rebase, launch a scoped re-review with context from the previous review and the worker's task description. The re-reviewer handles the rebase and verifies correctness.
4. If rebase is clean: force-push the rebased branch, merge to base branch via `git merge --ff-only` and push
5. Notify live sibling workers with overlapping files (see below)
6. Run postMerge command (if configured) on the base branch checkout
7. Mark the worker as merged in the registry

The worker and its worktree are not automatically cleaned up on merge. Cleanup happens only when the user kills the worker with `opt-x` or runs `garden reset`. This allows inspecting merged work before disposal.

Projects don't block each other — each project has its own poller and merge queue.

### Sibling Merge Notification
When code merges, the poller compares the changed files against every other active worker's branch in the same project. If files overlap and the sibling has a live Claude session, it is notified via `tmux send-keys` with the merged worker's commit summary and overlapping file list so it can review and avoid reverting the merged work. Dead workers are skipped — they will hit rebase conflicts naturally on their next review cycle.

### Alerts
The dashboard surfaces important events as alerts — persistent messages that require operator attention. Alerts are stored atomically in `~/.garden/sessions/dashboard.alerts.json` (same write-tmp-then-rename pattern as other state files), capped at 100 entries.

**Events that generate alerts:**
- Review process failure (Claude unavailable, timeout, unparseable output)
- Reviewer could not fix issues (FAILED verdict)
- Merge failure
- Repeated failures (3+ consecutive failures on the same worker)

**Visibility:**
- Header bar shows `[N alerts]` when alerts exist
- `garden alerts` lists all alerts with timestamps
- `garden alerts clear` dismisses all
- Alert file is cleaned up on `garden dashboard exit`

### Worker Isolation Model
- Every worker operates in its own git worktree — no shared working directory
- The project shell (`⌥s`) stays on the main checkout for manual work
- Branch name equals the worker name (e.g., `swift-oak`)
- Worktrees persist until the worker is killed, enabling the review cycle and manual inspection

## Worker Status Detection

The status pane shows each worker's lifecycle state using plant-themed icons:

- 🪴 **ready** — Claude launched but not yet tasked (no activity detected)
- 🌱 **working** — process alive, has child processes (actively running tools)
- 🌿 **waiting** — process alive, no child processes (showing prompt, wants input)
- 📦 **pushed** — commits detected, awaiting review launch
- 🌸 **reviewing** — poller is reviewing the worker's commits
- 🌸 **merge-pending** — review passed, in the merge queue
- 🍂 **failing** — checks or review failed (with failure count if repeated)
- 🌳 **merged** — code merged to main (with merge count if multiple merges)
- 🥀 **exited** — process has terminated

Process status is detected via tmux's `pane_pid` and child process checks. Lifecycle states (pushed, reviewing, merge-pending, failing, merged) come from the worker registry. Workers are displayed in aligned columns: focus indicator (filled/empty circle), lifecycle icon, name, status, and activity.

## Commands

### Projects
```
garden init                        # Initialize ~/.garden, check for tmux
garden add [path]                  # Add a project (defaults to cwd, name = basename)
garden remove <name>               # Remove a project
garden list                        # List all projects
garden config <project> [key] [val]  # View or set project config
```

### Dashboard
```
garden dashboard                   # Open the dashboard (creates if needed)
garden dashboard exit              # Close the dashboard
garden keys                        # Show dashboard keybindings
garden status                      # Show all projects and their workers
garden alerts                      # View dashboard alerts
garden alerts clear                # Dismiss all alerts
garden logs [options]              # View dashboard logs (pretty-printed)
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
    dashboard-<project>.context  # System prompt for project's Claude sessions
    dashboard-<project>-<branch>.context  # Worktree worker context
    dashboard.log           # Structured JSON log
    <project>-poll-signal   # FIFO for waking project pollers
    console-init.zsh              # Garden console init (custom prompt + auto-dispatch)
    bootstrap-<project>-<branch>.sh       # Transient worktree bootstrap script
    <project>-<worker>-review-prompt.txt  # Transient review prompt
    <project>-<worker>-review-result.txt  # Transient review output
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

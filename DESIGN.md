# Garden

A minimal CLI orchestrator for managing Claude Code sessions across multiple projects.

Garden is a personal tool — opinionated toward a single developer managing many projects from one place. It is not a team tool, not a CI system, and not a framework. It's a thin, extensible layer over Claude Code.

## Core Concepts

### Project
A named reference to a directory on disk where Claude Code can operate. Projects are added with `garden add [path]` (name is derived from the directory basename).

### Dashboard
A tmux session (`garden-dashboard`) that serves as the primary interface. The dashboard is a left/right split: project status and garden pane on the left, an active pane (worker or shell) on the right with a header bar. The garden pane (lower-left) is swappable between the garden shell (`⌥g`) and a logs/alerts view (`⌥l`), using the same swap-pane mechanism as the right pane. You never interact with tmux directly — garden sets up the layout, keybindings, and pane management.

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
│    ● worker-1 working│  Active Pane               │
│    ○ worker-2 waiting│  (worker or shell)         │
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

- **Project Status** (upper-left) — Live-updating display of all projects and their workers. Shows which project is active (`◄`), which worker is focused (`●` vs `○`), and each worker's status. Auto-sizes to the number of projects.
- **Garden Shell** (lower-left) — A shell cd'd to the garden project. Run garden commands: register projects, check status.
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
| `⌥]` / `⌥[` | Cycle between all panes (workers + shell) |
| `⌥x` | Kill current worker (shell is protected) |
| `⌥g` | Focus garden shell (lower-left) |
| `⌥l` | Focus logs/alerts view (lower-left) |

## Pane Management

### Swapping Mechanism
Each project's workers and shell live in hidden tmux windows when not active. When you switch projects:

1. A temporary hidden window is created, and the current active pane is swapped into it via `swap-pane`
2. The target project's pane is swapped from its hidden window into the right slot via `swap-pane`, then the hidden window is killed
3. The status pane and header update to reflect the new state

This preserves both the layout tree (the right pane slot is never destroyed) and all worker state across switches.

### Hidden Window Naming
Hidden windows follow the convention: `_<project>-worker-<N>` and `_<project>-shell`. When switching projects, the visible pane is parked as `_<project>-active`. The underscore prefix marks them as managed by garden — not user-facing.

### Worker Lifecycle
1. `⌥n` creates a git worktree at `~/.garden/worktrees/<project>/<worker-name>/` and a branch named after the worker
2. Claude launches in the worktree with project rules and worktree workflow instructions
3. The worker is interactive — you work with it directly
4. `⌥]`/`⌥[` cycles between workers and shell
5. `⌥x` kills the focused worker, removes its worktree and branch
6. Switching projects parks everything in hidden windows; switching back restores

### Poller and Auto-Merge
A background poller (`_garden-poller`) runs every 30 seconds in a hidden tmux window. It watches worker branches for new commits and drives the review/merge lifecycle using local git operations (no GitHub PRs).

**State machine per worker:**
```
working -> reviewing -> merged
                     \-> failing -> (new commits) -> working
```

1. **working**: Worker is active. Poller compares branch HEAD SHA against last-seen SHA. When new commits are detected, Claude is not actively working, and no other worker is reviewing, transitions to reviewing.
2. **reviewing**: Poller fetches main, rebases the branch, runs optional checks on the rebased code, force-pushes the rebased branch, then runs a Claude review (`claude -p --dangerously-skip-permissions`) against the diff and project rules. The reviewer has full tool access in the worktree. If the code is clean, merges to main. If the reviewer finds issues, it fixes them directly (editing files, updating tests/docs), commits the fixes, re-runs checks, and merges. If the reviewer cannot fix the issues, transitions to failing and surfaces an alert. If the review process fails (Claude unavailable, timeout, unparseable output), transitions to failing and surfaces an alert. Unreviewed code is never auto-merged.
3. **failing**: Checks failed, merge conflict, unfixable review issues, or review process failure. Poller watches for new commits via SHA tracking. After 30s debounce with no new pushes, state transitions back to working for retry. Each failure increments a `failCount` on the worker entry; after 3 consecutive failures, an alert is surfaced. The count resets on successful merge.
4. **merged**: Code merged to main. If the worker pushes new commits after merge, the poller detects them and transitions back to working for a new review cycle.

### Checks Configuration
Projects can optionally define a `checks` command in `~/.garden/config.yml`:

```yaml
projects:
  garden:
    path: /Users/joshua/code/keychange/garden
    checks: npm run build && npm test
```

The poller runs this command in the worker's worktree **after rebasing onto main**, so checks validate the combined state of the branch plus latest main. No checks configured means merge immediately after successful rebase.

Projects can also define a `postMerge` command that runs on the main checkout after fast-forwarding:

```yaml
projects:
  garden:
    path: /Users/joshua/code/keychange/garden
    checks: npx tsc --noEmit && npx vitest run
    postMerge: npm run build
```

This is essential for projects like garden itself, where the poller runs the compiled CLI. Without a post-merge rebuild, the poller continues executing stale code even after merging fixes.

### Merge Handling
Merges are serialized per project (one at a time). The merge sequence:
1. Check if Claude is running in the worktree — if so, skip this cycle
2. Fetch latest main
3. Rebase the branch onto main
4. Run checks (if configured) on the rebased code
5. Force-push the rebased branch
6. Review the diff via `claude -p --dangerously-skip-permissions` against project rules
7. If clean: merge to main via `git merge --ff-only` and push
8. If issues found: reviewer fixes them directly, re-runs checks, then merges
9. Notify sibling workers with overlapping files (see below)
10. Run postMerge command (if configured) on the main checkout
11. Mark the worker as merged in the registry

The worker and its worktree are not automatically cleaned up on merge. Cleanup happens only when the user kills the worker with `opt-x` or runs `garden reset`. This allows inspecting merged work before disposal.

Projects don't block each other — each project's queue drains independently.

### Sibling Merge Notification
When code merges, the poller compares the changed files against every other active worker's branch in the same project. If files overlap, the sibling is notified with the merged worker's commit summary and overlapping file list so it can review and avoid reverting the merged work.

- **Claude alive**: notification delivered via `tmux send-keys`
- **Claude exited**: the worker is relaunched with a new Claude session; the notification is stored as a pending message in the registry and delivered on the next poll cycle once Claude is detected as running

### Alerts
The dashboard surfaces important events as alerts — persistent messages that require operator attention. Alerts are stored atomically in `~/.garden/sessions/dashboard.alerts.json` (same write-tmp-then-rename pattern as other state files), capped at 100 entries.

**Events that generate alerts:**
- Review process failure (Claude unavailable, timeout, unparseable output)
- Merge failure
- Rebase conflict
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

The status pane shows each worker's state:

- **working** — process alive, recent output activity (within last few seconds)
- **waiting** — process alive, no recent activity (showing prompt, wants input)
- **exited** — process has terminated

Detection uses tmux's `pane_pid` to check process liveness and `pane_activity` timestamp to distinguish working from waiting.

## Commands

### Projects
```
garden init                        # Initialize ~/.garden, check for tmux
garden add [path]                  # Add a project (defaults to cwd, name = basename)
garden remove <name>               # Remove a project
garden list                        # List all projects
```

### Dashboard
```
garden dashboard                   # Open the dashboard (creates if needed)
garden dashboard exit              # Close the dashboard
garden keys                        # Show dashboard keybindings
garden status                      # Show all projects and their workers
garden alerts                      # View dashboard alerts
garden alerts clear                # Dismiss all alerts
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

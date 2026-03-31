# Garden

A minimal CLI orchestrator for managing Claude Code sessions across multiple projects.

Garden is a personal tool — opinionated toward a single developer managing many projects from one place. It is not a team tool, not a CI system, and not a framework. It's a thin, extensible layer over Claude Code.

## Core Concepts

### Project
A named reference to a directory on disk where Claude Code can operate. Projects are added with `garden add [path]` (name is derived from the directory basename).

### Dashboard
A tmux session (`garden-dashboard`) that serves as the primary interface. The dashboard is a left/right split: project status and garden shell on the left, an active pane (worker or shell) on the right with a header bar. You never interact with tmux directly — garden sets up the layout, keybindings, and pane management.

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
5. `⌥x` kills the focused worker, removes its worktree (and branch if no PR exists)
6. Switching projects parks everything in hidden windows; switching back restores

### PR Poller and Auto-Merge
A background poller (`_garden-pr-poller`) runs every 30 seconds in a hidden tmux window. It drives the PR lifecycle: detecting PRs, running optional local checks, and merging automatically.

**State machine per worker:**
```
working -> open -> merging -> reviewing -> (cleanup)
              |        |          |
              v        v          v (changes requested)
           failing <---+----------+
              |
              v (new commits + 30s debounce)
            open (retry)
```

1. **working**: Worker is active, no PR yet. Poller checks for PRs via `gh pr list`.
2. **open**: PR detected. Transitions to merging (which runs checks after rebase). If another worker is already merging or reviewing, waits until the next cycle.
3. **merging**: Poller checks if Claude is actively running in the worktree — if so, skips this cycle to avoid corrupting the live session. Otherwise: fetches main, rebases, runs optional checks on the rebased code, and force-pushes the rebased branch. On conflict or check failure, the worker is notified and state moves to failing. On force-push failure, state resets to open for retry.
4. **reviewing**: A Claude session reviews the PR diff against project rules via `claude -p`. Checks adherence to rules, test coverage, and doc coverage. Always posts a formatted review comment on the PR with the verdict and reasoning. Also attempts a formal GitHub review (`gh pr review --approve/--request-changes`), but this may fail for self-PRs. If approved, proceeds to merge. If changes requested, notifies the worker and transitions to failing. If the review process fails (Claude unavailable, timeout), proceeds with merge as a fallback.
5. **failing**: Checks failed, merge conflict, or review requested changes. Poller watches for new commits via SHA tracking. After 30s of no new pushes, state transitions back to open for retry.
6. **merged**: PR merged. Poller watches for new PRs or unmerged commits on the branch (detected via `origin/main..HEAD` ancestry check, not timestamps — timestamps miss commits orphaned by the force-push during merge). If the worker has commits not on main, the poller rebases onto main, force-pushes, and auto-creates a follow-up PR via `gh pr create`, transitioning directly to open. If rebase or PR creation fails, falls back to working.

If a PR is closed or merged externally, the poller detects this and cleans up from any state.

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
6. Review the PR diff via `claude -p` against project rules (next poll cycle)
7. Submit review via `gh pr review` (approve or request changes)
8. Merge via `gh pr merge --squash` (only if review approves or review process fails)
9. Notify sibling workers with overlapping files (see below)
10. Fast-forward local main
11. Run postMerge command (if configured) on the main checkout
12. Mark the worker as merged in the registry

The worker and its worktree are not automatically cleaned up on merge. Cleanup happens only when the user kills the worker with `opt-x` or runs `garden reset`. This allows inspecting merged work before disposal.

Projects don't block each other — each project's queue drains independently.

### Sibling Merge Notification
When a PR merges, the poller compares its changed files against every other active worker's branch in the same project. If files overlap, the sibling is notified with the merged PR's title, URL, and overlapping file list so it can review and avoid reverting the merged work.

- **Claude alive**: notification delivered via `tmux send-keys`
- **Claude exited**: the worker is relaunched with a new Claude session; the notification is stored as a pending message in the registry and delivered on the next poll cycle once Claude is detected as running

### Worker Isolation Model
- Every worker operates in its own git worktree — no shared working directory
- The project shell (`⌥s`) stays on the main checkout for manual work
- Branch name equals the worker name (e.g., `swift-oak`)
- PR title is the human-readable description, not the branch name
- Worktrees persist until the PR is merged, enabling the review cycle and manual inspection

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

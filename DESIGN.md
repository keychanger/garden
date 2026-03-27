# Garden

A minimal CLI orchestrator for managing Claude Code sessions across multiple projects.

Garden is a personal tool — opinionated toward a single developer managing many projects from one place. It is not a team tool, not a CI system, and not a framework. It's a thin, extensible layer over Claude Code.

## Core Concepts

### Project
A named reference to a directory on disk where Claude Code can operate. Projects are registered with `garden register <name> <path>`.

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

1. The current active pane is parked in a hidden window via `break-pane`
2. The target project's last-active pane (or shell) is brought in via `join-pane`
3. The status pane and header update to reflect the new state

This preserves all worker state across switches.

### Hidden Window Naming
Hidden windows follow the convention: `_<project>-worker-<N>` and `_<project>-shell`. When switching projects, the visible pane is parked as `_<project>-active`. The underscore prefix marks them as managed by garden — not user-facing.

### Worker Lifecycle
1. `⌥n` creates a new worker pane, launches `claude` with project rules via `--append-system-prompt-file`
2. The worker is interactive — you work with it directly
3. `⌥]`/`⌥[` cycles between workers and shell
4. `⌥x` kills the focused worker (shell is protected)
5. Switching projects parks everything in hidden windows; switching back restores

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
garden register <name> <path>      # Register a project
garden unregister <name>           # Unregister a project
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

Project name is auto-detected from cwd when inside a registered project. `GARDEN_PROJECT` env var overrides.

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
    dashboard-<project>.context  # System prompt for project's Claude sessions

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
garden register website ~/code/keychange/website
garden register api ~/code/keychange/api
garden register garden ~/code/keychange/garden

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

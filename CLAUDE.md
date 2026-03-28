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
  - `workers.ts` — worker lifecycle (create, kill)
  - `navigate.ts` — project switching, pane focus, worker cycling
  - `state.ts` — DashboardState type, atomic read/write to `dashboard.state.json`
  - `registry.ts` — worker registry, atomic read/write to `dashboard.registry.json`
  - `layout.ts` — pane parking/restoring via tmux swap-pane
  - `hotkeys.ts` — Alt/Option keybinding setup
  - `header.ts` — tmux status bar via `@garden_header` variable, instant refresh
  - `tmux.ts` — low-level tmux helpers (shared by dashboard and status command)
  - `validate.ts` — state/tmux consistency validation and self-healing
  - `log.ts` — structured JSON logger to `~/.garden/sessions/dashboard.log`
  - `names.ts` — worker name generation (adjective-noun pairs)
- `src/dashboard-claude.ts` — internal command: launches claude with rules context
- `src/config.ts` — reads/writes `~/.garden/config.yml`, project resolution
- `src/session.ts` — tmux session management (create, kill, attach, list)
- `src/rules.ts` — assembles global + project rules for Claude sessions
- `src/output.ts` — TTY detection for JSON vs pretty output

## Project management

Projects are added by directory path. The project name is always the directory basename.

```bash
garden add [path]      # defaults to cwd
garden remove <name>   # name = directory basename
```

`register`/`unregister` are kept as aliases for backward compatibility.

## Adding a new command

1. Create `src/commands/<name>.ts` exporting an async function that takes `args: string[]`
2. Register it in `src/commands/index.ts`
3. Add it to the help text in `src/cli.ts`
4. Use `output()` / `outputLines()` from `src/output.ts` for data output
5. Use `resolveProject()` or `resolveProjectFromArgs()` for project resolution

## Internal commands

Some commands are not user-facing — they're dispatched by the dashboard via tmux hotkeys or status bar. These are handled in `cli.ts` before normal command lookup:

- `_dashboard-claude` — launches claude with project rules context (used by dashboard workers)

The dashboard also has internal subcommands (e.g., `dashboard _switch 1`, `dashboard _new-worker`) called by hotkeys. These are dispatched inside `src/dashboard/index.ts`.

## Dashboard internals

The dashboard uses a permanent tmux layout with content swapped in and out of the right pane slot. This is the key architectural pattern:

- **The right pane is never removed.** Content is moved via `tmux swap-pane` between the visible slot and hidden tmux windows. This preserves the layout tree.
- **Hidden windows** use underscore-prefixed names: `_<project>-worker-N`, `_<project>-shell`. The underscore marks them as garden-managed.
- **Parking/restoring** (`src/dashboard/layout.ts`): To swap content, we create a temp hidden window, swap the current pane into it, then swap the target pane from its hidden window into the right slot, and kill the temp window.
- **State** (`src/dashboard/state.ts`): Tracks which project is active, which pane is visible, and pane IDs. Written atomically (write-tmp-then-rename) to `dashboard.state.json` after every operation.
- **Status detection** (`src/dashboard/tmux.ts`): Uses `pgrep` to detect whether claude is running and whether it has child processes (working vs waiting).
- **Header bar** (`src/dashboard/header.ts`): Uses a tmux session variable (`@garden_header`) instead of subprocess spawning. Updated instantly after every mutation via `refresh-client -S`. Background process detection runs on a 5-second poll.
- **State validation** (`src/dashboard/validate.ts`): On every attach, validates pane IDs against tmux reality and heals stale state. Cleans orphaned registry entries and context files.
- **Logging** (`src/dashboard/log.ts`): Structured JSON log to `~/.garden/sessions/dashboard.log`. Logs state mutations, swap operations, and validation results.
- **Health check**: `garden health` diagnoses state/tmux divergence. `garden health --fix` runs the self-healing validator.

## Conventions

- All read commands: JSON when piped, pretty in TTY. Use `src/output.ts`.
- tmux sessions are named `garden-dashboard`.
- `GARDEN_PROJECT` env var scopes commands inside sessions.
- Project name is auto-detected from cwd when inside a registered project.
- Dashboard workers are interactive Claude sessions, launched with project rules via `--append-system-prompt-file`.

## Rules system

Claude sessions get a system prompt built from:
1. Global rules (`~/.garden/rules.md`)
2. Project rules (`<project>/.garden/rules.md`)

Rules are plain markdown. They control commit behavior, testing requirements, PR workflow, and scope discipline.

## Git workflow

Feature branches, PRs, no direct commits to main. See `rules.md` for full details.

## Keeping docs current

If your task changes commands, architecture, file layout, or conventions, update DESIGN.md and CLAUDE.md as part of the task. Docs that disagree with code are worse than no docs.

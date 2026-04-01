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
  - `git.ts` — git CLI wrappers for worktree and merge operations
  - `poller.ts` — poller: event-driven state machine driving review/merge lifecycle
  - `alerts.ts` — persistent operator alerts (review failures, merge errors, repeated failures)
  - `log.ts` — structured JSON logger to `~/.garden/sessions/dashboard.log`
  - `names.ts` — worker name generation (adjective-noun pairs)
- `src/dashboard-claude.ts` — internal command: launches claude with rules context
- `src/commands/config.ts` — `garden config` command: view/set project config
- `src/config.ts` — reads/writes `~/.garden/config.yml`, project resolution
- `src/session.ts` — tmux session management (create, kill, attach, list)
- `src/rules.ts` — assembles global + project rules for Claude sessions
- `src/output.ts` — TTY detection for JSON vs pretty output

## Project management

Projects are added by directory path. The project name is always the directory basename.

```bash
garden add [path]      # defaults to cwd
garden remove <name>   # name = directory basename
garden config <project> [key] [value]  # view or set project config
```

`register`/`unregister` are kept as aliases for backward compatibility.

### Project configuration

Per-project settings can be viewed and set via `garden config`:

```bash
garden config garden                    # show all config for project
garden config garden baseBranch         # get a single key
garden config garden baseBranch develop # set a key
garden config garden baseBranch unset   # clear a key
```

Available keys: `baseBranch`, `checks`, `postMerge`. The `baseBranch` key controls which branch workers branch from and merge into. Resolution order: explicit config > auto-detected from `git symbolic-ref refs/remotes/origin/HEAD` > `"main"` as last resort.

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

The dashboard uses a permanent tmux layout with content swapped in and out of pane slots. This is the key architectural pattern:

- **Pane slots are never removed.** Content is moved via `tmux swap-pane` between visible slots and hidden tmux windows. This preserves the layout tree. Both the right pane and the garden pane (lower-left) are swappable.
- **Garden pane** (lower-left) cycles between three views: the garden console (bold green `garden>` prompt with auto-dispatch via zsh `command_not_found_handler`), a regular shell, and a logs view. `⌥[`/`⌥]` cycle when focused on the garden pane; `⌥g` jumps to console, `⌥l` jumps to logs.
- **Hidden windows** use underscore-prefixed names: `_<project>-worker-N`, `_<project>-shell`, `_<project>-poller`, `_<project>-review-<worker>`, `_garden-console`, `_garden-shell`, `_garden-logs`. The underscore marks them as garden-managed.
- **Parking/restoring** (`src/dashboard/layout.ts`): To swap content, we create a temp hidden window, swap the current pane into it, then swap the target pane from its hidden window into the slot, and kill the temp window. Separate functions handle the right pane (`parkToHidden`/`restoreFromHidden`) and garden pane (`gardenParkToHidden`/`gardenRestoreFromHidden`).
- **State** (`src/dashboard/state.ts`): Tracks which project is active, which pane is visible, and pane IDs. Written atomically (write-tmp-then-rename) to `dashboard.state.json` after every operation.
- **Status detection** (`src/dashboard/tmux.ts`): Uses `pgrep` to detect whether claude is running and whether it has child processes (working vs idle).
- **Header bar** (`src/dashboard/header.ts`): Uses a tmux session variable (`@garden_header`) instead of subprocess spawning. Updated instantly after every mutation via `refresh-client -S`. Background process detection runs on a 5-second poll.
- **State validation** (`src/dashboard/validate.ts`): On every attach, validates pane IDs against tmux reality and heals stale state. Cleans orphaned registry entries and context files.
- **Logging** (`src/dashboard/log.ts`): Structured JSON log to `~/.garden/sessions/dashboard.log`. Logs state mutations, swap operations, and validation results.
- **Health check**: `garden health` diagnoses state/tmux divergence. `garden health --fix` runs the self-healing validator.

## Worker isolation (worktrees)

Every worker runs in its own git worktree, isolated from the main checkout and other workers:

1. `opt-n` creates a worktree at `~/.garden/worktrees/<project>/<worker-name>/` on a branch named after the worker.
2. The worker's system prompt includes instructions to commit incrementally and push when done.
3. Each project gets its own **poller** (`src/dashboard/poller.ts`) running in a hidden tmux window (`_<project>-poller`), driving the review/merge lifecycle using local git (no GitHub PRs). Projects never block each other.
   - Detects new commits on worker branches via SHA comparison, transitioning to `pushed` immediately.
   - Defers review launch while Claude is actively working in the worktree (live-Claude guard). If Claude pushes new commits while in `pushed` state, reverts to `working`.
   - Launches a Claude reviewer asynchronously in a hidden tmux window (`_<project>-review-<worker>`). Multiple reviews can run in parallel within a project. The reviewer rebases onto the base branch, resolves conflicts, runs optional `checks` command (configured per project in `~/.garden/config.yml`), fixes check failures, and reviews code against project rules.
   - If code is clean or reviewer fixed all issues: force-pushes and transitions to `merge-pending`. A serial merge queue processes one merge at a time per project. If the rebase onto current base branch has conflicts (because the base branch advanced), a scoped re-review is launched with context from the previous review. If the rebase is clean: merges to the base branch via `git merge --ff-only`.
   - After merge, runs optional `postMerge` command (e.g., `npm run build` to rebuild the CLI).
   - Notifies live sibling workers with overlapping files so they can rebase.
   - Debounces commits (30s quiet period) before retrying.
4. Workers are killed on manual `opt-x` or `garden reset`.
5. Worktrees are cleaned up when the worker is killed.

The project shell (`opt-s`) stays on the main checkout for manual work.

## Conventions

- All read commands: JSON when piped, pretty in TTY. Use `src/output.ts`.
- tmux sessions are named `garden-dashboard`.
- `GARDEN_PROJECT` env var scopes commands inside sessions.
- Project name is auto-detected from cwd when inside a registered project.
- Dashboard workers are interactive Claude sessions in isolated git worktrees, launched with project rules via `--append-system-prompt-file`. Workers operate autonomously — they commit and push without asking for confirmation, since each worktree is fully isolated. The poller handles review and merge automatically.

## Rules system

Claude sessions get a system prompt built from:
1. Global rules (`~/.garden/rules.md`)
2. Project rules (`<project>/.garden/rules.md`)

Rules are plain markdown. They control commit behavior, testing requirements, PR workflow, and scope discipline.

## Git workflow

Feature branches, PRs, no direct commits to main. See `rules.md` for full details.

## Keeping docs current

If your task changes commands, architecture, file layout, or conventions, update DESIGN.md and CLAUDE.md as part of the task. Docs that disagree with code are worse than no docs.

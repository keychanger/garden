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
  - `header.ts` — tmux status bar: active project context (left) via `@garden_left`, build version (right) via `@garden_right`
  - `tmux.ts` — low-level tmux helpers (shared by dashboard and status command)
  - `validate.ts` — state/tmux consistency validation and self-healing
  - `git.ts` — git CLI wrappers for worktree and merge operations
  - `poller.ts` — poller: event-driven state machine driving review/merge lifecycle
  - `prompts.ts` — review prompt building for the reviewer Claude session
  - `window-names.ts` — centralized tmux window naming conventions (construction, parsing, classification)
  - `alerts.ts` — persistent operator alerts (review failures, merge errors, repeated failures)
  - `findings.ts` — reviewer-findings tally: parses `findings` blocks from review output, persists atomically to `rules-findings.json`, and fires a one-time alert when a category crosses the suggestion threshold
  - `log.ts` — structured JSON logger to `~/.garden/sessions/dashboard.log`
  - `names.ts` — worker name generation (adjective-noun pairs)
  - `sandbox.ts` — builds Claude sandbox config (filesystem allowWrite + network allowedDomains) for each worker and reviewer
  - `usage.ts` — Claude quota fetcher/renderer: OAuth-bearer call to `api.anthropic.com/api/oauth/usage`, normalizes the 5h/weekly/sonnet meters, renders three bars for the dedicated "usage" pane via `renderUsagePane()`. Third bar is Sonnet (not Opus) because on Max plans `seven_day_opus` is null and `seven_day_sonnet` is the populated model-specific bucket. Undocumented endpoint, strict rate-limit (~50min Retry-After after rapid probes).
  - `usage-poller.ts` — singleton poller (`_garden-usage-poller`) refreshing the quota snapshot every 5 min. Honors `Retry-After` on 429. Calls `refreshDashboard()` (not just `refreshStatusPane()`) so the pre-baked status file gets rewritten before SIGUSR1. On top of this, `maybeRefreshUsage()` in `usage.ts` is called from the `Stop` hook in `handleClaudeHook` — a fire-and-forget detached `_usage-refresh` subprocess, gated by a 60-second cooldown, so the meter updates right after each end-of-turn.
  - `STATUS.md` — **spec** for the worker status tracking and display system. Source of truth: the code follows this document, not the other way around. See "Specification files" below.
- `src/dashboard-claude.ts` — internal command: launches claude with rules context
- `src/commands/config.ts` — `garden config` command: view/set project config
- `src/commands/focus.ts` — `garden focus` / `garden unfocus`: control dashboard visibility
- `src/commands/reorder.ts` — `garden reorder`: reorder projects for hotkey assignment
- `src/commands/rules.ts` — `garden rules` command: view/accept/dismiss pending rule suggestions from reviewer findings
- `src/config.ts` — reads/writes `~/.garden/config.yml`, project resolution
- `src/session.ts` — tmux session management (create, kill, attach, list)
- `src/rules.ts` — assembles global + project rules for Claude sessions
- `src/output.ts` — TTY detection for JSON vs pretty output
- `src/version.ts` — build version constant (injected by esbuild, falls back to "dev")

## Project management

Projects are added by directory path. The project name is always the directory basename.

```bash
garden add [path]      # defaults to cwd
garden remove <name>   # name = directory basename
garden config <project> [key] [value]  # view or set project config
garden focus <name>    # show project in dashboard
garden unfocus <name>  # hide project from dashboard
garden reorder <name> <N> # move project to position N
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

Available keys: `baseBranch`, `checks`, `postMerge`, `focused`, `sandboxDomains`. The `baseBranch` key controls which branch workers branch from and merge into. Resolution order: explicit config > current branch of main checkout > `origin/HEAD` symref > `"main"` as last resort. The `focused` key controls dashboard visibility (default: focused). Use `garden focus`/`garden unfocus` as shortcuts. The `sandboxDomains` key is a comma-separated list of extra network domains added to each worker/reviewer's sandbox allowlist — use it for private registries, internal services, or other hosts beyond the garden-wide defaults (`garden config <project> sandboxDomains foo.com,bar.com`).

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
- **Left column** stacks three panes top-to-bottom: the dedicated "usage" pane (fixed 4 rows, Claude quota meters), the "status" pane (dynamic height, per-project worker list), and the garden pane (remainder). The usage and status panes each run their own SIGUSR1-driven refresh loop that re-displays a pre-baked file (`usage.rendered` / `status.rendered`) written atomically by `writeUsageRendered()` / `writeQuickStatus()` in `src/dashboard/header.ts`.
- **Garden pane** (lower-left) cycles between three views: garden (bold green `garden>` prompt with auto-dispatch via zsh `command_not_found_handler`), root (general-purpose shell), and logs. `⌥g` jumps to garden, `⌥r` jumps to root, `⌥l` jumps to logs.
- **Hidden windows** use underscore-prefixed names: `_<project>-worker-N`, `_<project>-shell`, `_<project>-poller`, `_<project>-review-<worker>`, `_garden-garden`, `_garden-root`, `_garden-logs`. The underscore marks them as garden-managed.
- **Parking/restoring** (`src/dashboard/layout.ts`): To swap content, we create a temp hidden window, swap the current pane into it, then swap the target pane from its hidden window into the slot, and kill the temp window. Separate functions handle the right pane (`parkToHidden`/`restoreFromHidden`) and garden pane (`gardenParkToHidden`/`gardenRestoreFromHidden`).
- **State** (`src/dashboard/state.ts`): Tracks which project is active, which pane is visible, and pane IDs. Written atomically (write-tmp-then-rename) to `dashboard.state.json` after every operation.
- **Status writers** (`src/dashboard/header.ts` `handleClaudeHook`/`handlePaneDied`, `src/dashboard/poller.ts`): The registry is the single source of truth (see `src/dashboard/STATUS.md`). Claude Code hooks (SessionStart, UserPromptSubmit, Stop) write `claudeStatus`; the poller writes `prState`; the tmux `pane-died` hook writes `claudeStatus="exited"`. The renderer never calls `pgrep`, never reads marker files. Every transition is event-triggered — there is no fallback poll.
- **Bottom bar** (`src/dashboard/header.ts`): Two-sided tmux status line. Left (`@garden_left`): active project name (bold) and its current git branch. Right (`@garden_right`): garden build version (git short SHA, or "dev" when running via tsx), prefixed with a red `⚠ N alerts — ⌥l to clear` badge when unread alerts exist. Updated instantly after every mutation via `refresh-client -S`. `formatRight()` pulls from `unreadAlertCount()` (in `src/dashboard/alerts.ts`); `addAlert()` and `acknowledgeAlerts()` also call `refreshAlertBadge()` directly so the bar flips even outside the normal dashboard-refresh paths. Claude Code hooks (`UserPromptSubmit`, `Stop`) signal the status pane when workers start/stop processing.
- **State validation** (`src/dashboard/validate.ts`): On every attach, validates pane IDs against tmux reality and heals stale state. Cleans orphaned registry entries and context files.
- **Logging** (`src/dashboard/log.ts`): Structured JSON log to `~/.garden/sessions/dashboard.log`. Logs state mutations, swap operations, and validation results.
- **Health check**: `garden health` diagnoses state/tmux divergence. `garden health --fix` runs the self-healing validator.
- **Kick**: `garden kick <worker>` re-arms a worker stranded in `working` for review (sets `pendingReviewAt` and pokes the project poller). Use when a reviewer-push race or a crashed poller has left a worker with no event to wake it. Refuses workers not in `working` state or with no commits ahead of base.

## Worker isolation (worktrees)

Every worker runs in its own git worktree, isolated from the main checkout and other workers:

1. `opt-n` creates a worktree at `~/.garden/worktrees/<project>/<worker-name>/` on a branch named after the worker. The worktree branches directly off `origin/<base>` (fetched as the first bootstrap step), so worker freshness never depends on the main checkout being clean or up-to-date. If the main checkout cannot be fast-forwarded, the bootstrap still proceeds and an alert (source `bootstrap`) is raised so the operator can clean the drift.
2. The worker's system prompt includes instructions to commit incrementally and push when done. Each worktree's `.claude/settings.local.json` also configures Claude's OS-level sandbox (Seatbelt on macOS, bubblewrap on Linux) with auto-allow for sandboxed bash and `permissions.defaultMode: "acceptEdits"` so file edits go through without prompting — workers no longer run with `--dangerously-skip-permissions` but remain autonomous inside the sandbox's filesystem and network allowlists. The allowlist is built in `src/dashboard/sandbox.ts` from garden-wide defaults (Anthropic, github, npm, the project's git remote host) plus the project's `sandboxDomains` config key. Reviewers inherit the same config by running inside the worktree.
3. Each project gets its own **poller** (`src/dashboard/poller.ts`) running in a hidden tmux window (`_<project>-poller`), driving the review/merge lifecycle using local git (no GitHub PRs). Projects never block each other.
   - Wakes only on FIFO pokes from event sources: Claude Code Stop hooks (when commits exist ahead of base), pre-push hooks installed in worktrees, merge-queue completion. There is no fallback poll. See `src/dashboard/STATUS.md` for the full state machine.
   - When the worker's Stop hook fires with commits ahead of base, the hook marks the worker for review (`pendingReviewAt`) and pokes the poller, which transitions `working → reviewing` and launches a Claude reviewer asynchronously in a hidden tmux window (`_<project>-review-<worker>`). Multiple reviews can run in parallel within a project. The reviewer rebases onto the base branch, resolves conflicts, runs optional `checks` command (configured per project in `~/.garden/config.yml`), fixes check failures, and reviews code against project rules.
   - If code is clean or reviewer fixed all issues: force-pushes and transitions to `merge-pending`. A serial merge queue processes one merge at a time per project. If the rebase onto current base branch has conflicts (because the base branch advanced), a dedicated resolver is launched (state `resolving`) — its verdict is verified programmatically (rebase actually landed, `origin/<base>` is an ancestor of HEAD, HEAD advanced past `preResolveSha`) and is retried up to a budget of 2 before escalating to `failing` with an operator alert. If the rebase is clean: fast-forwards the remote base branch via direct refspec push (no local checkout needed).
   - After merge, fast-forwards the local base branch checkout and runs optional `postMerge` command (e.g., `npm run build` to rebuild the CLI). If the fast-forward fails, postMerge is skipped and an alert is raised — the alert fires regardless of whether postMerge was configured, since local-checkout drift breaks manual workflow on its own.
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

### Rules evolution

Reviewers emit a fenced `findings` JSON block before their verdict on FIXED/FAILED, tagging each intervention with a short kebab-case `category` and a one-sentence `summary`. The poller tallies these in `~/.garden/sessions/rules-findings.json`. When a category accumulates ≥3 findings across ≥2 distinct workers within 30 days, a one-time alert fires (source: `rules`) and the category becomes a *pending suggestion*. Use `garden rules` to review them and `garden rules accept <category> --rule "..." [--global|--project <name>] --confirm` to append a synthesized rule block to the inferred rules.md. Dismissed categories won't re-surface.

## Git workflow

Feature branches, PRs, no direct commits to main. See `rules.md` for full details.

## Keeping docs current

If your task changes commands, architecture, file layout, or conventions, update DESIGN.md and CLAUDE.md as part of the task. Docs that disagree with code are worse than no docs.

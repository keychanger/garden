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
  - `workers.ts` — worker lifecycle (create, kill, bounce)
  - `continue.ts` — auto-continue prompts: interrupt-recovery (dispatched by ensureDashboard resume and bounceWorker) and post-merge auto-continue (dispatched by `finalizeMerge` so multi-phase work keeps building without a manual "please proceed"). Owns the `.garden-done` sentinel helpers (`donePath`, `isDoneSet`, `clearDoneSentinel`) used by the poller and the pause/resume commands. Sentinel lives at the worktree root — the only path writable by both Claude Code's harness sandbox and the OS Seatbelt sandbox that the poller can also reconstruct deterministically.
  - `navigate.ts` — project switching, pane focus, worker cycling
  - `state.ts` — DashboardState type, atomic read/write to `dashboard.state.json`
  - `registry.ts` — worker registry, atomic read/write to `dashboard.registry.json`
  - `layout.ts` — pane parking/restoring via tmux swap-pane
  - `hotkeys.ts` — Alt/Option keybinding setup
  - `header.ts` — tmux status bar: active project context (left) via `@garden_left`, build version (right) via `@garden_right`. Also renders the top-of-status-pane plot strip (`@garden_name`) with per-plot status icons (failing/asking/merged/working/idle) and animates the "working" spinner by piggybacking on the status pane's SIGUSR1 tick via `~/.garden/sessions/plot-strip.template`.
  - `plot-status.ts` — aggregates worker states across a plot's projects into a single `PlotState` (`failing` > `asking` > `merged` > `working` > `idle`). Drives the plot-strip icon.
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
  - `credentials.ts` — reads/captures Claude Code OAuth credentials from macOS Keychain and file slots
  - `claude-env.ts` — resolves `CLAUDE_CONFIG_DIR` env var/prefix for per-project Claude profiles
  - `sandbox.ts` — builds Claude sandbox config (filesystem allowWrite + network allowedDomains) for each worker and reviewer
  - `usage.ts` — Claude quota fetcher/renderer: OAuth-bearer call to `api.anthropic.com/api/oauth/usage`, normalizes the 5h/weekly/sonnet meters, renders three bars for the top-left "garden" title pane via `renderUsagePane()`. Third bar is Sonnet (not Opus) because on Max plans `seven_day_opus` is null and `seven_day_sonnet` is the populated model-specific bucket. Undocumented endpoint, strict rate-limit (~50min Retry-After after rapid probes). 401/403 responses set a synthetic 30-minute `retryAfterMs` (`AUTH_BACKOFF_MS`) so the poller doesn't hammer a dead token into a 429 cascade; `garden login` and `garden usage refresh` overwrite the snapshot to heal the meter early.
  - `usage-poller.ts` — singleton poller (`_garden-usage-poller`) refreshing the quota snapshot every 5 min. Honors `Retry-After` on 429. Calls `refreshDashboard()` (not just `refreshStatusPane()`) so the pre-baked status file gets rewritten before SIGUSR1. On top of this, `maybeRefreshUsage()` in `usage.ts` is called from the `Stop` hook in `handleClaudeHook` — a fire-and-forget detached `_usage-refresh` subprocess, gated by a 60-second cooldown, so the meter updates right after each end-of-turn.
  - `STATUS.md` — **spec** for the worker status tracking and display system. Source of truth: the code follows this document, not the other way around. See "Specification files" below.
- `src/dashboard-claude.ts` — internal command: launches claude with rules context
- `src/commands/config.ts` — `garden config` command: view/set project config
- `src/commands/plot.ts` — `garden plot`: list/activate/create/delete/rename/add/remove/reorder/show; drives the dashboard view
- `src/commands/focus.ts` — `garden focus` / `garden unfocus`: toggle whether a plot is in the ⌥p cycle
- `src/commands/reorder.ts` — `garden reorder`: reorder plots within the ⌥p cycle
- `src/commands/claude-profile.ts` — `garden claude-profile` command: manage alternate Claude config dirs (per-project plan)
- `src/commands/login.ts` — `garden login [profile]`: re-authenticate Claude (personal or profile)
- `src/commands/auth.ts` — `garden auth status`: credential diagnostic (presence, expiry, displacement)
- `src/commands/rules.ts` — `garden rules` command: view/accept/dismiss pending rule suggestions from reviewer findings
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

Available keys: `checks`, `postMerge`, `sandboxDomains`, `claudeProfile`, `logColor`. Workers always target the current branch of the main checkout at creation time (fallbacks: `origin/HEAD` symref, then `"main"`). That choice is pinned to the worker entry (`WorkerEntry.baseBranch`) so switching the main checkout's branch never retargets an existing worker; the base is validated against origin up front — workers with a base not on origin are rejected. The `sandboxDomains` key is a comma-separated list of extra network domains added to each worker/reviewer's sandbox allowlist — use it for private registries, internal services, or other hosts beyond the garden-wide defaults (`garden config <project> sandboxDomains foo.com,bar.com`). The `claudeProfile` key opts a project into an alternate Claude Code config dir (a separate plan); see `garden claude-profile` below. The `logColor` key pins the color used for the project's name in `garden logs` — every project gets a unique color from a fixed palette, assigned at `garden add`/`create` time and persisted in `~/.garden/config.yml`. `green` is reserved for `garden` itself and cannot be assigned to other projects. A one-shot migration on first `loadConfig()` post-upgrade assigns colors to existing projects. Dashboard visibility is controlled by plots (see above) — there is no per-project `focused` flag anymore.

### Claude profiles

Each project's workers and reviewers default to your personal `~/.claude` credentials. To run a project on a different plan (e.g. a client's Enterprise workspace) without disturbing the default, register a profile and assign it:

```bash
garden claude-profile add imp                  # creates ~/.claude-imp and registers the profile
garden claude-profile login imp                # interactive: claude /login pointed at ~/.claude-imp
garden config <project> claudeProfile imp      # opt the project in
garden claude-profile list                     # shows profiles and which projects use each
garden claude-profile remove imp               # refuses while any project still references it
```

A project's claudeProfile is injected as `CLAUDE_CONFIG_DIR` whenever its worker, reviewer, resolver, or `_dashboard-claude` session spawns. Hooks in `.claude/settings.json` shell out to garden and intentionally do not depend on the override. The dashboard usage meter is not split per-profile: Anthropic's `/api/oauth/usage` aggregates by user identity, so two workspace tokens tied to the same email return identical data — a per-profile bar would just mirror `week`. Whatever per-workspace quota the alternate plan has is visible only via the org owner's admin dashboard.

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
- **Status writers** (`src/dashboard/header.ts` `handleClaudeHook`/`handlePaneDied`, `src/dashboard/poller.ts`): The registry is the single source of truth (see `src/dashboard/STATUS.md`). Claude Code hooks (SessionStart, UserPromptSubmit, Stop) write `claudeStatus`; the poller writes `prState`; the tmux `pane-died` hook writes `claudeStatus="exited"`. The renderer never calls `pgrep`, never reads marker files. Every transition is event-triggered — there is no fallback poll.
- **Bottom bar** (`src/dashboard/header.ts`): Two-sided tmux status line. Left (`@garden_left`): active project name (bold) and its current git branch. Right (`@garden_right`): garden build version (git short SHA, or "dev" when running via tsx), prefixed with a red `⚠ N alerts — ⌥l to clear` badge when unread alerts exist. Updated instantly after every mutation via `refresh-client -S`. `formatRight()` pulls from `unreadAlertCount()` (in `src/dashboard/alerts.ts`); `addAlert()` and `acknowledgeAlerts()` also call `refreshAlertBadge()` directly so the bar flips even outside the normal dashboard-refresh paths. Claude Code hooks (`UserPromptSubmit`, `Stop`) signal the status pane when workers start/stop processing.
- **State validation** (`src/dashboard/validate.ts`): On every attach, validates pane IDs against tmux reality and heals stale state. Cleans orphaned registry entries and context files.
- **Logging** (`src/dashboard/log.ts`): Structured JSON log to `~/.garden/sessions/dashboard.log`. Levels are a semantic contract, not decoration: `error` = operator must act, `warn` = possibly wrong, `info` = **lifecycle state transition** (worker moved, merge landed, alert fired), `debug` = events, heartbeats, pair-half ops, poll cycles with no transition. Default level is info; `GARDEN_LOG_LEVEL=debug` brings back the firehose. Per-tool-call hooks, park/restore pair halves, and no-op poll cycles log at debug; Claude hooks that actually flip `claudeStatus` log at info.
- **Health check**: `garden health` diagnoses state/tmux divergence. `garden health --fix` runs the self-healing validator.
- **Kick**: `garden kick <worker>` re-arms a worker stranded in `working` for review (sets `pendingReviewAt` and pokes the project poller). Use when a reviewer-push race or a crashed poller has left a worker with no event to wake it. Refuses workers whose `prState` is set to a lifecycle state (reviewing, merge-pending, etc.), whose `claudeStatus` is `working` or `asking` (Claude is mid-turn — launching a reviewer would race live commits), or with no commits ahead of base.
- **Bounce**: `garden bounce <worker>` (or `⌥b` on an active worker pane) kills the Claude process and restarts it via `claude --resume <sessionId>` in the same pane. The conversation history is preserved, but transient session state is dropped — fresh read of `.claude/settings.json` (hook config, `permissions.defaultMode`), new permission-mode cycle. Use when a worker is stuck in plan/acceptEdits with no way back to auto, when hook config was changed by a new build, or when Claude has wedged into a bad state. Writes `claudeStatus = "idle"` afterwards (`--resume` skips SessionStart).
- **Pause/Resume**: `garden pause <worker>` writes the `.garden-done` sentinel at the worker's worktree root; `garden resume <worker>` deletes it. The sentinel suppresses the post-merge auto-continue (see below). Use pause to stop a running phase chain without killing the worker; use resume to re-arm auto-continue after a pause or after the worker self-declared done.
- **Auto-continue on resume** (`src/dashboard/continue.ts`): When a worker is interrupted mid-turn (dashboard kill, tmux server crash, manual bounce while `claudeStatus === "working"`), the resume path auto-sends a "continue from where you left off" prompt a few seconds after the pane comes back. Detection signals: `pane-died` writes `interruptedWhileWorking: true` to the registry entry when claudeStatus was `working` at exit; `ensureDashboard` also treats a still-`working` claudeStatus as interrupted (covers the no-pane-died-fired case). Bounce snapshots `claudeStatus` in-memory before overwriting to `idle`. The actual send is dispatched via a detached `sleep 3 && garden dashboard _continue-worker` subprocess so Claude `--resume` has time to take over the pane's stdin; `_continue-worker` skips silently if the operator already started typing (status is `working`/`asking` again).
- **Auto-continue across the merge boundary** (`src/dashboard/continue.ts`, `poller.ts:maybeAutoContinue`): After a clean merge, `finalizeMerge` dispatches a delayed `_continue-worker-after-merge` subprocess that sends a "previous changes were merged, continue with the next phase" prompt to the worker pane. This removes the manual "please proceed" step in multi-phase tasks. The worker opts out by writing the sentinel `<worktree>/.garden-done` (`touch .garden-done` from its CWD — instructed not to commit it) before ending its turn; the worker's system prompt covers this in `src/rules.ts` `buildWorktreeRules`. Skip conditions logged at `debug`: sentinel present, `claudeStatus` is `working`/`asking` (operator already typing — same guard as interrupt-recovery), or a previous auto-continue fired within `AUTO_CONTINUE_DEBOUNCE_MS` (10s, idempotency guard against any merge-event replay). The dispatch itself logs at `info` (`auto-continued worker after merge`) so the operator sees the lifecycle transition in `⌥l` logs. Registry field: `lastAutoContinueAt`. The 5s subprocess delay (longer than the 3s interrupt-recovery delay) lets postMerge and the reviewer's force-push settle before keys land in the pane. `garden pause` / `garden resume` toggle the sentinel via the registry's `worktreePath`; `killPane` does NOT need explicit cleanup because `git worktree remove --force` removes the sentinel along with the worktree.
- **`merged` is the cleanup signal** (`src/dashboard/header.ts:routeStopHookEnd`): `finalizeMerge` sets `prState=merged` after a clean merge; the auto-continue prompt's `UserPromptSubmit` then clears it (existing invariant 4 behavior). To preserve `merged` as the operator's "this worker is finished, you can clean it up" signal, the Stop hook reinstates `prState=merged` when the worker has no commits ahead of base AND `.garden-done` is present at the worktree. Three Stop-hook end-of-turn dispositions: commits ahead → queue review (`pendingReviewAt`), no commits + `.garden-done` → restore `merged`, no commits + no sentinel → plain `idle`. STATUS.md invariant 4 codifies this (the spec was updated in lockstep with the code).

## Worker isolation (worktrees)

Every worker runs in its own git worktree, isolated from the main checkout and other workers:

1. `opt-n` creates a worktree at `~/.garden/worktrees/<project>/<worker-name>/` on a branch named after the worker. The worktree branches directly off `origin/<base>` (fetched as the first bootstrap step), so worker freshness never depends on the main checkout being clean or up-to-date. If the main checkout cannot be fast-forwarded, the bootstrap still proceeds and an alert (source `bootstrap`) is raised so the operator can clean the drift.
2. The worker's system prompt includes instructions to commit incrementally and push when done. Each worktree's `.claude/settings.json` also configures Claude's OS-level sandbox (Seatbelt on macOS, bubblewrap on Linux) with auto-allow for sandboxed bash and `permissions.defaultMode: "auto"` so every Claude process in the worktree (worker, reviewer, resolver, resume) starts in Anthropic's built-in auto mode — the classifier auto-approves low-risk tool calls and only prompts the operator for the rest. `permissions.allow` also pre-approves `Bash(tmux:*)` plus read-only tail utilities (`echo`, `head`, `tail`, `cat`, `grep`, `wc`) so routine pane/window queries — including compound chains like `tmux ... && echo ok` or `tmux ... | head -40` — never raise a prompt. Claude Code requires every subcommand of a compound bash call to match an allow rule independently, so the tails have to be allowlisted too. Workers no longer run with `--dangerously-skip-permissions` but remain autonomous inside the sandbox's filesystem and network allowlists. The allowlist is built in `src/dashboard/sandbox.ts` from garden-wide defaults (Anthropic, github, npm, the project's git remote host) plus the project's `sandboxDomains` config key. Reviewers inherit the same config by running inside the worktree.
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

## Conventions

- All read commands: JSON when piped, pretty in TTY. Use `src/output.ts`.
- tmux sessions are named `garden-dashboard`.
- `GARDEN_PROJECT` env var scopes commands inside sessions. Worker panes also export `GARDEN_WORKER`, `GARDEN_BRANCH`, `GARDEN_BASE_BRANCH` so workers can self-identify; `garden whoami` reads these to print the current worker's registry entry, and `garden logs -w $GARDEN_WORKER` filters to the worker's own history.
- Project name is auto-detected from cwd when inside a registered project.
- Dashboard workers are interactive Claude sessions in isolated git worktrees, launched with project rules via `--append-system-prompt-file`. Workers operate autonomously — they commit and push without asking for confirmation, since each worktree is fully isolated. The poller handles review and merge automatically.

## Rules system

Claude sessions get a system prompt built from:
1. Global rules (`~/.garden/rules.md`)
2. Project rules (`<project>/.garden/rules.md`)

Rules are plain markdown. They control commit behavior, testing requirements, PR workflow, and scope discipline.

### Rules evolution

Reviewers emit a fenced `findings` JSON block before their verdict on FIXED/FAILED, tagging each intervention with a short kebab-case `category` and a one-sentence `summary`. The poller tallies these in `~/.garden/sessions/rules-findings.json`. When a category accumulates ≥3 findings across ≥2 distinct workers within 30 days, a one-time alert fires (source: `rules`) and the category becomes a *pending suggestion*. `garden rules` walks each suggestion interactively with an `[a]ccept / [d]ismiss / [s]kip` prompt (accept asks for an optional one-line rule and auto-resolves scope). For scripting, `garden rules accept <category> --rule "..." [--global|--project <name>] --confirm` still works. Dismissed categories won't re-surface.

## Git workflow

Feature branches, PRs, no direct commits to main. See `rules.md` for full details.

## Keeping docs current

If your task changes commands, architecture, file layout, or conventions, update DESIGN.md and CLAUDE.md as part of the task. Docs that disagree with code are worse than no docs.

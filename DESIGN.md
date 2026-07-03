# Garden

A minimal CLI orchestrator for managing Claude Code sessions across multiple projects.

Garden is a personal tool — opinionated toward a single developer managing many projects from one place. It is not a team tool, not a CI system, and not a framework. It's a thin, extensible layer over Claude Code.

## Core Concepts

### Project
A named reference to a directory on disk where Claude Code can operate. Projects are added with `garden add [path]` (name is derived from the directory basename).

### Dashboard
A tmux session (`garden-dashboard`) that serves as the primary interface. The dashboard is a left/right split: garden title and usage meters (top), project status (middle), and a growhouse pane (bottom) on the left; an active pane (worker or shell) on the right with a header bar. The growhouse pane cycles between five views: the growhouse (`⌥g`) with a bold green `garden>` prompt and auto-dispatch for garden commands, the root shell (`⌥r`) for general-purpose terminal use, a logs view (`⌥l`), a history view (`⌥h`) showing the focused worker's prompt history, and a diary view (`⌥d`) editing the focused project's diary in `$EDITOR`. The same swap-pane mechanism as the right pane is used. You never interact with tmux directly — garden sets up the layout, keybindings, and pane management.

### Workers
Interactive Claude Code sessions running inside the dashboard. Each project can have multiple workers (e.g., one for a feature, one for a review). Workers persist when you switch between projects — they're parked in hidden tmux windows and swapped back in when you return.

### Workflows
A **workflow** is a `WorkflowDefinition` (state machine + state handlers + hook handlers) that drives a worker's lifecycle. Each worker has a `workflow` field on its registry entry; the poller dispatcher and the Claude Code hook dispatcher route through `getWorkflow(name)` rather than hard-coded switches. The `default` workflow reproduces the standard "review and merge" pipeline. Alternate workflows are introduced as data, not as forks of the dispatcher. Architectural rationale: `WORKFLOWS.md`. Author guide: `CLAUDE.md` § "Adding a new workflow".

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

- **Garden title + Usage Meters** (top-left) — Dedicated pane with a bold green `garden` title label on the pane border and three Claude quota bars inside (5-hour rolling window, weekly total, Sonnet-specific weekly meter). Height auto-sizes to the rendered content — 5 rows at rest, plus one dim footer row each for an enabled extra-usage credit tally and a one-line health tag (stale snapshot or last-fetch error) when present. Refreshed via SIGUSR1 from a pre-baked `usage.rendered` file.
- **Project Status** (mid-left) — Live-updating display of all projects and their workers. Shows which project is active (`◄`), each worker's lifecycle state via status icons (braille spinner for working, Unicode symbols for other states), a focus indicator (filled/empty circle) showing which worker is active, and aligned columns for name/status/activity. Auto-sizes to the number of projects. A project header row also carries a dimmed pencil `✎` after the name when that project's diary holds non-whitespace content — answering "did I leave notes here?", which nothing else on the row shows. Detection is `diaryHasContent` (`src/diary.ts`), which reads the diary directly (no mkdir) and stat-caches on mtime+size so the firehose of status re-bakes doesn't re-read every project's diary; `formatDiaryGlyph` (`src/commands/status.ts`) renders the glyph in both the baked dashboard path and `garden status`. An empty or whitespace-only diary counts as no content, so a never-written diary stays unmarked.
- **Growhouse Pane** (lower-left) — Cycles between five views: growhouse (bold green `garden>` prompt with auto-dispatch for garden commands), root (general-purpose shell), logs, history, and diary. `⌥g` jumps to growhouse, `⌥r` jumps to root, `⌥l` jumps to logs, `⌥h` jumps to history (the focused worker's operator prompts + verb-tagged assistant summaries, read from the worker's Claude transcript JSONL by `conversation.ts`), `⌥d` jumps to the diary (the focused project's diary at `~/.garden/diary/<project>.md`, open in `$EDITOR`). The history pane renders via the same pre-baked-file + SIGUSR1 path as the usage meter; `writeHistoryRendered` parses the transcript only while history is the active mode. The diary pane runs a wrapper loop (`diary-view.sh`) that re-resolves the focused project via `garden dashboard _diary-path` each time the editor exits, so quitting the editor reopens on the now-focused project's diary; switching views parks the editor with its state intact. Switching projects (`⌥1–9` / `⌥p`) makes the diary follow: `reloadDiaryEditor` (`navigate.ts`) drives the editor's save+exit so the loop reopens on the new project. This fires whether the diary is the active garden pane or parked in the hidden `_garden-diary` window — re-entering the diary view reuses the parked editor rather than restarting it, so without the parked-case reload it would show whatever project was focused when it parked. A live modal editor can only be re-targeted by restarting it, which would discard unsaved notes, so this is nano/pico-only (the shipped default; on macOS `nano` is a symlink to pico): it sends `^O Enter ^X` — write the buffer to its current file, then exit cleanly. A custom `$EDITOR` is left untouched (its save keys can't be driven blindly) and still reopens on the operator's own exit. When the editor is nano/pico it is launched with `-b` to enable word wrap, so long diary lines wrap to the pane width instead of scrolling off the right edge.
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

**Plot status indicators**: Each plot segment also carries a status icon derived from the aggregated state of all workers across the plot's projects (`resolvePlotStatus` in `src/dashboard/plot-status.ts`). Priority order: `failing` (red ✖) > `asking` (yellow ⚑) > `working` (braille spinner) > `done` (green ✓) > `idle` (no icon). Only `done` is green — `merged` (transient post-merge beat), `reviewing`, `merge-pending`, and `resolving` fall through to `working`, since none of those are operator-actionable. Colors override the active/inactive styling for non-working states; working plots keep the bold/dim active/inactive distinction and add a bright spinner. The spinner animates at the same 120ms cadence as worker rows by piggybacking on the status pane's existing SIGUSR1-driven tick: `buildPlotStrip` writes a template file (`~/.garden/sessions/plot-strip.template`) with a `__GSP__` sentinel where the spinner frame goes, and the status pane's bash loop substitutes the current frame and rewrites `@garden_name` each tick. The loop enters animation mode if either `$cur` has a braille char or the template file contains the sentinel.

**Right-pane clock**: The right pane — whether it holds a worker or the project shell — renders a `%H:%M` wall clock in the right corner of its top border, mirroring the `garden` title in the top-left. The shared `pane-border-format` (set in `setupStatusBar`) carries a right-aligned clock segment — bold green to match the `garden` title, wrapped in spaces and capped with two border dashes so the border runs to the right corner exactly as the left edge frames `garden` — gated on the `@garden_clock` pane variable. The clock's style is kept comma-free (`#[fg=green]#[bold]`, never `#[fg=green,bold]`): a comma inside the `#{?@garden_clock,…}` conditional is parsed as the true/false separator and silently blanks the clock. That variable is set on worker panes (`restoreWorkerPaneVars` in `navigate.ts` and the worker-pane creation sites in `workers.ts` / `create.ts`) and on the right-pane shell (`createShellWindow` in `create.ts` and `focusShell` in `navigate.ts`). The left-column garden shells (growhouse / root / logs) deliberately do not set it. The time is strftime-expanded by tmux on each `status-interval` tick (30s), so it advances on tmux's own timer with no extra process or poll.

**Project color in the right-pane border**: Every registered project carries a stable `logColor` (palette in `src/log-palette.ts`, auto-assigned by the `loadConfig()` migration), used to color project names in `garden logs`. The right pane's top border echoes that color as a small `●` before the worker/shell label — the one place project identity is otherwise absent (the border names the worker and task, never the project). The dot is gated on the `@garden_color` pane variable (a tmux color name like `colour208`), set by `setPaneProjectColor` (`src/dashboard/header.ts`) at the same sites that set `@garden_clock`; the shared `pane-border-format` renders `#[fg=#{@garden_color}]●#[default]` — tmux expands the nested variable before parsing the style, and the style must stay comma-free like the clock's. The color deliberately appears nowhere else in the dashboard (status pane and bottom bar already name the project in text), and the palette stores 256-color indices, deriving the ANSI form (`logColorAnsi`, log lines) and the tmux form (`logColorTmux`, border format) from the same index.

**Project removal** (`garden remove <project>`) also calls `purgeProjectFromPlots` to strip the project from every plot's project list. Empty plots are kept — delete explicitly with `garden plot delete`.

## Hotkeys

All hotkeys use Alt/Option with no prefix — single keypress, instant.

Requires terminal setup: iTerm2 → Profiles → Keys → Left Option key → "Esc+" (sends Meta).

| Key | Action |
|-----|--------|
| `⌥1` – `⌥9` | Switch to project by index within the active plot |
| `⌥p` / `⌥P` | Cycle to next/previous focused plot (`⌥o` also cycles previous) |
| `⌥n` | New worker (Claude session) |
| `⌥⇧N` | Workflow picker — choose default / trellis / grow for the new worker |
| `⌥w` | Jump to first worker |
| `⌥s` | Jump to project shell |
| `⌥]` / `⌥[` | Cycle workers and shell |
| `⌥x` | Kill current worker (shell is protected) |
| `⌥b` | Bounce current worker (restart Claude via `--resume`, preserve history) |
| `⌥e` | Hold/release current worker — interrupt its turn (sends Escape) and mark it `paused`; toggles back to `idle` when already held |
| `⌥g` | Focus growhouse (lower-left) |
| `⌥r` | Focus root shell (lower-left) |
| `⌥l` | Focus logs view (lower-left); also acknowledges the alert badge |
| `⌥h` | Focus history view (lower-left): the focused worker's prompt history + brief assistant summaries |
| `⌥d` | Focus diary view (lower-left): the focused project's diary open in `$EDITOR` |
| `⌥/` | Edit the sticky logs filter via `tmux command-prompt` (pre-filled with current value); empty input clears |
| `⌥.` | Clear the sticky logs filter immediately (no prompt) |

## Pane Management

### Swapping Mechanism
Each project's workers and shell live in hidden tmux windows when not active. When you switch projects:

1. A temporary hidden window is created, and the current active pane is swapped into it via `swap-pane`
2. The target project's pane is swapped from its hidden window into the right slot via `swap-pane`, then the hidden window is killed
3. The status pane and header update to reflect the new state

This preserves both the layout tree (the right pane slot is never destroyed) and all worker state across switches.

### Hidden Window Naming
Hidden windows follow the convention: `_<project>-worker-<N>`, `_<project>-shell`, `_<project>-poller`, `_<project>-review-<worker>`, `_garden-growhouse`, `_garden-root`, `_garden-logs`, `_garden-history`, `_garden-diary`, `_garden-usage-poller`, and `_garden-watchdog`. When switching projects, the visible pane is parked as `_<project>-active`. The underscore prefix marks them as managed by garden — not user-facing.

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
2. **reviewing**: Poller launches a Claude reviewer (`claude -p`) asynchronously in a hidden tmux window (`_<project>-review-<worker>`). The reviewer runs inside the worker's worktree, so it inherits the worktree's `.claude/settings.json` sandbox config (auto-allow for bash within the configured filesystem/network allowlist). The reviewer rebases onto the base branch, resolves conflicts, runs optional checks, fixes check failures, and reviews code against project rules. The poller polls for review completion by checking if the review window still exists. On completion: if clean or fixed, force-pushes and transitions to merge-pending. If the reviewer cannot fix the issues, transitions to failing. If the review process fails for transient reasons (Anthropic API 5xx/429/`overloaded_error`/`rate_limit_error` and the reviewer didn't commit anything), the poller auto-retries with exponential backoff (30 s → 2 min → 5 min, budget 3) before escalating to `failing` with `failingReason: "transient-review"` — `garden kick` accepts that reason and re-queues without requiring new commits. A session/usage-**quota** cutoff is distinct: when the reviewer hit the operator's rolling Claude window ("You've hit your session limit …") it emits no verdict, and because the reviewer runs on the operator's own account, that limit *is* the operator's window — so a seconds-scale retry is useless. The poller auto-retries on a flat 15-min cadence (budget 24, ~6 h ceiling) until the window resets and the review merges on its own with no operator action, escalating to `failingReason: "quota"` only if it never clears. Both `transient-review` and `quota` are `garden kick`-recoverable. Other unparseable outputs (reviewer went off-rails, timeout) still transition to failing immediately. Unreviewed code is never auto-merged.
4. **merge-pending**: Review passed, waiting to merge. A serial merge queue processes one merge at a time per project (ordered by timestamp). The merge sequence: rebase onto current base branch, force-push, then ff-merge. If the rebase has conflicts (because the base branch advanced while waiting), the poller launches a dedicated resolver and transitions to `resolving`. If the rebase is clean, the merge proceeds.
5. **resolving**: A dedicated resolver Claude session is running in a hidden tmux window with a single narrow job: complete `git rebase origin/<base>` and commit any conflict resolutions. The resolver does not push and does not re-review code — the code was already approved. On Stop, the poller verifies the rebase actually landed (no `.git/rebase-merge` or `.git/rebase-apply` present; `origin/<base>` is an ancestor of HEAD; HEAD differs from `preResolveSha`). On pass, force-pushes and returns to `merge-pending`. On fail, retries up to `resolveAttempts = 2`; on budget exhaustion, transitions to `failing`. A genuine unresolvable conflict parks with `failingReason: "code"` and an operator alert that names the unmerged files; a transient backend outage (Anthropic/codex 5xx/429/`overloaded_error`/`rate_limit_error`) parks with the kick-recoverable `failingReason: "transient-review"` instead — `garden kick` re-queues the merge once the outage clears, rather than telling the operator to push a fix they don't need. Any worker push during `resolving` aborts and resets budget — the worker's new state is the new ground truth.
6. **failing**: Unfixable review issues, failed review process, exhausted resolver budget, or repeated merge failures (a diverged base or branch protection wedges the merge; once `failCount` hits the retry budget the poller stops re-reviewing and parks here instead of burning a review every cycle). Poller watches for new commits via SHA tracking. After 30s debounce with no new pushes, state transitions back to working for retry. Each failure increments a `failCount` on the worker entry; after 3 consecutive failures, an alert is surfaced. The count resets on successful merge.
7. **merged**: Transient post-merge beat — code just landed on the base branch. Renders neutral (not green) in the status pane; not an operator-actionable signal. Cleared the moment the auto-continue prompt's `UserPromptSubmit` fires, returning the worker to `working` for the next phase. If `agentStatus` is `working` at the moment `finalizeMerge` runs (a prompt landed mid-merge race), the poller clears `merged` immediately to `working`.
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

The resolved value is validated against the local `refs/remotes/origin/<base>` ref (no network call, so the ⌥n hotkey stays snappy on slow links) and pinned to the worker in the registry (`WorkerEntry.baseBranch`). If the base branch has no local origin ref — the natural case is the operator switching the main checkout to a brand-new local-only branch and pressing ⌥n — garden treats the ⌥n press as a publish gesture and runs `git push -u origin <base>` from the main checkout to create the ref, then proceeds with worker creation. Only when the publish itself fails (no remote, branch protection, non-fast-forward, network) is the worker rejected; the rejection message surfaces the actual git stderr so the operator can fix the real problem instead of guessing. The bootstrap script's fresh `git fetch origin <base>` is the backstop: if the branch has since been deleted from origin, the fetch fails and a `bootstrap` alert fires. Once pinned, all consumers (poller, Stop hook, kick, resume) use `getWorkerBaseBranch(entry, ...)` — they never re-resolve from the main checkout, so switching the main checkout's branch after a worker is spawned does not retarget that worker.

If the Stop hook still fails to count commits ahead of `origin/<pinned-base>` (e.g., the base branch was deleted from origin after creation), it raises a one-per-hour `base-drift` alert (`source: worker`, `level: warn`) rather than silently swallowing the error.

**checks**: Command the reviewer runs in the worker's worktree after rebasing onto the base branch, so checks validate the combined state of the branch plus latest base. If checks fail, the reviewer fixes the issues and re-runs. No checks configured means the reviewer only does the code review.

**postMerge**: Command that runs on the main checkout after merging, but only when the *working tree itself* advanced — i.e. the base branch was the one checked out, so `merge --ff-only` moved the tree to the merged code. When the operator has parked the checkout on a different branch (the deliberate many-base workflow), the merged base ref is advanced on its own via `git fetch origin <base>:<base>` (fast-forward-enforced, worktree-aware) without touching the working tree, and postMerge is skipped — building a tree that's on another branch would build the wrong branch. That off-base ref advance is silent: a local base ref that merely trailed origin is normal here, not drift. The base checkout is the operator's shared working directory — they commit, pull, and edit in it, and postMerge itself can dirty it — not a pristine mirror, so a failed fast-forward is expected and benign for merge correctness (the work already landed on origin; only the local rebuild lags). One failure mode self-heals: when the on-base checkout has a redundant local commit whose *clean* tree already equals origin/<base> (e.g. an operator heal commit whose change also merged the normal way), the ref is reset onto origin (`reset --hard`, reflog-preserved, working tree unmoved) and postMerge runs — no alert. The remaining states alert, framed as "merge succeeded, local checkout needs a hand": it has *diverged* from origin with real local-only content (warn, the operator reconciles by hand), the base is checked out in *another worktree* (warn, that worktree needs a pull), the on-base checkout is *dirty* with uncommitted changes (warn, the operator cleans it), or it is *wedged*/unfetchable (`stuck`, error — infra trouble). Each alert fires only on *entry* into the state, not on every subsequent merge while it persists. This is essential for projects like garden itself, where the poller runs the compiled CLI. When the garden project itself rebuilds successfully, the poller spawns a detached `_post-rebuild-refresh` via the freshly-built binary; it respawns the status and logs panes, calls `restartLongLivedPollers()` so the usage-poller and per-project pollers reload the new bundle (they cache JS in memory at spawn time), and refreshes the dashboard.

**sandboxDomains**: Comma-separated list of extra network domains added to each worker/reviewer's sandbox allowlist. Use for private registries, internal services, or other hosts beyond the garden-wide defaults (Anthropic, GitHub, npm, the project's git remote host). Set via `garden config <project> sandboxDomains foo.com,bar.com`.

**claudeProfile**: Name of an alternate Claude Code config dir to use for this project's workers and reviewers. Profiles are registered globally under `claudeProfiles:` in `~/.garden/config.yml` (each entry has a `configDir` and optional display `label`). When set, every `claude` invocation for the project — workers, reviewers, resolvers, the prefix-`C` ad-hoc launcher — runs with `CLAUDE_CONFIG_DIR=<configDir>`, so Claude reads its credentials, settings, and history from that dir instead of `~/.claude`. Projects without `claudeProfile` use the personal default. Manage profiles with `garden claude-profile {list,add,remove,login}`. The usage meter is not split per profile: `/api/oauth/usage` aggregates by user identity, so two workspace tokens tied to one email return identical data. Per-workspace quota for the alternate plan, if any, is only visible from the org owner's admin dashboard.

**provider**: Name of a model provider this project's WORKERS run on — an Anthropic-Messages-compatible backend (DeepSeek's `/anthropic` endpoint, a local Ollama, a gateway) the unchanged Claude Code harness reaches by env swap. Providers are registered globally under `providers:` in `~/.garden/config.yml` via `garden provider add <name> --base-url <url> --token-env <ENV_VAR> [--map opus=m1,sonnet=m2,haiku=m3] [--egress h1,h2]`. Worker launch commands get `ANTHROPIC_BASE_URL`, an `ANTHROPIC_AUTH_TOKEN="$<ENV_VAR>"` reference expanded at spawn time (the key never enters config or command lines), and `ANTHROPIC_DEFAULT_*_MODEL` from the model map; the sandbox allowlist gains the base-URL host plus any `--egress` extras. The key reaches panes through the tmux **session environment**: the server's own env is frozen at server start, so garden's operator-shell entry points (`provider add`, `config set provider`, dashboard create/attach, `workers new`, `auth status`) sync the key from the invoking shell via `tmux set-environment`, `workers new` refuses to spawn a provider worker whose key is in neither place, and `garden auth status` reports both locations (and syncs as it reads). Reviewer, resolver, and ci-fix agents deliberately ignore this key: `reviewerEnvPrefix` actively empties any inherited `ANTHROPIC_*` provider env so they stay on the first-party Anthropic path, and each of the three defaults to Opus on the claude-code path (not just for provider-backed projects) — the strong reviewer is the safety net that makes cheap or experimental worker models safe to try. Each default is overridable per role via `garden config <p> role <role> model <m>` (and the whole role is routable to another harness, e.g. Codex; see the per-role resolution in `docs/MULTI-MODEL.md` "Phase 4"). When *every* project has a provider, the Claude usage poller, the Stop-hook usage refresh, `garden usage`, and the meter pane switch off with an explanatory line. Applies to newly created or bounced workers; live panes keep their pinned env. See `docs/MULTI-MODEL.md`.

### Merge Handling
After a review passes, workers enter the `merge-pending` state. The merge queue processes one worker at a time per project (ordered by `mergePendingAt` timestamp):

1. Fetch latest base branch (this also refreshes the local `origin/<base>` ref the resume check and CI gate read).
2. **Resume an interrupted merge** (`src/dashboard/poller-merge.ts`): if the worktree HEAD is already contained in `origin/<base>`, a prior finalization already fast-forward-pushed the merge but was torn down before the terminal-state transition (e.g. a garden rebuild restarted every project's poller mid-finalize). Skip the re-merge and run only the idempotent post-merge tail. Naively re-running rebase + force-push here would hit a `--force-with-lease` "stale info" rejection against the now-deleted remote branch; the force-push catch then re-arms a full re-review of the already-merged worker and fires a spurious push-failed alert (it no longer strands the worker, but the wasted cycle also masks a trellis ALIGNED convergence).
3. **Defer while the worker's Claude is mid-turn** (`src/dashboard/poller-merge.ts`): if the merge-pending worker's `agentStatus` is `working` — the operator prompted it and it may be editing tracked files not yet committed — defer the whole merge before touching the shared worktree. `cleanWorktree` (`git checkout -- .`) and the rebase below rewrite tracked files and HEAD; a plain rebase would refuse on a dirty tree, but `cleanWorktree` turns that refusal into a silent wipe of the uncommitted edits (there is no reflog for unstaged changes). This sits **after** the resume check — an already-pushed merge is safe to finalize regardless — and `launchResolver` guards the identical shared-worktree hazard. The deferral cannot strand the worker: its Stop hook re-pokes on turn end, and the watchdog backstops a lost poke since `merge-pending` is a watched state.
4. **CI gate** (`src/dashboard/poller-ci.ts`): query `gh api repos/<owner>/<repo>/commits/<sha>/check-runs` for the worker's HEAD. **Success** (every completed check-run conclusion is `success`/`skipped`/`neutral`) → proceed. **Pending** (any check-run not yet `completed`) → defer the merge with a 60 s re-poke; worker stays in `merge-pending`. **Failed** (any non-success conclusion) → dispatch a self-healing ci-fix agent (`src/dashboard/poller-ci-fix.ts`) in a hidden `_<project>-ci-fix-<worker>` tmux window and transition the worker to `ci-fixing`. The agent runs in the worker's own worktree, reads the failing logs via `gh run view --log-failed`, makes the minimum fix to turn the checks green, and pushes. The poller's verification path checks that the agent actually advanced HEAD (against the captured `preCiFixSha`) and that origin tracking matches the new local HEAD; on success it transitions back to `merge-pending` so the CI gate re-runs against the new SHA. Verdict `FIXED` without a verified push, verdict `FAILED`, or unparseable output: retry up to budget (3 attempts per merge cycle), then escalate to `failing` and an operator alert — `failingReason: "ci"` (push a fix) for a genuinely red CI the agent couldn't repair, or the kick-recoverable `failingReason: "transient-review"` when the agent only hit transient backend outages (Anthropic/codex 5xx/429/overloaded) and never reached its backend. Lifecycle alerts fire at warn level on launch and on successful push (so the operator can watch the auto-heal land); at error level when the budget exhausts. The gate is a no-op for projects with `requireCiSuccess: false`, projects whose `origin` isn't a github.com remote, environments where `gh` isn't installed, and commits with zero check-runs on a project never observed to run CI (no CI configured). On a project already known to run CI, zero check-runs on a freshly force-pushed SHA (a reviewer-fix or ci-fix commit whose runs haven't materialized yet — they appear ~30 s after a push) are treated as not-yet-materialized: the merge defers within a bounded grace window (3 min, re-poked every 60 s) before passing through, rather than merging the exact commit CI most needs to vet un-gated. The gate runs **before** the rebase/force-push so it reads CI for the SHA the worker actually published; the rebased commits that ultimately land on base are the same commits in rebased form, and the workers we guard push frequently enough during their turn that CI is usually already settled by the time the reviewer signs off. This is defense-in-depth against GitHub branch protection — the poller's force-push path bypasses the merge UI entirely, so branch protection alone can't block a red CI.
5. Clear any leftover rebase state from a prior crashed resolver (`ensureNoRebaseInProgress`)
6. Rebase onto current base branch
7. If rebase conflicts: abort rebase, launch a dedicated resolver in the worktree and transition to `resolving`. The resolver completes the rebase and commits the resolution; the poller verifies and pushes. Budget is 2 attempts per merge; exhaustion transitions to `failing` with an operator alert — `failingReason: "code"` naming the unmerged files for a genuine conflict, or the kick-recoverable `failingReason: "transient-review"` when the resolver only hit transient backend outages.
8. If rebase is clean: force-push the rebased branch, fast-forward the remote base branch via direct refspec push (no local checkout needed)
9. Notify live sibling workers with overlapping files (see below)
10. Advance the local base branch to the merged tip — `merge --ff-only` if it is the checked-out branch (also moves the working tree, so postMerge can run), otherwise `git fetch origin <base>:<base>` to advance the ref alone (working tree untouched, postMerge skipped). A clean advance is silent, as is auto-healing a redundant local commit whose clean tree already matches origin (reset onto origin, then postMerge runs). The remaining states alert only on entry: the local base diverged from origin with real local-only content (warn), the base is checked out in another worktree (warn), the on-base checkout is dirty (warn), or it is wedged/unfetchable (`stuck`, error)
11. Mark the worker as `merged` (or `done` if `.garden-done` is present at the worktree) in the registry

The worker and its worktree are not automatically cleaned up on merge. Cleanup happens only when the user kills the worker with `opt-x` or runs `garden reset`. This allows inspecting merged work before disposal.

Projects don't block each other — each project has its own poller and merge queue.

### Auto-Continue Across the Merge Boundary
Multi-phase work (build → review → merge → keep building) used to require the operator to type "please proceed" after every merge. Garden eliminates that step: `finalizeMerge` ends with a call to `maybeAutoContinue`, which dispatches a delayed `_continue-worker-after-merge` subprocess that sends a "previous changes were merged, continue with the next phase" prompt to the worker pane.

The worker opts out by writing the sentinel file `<worktree>/.garden-done` before ending its turn. The worktree system prompt and the `done` skill instruct every worker, before writing the sentinel, to re-read the operator's original request and confirm each deliverable they asked for has landed in a merged commit and is verified working — explicitly distinguishing the operator's deliverables from the internal stages of any analysis or workflow the worker ran (research, design, implementation, a review or verification pass), which do not count, and treating "I feel finished" as insufficient evidence. This gate exists because the decision rests on the worker's own (and possibly context-compacted) memory of the request — garden keeps no durable copy of it for default workers — so deep or long-running workers were observed declaring done while a named deliverable was still unlanded or merely pushed-but-unverified. The bias remains toward stopping over inventing busywork: a worker must never fabricate "while we're here" scope to justify continuing. If the sentinel is missing on merge, garden assumes there is more to do and re-prompts.

Workers are nudged to invoke the sentinel-write via the `done` skill installed under `<worktree>/.claude/skills/done/SKILL.md` (see `src/dashboard/skills.ts`). Claude Code requires the directory + `SKILL.md` layout for project-skill discovery — a flat `done.md` at `.claude/skills/` is silently invisible to the planner. Skill descriptions act as Claude's trigger condition during planning — Claude evaluates "should I invoke this?" alongside its other tools when deciding the next action — which is more reliable than instructions buried in the system prompt. The skill body (when, when-not, mechanics, recovery) lives only in the skill file, not the main worktree-rules block, so the prompt stays scannable. The bootstrap script inlines the skill content at worker creation; the harness adapter's `installRuntimeConfig` rewrites it on every refresh/bounce so workers from rebuilds pick up content changes. Older workers created before the skill existed do not get it retroactively without a refresh — bouncing or recreating them is the only way to install it.

A second skill, `handoff`, lives alongside `done` and lets the operator pass a task to a fresh worker on another (or the same) project. Triggered when the operator instructs the worker to hand off; the skill body teaches the heredoc recipe `garden handoff <project> <<'EOF' ... EOF`. The CLI command writes the briefing to `~/.garden/sessions/seeds/seed-*.txt`, then submits a JSON request file under `~/.garden/sessions/handoff-requests/<id>.req.json` and pokes one or more project pollers. The pollers run in unsandboxed tmux windows; on wake they call `processPendingHandoffs` (`src/dashboard/handoff-dispatch.ts`), which atomically claims each request via `rename(*.req.json → *.req.json.processing)` and calls `newWorker({ projectName, seedMessageFile, background: true })`. The `--ultracode` flag threads a `ultracode: true` opt through the same request file into `newWorker`, which pins the child to Opus (`entry.model`) and stamps `entry.ultracode` so the harness `buildAgentCommand` renders `--effort max --settings '{"ultracodeKeywordTrigger":"on"}'` on every launch/resume/bounce — the operator's "hand this off to an ultracode worker" with no manual escape-edit-continue. The dispatcher writes a response file the CLI polls for (up to 15s) so the operator-facing line "Handed off to <project>/<worker>" still prints the real worker name. The request-file detour is load-bearing: the CLI runs inside the source worker's Claude Code OS sandbox, which blocks the tmux server socket (`/private/tmp/tmux-*/default` → "Operation not permitted"), so the CLI cannot create tmux windows itself. Routing through a poller — which lives outside the sandbox — gets the tmux ops done while keeping every disk write inside the sandbox-allowed `~/.garden/sessions` tree. The `background:true` flag remains load-bearing inside `newWorker`: handoff must not yank the operator out of whatever pane they're focused on, so the new worker is born hidden and `newWorker` skips the cross-project active-project/plot switch, the park-to-hidden of the visible pane, and the restore-from-hidden swap that the ⌥n hotkey path uses. The operator's `activePaneType`/`activeWindowName`/`activePaneId` stay exactly as they were; the dashboard refresh picks up the new worker in the status pane, and the operator reaches it via ⌥<n> on the target project + ⌥w to cycle. A delayed `_seed-worker` subprocess polls until the worker's `agentStatus` leaves `loading` and then sends the seed prompt prefixed with `[handoff from <source-project>/<source-worker>]`; pane resolution falls back to `windowExists` when the seed fires, so a hidden worker still receives its briefing. The source worker writes `.garden-done` itself (per the skill recipe) rather than having the CLI command do it implicitly, mirroring the `done` skill's recipe-style instructions and leaving room for a final commit before handoff.

Handoff callbacks (opt-in via `--expect-callback`) close the parent → child → parent communication loop. When the source worker passes `--expect-callback`, the CLI captures `$GARDEN_PROJECT`/`$GARDEN_WORKER` and threads `expectCallback`/`parentProject`/`parentWorker` through the request file into `processPendingHandoffs`, which stamps `parentProject` + `parentWorker` + `handoffCallbackExpected` onto the child's `WorkerEntry`. The dispatch chokepoint is `transitionState` (`src/dashboard/poller-state.ts`): every PrState write flows through it, so terminal transitions to `merged`/`done`/`failing` are detected in one place regardless of which poller (review, merge, resolve) triggered them. On the first terminal write for a callback-expecting child, `maybeFireHandoffCallback` sets `handoffCallbackFiredAt` under the registry lock (idempotency guard against replayed terminal events) and lazy-imports `notifyHandoffCallback` from `continue.ts` to paste a one-shot `[garden] Handoff callback: …` prompt into the parent's pane. `notifyHandoffCallback` reuses `continueWorker`'s pane-resolution and claude-status gate (working/asking → silent no-op), so the callback can't stomp on a parent that has already moved on or is mid-turn. The child can stage a freeform note at any point before its terminal state via `garden reply -m "<text>"` (or stdin/heredoc); the note is stored on the child's own `WorkerEntry.handoffReplyNote` field and folded verbatim into the callback prompt. Multiple `garden reply` calls accumulate (blank-line-separated); `--replace` clobbers an earlier draft. Callbacks are opt-in by design — default handoff behavior is unchanged, so fan-out handoffs (where the parent doesn't care about results) and pass-the-baton handoffs (where the parent calls `done` immediately) both work exactly as before.

The sentinel lives at the worktree root because that is the only path satisfying all three constraints: (1) writable by Claude Code's harness sandbox, which blocks raw `/tmp` writes — only `$TMPDIR` works there; (2) writable by the OS-level Seatbelt sandbox (`src/dashboard/sandbox.ts` `DEFAULT_ALLOW_WRITE`), which permits the worktree, `~/.npm`, `~/.cache`, and `/tmp`; (3) reconstructible by the poller from the registry entry's `worktreePath`. `$TMPDIR` falls out on (3) because it is per-Claude-session. `~/.garden/sessions` falls out on (2). The worktree is the intersection. As a side effect, `killPane` no longer needs explicit sentinel cleanup — `git worktree remove --force` in `backgroundGitCleanup` removes the file along with the worktree. Workers are instructed not to commit the file (it is per-worker state, not project state).

Skip conditions (logged at `debug`):
- The `.garden-done` sentinel exists for this worker.
- `agentStatus` is `working` or `asking` — the operator is already typing, same guard the interrupt-recovery path uses.
- `lastAutoContinueAt` is within the idempotency window — 10 seconds for the merge-time dispatch (guard against merge-event replay), 60 seconds for the gate-reopen sweep (guard against double-pasting a delivery still in flight).

The merge-continue prompt includes contextual preambles when applicable: a stale-files list when the reviewer modified files, a manual-sync nudge when the worktree could not auto-sync, and a postMerge acknowledgement when the project has a `postMerge` hook configured (so the worker does not redundantly suggest the operator run build/install steps that already ran).

Both autocontinue prompts (post-merge and interrupt recovery) lead with a branch-identity line naming the worker's own branch and base and forbidding any rebase/merge/reset/checkout onto another worker's branch. Every worker runs in a worktree of the *shared* project repo, so a sibling worker's branch — and its `origin/<branch>` tracking ref — is visible in `git branch -a` from this worktree. The prompt previously named no branch, and a worker on a multi-worker project rebased onto a sibling's branch when it tried to "continue on the merged base"; pinning the branch in the prompt (`branchIdentityLine` in `continue.ts`) removes that ambiguity. The base-sync operations the manual-sync nudge relies on (`git reset --hard origin/<base>`) stay allowed — only sibling worker branches are off-limits.

A successful dispatch logs at `info` (`auto-continued worker after merge`) so the operator sees the lifecycle transition in `⌥l` logs alongside the `merged` line. The post-merge dispatch fires a 5s primary plus a 16s retry (`_continue-worker-after-merge-if-stuck`): the 5s delay lets postMerge and the reviewer's force-push settle before keys land in the pane, and the retry recovers the case where the worker still read as `working`/`asking` at the 5s mark (e.g. mid-turn on a long response), under which the single-shot prompt would otherwise be lost with no recovery. The retry re-fires only when `prState` is still `merged` — a delivered prompt fires `UserPromptSubmit`, which clears `merged`, so any other state proves the prompt already landed and the retry no-ops rather than double-prompting. The interrupt-recovery dispatch uses the same shape (6s primary + 16s retry) to absorb the slower TUI bind under dashboard-rebuild load.

**Operator-draft deferral.** The `agentStatus` gate above catches a worker that is *already running*, but not one that is idle while the operator is mid-compose — text sitting unsent in the Claude input box. Pasting then would concatenate garden's prompt onto that draft and submit the mangled result. Every delivery path (interrupt recovery, post-merge, handoff callback) funnels through `continueWorker`, which therefore inspects the pane before pasting: `capturePaneText` reads the visible pane, `capturePaneCursor` reads the caret position, and `extractOperatorDraft` returns the operator's draft as the span between the prompt marker (`❯`, U+276F) on the bottom-most input line and the cursor column. A non-empty result means an unsent draft, and `continueWorker` skips the paste (leaving `interruptedWhileWorking` set, since the prompt is still owed). The cursor bound is load-bearing: an *empty* box is not blank — Claude Code paints dimmed ghost/placeholder/autosuggest text into it, and `capture-pane` strips the dimming, so the bare text after the marker can't distinguish a suggestion from a draft. The caret can: it sits at the end of typed text with any suggestion rendered to its right, so the marker-to-cursor span is empty for a ghost-only box and exactly the typed prefix when a partial draft is followed by a completion. A caret on a row below the marker means the draft wrapped (non-empty); a caret above it is not on the input line (no draft). The capture therefore drops `-J` so its row indices stay aligned with `cursor_y`. When the cursor is unreadable (pane unreachable), `extractOperatorDraft` falls back to the whole post-marker remainder — the conservative pre-cursor behavior — but in that state `capturePaneText` is also empty, so it resolves to "no draft" anyway. On a draft-deferred skip, the two primary dispatch legs (`_continue-worker`, `_continue-worker-after-merge`) re-arm via `rearmContinueIfDrafting`: a fresh detached child every 12s, threading an `--attempt N` counter, until the box clears or `MAX_DRAFT_RETRIES` (15, ≈3 min) is hit. Re-arm fires only while a draft is still present, so an `agentStatus`-caused skip (empty box) falls through to the existing `*-if-stuck` leg instead, and a delivered prompt — whose paste transiently fills the box — is not mistaken for a draft because the handler keys re-arm on the delivery result, not a re-capture. The merge path's gate-reopen sweep remains the long-tail backstop past the retry cap.

`garden pause <worker>` writes the sentinel; `garden resume <worker>` deletes it. Killing a worker (`opt-x`) removes the worktree entirely, so the sentinel goes with it.

A second, *global* opt-out lives alongside the per-worker sentinel: a gate in `~/.garden/config.yml` under `autoContinue` (`enabled`, `usageThreshold`, `resumeAfterReset`). Defaults are enabled, 95% threshold, no auto-resume. The gate is consulted on every `maybeAutoContinue` after the per-worker checks. The threshold check evaluates the `5h` and `weekly` meters from the latest usage snapshot; sonnet is intentionally excluded since the workhorse is Opus. When any included meter is at or above `usageThreshold`, the gate flips `enabled=false`, persists `pausedUntil` (the latest `resetsAt` among tripped meters, so re-enabling does not immediately re-trip on the slower-resetting meter) and `pausedReason`, and fires a warn-level alert (source `usage`). With `resumeAfterReset: true`, the next call past `pausedUntil` flips `enabled` back on automatically; with it off (the default), the operator must run `garden auto on`. Manage with `garden auto [on|off|status|threshold <N>|resume-on-reset on|off]` (alias `auto-continue`).

A gate block does not lose the prompt. `maybeAutoContinue` is one-shot at merge time, so a worker whose continue was blocked parks in `merged`; the merged-state handler (`handleMerged` in `src/dashboard/poller-merge.ts`, shared by every workflow) replays the same auto-continue decision on each poller poke — the gate-reopen sweep. The first poke after the gate reopens (manual `garden auto on` or `resumeAfterReset` firing) delivers the stranded prompt; the sweep also fires the auto-resume check itself, so `resumeAfterReset` does not need a fresh merge to take effect. The poke is guaranteed even on a fully idle garden: `garden auto on` and `garden auto resume-on-reset on` wake every project poller directly, and the usage poller pokes all pollers when it observes that a paused window with auto-resume armed has passed (`pokeOnGateReset` in `usage-poller.ts`). Sweep-specific guards: a 60s idempotency window (wider than the 5s/16s delivery legs, so an in-flight merge-time dispatch is never double-pasted — this also recovers prompts whose paste was silently lost), gate blocks logged at debug rather than info (one line per stranded worker per poke otherwise), and `claudeStatus: "exited"` workers skipped (no live Claude pane to paste into; reviving one is bounce territory).

### Sibling Merge Notification
When code merges, the poller compares the changed files against every other active worker's branch in the same project. If files overlap and the sibling has a live Claude session, it is notified via `tmux send-keys` with the merged worker's commit summary and overlapping file list so it can review and avoid reverting the merged work. Dead workers are skipped — they will hit rebase conflicts naturally on their next review cycle.

### Claude Usage Meter
Three quota bars render in the top-left "garden" title pane sitting above the status pane: the 5-hour rolling window, the weekly total, and the Sonnet-specific weekly meter (shown as `—` on plans that don't track it separately). Bars are colored by utilization — green <60%, yellow <85%, red at or above — with a bright `│` marker overlaid at the current time position in the window (so you can see whether usage is ahead of or behind the clock) and the reset countdown next to each. The third bar is Sonnet rather than Opus because on Max plans the API returns `seven_day_opus: null` (Opus usage is rolled into the weekly total) while `seven_day_sonnet` is the populated model-specific bucket.

When the account has pay-as-you-go extra usage enabled, the response's `extra_usage` bucket is surfaced as a dim credit footer under the three bars (`extra  1234 / 5000 credits (25%)`) — an absolute credit tally, not a resetting time-window meter, so it renders as text rather than a fourth bar and is hidden entirely when extra usage is off. The same line appears in `garden usage`. A null/uncapped `monthly_limit` degrades to whatever fields the endpoint returns (`1234 credits used`).

Data comes from `GET https://api.anthropic.com/api/oauth/usage`, authenticated with the OAuth token Claude Code already writes to the macOS Keychain under service `Claude Code-credentials`. The endpoint is undocumented and strictly rate-limited (observed `Retry-After` of ~50 minutes after three rapid probes), so the fetch cadence is deliberately conservative. Credential discovery probes the `GARDEN_CLAUDE_SESSION_KEY` env var first, then the macOS Keychain, then `~/.claude/.credentials.json`. When the stored access token has expired, the meter exchanges the refresh token against `https://platform.claude.com/v1/oauth/token` (the same endpoint Claude Code uses) and persists the rotated tokens back to the source so claude CLI's next read stays in sync — otherwise the meter would silently revoke claude CLI's cached refresh token and force the operator to re-login. A revoked refresh token (`invalid_grant`) is surfaced as `login expired` and held off the API for `AUTH_BACKOFF_MS` until `garden login` heals it. On any other failure the snapshot records a short error and the pane renders a single dim "claude usage: …" line instead of bars — the meter is a progressive enhancement, not a dependency. Fetched snapshots live in `~/.garden/sessions/claude-usage.json`.

Refresh is event-driven first, timer-driven as a fallback. A singleton poller (`_garden-usage-poller`) refreshes every 5 minutes (honoring `Retry-After` on 429), which keeps idle dashboards current. On top of that, every Claude Code `Stop` hook calls `maybeRefreshUsage()` — a fire-and-forget detached fetch gated by a 60-second cooldown, so the meter updates shortly after each end-of-turn (when quota has just advanced) without hammering the rate-limited endpoint. The Retry-After window is also honored by the hook path: if the server is actively throttling, hook calls short-circuit until the window expires.

### Alerts
The dashboard surfaces important events as alerts — persistent messages that require operator attention. Alerts are stored atomically in `~/.garden/sessions/dashboard.alerts.json` (same write-tmp-then-rename pattern as other state files), capped at 100 entries.

**Events that generate alerts:**
- Worker bootstrap could not fast-forward main checkout (stale main, dirty worktree)
- Review process failure (Claude unavailable, timeout, unparseable output)
- Reviewer or resolver exceeded the 60-minute wall-clock cap and was killed (typically a hung subprocess — e.g. tests with no timeout blocked by the sandbox — wedging the state machine)
- Reviewer could not fix issues (FAILED verdict)
- Merge failure
- Force-push failed after a passing review, in the merge queue, or after conflict resolution (source: `poller`, level: `warn`; deduped per worker via `push-failed:<project>:<worker>`). The worker is re-armed for a fresh review (`pendingReviewAt` + a 30 s delayed poke) rather than stranded, so a transient failure self-heals and a persistent one stays visible
- Local base ref could not be advanced after merge — only when it diverged from origin with real local-only content (warn), is checked out in another worktree (warn), the on-base checkout is dirty (warn), or it is wedged/unfetchable (`stuck`, error); a clean off-base ref advance and an auto-healed redundant local commit are both silent. Each alert fires only on entry into the state, not every merge cycle
- Repeated failures (3+ consecutive failures on the same worker)
- Base-branch drift after worker creation (Stop hook cannot count commits against `origin/<pinned-base>`; deduped to one firing per worker per hour)
- Auto-continue auto-disabled by usage threshold (source: `usage`, level: `warn`)
- `.garden-done` tracked in HEAD of the project main at worker spawn (source: `create`, level: `warn`; deduped per project per hour).
- Orphaned worker window: a live tmux worker window with no registry entry (the create/sweep race casualty; source: `watchdog`, level: `warn`; deduped per orphan per hour).

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
- Every agent-CLI-specific decision (the launch command dialect, the `.claude/settings.json` runtime config below, headless invocation, transcript reading, prompt delivery, transient-error shapes, session identity) lives on the harness adapter registry in `src/dashboard/harness/` — `claude-code` is the default adapter and the only one wired to workers; a second adapter (`codex`) is reachable as a **reviewer/resolver/ci-fix** via per-role resolution (`garden config <p> role reviewer harness codex`; see `resolveReviewRole` in `src/dashboard/roles.ts`), but the Codex worker path is not yet wired (Phase 4 reviewer-first). `WorkerEntry.harness` names a worker's adapter and the launch/resume/bounce/loop paths thread it. The adapter splits into a light core (`harness/core.ts`, importable from the hook bundle) and the full adapter (`harness/index.ts`, adds the heavyweight `installRuntimeConfig`; CLI bundle only) so `dist/hook.js` stays lean; `package.json` sets `"sideEffects": false` to keep that split effective, which means modules must stay free of import-time side effects (only entry points execute at top level). See `docs/MULTI-MODEL.md` "Layer 3".
- Each worktree's `.claude/settings.json` configures Claude's OS-level sandbox (Seatbelt on macOS, bubblewrap on Linux) — auto-allow mode approves sandboxed bash without prompts while blocking out-of-allowlist filesystem writes and network calls at the kernel. Workers and reviewers run without `--dangerously-skip-permissions` but remain autonomous inside the sandbox. Allowlist defaults (Anthropic, GitHub, npm, the project's git remote host, plus worktree + standard subprocess caches) are built in `src/dashboard/sandbox.ts` and extended per-project via the `sandboxDomains` config key. The config lives in `settings.json` (not `settings.local.json`) because Claude Code writes permission approvals to `settings.local.json` and can clobber our keys; keeping hooks/sandbox in `settings.json` isolates them from that churn.
- The same `settings.json` sets `permissions.defaultMode: "auto"`, so every Claude process in the worktree (worker, reviewer, resolver, resume) starts in Anthropic's built-in auto mode. The classifier auto-approves low-risk tool calls and only prompts the operator for the rest. `permissions.allow` also pre-approves `Bash(tmux:*)` plus read-only tail utilities (`echo`, `head`, `tail`, `cat`, `grep`, `wc`) since workers routinely query pane/window state and pipe or chain the output — Claude Code checks each subcommand of a compound bash call against the allow list independently, so without the tails a command like `tmux list-keys -T root | head -40` still escalates. Garden wires a `PermissionRequest` hook (no matcher — all tools) that fires **only** when a prompt is actually being shown; it flips `agentStatus` to `asking`, which renders the worker row bold-yellow in the status pane. A catch-all `PostToolUse` hook (no matcher — all tools) flips `asking` back to `working` once the operator approves, regardless of which tool the classifier escalated

## Worker Status Detection

Each worker has two independent status axes:

**Process status** — what Claude is doing, written by Claude Code hooks (except `paused`, written by the operator `hold` action — a raw Escape fires no hook):
- ⏳ **loading** — worker pane started, bootstrap script running, Claude not yet launched
- ◇ **ready** — Claude launched but not yet tasked
- ⠋ **working** — Claude is processing a submitted prompt (braille spinner animation)
- ⚑ **asking** — Claude is blocked mid-turn on operator input (plan approval, question, permission escalation); row is highlighted bold-yellow in the status pane
- ◆ **idle** — turn has ended, Claude is at the prompt waiting for the next message
- ‖ **paused** — operator deliberately halted the worker mid-turn via the hold action (`⌥e` / `garden hold`); held awaiting a redirect, cleared by the next prompt; row is highlighted bold-cyan in the status pane
- ○ **exited** — process has terminated

**Lifecycle status** — where the worker's code is in the review pipeline, written by the poller:
- ◎ **reviewing** — automated reviewer is checking the worker's commits
- ◷ **merge-pending** — review passed, in the merge queue
- ◔ **resolving** — automated resolver is fixing a merge-queue rebase conflict
- ✖ **failing** — review failed, waiting for worker to fix; row is highlighted bold-red in the status pane
- ✓ **merged** — transient post-merge beat; row is uncolored (not actionable; cleared by the next auto-continue prompt)
- ✓ **done** — worker self-declared finished via `.garden-done`; row is highlighted bold-green in the status pane (operator cleanup signal)

The display combines both axes: lifecycle state takes priority when present, otherwise the process state is shown. A worker that is "reviewing" shows the reviewing bullseye regardless of what Claude is doing. Only workers in the "working" display state get the animated braille spinner.

**Base-branch divergence indicator**: a worker whose pinned `baseBranch` differs from the branch currently checked out in its project's main directory gets a yellow `→ <baseBranch>` appended to its row in the status pane. Workers pin their base at creation time, so switching the project's checkout afterwards leaves any in-flight workers merging to a branch other than the one checked out. The yellow arrow makes that pin/checkout mismatch visible without requiring a registry inspection — informational, not a warning: merging into a non-checked-out base is a fully supported workflow (the post-merge step advances that base's ref on its own, no checkout switch needed). When *any* worker in a project diverges, the workers whose base *matches* the checkout also show their base — in grey, not yellow (`projectHasBranchDivergence` / `formatBranchHint` in `src/commands/status.ts`). This keeps a mixed project unambiguous: without it, one row would read `→ feature` and the siblings nothing, leaving it unclear whether the silent rows target the checkout or simply aren't flagged. Grey reserves yellow for the worker whose base actually diverges from the checkout while still answering "what does each worker target?" per row. The project's current branch itself isn't repeated next to the project name — the bottom status bar (`formatLeft` in `header.ts`) already shows it for the active project. The post-merge alert is correspondingly narrow — `notifyPostMerge` stays silent when an off-base base ref advances cleanly or a redundant local commit auto-heals, and otherwise alerts only on entry into the state: `diverged` (real local-only commits, warn), `checked-out-elsewhere` (base live in another worktree, warn), `dirty` (uncommitted changes on the on-base checkout, warn), or `stuck` (fetch failure or a wedged checkout, error).

**Worker row ordering**: rows are ordered by attention and recency rather than by name (the name is just an address handle). `compareWorkerFreshness` (`src/dashboard/registry.ts`) sorts by attention tier first — (0) blocked on the operator (`failing`/`asking`), (1) new and awaiting its first prompt (`loading`/`ready`), (2) active/recent (`working`/`idle`/`paused`/`exited`), (3) in flight under the poller (`reviewing`/`resolving`/`ci-fixing`/`merge-pending`/`merged`), (4) `done` (sinks to the bottom as a cleanup candidate) — then within a tier by freshness descending, then by name as a stable tiebreak. The bands follow a worker's life top-to-bottom: needs-you at the top, then the work descends through active → in-flight → done as it heads toward merge. The in-flight prState is classified before the new (`loading`/`ready`) agentStatus, so a worker whose turn ended and was picked up for review lands in the in-flight band even if its agentStatus is a stale `ready`/`loading` (a STATUS.md invariant). The active band's tier number is the exported `ACTIVE_SORT_TIER`, shared with `isWorkerStale` so the stale-dim follows the active band if the bands are ever renumbered. Ordering freshness (`workerSortFreshness`) is the most recent of `lastStateChangeAt` — the worker's last *meaningful* transition (an `agentStatus`/`prState` change, stamped by `applyAndLog` only when state actually moves) — then `lastEventAt`, then `createdAt` (stamped at `addWorker` so a brand-new worker sorts fresh before its first hook; both timestamps are backfilled on read for pre-existing entries by `migrateCreatedAt` / `migrateLastStateChangeAt`). Keying on the state-change time, not the raw `lastEventAt`, is deliberate: the 10s hook heartbeat bumps `lastEventAt` for a working agent without repainting the status pane (the refresh is gated on a real state change), so ordering by `lastEventAt` let the registry order drift silently and then snap on the next unrelated repaint — e.g. the operator navigating to another worker. Tying ordering to the transition keeps every reorder coincident with the repaint that the same transition already triggers, so the list stays fixed while you navigate and only moves when a worker genuinely changes state. Freshness is compared at 60-second granularity so a burst of state changes among co-active workers doesn't reshuffle the list. The same comparator orders the ⌥]/⌥[ cycle (`cyclePane`) and the `whoami` sibling list, so navigation matches the visible order; the default focus target on project switch is deliberately left in tmux insertion order. An active-band worker untouched for over `WORKER_STALE_MS` (24 h — far coarser than the 15-min health staleness, since this only drives a dim) is rendered faint via `dimRow`, which re-arms the faint attribute after each inner ANSI reset so embedded colored segments (the base-divergence hint, the trellis counter) don't half-brighten the row. Blocked, new, in-flight, and `done` rows are never dimmed; nor is the one colored active-band state, `paused` (an explicit operator hold rendered bold cyan — a dim would fight that color and hide a deliberate state), which `isWorkerStale` excludes so `dimRow` only ever wraps an uncolored row.

The full specification for status tracking and display lives in `docs/STATUS.md`. The registry is the single source of truth: Claude Code hooks (`SessionStart`, `UserPromptSubmit`, `Stop`) write `agentStatus`; the poller writes `prState`; the tmux `pane-died` hook writes `agentStatus="exited"`; the operator `hold` action (`⌥e` / `garden hold`) writes `agentStatus="paused"` (the one operator-initiated writer — a raw Escape interrupt fires no hook, so a deliberate halt is otherwise invisible). There is no pgrep, no marker file, no fallback poll. Every transition is event-triggered. The single recurring tick in the system is the liveness watchdog (`watchdog.ts`, `_garden-watchdog` window): every 60 s it (1) re-pokes any project holding a worker stranded in an active state past a 5 min staleness threshold, recovering dropped one-shot pokes (poller respawn gap, reboot-killed detached wake-ups), and (2) keeps each project's poller window healthy — respawning it if it died uncleanly (a poke is useless with no poller reading the FIFO) and collapsing duplicates to one if a spawn race left several (resolving windows by index, since a tmux name target is ambiguous across duplicates). The spawn race itself is prevented at the source: `startProjectPoller` runs its check-and-spawn under a per-project file lock (`<project>-poller.spawn.lock`), so two concurrent starters serialize and the second no-ops instead of opening a second window — the watchdog collapse is now a backstop, not the primary defense. It also (3) alerts on orphaned worker windows — a live tmux worker window with no registry entry, the casualty of the create/sweep race fixed in `dropGhostEntries` — making the detached worker visible (detection only; it never reconstructs the entry) so the operator can recover it. These actions only restore lost event delivery or surface a casualty — the watchdog never transitions state itself.

## Commands

### Projects
```
garden init                        # Initialize ~/.garden, check for tmux
garden add [path]                  # Add a project (defaults to cwd, name = basename)
garden create <path>               # Scaffold a new project: mkdir, git init -b main, private GitHub repo under the gh-authed account, add to active plot
garden remove <name>               # Remove a project
garden list                        # List all projects
garden config <project> [key] [val]  # View or set project config
garden diary [project] [--path]    # Open the project's diary in $EDITOR (--path prints the file path)
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
garden provider [list|add|remove]  # Manage model providers (Anthropic-compatible backends
                                   # for workers; reviewers stay on Anthropic)
garden login [profile]             # Re-authenticate Claude (personal, or a profile)
garden auth status                 # Show credential presence, expiry, and displacement (and provider env vars)
garden usage [refresh]             # Show or force-refresh the Claude usage meter
```

### Dashboard
```
garden dashboard                   # Open the dashboard (creates if needed)
garden dashboard exit              # Close the dashboard
garden keys                        # Show dashboard keybindings
garden status [--all]              # Show worker status for the active plot (--all: every plot)
garden whoami [worker]             # Show the current worker's registry entry (uses $GARDEN_WORKER)
garden alerts                      # View dashboard alerts
garden alerts clear                # Dismiss all alerts
garden logs [options]              # View dashboard logs (pretty-printed)
garden logs filter [<expr>]        # Show / set the sticky filter (also via ⌥/ in dashboard)
garden logs filter --clear         # Remove the sticky filter
garden kick <worker>               # Re-arm a stranded 'working' worker for review; also recovers
                                   # `failing` workers whose failingReason is review-side
                                   # (`unparseable-verdict` / `transient-review` / `quota`)
garden bounce <worker>             # Restart a worker's Claude process (preserves session history)
garden hold <worker>               # Interrupt a working worker and mark it 'paused' (⌥e in the dashboard; next prompt resumes)
garden pause <worker>              # Suppress post-merge auto-continue (writes the .garden-done sentinel)
garden resume <worker>             # Re-arm post-merge auto-continue (clears the .garden-done sentinel)
garden handoff <project> [--expect-callback] [--ultracode] [-m ...]  # Spawn a fresh worker on <project> seeded with a briefing (stdin or -m); callback fires a prompt at the source pane on terminal state; --ultracode creates it in ultracode mode (Opus + max effort + dynamic workflows)
garden reply [-m ...]              # Stage a freeform note from a handoff child for its parent (delivered with the callback)
garden auto [on|off|status]        # Toggle the global auto-continue gate
garden auto threshold <N>          # Set the usage-threshold percent (auto-disable above this)
garden auto resume-on-reset on|off # Re-enable automatically after the usage window resets
garden rebuild                     # Rebuild garden and relaunch dashboard
```

### Workers and trellises
```
garden workers new <project> [--workflow trellis|grow]
                             [--trellis <name>]
                             [--seed <text> | --seed-file <path>]
                             [--model <alias-or-id>] [--max-iterations N]
                                   # Spawn a worker. Default workflow plants an interactive worker;
                                   # trellis plants a vine bound to the named trellis (--model
                                   # overrides the Sonnet default); grow plants a bounded
                                   # hardening loop seeded by --seed/--seed-file. --model pins the
                                   # worker model on any workflow: an Anthropic alias or any
                                   # concrete model id the backend accepts, persisted so the pin
                                   # survives bounce/resume/respawn (account default when absent).
                                   # --max-iterations defaults to project.maxGrowIterations or 5.
garden workers grow [<worker>] [--seed <text> | --seed-file <path> | --goal-file <path>]
                             [--max-iterations N]
                                   # Convert an active default worker into grow. Self-resolves the
                                   # worker via $GARDEN_WORKER when no positional arg is given.
                                   # Writes the seed to <worktree>/.garden/grow-goal.md (the durable,
                                   # operator-editable goal anchor) and flips entry.workflow to grow.
                                   # Re-conversion of an already-grow or trellis worker is rejected.
garden trellis new <project> <name>
                                   # Scaffold a trellis at <project>/.garden/trellises/<name>.md
                                   # (see WORKFLOWS.md § "Trellis workflow" for the workflow spec)
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
    dashboard.registry.json.bak-<ts>      # Rotating pre-shrink registry snapshot (keep 5)
    dashboard.registry.json.corrupt-<ts>  # Quarantined unreadable registry, preserved for recovery
    dashboard.alerts.json # Operator alerts (review failures, merge errors)
    dashboard-<project>.context  # System prompt for project's Claude sessions
    dashboard-<project>-<branch>.context  # Worktree worker context
    dashboard.log           # Structured JSON log
    <project>-poll-signal   # FIFO for waking project pollers
    <project>-poller.spawn.lock  # Transient lock serializing poller spawn across processes
    growhouse-init.zsh            # Garden growhouse init (custom prompt + auto-dispatch)
    diary-view.sh                 # Diary view editor loop (⌥d)
    bootstrap-<project>-<branch>.sh       # Transient worktree bootstrap script
    <project>-<worker>-review-prompt.txt  # Transient review prompt
    <project>-<worker>-review-result.txt  # Transient review output
    status.rendered           # Pre-rendered status snapshot for instant display
    usage.rendered            # Pre-rendered usage meter snapshot for the usage pane
    history.rendered          # Pre-rendered conversation snapshot for the ⌥h history pane
    claude-usage.json         # Claude quota snapshot (5h / weekly / sonnet)
  diary/
    <project>.md          # Per-project diary (operator notes; garden diary / ⌥d)
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

- TypeScript, compiled via esbuild to `dist/cli.js` (plus `dist/hook.js`, a minimal entrypoint for the per-tool-call Claude hook so its node cold-start parses only the hook dispatcher's closure)
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

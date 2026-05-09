# Garden

Garden is a CLI orchestrator for managing interactive Claude Code sessions across multiple projects via a tmux dashboard.

**Authoritative docs.** This file is a quick-start. Depth lives elsewhere — when something here disagrees with one of these, the spec wins:

- `DESIGN.md` — full architecture
- `rules.md` — coding rules loaded into every Claude session (commit/test/scope discipline)
- `WORKFLOWS.md` — workflow registry design, "how to add a new workflow", and trellis/grow workflow specs
- `docs/STATUS.md` — worker status state machine (spec)
- `docs/TRACKS.md` — multi-track / promotion pipeline (design target, no code yet)
- `docs/` — additional design docs and behavioral specs; see `docs/README.md` for the index

## Build and run

```bash
npm install
npm run build          # esbuild → dist/cli.js
npm run dev -- help    # tsx during development
npm test               # vitest unit + integration; tsc --noEmit
```

`npm link` makes `garden` global. `dist/cli.js` is the symlink target — `npm run build` is all you need after edits.

## Source layout

- `src/cli.ts` — entry point, command dispatch, help text
- `src/commands/<name>.ts` — one async function per CLI command, registered in `commands/index.ts`
- `src/config.ts` / `src/session.ts` / `src/rules.ts` / `src/output.ts` / `src/version.ts` — config (`~/.garden/config.yml`), tmux sessions, system-prompt assembly, TTY-aware output, build version
- `src/dashboard/` — the dashboard. Notable modules:
  - `index.ts`, `create.ts`, `workers.ts`, `navigate.ts`, `layout.ts`, `hotkeys.ts`, `header.ts` — UI lifecycle and pane swapping
  - `state.ts`, `registry.ts`, `validate.ts` — atomic state files + tmux/state reconciliation
  - `tmux.ts`, `window-names.ts`, `atomic-write.ts` — low-level helpers
  - `poller.ts` + `poller-state.ts` + `poller-{review,merge,resolve,fifo}.ts` — per-project review/merge/resolve lifecycle, event-driven via FIFO
  - `workflows/` — workflow registry (`default.ts`, `trellis.ts`, `grow.ts`, `types.ts`, `index.ts`); see `WORKFLOWS.md`
  - `hooks/default.ts` + `hook-dispatcher.ts` — Claude Code hook routing
  - `trellis-{tag,verdict,prompts,continue,model,picker}.ts` — trellis workflow internals
  - `grow-continue.ts` — grow workflow's `LoopHooks`, continue-prompt builder, and iter-1 seed prompt
  - `prompts.ts` + `prompt-compose.ts` + `headless-agent.ts` + `verdict.ts` — prompt assembly and headless reviewer/resolver primitives
  - `continue.ts` — auto-continue (interrupt-recovery and post-merge) and `.garden-done` sentinel
  - `loop.ts` — workflow-agnostic loop primitive (cold-respawn + per-iteration counter) shared by trellis and grow workflows
  - `skills.ts` — bundles `done` / `handoff` / `trellis-author` / `grow` skills into worker worktrees
  - `usage.ts` + `usage-poller.ts` — Claude quota meter
  - `sandbox.ts`, `credentials.ts`, `claude-env.ts` — Claude profile / Keychain / sandbox config
  - `alerts.ts`, `log.ts`, `git.ts`, `names.ts`, `runner.ts`, `plot-status.ts` — utilities

## CLI surface

Use `garden <cmd> --help` for flag-level detail. High-level groupings:

- **Projects**: `add` / `create` / `remove` / `config` (keys: `checks`, `postMerge`, `sandboxDomains`, `claudeProfile`, `logColor`). `register`/`unregister` aliased.
- **Plots**: `plot` (alias `p`) — named ordered subsets of projects (max 9). `⌥1–⌥9` index into the active plot, `⌥p` cycles focused plots. `focus` / `unfocus` / `reorder` toggle and order ⌥p inclusion. Storage: `~/.garden/config.yml`.
- **Claude profiles**: `claude-profile add|login|list|remove`. Per-project `claudeProfile` config injects `CLAUDE_CONFIG_DIR` for that project's worker / reviewer / resolver. macOS Keychain footgun: every Claude `/login` overwrites one shared entry, so always re-auth via `garden login` (it strips `CLAUDE_CONFIG_DIR` and captures Keychain → file for profiles).
- **Auth**: `login [profile]`, `auth status` (presence/expiry/Keychain displacement diagnostic).
- **Workers**: `whoami`, `kick`, `bounce`, `pause`, `resume`, `health [--fix]`, `logs [-w <worker>]`. Workers can self-identify via `$GARDEN_WORKER` / `$GARDEN_BRANCH` / `$GARDEN_BASE_BRANCH` / `$GARDEN_PROJECT`.
- **Trellis**: `trellis list|show|new|status|amend|resume|retire|revive`; plant via `workers new <project> --workflow trellis --trellis <name> [--model opus|sonnet]` or the `⌥⇧N` workflow picker (`(t)` row). Spec: `WORKFLOWS.md` § "Trellis workflow".
- **Grow**: bounded hardening loop with no design doc; plant via `workers new <project> --workflow grow --seed <text>|--seed-file <path> [--max-iterations N]` or the `⌥⇧N` workflow picker (`(g)` row, prompts for a single-line seed; the CLI is required for multi-line / metacharacter-bearing seeds). Convert an active default worker into grow with `workers grow [<worker>] --seed/--seed-file/--goal-file <…>` (self-resolves via `$GARDEN_WORKER`). The durable goal lives at `<worktree>/.garden/grow-goal.md` and is operator-editable mid-loop — every iteration re-reads it at dispatch time. Default budget 5 (overridable per-project via `maxGrowIterations` config or per-plant via `--max-iterations`). Runs on the account-default model.
- **Auto-continue gate**: `auto [on|off|status|threshold N|resume-on-reset on|off]` — global gate in `~/.garden/config.yml` under `autoContinue`.

## Workers (worktrees)

Every worker runs in its own git worktree at `~/.garden/worktrees/<project>/<worker>/`, on a branch named after the worker, branched from `origin/<base>` (fetched first). Each project has a dedicated **poller** in a hidden tmux window that drives review/merge using local git — no GitHub PRs. Reviewers and resolvers run headless in hidden `_<project>-review-<worker>` / `_<project>-resolve-<worker>` windows. Multiple reviews run in parallel within a project; the merge queue is serial. Full state machine: `docs/STATUS.md`.

Worker prompt is `rules.md` (global) + `<project>/.garden/rules.md` (project) + per-worker preamble built by `buildWorktreeRules` in `src/rules.ts`. The preamble names the project's configured `checks` command (from `garden config <project> checks`) so the worker, the reviewer, and CI all gate on the same string — keep that command aligned with `.github/workflows/test.yml` or you reintroduce the asymmetry that caused workers to push broken state and CI to email "Run failed" on every commit. Worker panes start in `permissions.defaultMode: "auto"` inside an OS sandbox (Seatbelt/bubblewrap) configured by `sandbox.ts`. Workers commit and push autonomously — no operator confirmation; the poller handles review and merge.

## Dashboard internals

Permanent tmux layout — content is moved between visible slots and **hidden underscore-prefixed windows** (`_<project>-worker-N`, `_<project>-shell`, `_<project>-poller`, `_garden-{growhouse,root,logs}`) via `tmux swap-pane`. Pane slots are never destroyed.

- **Left column**: `garden` title pane (Claude quota meters), `status` pane (per-project worker list), and `growhouse` pane (cycles `⌥g` growhouse / `⌥r` root / `⌥l` logs). Title and status panes refresh via SIGUSR1, replaying pre-baked files written atomically.
- **Logs sticky filter**: `⌥/` opens `tmux command-prompt` (pre-filled with the current filter); the typed expression persists in `~/.garden/sessions/logs.filter.json` and is honored by both the dashboard logs pane and bare `garden logs` until cleared. Syntax: `key:value` for `worker`/`src`/`level`/`project` plus bare fuzzy tokens. CLI escape hatch for metacharacter-bearing exprs: `garden logs filter <expr>` / `--clear`.
- **State of record**: registry (`dashboard.registry.json`) for workers, state file (`dashboard.state.json`) for UI runtime, alerts file for operator-visible issues. Tmux is the source of truth for pane existence; `validate.ts` reconciles on attach.
- **Status**: hooks write `claudeStatus`, the poller writes `prState`, `pane-died` writes `claudeStatus="exited"`. Event-driven; no fallback poll. Spec: `docs/STATUS.md`.
- **Auto-continue**: `continue.ts` re-prompts after interrupt (mid-turn dashboard kill / tmux crash / bounce-while-working) and after a clean merge (with the list of files changed during review). Worker opts out by writing `.garden-done` in its worktree root before ending its turn. `garden pause` / `resume` toggle the sentinel; `UserPromptSubmit` clears it.
- **Post-merge**: fast-forward the local base checkout, run optional `postMerge`, then notify live siblings whose files overlap.

## Conventions

- **JSON when piped, pretty in TTY** — use `output()` / `outputLines()` from `src/output.ts` for all data output.
- **Project resolution** — use `resolveProject()` / `resolveProjectFromArgs()`. Never parse names manually. Auto-detected from cwd inside a registered project.
- **Bash escaping** — every value interpolated into a generated shell command goes through `shellEscape` (`src/dashboard/tmux.ts`). It returns a fully single-quoted bash literal — use the result without surrounding `'...'`. No inline `.replace(/'/g, "'\\''")`.
- **Atomic writes** — every persisted state file goes through `atomicWriteFile` (`src/dashboard/atomic-write.ts`). Readers pair this with an `is{ShapeName}` type guard before trusting parsed JSON. See `readDashState` / `readRegistry` / `readAlerts`.
- **Alert dedup** — `addAlert` (`src/dashboard/alerts.ts`) suppresses identical-key alerts within a 1-hour window. Default key is `${level}:${source}:${project}:${worker}:${message[:200]}`. When a message embeds time-varying detail (SHA, error string, file list), pass an explicit stable `dedupKey`.
- **Specs** — files containing the marker phrase **"the code is wrong"** in their opening paragraph are specs. The reviewer prompt-prepends a strong warning never to edit a spec to match the code. If the code disagrees, fix the code.
- **Tests** — `npm test` runs unit + integration (`test/integration/**`); the bundled-hook test catches module-init cycles vitest's source resolver misses. Don't move integration tests behind a flag.

## Adding a new command

1. `src/commands/<name>.ts` — export an async `(args: string[]) => Promise<void>`
2. Register in `src/commands/index.ts`
3. Add to the help text in `src/cli.ts`
4. Use `output()` and `resolveProject*()` per Conventions

## Adding a new workflow

See `WORKFLOWS.md`. Short version: define a `WorkflowDefinition` in `src/dashboard/workflows/<name>.ts`, register in `workflows/index.ts`, reuse `default.ts`'s state handlers and `defaultHookHandlers` wherever possible. Tests: `test/workflows.test.ts` + an integration test on real fs/git. Two concrete examples in the registry: `trellis.ts` (full-spec divergence — own reviewer prompt, verdict vocab, model pinning, post-merge dispatch) and `grow.ts` (minimal divergence — reuses default's reviewer/verdicts/hooks; only the iteration counter and post-merge dispatch differ). If your workflow shares the cold-respawn-per-iteration mechanics, supply a `LoopHooks` instance (see `src/dashboard/loop.ts`) instead of forking the dance.

**Per-workflow runtime data** (the trellis pattern). Anything the workflow accumulates per worker goes under an optional sub-object on `WorkerEntry`, not as flat fields — `entry.trellis?: TrellisData` and `entry.grow?: GrowData` are the two concrete examples (`registry.ts`). `updateWorkerFields({ <subObject>: { <field>: ... } })` deep-merges that sub-object so callers don't clobber sibling fields. Add a legacy-shape migration to `readRegistry` so on-disk entries from earlier shapes get rebuilt at next read. Don't add flat per-workflow fields to `WorkerEntry`; the flat-fields path was deliberately removed (the migration in `readRegistry` exists to scrub stragglers from old on-disk entries).

## Keeping docs current

If your task changes commands, architecture, file layout, or conventions, update `DESIGN.md` and this file. Specs (`docs/STATUS.md`, WORKFLOWS.md § "Trellis workflow", WORKFLOWS.md § "Grow workflow", `docs/TRACKS.md`) are design targets — fix the code to match, not the spec.

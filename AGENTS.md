# Garden

Garden is a CLI orchestrator for managing interactive coding-agent sessions (Claude Code, Codex) across multiple projects via a tmux dashboard.

This file is the project's agent instructions for every harness. Claude Code reads `CLAUDE.md` (a one-line `@AGENTS.md` import); Codex reads `AGENTS.md`. Edit this file, never a second copy.

**This file is a quick-start, not the spec.** It is loaded into every session, so it stays short: a map of where things live and the invariants that bite. Depth lives in these docs, and when they disagree with this file, they win:

- `DESIGN.md` — full architecture: layout, hotkeys, poller/merge, config, usage meter, alerts, telemetry, cleanup, resurrection, bead intake
- `docs/STATUS.md` — worker status state machine (spec)
- `WORKFLOWS.md` — workflow registry and the default/trellis/grow/designer/planner/holistic-review specs
- `docs/MULTI-MODEL.md` — providers, the neutral core, harness adapters
- `docs/EXTENDING.md` — checklists for adding a command, tmux hook, config key, garden setting, workflow, or harness
- `docs/SANDBOX-THREAT-MODEL.md` — trust boundaries
- `docs/README.md` — index of everything else
- `rules.md` (global) + `.garden/rules.md` (project) — coding rules composed into every worker's prompt

Before changing a subsystem, grep `DESIGN.md` for it. Most modules have a section explaining a past incident that the code's shape exists to prevent.

## Build and run

Node 22.12+ (22.x) or 24+. Fresh-machine setup is in `README.md`; `garden doctor` preflights the environment.

```bash
npm install
npm run build          # esbuild -> dist/cli.js + dist/hook.js
npm run dev -- help    # tsx during development
npm test               # vitest unit + integration; tsc --noEmit
garden checks          # the project's full checks command, under the machine-wide checks semaphore
```

`npm link` makes `garden` global, pointing at `dist/cli.js`. After an edit, `npm run build` is all that's needed. Each poll execs the current bundle, so pollers pick up a rebuild without a restart.

- **Two bundles.** `dist/hook.js` (from `src/hook-entry.ts`) serves the per-tool-call hook and must stay lean: `hook-bundle.real.test.ts` enforces a 140KB ceiling and forbids it from importing the workflow registry or poller handlers. Check whether new code is reachable from `hook-dispatcher.ts` / `hooks/default.ts` / `registry.ts` / `continue.ts` before adding imports there. Per-harness tables that must be tree-shakeable (`prompt-verify.ts` `READERS`, `task-title.ts` `OPENING_READERS`) are leaves for this reason, not `HarnessCore` methods.
- **No import-time side effects.** `package.json` sets `"sideEffects": false`; only `cli.ts` and `hook-entry.ts` execute at top level.
- Bundles are written to a temp file and renamed into place (`scripts/build.mjs`). The live fleet executes them continuously.

## Source layout

- `src/cli.ts` — entry point, dispatch, help text. `src/commands/<name>.ts` — one async function per command, registered in `commands/index.ts`.
- `src/config.ts` (`~/.garden/config.yml`, project + garden-level settings), `src/paths.ts`, `src/rules.ts` (worker prompt assembly), `src/output.ts`, `src/checks-semaphore.ts`.
- `src/dashboard/` — everything else:
  - UI and panes: `index.ts`, `create.ts`, `navigate.ts`, `layout.ts`, `header.ts`, `hotkeys.ts` + `keybindings.ts` (single source of truth for Meta-key hotkeys), menus (`menu.ts`, `worker-menu.ts` ⌥i, `project-menu.ts` ⌥,, `garden-menu.ts` ⌥;, `crew-picker.ts` ⌥⇧C, `trellis-picker.ts` + `spawn-draft.ts` for the ⌥⇧N composer).
  - State: `registry.ts` (workers), `state.ts` (UI runtime), `validate.ts` (tmux/state reconciliation, including the sole right-slot repair `healActivePaneInState`), `window-heal.ts`, `atomic-write.ts`, `file-lock.ts`, `alerts.ts`, `log.ts`.
  - Worker lifecycle: `workers.ts` (spawn/stop/hold/block), `launch-plan.ts` (fail-closed launch identity for every launch path), `continue.ts` (auto-continue, sentinels, seed delivery), `prompt-verify.ts`, `worker-cleanup.ts` + `worker-reap.ts` (removal), `resurrect.ts`.
  - Poller: `poller.ts`, `poller-state.ts`, `poller-{review,merge,resolve,ci,ci-fix,holistic-review,intake,fifo}.ts`; prompts in `prompts.ts` + `prompt-compose.ts` (review prompts degrade under a 1MB ceiling); `headless-agent.ts`, `verdict.ts`, `verdict-extract.ts`.
  - `workflows/` — poller-only `WorkflowDefinition`s (`default`, `trellis`, `grow`, `designer`, `planner`). Hooks are shared in `hooks/default.ts` and must not import this registry.
  - `harness/` — adapter registry. `core.ts` is the light registry, safe in the hook bundle; `index.ts` is the full one, CLI bundle only. `claude-code*`, `codex*`, `agents-md.ts`.
  - `watchdog.ts` — the one recurring tick: liveness re-pokes, poller health, orphan detection, sleep discounting, cleanup retries, model-drift and title sweeps, hourly housekeeping. Use `grep -a` or `rg` on it, since it contains a NUL byte.
  - Others worth knowing: `crew.ts` (crews), `beads.ts` (bd client), `usage.ts` + `usage-poller.ts` + `codex-usage.ts` (quota meters), `telemetry.ts` (event ledger behind `garden stats`/`resurrect`), `conversation.ts` (transcript parsing for ⌥h), `sandbox.ts`, `codex-input.ts`, `model-drift.ts`, `task-title.ts`, `headless-paths.ts`, `tmux.ts`.

## How it works, in one screen

- Each worker runs in its own git worktree at `~/.garden/worktrees/<project>/<worker>/`, on a branch named after the worker, cut from `origin/<base>`. Workers commit and push on their own.
- Each project has a **poller** in a hidden tmux window. It drives review -> CI gate -> rebase -> merge with local git (no GitHub PRs). Reviewers, resolvers, and CI fixers run headless in hidden `_<project>-review-<worker>` (etc.) windows. Reviews run in parallel; merges are serial. A failed review is fixed by the reviewer, not bounced back to the worker.
- A multi-phase default worker gets one final holistic review of the whole-task diff (`holisticReview: off|shadow|fix`, default `fix`).
- Status: hooks write `agentStatus`, the poller writes `prState`, and `pane-died` writes `exited`. Event-driven by design; the watchdog only recovers lost events. Spec: `docs/STATUS.md`.
- A worker's prompt is `rules.md` + `.garden/rules.md` + the per-worker preamble from `buildWorktreeRules`. The preamble names the project's `checks` command, so worker, reviewer, and CI gate on the same string. Keep it aligned with `.github/workflows/test.yml`.
- A worker ends a turn in one of three ways: continue (auto-continue fires after merge), `.garden-done` (finished), or `garden blocked "<question>"` (needs the operator).
- On claude-code, garden's hooks, sandbox, and status line live in a settings file under `~/.garden/control/claude-settings/`, passed via `--settings`. Never write to the worktree's `.claude/settings.json`.
- Dashboard: permanent tmux layout. Content moves between visible slots and hidden underscore-prefixed windows via `swap-pane`. See DESIGN.md "Dashboard Layout" / "Pane Management".

## CLI

`garden help` lists every command. Groups: projects (`add`/`create`/`remove`/`config`), crews (`crew`), plots (`plot`/`focus`), workers (`workers new|stop|grow`, `whoami`, `review`, `kick`, `bounce`, `hold`, `pause`, `resume`, `blocked`, `logs`, `checks`, `health`), inspection (`queue`, `alerts`, `notes`, `stats`, `doctor`, `usage`), auth (`login`, `auth status`, `claude-profile`, `provider`), workflows (`trellis`, `designer publish`, `handoff`, `reply`), recovery (`resurrect`, `redraw`), and garden-wide settings (`auto`, `limits`, `awake`, `poke`, `diary`). DESIGN.md "Commands" has details.

## Conventions and invariants

- **Output** — `output()` / `outputLines()` from `src/output.ts`: JSON when piped, pretty in a TTY.
- **Project resolution** — `resolveProject()` / `resolveProjectFromArgs()`. Worker arguments go through `resolveWorkerArg` (`commands/resolve-worker.ts`). Never parse names by hand.
- **Shell escaping** — every value interpolated into a generated shell command goes through `shellEscape` (`dashboard/tmux.ts`). It returns a complete single-quoted literal; don't wrap it in quotes.
- **Shared state is transactional** — persist only through `atomicWriteFile`, and hold the matching lock for every read-modify-write: `mutateConfig`, `mutateRegistry` / `updateWorkerFieldsIf`, `withStateLock`, `addWorkerWithUniqueName`. `prState` moves only through `transitionState`; `forceTransitionState` is reserved for explicit recovery. Readers validate persisted JSON with an `is<Shape>` type guard.
- **State a poll must remember lives on disk** — each poll is a fresh process, so a module-level `Map` in poller code is per-poll scratch, not memory.
- **Tmux is the source of truth for pane existence, but only when it answers** — a sandboxed `garden` is denied the tmux socket, and a failed probe looks exactly like a missing pane. Confirm the session is reachable before healing state from absence.
- **Trusted vs. worker-writable** — `~/.garden/sessions` is writable by every worker sandbox, so it holds IPC requests and nothing a worker must not forge. Control-plane files (headless prompts/results, reports, Claude settings) live under `~/.garden/control`, using paths from `headless-paths.ts`.
- **Dashboard windows** — create them with `newDashboardWindow` / `newDashboardWindowPaned` (`tmux.ts`), never raw `new-window`, which leaks the window name into the status bar. Underscore-prefixed windows belong to dashboard code only.
- **Alerts** — `addAlert` dedups identical keys for an hour. Pass a stable `dedupKey` when the message embeds a SHA, error text, or file list. Alerts are for faults; routine lifecycle beats are logged, not alerted.
- **Per-workflow runtime data** goes in an optional sub-object on `WorkerEntry` (`entry.trellis`, `entry.grow`), never as flat fields.
- **Harness-specific call sites don't follow from registration.** The composer vocabularies, `harnessTuning`, the `READERS` / `OPENING_READERS` tables, `pinnedModel`, and others all branch explicitly. Read `docs/EXTENDING.md` before touching a harness or workflow.
- **Specs** — a doc whose opening paragraph contains "the code is wrong" is a spec (`docs/STATUS.md`, the WORKFLOWS.md trellis/grow sections, `docs/TRACKS.md`). If the code disagrees with it, fix the code. `docs/future/` is background only.
- **Tests** — vitest. `npm test` runs unit + integration; keep integration tests out from behind flags. `test/setup-home.ts` pins `HOME` to a throwaway dir; a test needing a writable garden uses `useTmpHome()` (`test/helpers.ts`), and nothing reads the real `~/.garden`. Real-tmux tests skip inside a worker sandbox and run on CI.

## Keeping docs current

- Architecture, behavior, and incident history go in `DESIGN.md` (or the relevant spec under `docs/`), not here.
- Update this file only when a quick-start fact changes: a new top-level module, a new command group, a new invariant every contributor must know. One line per fact. If it needs a paragraph, it belongs in DESIGN.md with a pointer here.
- Keep this file under ~15KB. It is loaded into every session, and it grew to 158KB once before.

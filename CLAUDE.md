# Garden — Claude Code Context

## What is this project?

Garden is a CLI orchestrator for managing multiple Claude Code sessions. It lets a developer (or a future orchestrator agent) dispatch tasks to Claude sessions running in tmux, monitor their progress, and manage task lists — all through a single CLI.

## Architecture

Garden has two layers that both use the same CLI:

- **Orchestrator layer** — the human (or future agent) who runs `garden start`, `garden status`, `garden next`. Sees all projects.
- **Worker layer** — Claude sessions scoped to a single project via `GARDEN_PROJECT` env var. Only interacts with its own tasks via `garden tasks`.

Key subsystems:
- `src/cli.ts` — entry point, command dispatch
- `src/commands/` — one file per command
- `src/worker.ts` — internal task loop that runs inside tmux sessions
- `src/config.ts` — reads/writes `~/.garden/config.yml`
- `src/tasks.ts` — reads/writes `<project>/.garden/tasks.json`
- `src/session.ts` — tmux operations, state files
- `src/events.ts` — append-only event log at `~/.garden/events.jsonl`
- `src/notify.ts` — macOS notifications via osascript
- `src/output.ts` — TTY detection, JSON vs pretty output

## Design principles

1. **Agent-first.** Every interaction goes through the CLI. Output is JSON when piped, pretty when in a TTY. If an agent can't do something, it's a missing feature.
2. **Files over databases.** Config is YAML, tasks are JSON, events are JSONL. All human-inspectable.
3. **Shell out, don't abstract.** Garden calls `claude` directly. It does not wrap the Claude API.
4. **Events over state.** The event log (`events.jsonl`) is the source of truth. State files are ephemeral.

## Build and run

```bash
npm install
npm run build          # esbuild → dist/cli.js
npm run dev -- help    # run via tsx during development
npx tsx src/cli.ts     # same as above
```

The `bin` field in package.json points to `dist/cli.js`. Use `npm link` to make `garden` available globally.

## Key conventions

- All read commands detect TTY: JSON for non-TTY, pretty for TTY. Use `src/output.ts` helpers.
- Task IDs are 4-char random hex strings.
- Event log is append-only JSONL. Never delete or rewrite entries.
- The worker (`garden _worker`) is an internal command, not user-facing. It runs inside tmux.
- tmux sessions are named `garden-<project>`.
- `GARDEN_PROJECT` env var is set inside sessions to scope `garden tasks` commands.

## Adding a new command

1. Create `src/commands/<name>.ts` exporting an async function
2. Register it in `src/commands/index.ts`
3. Add it to the help text in `src/cli.ts`
4. Use `output()` from `src/output.ts` for any data the command returns

## Task lifecycle

Tasks flow: `pending` → `in_progress` → `done` | `blocked` | `failed`

The worker sets tasks to `in_progress` when starting them. Claude (inside the session) calls `garden tasks done <id>` or `garden tasks block <id>` to complete them. The worker confirms completion after Claude exits.

## Testing during development

```bash
npx tsx src/cli.ts init
npx tsx src/cli.ts add myproject /path/to/project
npx tsx src/cli.ts tasks myproject add "Test task"
npx tsx src/cli.ts start myproject
npx tsx src/cli.ts status
npx tsx src/cli.ts attach myproject    # ctrl-b d to detach
```

Set `GARDEN_DEBUG=1` for verbose output from session start.

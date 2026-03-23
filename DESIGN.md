# Garden

A minimal CLI orchestrator for managing Claude Code sessions across multiple projects.

Garden is a personal tool — opinionated toward a single developer managing many projects from one place. It is not a team tool, not a CI system, and not a framework. It's a thin, extensible layer over Claude Code.

## Core Concepts

### Project
A named reference to a directory on disk where Claude Code can operate. Projects are registered with `garden register <name> <path>`. Each project has its own task list and session lifecycle.

### Session
A Claude Code process running inside a tmux session in `-p` (print) mode. Sessions run in the background invisibly. You dispatch tasks, check status, and review results — you never interact with tmux directly. A project has at most one active session at a time.

### Task List
A per-project JSON file (`.garden/tasks.json`) that tracks work items. Tasks have IDs, statuses, descriptions, and notes. Agents interact with tasks exclusively through the `garden tasks` CLI — never by editing the JSON directly. The CLI renders tasks in a human-readable format for terminal display and outputs JSON when piped.

### Task Statuses
- `backlog` — captured for later, not yet ready to work
- `pending` — ready to be picked up by a session
- `in_progress` — currently being worked by a session
- `done` — completed
- `blocked` — agent could not proceed, needs human input
- `failed` — agent encountered an unrecoverable error

### Session Lifecycle
A session runs a loop:

1. Pick the next `in_progress` or `pending` task
2. Launch `claude -p` with the task description, injecting context via `--append-system-prompt-file`
3. Claude works the task, calls `garden tasks done <id>` or `garden tasks block <id>`
4. Garden emits an event to the event log and sends a macOS notification
5. **Paused mode (default):** wait for `garden next` signal before continuing
6. **Auto mode:** immediately pick up the next task

Each task gets a fresh Claude session (no conversation carry-over between tasks). When there are no remaining tasks, the session idles and emits an event.

### Rules System
Agent behavior is controlled by layered rules files injected into every Claude session:

1. **Global rules** (`~/.garden/rules.md`) — methodology, testing, git workflow, agent behavior
2. **Project rules** (`<project>/.garden/rules.md`) — project-specific conventions
3. **Task notes** — per-task context from the task's notes field

Rules are plain markdown, concatenated into the system prompt. Edit them directly.

### Layers

```
Orchestrator (human now, agent later)
  reads: garden status, garden tasks --all, garden events
  decides: what to start, when to advance, how to handle blocked tasks
  acts: garden start, garden next, garden add, garden stop

Garden CLI
  event log (~/.garden/events.jsonl)
  project sessions (tmux, invisible)
  notifications (macOS, from event log)

Worker sessions (Claude in -p mode)
  scoped to one project via GARDEN_PROJECT
  interacts only via: garden tasks done/block/add
```

## Commands

### Projects
```
garden init                        # Initialize ~/.garden, check for tmux
garden register <name> <path>      # Register a project
garden unregister <name>           # Unregister a project
garden list                        # List all projects and session status
```

### Sessions
```
garden start [name] [prompt]       # Start a session (project auto-detected from cwd)
garden start [name] --auto         # Start in auto mode
garden start --all [--auto]        # Start all projects
garden stop [name]                 # Stop a session
garden stop --all                  # Stop all sessions
garden next [name]                 # Advance a paused session to the next task
garden next [name] --auto          # Advance and switch to auto mode
garden pause [name]                # Switch from auto to paused
garden status [name]               # Show session status
garden review [name] [taskId]      # Resume a task's Claude conversation for review
```

### Tasks
```
garden add <desc>                  # Add a pending task (shortcut)
garden backlog <desc>              # Add a backlog task (shortcut)
garden done <id>                   # Mark task complete (shortcut)
garden block <id> [reason]         # Mark task blocked (shortcut)

garden tasks [name]                # List tasks (hides done/failed by default)
garden tasks [name] --done         # Include completed tasks
garden tasks --all                 # List tasks across all projects
garden tasks --all --pending       # Filter by status across all projects
garden tasks [name] add <desc>     # Add a task
garden tasks [name] backlog <desc> # Add a backlog task
garden tasks [name] done <id>      # Mark complete
garden tasks [name] block <id>     # Mark blocked
garden tasks [name] remove <id>    # Remove a task
garden tasks [name] update <id>    # Update (--status, --note, --desc)
garden tasks [name] next           # Show next pending task
```

### Agent
```
garden context [name]              # Output project context for agent bootstrapping
garden events [--since <time>]     # Show event log (1h, 30m, 2d)
```

Project name is optional when `GARDEN_PROJECT` is set (inside sessions) or when cwd is inside a registered project.

## Output Format

All read commands detect whether stdout is a TTY:
- **TTY:** pretty-printed for humans
- **Non-TTY:** JSON, one object per line

## File Layout

```
~/.garden/
  config.yml              # Project registry
  rules.md                # Global agent rules (symlinked from garden repo)
  events.jsonl            # Global event log (append-only)
  sessions/
    <name>.state          # Session state (JSON)
    <name>.context        # Current system prompt for worker

<project-root>/
  .garden/
    tasks.json            # Task list (JSON, managed by CLI only)
    rules.md              # Project-specific agent rules (optional)
```

## Task Format

```json
{
  "tasks": [
    {
      "id": "a1b2",
      "description": "Fix the auth timeout bug",
      "status": "pending",
      "notes": [],
      "created": "2026-03-22T10:00:00Z"
    }
  ]
}
```

IDs are 4-char random hex strings assigned by garden on creation.

## Event Log

Append-only JSONL at `~/.garden/events.jsonl`:

```jsonl
{"time":"...","project":"website","event":"session_start","mode":"paused"}
{"time":"...","project":"website","event":"task_start","taskId":"a1b2","description":"..."}
{"time":"...","project":"website","event":"task_done","taskId":"a1b2","description":"..."}
{"time":"...","project":"website","event":"session_idle","reason":"no_pending_tasks"}
```

## Session Management

tmux is invisible plumbing. Sessions are named `garden-<project>`.

- `garden start` creates a tmux session, runs the worker
- `garden stop` kills the tmux session, resets `in_progress` tasks to `pending`
- `garden status` queries tmux and reads state files
- `garden next` sends SIGUSR1 to the worker process

## Worker

The worker (`garden _worker`, internal) runs inside tmux:

1. Read next task (prefers `in_progress`, then `pending`)
2. Write system prompt to context file (garden instructions + global rules + project rules + task notes)
3. Run `claude -p --verbose <task> --name garden-<project>-<taskId> --append-system-prompt-file <context> --allowedTools Bash Edit Write Read Glob Grep`
4. Check task status after Claude exits
5. Emit event, send notification
6. In paused mode, wait for SIGUSR1; in auto mode, loop

## Claude Integration

Each task runs in a fresh `claude -p` session configured with:
- `--append-system-prompt-file` containing garden instructions, rules, and task context
- `--name garden-<project>-<taskId>` for session resumption via `garden review`
- `--allowedTools Bash Edit Write Read Glob Grep` for full tool access
- `GARDEN_PROJECT` env var for scoped garden CLI commands

## Technology

- TypeScript, compiled via esbuild to a single `dist/cli.js`
- tmux for background session persistence
- macOS notifications via `osascript`
- `js-yaml` for config parsing
- No CLI framework — lightweight `process.argv` dispatch with aliases

## Principles

1. **Agent-first.** CLI is the API. Structured output by default. If an agent can't do it, it's a bug.
2. **Files over databases.** YAML, JSON, JSONL. All human-inspectable.
3. **Shell out, don't abstract.** Call `claude` directly. Don't wrap the API.
4. **Events over state.** The event log records what happened. State files are ephemeral.
5. **Grow by adding, not changing.** New commands, new event types, new fields — avoid breaking what works.

## Example Workflow

```bash
# Register projects
garden register website ~/code/keychange/website
garden register api ~/code/keychange/api

# Add tasks
garden add "Fix the auth timeout bug"
garden add "Add rate limiting to /v2 endpoints"
garden backlog "Refactor middleware layer"

# Dispatch work
garden start website
garden start api --auto

# Monitor
garden status
garden tasks --all --pending
garden events --since 1h

# Review completed work
garden review website

# Stop everything
garden stop --all
```

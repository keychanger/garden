# Garden

A minimal CLI orchestrator for managing Claude Code sessions across multiple projects.

Garden is a personal tool — opinionated toward a single developer managing many projects from one place. It is not a team tool, not a CI system, and not a framework. It's a thin, extensible layer over Claude Code.

## Core Concepts

### Project
A named reference to a directory on disk where Claude Code can operate. Projects are registered in a single config file. Each project has its own task list and session lifecycle.

### Session
A Claude Code process running inside a tmux session. Sessions run in the background whether you're watching or not. You can attach to interact with Claude directly, detach to let it keep working, or leave it running headlessly. A project has at most one active session at a time.

### Task List
A per-project JSON file (`.garden/tasks.json`) that tracks work items. Tasks have IDs, statuses, descriptions, and notes. Agents interact with tasks exclusively through the `garden tasks` CLI — never by editing the JSON directly. The CLI renders tasks in a human-readable format for terminal display.

### Session Lifecycle
A session runs a loop:

1. Call `garden tasks next` to get the next pending task
2. Launch `claude -p` with the task, injecting garden context via `--append-system-prompt`
3. Claude works the task and calls `garden tasks done <id>` when finished (or `garden tasks block <id>` if stuck)
4. Garden emits a `task_done` or `task_blocked` event to the event log
5. **Paused mode (default):** wait for `garden next` signal before continuing
6. **Auto mode:** immediately pick up the next task

When there are no remaining tasks, the session idles and emits an event.

A session can also be started with an explicit prompt (`garden start website "fix the bug"`) which creates a temporary task and runs it.

### Layers

```
Orchestrator (human now, agent later)
  ├── reads: garden status, garden tasks, garden events
  ├── decides: what to start, when to next, how to handle blocked
  └── acts: garden start, garden next, garden tasks add, garden attach

Garden CLI (the API for both layers)
  ├── event log (~/.garden/events.jsonl)
  ├── project sessions
  │     ├── website  (Claude — only sees its own tasks via garden tasks)
  │     ├── api      (Claude — only sees its own tasks via garden tasks)
  │     └── research (Claude — only sees its own tasks via garden tasks)
  └── notifications (consumes event log → macOS notifications)
```

The orchestrator and the worker agents use the same CLI. The only difference is scope: workers are scoped to one project via `GARDEN_PROJECT`, the orchestrator sees everything.

## Commands

### Project Management
```
garden init                        # Initialize ~/.garden, check prerequisites
garden add <name> <path>           # Register a project
garden remove <name>               # Unregister a project (does not delete files)
garden list                        # List all registered projects and their session status
```

### Session Management
```
garden start <name> [prompt]       # Start a session. With prompt: run that task.
                                   #   Without: pick up next task from task list.
garden start <name> --auto         # Start in auto mode (churn through task list)
garden stop <name>                 # Stop the session entirely
garden attach <name>               # Attach to a running session (interactive)
                                   #   Detach with ctrl-b d. Session keeps running.
garden next <name>                 # Tell a paused session to move to the next task
garden pause <name>                # Switch a running session from auto to paused
                                   #   (waits after current task finishes)
garden status [name]               # Show session status (all projects, or one)
garden log <name>                  # Show output from the most recent task
```

### Task Management
```
garden tasks [name]                # List tasks for a project
garden tasks add <desc>            # Add a task (returns the new task ID)
garden tasks done <id>             # Mark a task complete
garden tasks block <id> [reason]   # Mark a task blocked
garden tasks update <id> [fields]  # Update a task (--status, --note, --desc)
garden tasks next                  # Show the next pending task
```

When `GARDEN_PROJECT` is set (inside a session), the project name is optional for all task commands.

### Agent Context
```
garden context [name]              # Output full project context for agent bootstrapping
garden events [--since <time>]     # Tail the event log
```

## Output Format

All read commands (status, list, tasks, log, context, events) detect whether stdout is a TTY:
- **TTY (human in terminal):** pretty-printed, colored output
- **Non-TTY (piped, agent):** JSON, one object per line where applicable

This means `garden status` looks good for you, and `garden status | jq .` works for an agent. No flags needed.

## Project Config

Single file at `~/.garden/config.yml`:

```yaml
projects:
  website:
    path: /Users/joshua/code/keychange/website
  garden:
    path: /Users/joshua/code/keychange/garden
  research:
    path: /Users/joshua/code/research/llm-patterns
```

## Task Format

Per-project file at `<project-root>/.garden/tasks.json`:

```json
{
  "tasks": [
    {
      "id": "a1b2",
      "description": "Fix the auth timeout bug",
      "status": "pending",
      "notes": [],
      "created": "2026-03-22T10:00:00Z"
    },
    {
      "id": "c3d4",
      "description": "Add rate limiting to /v2 endpoints",
      "status": "done",
      "notes": ["Implemented with express-rate-limit"],
      "created": "2026-03-22T10:05:00Z",
      "completed": "2026-03-22T11:30:00Z"
    },
    {
      "id": "e5f6",
      "description": "Update schema for new user fields",
      "status": "blocked",
      "notes": ["Need database credentials from ops team"],
      "created": "2026-03-22T10:10:00Z"
    }
  ]
}
```

Task statuses: `pending`, `in_progress`, `done`, `blocked`, `failed`

IDs are short random hex strings (4 chars), assigned by garden on creation. The CLI is the only thing that writes this file.

## Event Log

Append-only file at `~/.garden/events.jsonl`:

```jsonl
{"time":"2026-03-22T10:00:00Z","project":"website","event":"session_start","mode":"paused"}
{"time":"2026-03-22T10:01:00Z","project":"website","event":"task_start","taskId":"a1b2","description":"Fix the auth timeout bug"}
{"time":"2026-03-22T10:15:00Z","project":"website","event":"task_done","taskId":"a1b2","description":"Fix the auth timeout bug"}
{"time":"2026-03-22T10:15:00Z","project":"website","event":"task_blocked","taskId":"e5f6","reason":"Need database credentials"}
{"time":"2026-03-22T10:20:00Z","project":"website","event":"session_idle","reason":"no_pending_tasks"}
```

Events are the source of truth for what happened. Notifications (macOS) and future orchestrator agents consume this log.

## Architecture

```
~/.garden/
  config.yml              # Project registry
  events.jsonl            # Global event log
  sessions/
    <name>.state          # Session state (JSON)
    <name>.log            # Last task output

<project-root>/
  .garden/
    tasks.json            # Task list (JSON, managed by CLI)
```

### Session Management (tmux)

tmux is the session substrate. Garden never asks you to use tmux directly — it's plumbing.

- `garden start <name>` creates a tmux session named `garden-<name>`, sets `GARDEN_PROJECT` env var, runs the worker
- `garden attach <name>` calls `tmux attach -t garden-<name>`
- `garden stop <name>` kills the tmux session, emits `session_stop` event
- `garden status` queries tmux for session existence and reads state files
- Detaching (ctrl-b d) returns you to your terminal; the session keeps running

Session state (`~/.garden/sessions/<name>.state`):
```json
{
  "mode": "paused",
  "currentTaskId": "a1b2",
  "startedAt": "2026-03-22T10:00:00Z",
  "completedTasks": 3,
  "pid": 12345
}
```

### Worker

The worker is an internal command (`garden _worker`) that runs inside the tmux session. It manages the task loop but does not manage task state — Claude does that by calling `garden tasks done/block`.

```
emit event: session_start
while true:
    task = garden tasks next (JSON)
    if no task:
        emit event: session_idle
        wait for SIGUSR1
        continue

    set task to in_progress
    emit event: task_start

    run: claude -p "$task.description" \
         --append-system-prompt "$(garden context)" \
         --allowedTools "Bash(garden:*)"

    # Claude calls garden tasks done/block during execution
    # Worker reads task status after claude exits to confirm

    emit event: task_done or task_failed

    if mode == "paused":
        wait for SIGUSR1
```

### Claude Integration

When `garden start` launches a session, Claude is configured with:

1. **`--append-system-prompt`** with output from `garden context`, which includes:
   - The project name and current task
   - Available garden commands (tasks add/done/block)
   - Instructions to use the CLI for task management
   - The task ID to mark done when finished

2. **`GARDEN_PROJECT` env var** so garden commands inside the session are auto-scoped

3. **`--allowedTools "Bash(garden:*)"`** to pre-authorize garden CLI calls

### Notifications

macOS native notifications via `osascript`. Triggered by events in the event log:
- `task_done` — "{project} finished: {description}"
- `task_blocked` — "{project} blocked: {description} — {reason}"
- `session_idle` — "{project}: no remaining tasks"
- `task_failed` — "{project} failed: {description}"

### Technology

- TypeScript, compiled via `esbuild`
- tmux for session management (prerequisite, checked on `garden init`)
- `osascript` for macOS notifications (built into macOS)
- YAML parsing via `js-yaml` for config
- No CLI framework — lightweight command dispatch

## Principles

1. **Agent-first.** Every interaction goes through the CLI. Structured data by default. If an agent can't do it, it's a bug.
2. **Files over databases.** Everything is a readable file on disk — JSON, YAML, JSONL.
3. **Shell out, don't abstract.** Call `claude` directly. Don't wrap the API.
4. **Events over state.** The event log is the source of truth for what happened. State files are derived/ephemeral.
5. **Grow by adding, not changing.** New commands, new event types, new task fields — avoid breaking what works.

## Example Workflow

```bash
# Morning — dispatch work
garden start website                    # picks up next pending task
garden start research                   # same
garden start api "add rate limiting"    # creates a task and runs it

# Dig into one interactively
garden attach api                       # watch it work, give feedback
# ctrl-b d to detach when it's on the right track

# Check on everything
garden status
#  website    ● running   task: Fix auth timeout bug
#  research   ● running   task: Survey embedding models
#  api        ● running   task: Add rate limiting to /v2
#  mobile     ○ stopped

# Notification: "website finished: Fix auth timeout bug"
garden attach website                   # review what it did
garden next website                     # move to next task

# Or let one churn
garden start mobile --auto

# Check events
garden events --since 1h
# 10:00 website  session_start (paused)
# 10:01 website  task_start    Fix auth timeout bug
# 10:15 website  task_done     Fix auth timeout bug
# 10:16 api      task_blocked  Add rate limiting — need API docs
```

## Future Considerations (Explicitly Deferred)

- **Orchestrator agent** — agent that reads events and manages sessions automatically
- **Global task view** — aggregate tasks across all projects
- **Auto-discovery** — find projects by marker file instead of manual registration
- **Session persistence** — auto-restart sessions on boot
- **Inter-project coordination** — pass context between sessions
- **Project templates** — `garden new` to scaffold a project
- **TUI dashboard** — real-time multi-pane view of all sessions
- **Actionable notifications** — buttons on macOS notifications

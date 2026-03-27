// CLI entry point: parses args, dispatches commands, and prints help.
import { commands } from "./commands/index.js";

const args = process.argv.slice(2);
let commandName = args[0];
const commandArgs = args.slice(1);

// Internal worker command — runs inside tmux sessions
if (commandName === "_worker") {
  const { workerPromise } = await import("./worker.js");
  await workerPromise;
  process.exit(0);
}

// Internal command — launches claude with rules context for a directory
if (commandName === "_dashboard-claude") {
  const { launchDashboardClaude } = await import("./dashboard-claude.js");
  await launchDashboardClaude(commandArgs);
  process.exit(0);
}

if (!commandName || commandName === "help" || commandName === "--help") {
  printHelp();
  process.exit(0);
}

// Aliases
const aliases: Record<string, string> = {
  ls: "list",
  dash: "dashboard",
};

// Top-level shortcuts
// garden exit → garden dashboard exit
if (commandName === "exit") {
  commandArgs.unshift("exit");
  commandName = "dashboard";
}

// garden add/done/block → garden tasks add/done/block
const taskShortcuts = new Set(["add", "done", "block", "backlog"]);

if (taskShortcuts.has(commandName)) {
  // Rewrite: garden add "desc" → garden tasks add "desc"
  commandArgs.unshift(commandName);
  commandName = "tasks";
}

const resolved = aliases[commandName] ?? commandName;
const command = commands[resolved];
if (!command) {
  console.error(`Unknown command: ${commandName}`);
  console.error(`Run 'garden help' for usage.`);
  process.exit(1);
}

try {
  await command(commandArgs);
} catch (err) {
  console.error(
    `Error: ${err instanceof Error ? err.message : String(err)}`
  );
  process.exit(1);
}

function printHelp() {
  console.log(`
garden — manage Claude Code sessions across projects

Usage: garden <command> [args]

Project auto-detection: if you're cd'd into a registered project,
the project name is optional for most commands.

Projects:
  init                           Initialize garden config
  register <name> <path>         Register a project
  unregister <name>              Unregister a project
  list, ls                       List all projects and session status

Sessions:
  start [name] [prompt]          Start a session (with optional task)
  start [name] --auto            Start in auto mode
  start --all [--auto]           Start all projects
  stop [name | --all]             Stop a session (or all sessions)
  next [name]                    Advance a paused session to the next task
  next [name] --auto             Resume and switch to auto mode
  pause [name]                   Switch session from auto to paused
  status [name]                  Show session status
  review [name] [taskId]         Review a task's Claude conversation

Task shortcuts (project auto-detected from cwd):
  add <desc>                     Add a task
  backlog <desc>                 Add a task to the backlog
  done <id>                      Mark a task complete
  block <id> [reason]            Mark a task blocked

Full task commands:
  tasks [name]                   List all tasks
  tasks [name] add <desc>        Add a task
  tasks [name] backlog <desc>    Add a task to the backlog
  tasks [name] done <id>         Mark a task complete
  tasks [name] block <id> [why]  Mark a task blocked
  tasks [name] remove <id>       Remove a task
  tasks [name] update <id> ...   Update a task (--status, --note, --desc)
  tasks [name] next              Show the next pending task

Dashboard:
  dashboard                      Open the dashboard (creates if needed)
  dashboard exit, exit           Close the dashboard
  keys                           Show dashboard keybindings

Agent:
  context [name]                 Output project context for agent bootstrapping
  events [--since <time>]        Show event log (supports 1h, 30m, 2d)

Output is JSON when piped, pretty-printed in a terminal.
`.trim());
}

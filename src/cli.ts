import { commands } from "./commands/index.js";

const args = process.argv.slice(2);
const commandName = args[0];
const commandArgs = args.slice(1);

// Internal worker command — runs inside tmux sessions
if (commandName === "_worker") {
  const { workerPromise } = await import("./worker.js");
  await workerPromise;
  process.exit(0);
}

if (!commandName || commandName === "help" || commandName === "--help") {
  printHelp();
  process.exit(0);
}

const command = commands[commandName];
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

Projects:
  init                           Initialize garden config
  add <name> <path>              Register a project
  remove <name>                  Unregister a project
  list                           List all projects and session status

Sessions:
  start <name> [prompt]          Start a session (with optional task)
  start <name> --auto            Start in auto mode
  stop <name>                    Stop a session
  attach <name>                  Attach to a running session
  next <name>                    Advance a paused session to the next task
  pause <name>                   Switch session from auto to paused
  status [name]                  Show session status
  log <name>                     Show output from the most recent task

Tasks (project name optional if GARDEN_PROJECT is set):
  tasks [name]                   List all tasks
  tasks [name] add <desc>        Add a task
  tasks [name] done <id>         Mark a task complete
  tasks [name] block <id> [why]  Mark a task blocked
  tasks [name] update <id> ...   Update a task (--status, --note, --desc)
  tasks [name] next              Show the next pending task

Agent:
  context [name]                 Output project context for agent bootstrapping
  events [--since <time>]        Show event log (supports 1h, 30m, 2d)

Output is JSON when piped, pretty-printed in a terminal.
`.trim());
}

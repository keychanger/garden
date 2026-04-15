// CLI entry point: parses args, dispatches commands, and prints help.
import { commands } from "./commands/index.js";

const args = process.argv.slice(2);
let commandName = args[0];
const commandArgs = args.slice(1);

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
  register: "add",
  unregister: "remove",
};

// Top-level shortcut: garden exit → garden dashboard exit
if (commandName === "exit") {
  commandArgs.unshift(commandName);
  commandName = "dashboard";
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

Projects:
  init                           Initialize garden config
  add [path]                     Add a project (defaults to current directory)
  remove <name>                  Remove a project
  list, ls                       List all projects
  config <project> [key] [value] View or set project config
  focus <name>                   Show project in dashboard
  unfocus <name>                 Hide project from dashboard
  reorder <name> <position>      Move project to position (1-based)

Development:
  test [project] [-- args]       Run project tests (npm test)

Dashboard:
  dashboard                      Open the dashboard (creates if needed)
  dashboard exit, exit           Close the dashboard
  keys                           Show dashboard keybindings
  status                         Show project and worker status
  alerts                         View dashboard alerts
  alerts clear                   Dismiss all alerts
  rules                          View pending rule suggestions from reviewer findings
  rules accept <category>        Append a suggested rule to rules.md (use --confirm)
  rules dismiss <category>       Dismiss a rule suggestion
  rules findings                 Raw reviewer-findings log
  logs [options]                 View dashboard logs (pretty-printed)
  logs -f                        Follow logs in real time
  logs -l warn                   Filter by minimum level
  logs -s poller                 Filter by source module
  logs -w <name>                 Filter by worker name
  health                         Check dashboard state consistency
  kick <worker>                  Re-arm a stranded 'working' worker for review
  reset                          Clear the worker registry
  rebuild                        Rebuild garden and relaunch dashboard

Output is JSON when piped, pretty-printed in a terminal.
`.trim());
}

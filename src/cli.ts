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

// Top-level shortcuts
// garden exit → garden dashboard exit
if (commandName === "exit") {
  commandArgs.unshift("exit");
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

Dashboard:
  dashboard                      Open the dashboard (creates if needed)
  dashboard exit, exit           Close the dashboard
  keys                           Show dashboard keybindings
  status                         Show project and worker status
  health                         Check dashboard state consistency
  reset                          Clear the worker registry
  rebuild                        Rebuild garden and relaunch dashboard

Output is JSON when piped, pretty-printed in a terminal.
`.trim());
}

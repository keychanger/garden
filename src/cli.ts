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
  p: "plot",
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
  create <path>                  Scaffold a new project: mkdir, git init, private GitHub repo under the gh-authed account, add to active plot
  remove <name>                  Remove a project (also purges from plots)
  list, ls                       List all projects
  config <project> [key] [value] View or set project config
  claude-profile [list|add|remove|login]
                                 Manage alternate Claude config dirs (per-project plan)

Plots (named, ordered subsets of projects — drive the dashboard view):
  plot, p                        List plots (marks active with *)
  plot <name>                    Activate plot (switch view)
  plot create <name> [proj...]   Create a plot (auto-activates if none active)
  plot delete <name>             Delete a plot
  plot rename <old> <new>        Rename a plot
  plot add <plot> <project> [at N]    Add a project to a plot
  plot remove <plot> <project>   Remove a project from a plot
  plot reorder <plot> <proj> <N> Move project within a plot
  plot show <name>               Print a plot's ordered contents
  focus <plot>                   Include plot in the ⌥p cycle
  unfocus <plot>                 Exclude plot from the ⌥p cycle
  reorder <plot> <position>      Move plot within the ⌥p cycle

Auth:
  login [profile]                Re-authenticate Claude (personal, or a profile)
  auth status                    Show which Claude credentials are present and where
  usage [refresh]                Show or force-refresh the Claude usage meter

Development:
  test [project] [-- args]       Run project tests (npm test)

Dashboard:
  dashboard                      Open the dashboard (creates if needed)
  dashboard exit, exit           Close the dashboard
  keys                           Show dashboard keybindings
  status [--all]                 Show project and worker status (--all: every plot, not just the active one)
  whoami [worker]                Show the current worker's registry entry (uses $GARDEN_WORKER)
  alerts                         View dashboard alerts
  alerts clear                   Dismiss all alerts
  logs [options]                 View dashboard logs (pretty by default)
  logs -f                        Follow logs in real time
  logs -l warn                   Filter by minimum level
  logs -s poller                 Filter by source module
  logs -w <name>                 Filter by worker name
  logs -p <name>                 Filter by project name
  logs -a, --all                 Show suppressed housekeeping entries (one-shot)
  logs --raw, --pretty           Override render mode for one invocation
  logs --no-saved-filter         Ignore the sticky filter for this invocation
  logs raw | pretty              Persist mode (live pane respawns to apply)
  logs mode [raw|pretty]         Read or set the persisted mode
  logs filter [<expr>]           Show / set sticky filter (also via ⌥/ in dashboard)
  logs filter --clear            Remove the sticky filter
  health                         Check dashboard state consistency
  kick <worker>                  Re-arm a stranded 'working' worker for review
  bounce <worker>                Restart a worker's Claude process (preserves session history)
  pause <worker>                 Suppress post-merge auto-continue (writes the .garden-done sentinel; a worker UserPromptSubmit also clears it, so prompting an explicitly-paused worker is itself an unpause)
  resume <worker>                Re-arm post-merge auto-continue (clears the .garden-done sentinel)
  handoff <project> [-m "<msg>"] Spawn a fresh worker on <project> seeded with a briefing (stdin or -m)
                                 Add --expect-callback to receive a one-shot prompt at this pane when the child terminates
  reply [-m "<msg>"]             Stage a freeform note for the parent that handed off to this worker (delivered with the callback)
  auto [on|off|status]           Toggle the global auto-continue gate
  auto threshold <N>             Set the usage-threshold percent (auto-disable above this)
  auto resume-on-reset on|off    Re-enable automatically after the usage window resets
  reset                          Clear the worker registry
  rebuild                        Rebuild garden and relaunch dashboard

Workers:
  workers new <project> [--workflow trellis --trellis <name>]
                        [--model opus|sonnet] [--max-iterations N]
                                 Spawn a new worker. Default workflow plants an interactive worker;
                                 trellis plants a vine bound to the named trellis. --model overrides
                                 the trellis default (Sonnet).

Trellis (spec-driven loop workflow — see WORKFLOWS.md § "Trellis workflow"):
  trellis list <project> [--active]   List trellises (active + archived)
  trellis show <project> <name>       Print a trellis's content
  trellis new <project> <name>        Scaffold a trellis at <project>/.garden/trellises/<name>.md
  trellis status <worker>             Show iteration count, last verdict, drift list, lessons tail
  trellis amend <worker>              Open the worker's bound trellis in $EDITOR; commit on success (refuses on dirty main)
  trellis resume <worker>             Clear a trellis-flagged failure and arm a fresh review
  trellis retire <project> <name>     Mark a trellis retired (filters from picker, refuses new vines)
  trellis revive <project> <name>     Remove the retirement comment

Diagnostics (temporary — see src/commands/diag.ts cleanup checklist):
  diag handoff                        Spawn a worker pre-loaded with the latest auto-captured status-pane corruption snapshot

Output is JSON when piped, pretty-printed in a terminal.
`.trim());
}

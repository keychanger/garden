// CLI entry point: parses args, dispatches commands, and prints help.
import { commands } from "./commands/index.js";
import { GARDEN_VERSION } from "./version.js";

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

if (commandName === "version" || commandName === "--version" || commandName === "-v") {
  console.log(GARDEN_VERSION);
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

// `garden <cmd> --help` / `-h`: show the full help rather than letting the
// command mis-read the flag (e.g. `garden kick --help` would otherwise resolve
// "--help" as a worker name and error). Garden has no per-command flag pages, so
// the top-level help — which lists every command and its arguments — is the
// answer; `garden help` is the same output.
if (commandArgs[0] === "--help" || commandArgs[0] === "-h") {
  printHelp();
  process.exit(0);
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
                                 keys incl. model / effort (default+grow worker
                                 defaults; per-spawn --model/--effort override)
                                 and beadIntake / beadIntakeCap (bead-intake loop:
                                 dispatch-labeled epics in the project's .beads
                                 store spawn workers; see 'garden poke')
  config <project> role [<role> [harness|model|effort] [value]]
                                 Per-role review harness/model/effort (role: reviewer|resolver|ci-fix)
                                 effort is claude-code-only: low|medium|high|xhigh|max
                                 e.g. 'config <p> role reviewer harness codex' for a Codex reviewer
  config <project> crew [<name>] Bind the project to a crew ('none' unbinds). See 'garden crew'.
  crew [list|show|add|edit|remove|apply]
                                 Manage crews: who builds and who reviews, and how strong.
                                 Builtin names are <worker>-<reviewer> (all-X sugar): all-claude,
                                 all-codex, codex-claude, claude-codex, plus <provider>-claude /
                                 <provider>-codex per configured provider (e.g. deepseek-claude).
                                 A provider can build but never reviews (safety net).
                                 Builtins carry a harness pairing only; define your own to pin
                                 model and effort too:
                                   crew add heavy --worker claude --model opus --effort xhigh \\
                                     --review claude --review-model opus --review-effort max
                                   crew add cheap --from all-claude --model sonnet --effort medium
                                   crew apply heavy myproject
                                 Projects bind by REFERENCE, so 'crew edit' re-targets every
                                 project on that crew at its next spawn/review. A project's own
                                 config keys override the crew.
  diary [project] [--path]       Open the project's diary in $EDITOR (--path prints the file path)
  claude-profile [list|add|remove|login]
                                 Manage alternate Claude config dirs (per-project plan)
  provider [list|add|remove]     Manage model providers (Anthropic-compatible backends
                                 workers reach by env swap; reviewers stay on Anthropic)

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
  review [worker]                Show a worker's last review: verdict, review-window diff, notes (default: focused)
  queue [project]                Show the merge pipeline: queue order, in-review, blocked, CI markers
  checks [project]               Run the project's checks command under the machine-wide concurrency gate
  stats [options]                Aggregate the telemetry ledger by config (quality / cost / autonomy)
  stats --by <axis>              Group by config|model|provider|harness|workflow|crew|rules|version
  stats --since 7d -p <project>  Window by age (Nd/Nh/Nm) and/or scope to one project
  alerts                         View dashboard alerts (unread/read split, relative time)
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
  doctor                         Environment preflight (tmux / claude / gh / node / config / Option-key)
  kick <worker>                  Re-arm a stranded 'working' worker for review
  poke [project]                 Wake the project's poller now (runs bead intake immediately; board's dispatch gate uses this)
  bounce <worker>                Restart a worker's Claude process (preserves session history)
  hold <worker>                  Interrupt a working worker and mark it 'paused' (sends Escape; ⌥e in the dashboard toggles this on the focused worker; the next prompt resumes it)
  pause <worker>                 Suppress post-merge auto-continue (writes the .garden-done sentinel; a worker UserPromptSubmit also clears it, so prompting an explicitly-paused worker is itself an unpause)
  resume <worker>                Re-arm post-merge auto-continue (clears the .garden-done sentinel)
  resurrect                      List killed workers rebuildable from their tombstones (newest first)
  resurrect <worker>             Rebuild a killed worker: worktree at its original path, entry restored, session resumed
  resurrect --search <expr>      Narrow the list by name/task/branch and transcript content ("what it did")
  handoff <project> [-m "<msg>"] Spawn a fresh worker on <project> seeded with a briefing (stdin or -m)
                                 Add --expect-callback to receive a one-shot prompt at this pane when the child terminates
                                 Add --ultracode to create the worker in ultracode mode (Opus + max effort + dynamic workflows)
                                 Add --bead <id> to stamp the bead↔worker join on the new worker's registry entry (no bd claim is made)
  reply [-m "<msg>"]             Stage a freeform note for the parent that handed off to this worker (delivered with the callback)
  auto [on|off|status]           Toggle the global auto-continue gate
  auto threshold <N>             Set the usage-threshold percent (auto-disable above this)
  auto resume-on-reset on|off    Re-enable automatically after the usage window resets
  limits [status]                Show machine-wide resource budgets (garden-level)
  limits checks-slots <N|unset>  Cap concurrent checks-suite runs (default: cores/8)
  limits max-reviews <N|unset>   Cap simultaneous headless reviewers fleet-wide (default: unlimited)
  reset                          Clear the worker registry and delete each worker's remote branch
  rebuild                        Rebuild garden and relaunch dashboard (macOS + iTerm only)
  version, --version, -v         Print the garden build version (git short SHA, or "dev" under tsx)

Workers:
  workers new <project> [--workflow default|trellis|grow|botanist] [--model <alias-or-id>] [--effort low|medium|high|xhigh|ultra]
                        [--harness codex] [--crew <name>] [--base <branch>] [--trellis <name>]
                        [--seed <text> | --seed-file <path>] [--max-iterations N]
                                 Spawn a new worker. default plants an interactive worker;
                                 trellis plants a vine bound to the named trellis (--trellis);
                                 grow plants a bounded hardening loop from a --seed / --seed-file
                                 (--max-iterations caps the passes, default 5); botanist plants a
                                 design worker whose deliverable is a doc, not code (Opus/xhigh
                                 designer seat) — --seed / --seed-file optionally inlines the design
                                 brief, and without one no message is sent — the brief arrives
                                 as your first message in its pane. --model overrides
                                 the workflow's default worker model. --effort sets the reasoning
                                 rung (ultra = max effort + dynamic workflows; default/grow/botanist).
                                 --harness picks the agent CLI (default claude-code; codex = a
                                 sandboxed Codex worker, default/botanist workflows only).
  workers grow [<worker>] --seed <text> | --seed-file <path> | --goal-file <path>
                                 Convert an active default worker into a grow loop after its
                                 current work merges (self-resolves via $GARDEN_WORKER). The durable
                                 goal lives at <worktree>/.garden/grow-goal.md, editable mid-loop.
  workers stop <worker>          Remove a worker end-to-end from the CLI: windows killed, telemetry
                                 tombstone written, its bead (if any) conditionally unclaimed, entry
                                 removed, branch/worktree cleanup dispatched — the same removal the
                                 dashboard ⌥x performs. Prefix matching and '.' resolve like kick/bounce.

Trellis (spec-driven loop workflow — see WORKFLOWS.md § "Trellis workflow"):
  trellis list <project> [--active]   List trellises (active + archived)
  trellis show <project> <name>       Print a trellis's content
  trellis new <project> <name>        Scaffold a trellis at <project>/.garden/trellises/<name>.md
  trellis status <worker>             Show iteration count, last verdict, drift list, lessons tail
  trellis amend <worker>              Open the worker's bound trellis in $EDITOR; commit on success (refuses on dirty main)
  trellis resume <worker>             Clear a trellis-flagged failure and arm a fresh review
  trellis retire <project> <name>     Mark a trellis retired (filters from picker, refuses new vines)
  trellis revive <project> <name>     Remove the retirement comment

Botanist (design workflow — see docs/future/BOTANIST-WORKFLOW.md):
  botanist publish [<worker>] --to docs/<name>.md [--dry-run]
                                      Publish an approved design artifact: move it from the worker's
                                      .garden/botanist/ working dir to a tracked docs/ path, commit it,
                                      and mark the botanist done (self-resolves via $GARDEN_WORKER). The
                                      poller merges it with no reviewer. --dry-run previews, changes nothing.

Diagnostics (temporary — see src/commands/diag.ts cleanup checklist):
  diag handoff                        Spawn a worker pre-loaded with the latest auto-captured status-pane corruption snapshot

Output is JSON when piped, pretty-printed in a terminal.
`.trim());
}

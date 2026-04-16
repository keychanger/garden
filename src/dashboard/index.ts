// Dashboard entry point: subcommand dispatch and help.
import fs from "node:fs";
import {
  checkTmux,
  dashboardExists,
  attachDashboardSession,
  killDashboardSession,
} from "../session.js";
import { STATE_FILE } from "./state.js";
import { REGISTRY_FILE } from "./registry.js";
import { ALERTS_FILE } from "./alerts.js";
import { printHeader, handleClaudeHook, handlePaneDied, handleTitleChanged } from "./header.js";
import { log } from "./log.js";
import { ensureDashboard, resizeTerminal, cleanupContextFiles } from "./create.js";
import { newWorker, killPane } from "./workers.js";
import { switchProject, focusWorker, focusShell, focusGarden, focusRoot, focusLogs, cyclePane } from "./navigate.js";
import { poll, triggerProjectPoll, postPush, stopAllPollers } from "./poller.js";
import { runUsagePollerLoop, stopUsagePoller } from "./usage-poller.js";
import { loadConfig } from "../config.js";
import { addAlert } from "./alerts.js";

export async function dashboard(args: string[]): Promise<void> {
  checkTmux();

  const sub = args[0];

  if (sub === "exit" || sub === "close") {
    if (!dashboardExists()) {
      console.log("No dashboard running.");
      return;
    }
    log.info("dashboard", "closing dashboard");
    stopAllPollers();
    stopUsagePoller();
    killDashboardSession();
    try { fs.unlinkSync(STATE_FILE); } catch { /* ignore */ }
    try { fs.unlinkSync(REGISTRY_FILE); } catch { /* ignore */ }
    try { fs.unlinkSync(ALERTS_FILE); } catch { /* ignore */ }
    cleanupContextFiles();
    console.log("Dashboard closed.");
    return;
  }

  // Internal subcommands called by hotkeys
  if (sub === "_switch") return switchProject(args[1]);
  if (sub === "_new-worker") return newWorker();
  if (sub === "_focus-worker") return focusWorker();
  if (sub === "_focus-shell") return focusShell();
  if (sub === "_focus-garden") return focusGarden();
  if (sub === "_focus-root") return focusRoot();
  if (sub === "_focus-logs") return focusLogs();
  if (sub === "_cycle-pane") return cyclePane(args[1] === "prev" ? -1 : 1);
  if (sub === "_kill-pane") return killPane({ force: args.includes("--force") });
  if (sub === "_poll") {
    poll(args[1]);
    return;
  }
  if (sub === "_trigger-poll") {
    if (args[1]) return triggerProjectPoll(args[1]);
    const config = loadConfig();
    for (const pn of Object.keys(config.projects)) triggerProjectPoll(pn);
    return;
  }
  if (sub === "_post-push") return postPush(args[1]);
  if (sub === "_usage-poll-loop") {
    await runUsagePollerLoop();
    return;
  }
  if (sub === "_usage-refresh") {
    const { refreshUsage } = await import("./usage.js");
    const { refreshDashboard } = await import("./header.js");
    await refreshUsage();
    try { refreshDashboard(); } catch { /* pane gone, not running, etc. */ }
    return;
  }
  if (sub === "_post-rebuild-refresh") {
    // Spawned via the rebuilt binary so respawnStatusPane bakes in the new code
    const { respawnStatusPane, resolveGardenRunner } = await import("./create.js");
    const { readDashState } = await import("./state.js");
    const { refreshDashboard } = await import("./header.js");
    const { restartLongLivedPollers } = await import("./poller.js");
    if (dashboardExists()) {
      try { respawnStatusPane(readDashState()); } catch { /* pane gone */ }
      // Pollers cache the pre-rebuild JS bundle in memory — restart so they run the new code.
      try { restartLongLivedPollers(resolveGardenRunner()); } catch { /* best effort */ }
      try { refreshDashboard(); } catch { /* no attached client */ }
    }
    return;
  }
  if (sub === "_header") return printHeader();
  if (sub === "_claude-hook") return handleClaudeHook(args[1]);
  if (sub === "_judge-bash") {
    const { judgeBashHook } = await import("./judge.js");
    await judgeBashHook();
    return;
  }
  if (sub === "_pane-died") return handlePaneDied(args[1]);
  if (sub === "_title-changed") return handleTitleChanged(args[1], args[2]);
  if (sub === "_bootstrap-alert") {
    const [, projectName, baseBranch, projectPath, ...rest] = args;
    const errText = rest.join(" ").slice(0, 400);
    addAlert({
      level: "error",
      source: "bootstrap",
      project: projectName ?? "unknown",
      message: `Worker bootstrap could not update ${baseBranch ?? "base"} at ${projectPath ?? "?"}: ${errText}. Worker will still branch off origin/${baseBranch ?? "base"}; clean the main checkout so future workers stay fresh.`,
    });
    return;
  }

  if (sub === "help") {
    printDashboardHelp();
    return;
  }

  if (sub && sub !== "help") {
    throw new Error(`Unknown dashboard subcommand: ${sub}. Try 'garden dashboard help'.`);
  }

  // Default: create/attach
  resizeTerminal();
  ensureDashboard();
  console.log("Attaching to dashboard... (detach with ctrl-b d)");
  attachDashboardSession();
}

function printDashboardHelp(): void {
  console.log(`
garden dashboard — multi-project control center

Usage:
  garden dashboard                 Open the dashboard (creates if needed)
  garden dashboard exit            Close the dashboard
Layout:
  Left: project status (upper) + garden pane (lower: garden, root, or logs).
  Right: active pane (worker or shell). Info in status bar.

Hotkeys (⌥ = Option/Alt, no prefix needed):
  ⌥1 – ⌥9     Switch to project by number
  ⌥n           New worker (Claude session)
  ⌥w           Jump to first worker
  ⌥s           Jump to project shell
  ⌥] / ⌥[     Cycle workers and shell
  ⌥x           Kill current worker (shell is protected)
  ⌥g           Focus garden (console with garden> prompt)
  ⌥r           Focus root shell
  ⌥l           Focus logs

Setup:
  iTerm2: Profiles → Keys → Left Option key → "Esc+"

Navigation:
  ctrl-b d     Detach (everything keeps running)
  ctrl-b z     Zoom/unzoom current pane
`.trim());
}

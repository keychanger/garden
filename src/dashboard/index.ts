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
import { newWorker, killPane, bounceActiveWorker } from "./workers.js";
import { continueWorker } from "./continue.js";
import { switchProject, focusWorker, focusShell, focusGrowhouse, focusRoot, focusLogs, cyclePane, cyclePlot } from "./navigate.js";
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
  if (sub === "_focus-growhouse") return focusGrowhouse();
  if (sub === "_focus-root") return focusRoot();
  if (sub === "_focus-logs") return focusLogs();
  if (sub === "_cycle-pane") return cyclePane(args[1] === "prev" ? -1 : 1);
  if (sub === "_cycle-plot") return cyclePlot(args[1] === "prev" ? -1 : 1);
  if (sub === "_kill-pane") return killPane();
  if (sub === "_bounce") return bounceActiveWorker();
  if (sub === "_continue-worker") {
    if (args[1] && args[2]) continueWorker(args[1], args[2]);
    return;
  }
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
    const { respawnStatusPane, respawnLogsPane, resolveGardenRunner } = await import("./create.js");
    const { readDashState } = await import("./state.js");
    const { refreshDashboard, setupStatusBar } = await import("./header.js");
    const { restartLongLivedPollers } = await import("./poller.js");
    if (dashboardExists()) {
      const state = readDashState();
      const runner = resolveGardenRunner();
      try { setupStatusBar(runner); } catch { /* best effort — pick up format-string changes */ }
      try { respawnStatusPane(state); } catch { /* pane gone */ }
      try { restartLongLivedPollers(runner); } catch { /* best effort */ }
      try { respawnLogsPane(state); } catch { /* pane gone */ }
      try { refreshDashboard(); } catch { /* no attached client */ }
    }
    return;
  }
  if (sub === "_header") return printHeader();
  if (sub === "_claude-hook") return handleClaudeHook(args[1]);
  // Back-compat: pre-auto-mode worktrees wired _judge-bash as a PreToolUse Bash hook; drop once no settings.local.json references it.
  if (sub === "_judge-bash") return;
  if (sub === "_pane-died") return handlePaneDied(args[1]);
  if (sub === "_title-changed") return handleTitleChanged(args[1], args[2]);
  if (sub === "_client-resized") {
    // Re-pin usage pane height: tmux redistributes pane sizes proportionally on
    // terminal resize, leaving blank rows below the meters until the next refresh.
    // Skip refresh-client/full refresh — those broke copy-mode scrolling (a10642c).
    const { readDashState } = await import("./state.js");
    const { tmux } = await import("./tmux.js");
    const { USAGE_PANE_HEIGHT } = await import("./create.js");
    try {
      const state = readDashState();
      if (state.usagePaneId) {
        tmux("resize-pane", "-t", state.usagePaneId, "-y", String(USAGE_PANE_HEIGHT));
      }
    } catch { /* pane gone or no client */ }
    return;
  }
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
  Left: garden title + usage meters (top), project status (middle), growhouse pane (bottom: growhouse, root, or logs).
  Right: active pane (worker or shell). Info in status bar.

Hotkeys (⌥ = Option/Alt, no prefix needed):
  ⌥1 – ⌥9     Switch to project by number (within active plot)
  ⌥p / ⌥P     Cycle to next/previous focused plot (⌥o also cycles previous)
  ⌥n           New worker (Claude session)
  ⌥w           Jump to first worker
  ⌥s           Jump to project shell
  ⌥] / ⌥[     Cycle workers and shell
  ⌥x           Kill current worker (shell is protected)
  ⌥b           Bounce current worker (restart Claude, preserve session history)
  ⌥g           Focus growhouse (garden> prompt with auto-dispatch)
  ⌥r           Focus root shell
  ⌥l           Focus logs

Setup:
  iTerm2: Profiles → Keys → Left Option key → "Esc+"

Navigation:
  ctrl-b d     Detach (everything keeps running)
  ctrl-b z     Zoom/unzoom current pane
`.trim());
}

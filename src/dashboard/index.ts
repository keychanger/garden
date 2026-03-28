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
import { printHeader } from "./header.js";
import { log } from "./log.js";
import { ensureDashboard, resizeTerminal, cleanupContextFiles } from "./create.js";
import { newWorker, killPane } from "./workers.js";
import { switchProject, focusWorker, focusShell, focusGarden, cyclePane } from "./navigate.js";
import { handlePostExit, handlePostReview, checkWorkerPRs } from "./review.js";

export async function dashboard(args: string[]): Promise<void> {
  checkTmux();

  const sub = args[0];

  if (sub === "exit" || sub === "close") {
    if (!dashboardExists()) {
      console.log("No dashboard running.");
      return;
    }
    log.info("dashboard", "closing dashboard");
    killDashboardSession();
    try { fs.unlinkSync(STATE_FILE); } catch { /* ignore */ }
    try { fs.unlinkSync(REGISTRY_FILE); } catch { /* ignore */ }
    cleanupContextFiles();
    console.log("Dashboard closed.");
    return;
  }

  if (sub === "restart") {
    if (dashboardExists()) {
      log.info("dashboard", "restarting dashboard");
      killDashboardSession();
      try { fs.unlinkSync(STATE_FILE); } catch { /* ignore */ }
      cleanupContextFiles();
    }
    resizeTerminal();
    ensureDashboard();
    console.log("Attaching to dashboard... (detach with ctrl-b d)");
    attachDashboardSession();
    return;
  }

  // Internal subcommands called by hotkeys
  if (sub === "_switch") return switchProject(args[1]);
  if (sub === "_new-worker") return newWorker();
  if (sub === "_focus-worker") return focusWorker();
  if (sub === "_focus-shell") return focusShell();
  if (sub === "_focus-garden") return focusGarden();
  if (sub === "_cycle-pane") return cyclePane(args[1] === "prev" ? -1 : 1);
  if (sub === "_kill-pane") return killPane();
  if (sub === "_post-exit") return handlePostExit(args[1], args[2]);
  if (sub === "_post-review") return handlePostReview(args[1], args[2]);
  if (sub === "_check-prs") return checkWorkerPRs();
  if (sub === "_header") return printHeader();

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
  garden dashboard restart         Restart (preserves workers)

Layout:
  Left: project status (upper, auto-sized) + garden shell (lower).
  Right: active pane (worker or shell). Info in status bar.

Hotkeys (⌥ = Option/Alt, no prefix needed):
  ⌥1 – ⌥9     Switch to project by number
  ⌥n           New worker (Claude session)
  ⌥w           Jump to first worker
  ⌥s           Jump to project shell
  ⌥] / ⌥[     Cycle between workers
  ⌥x           Kill current worker (shell is protected)
  ⌥g           Focus garden shell

Setup:
  iTerm2: Profiles → Keys → Left Option key → "Esc+"

Navigation:
  ctrl-b d     Detach (everything keeps running)
  ctrl-b z     Zoom/unzoom current pane
`.trim());
}

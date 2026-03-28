// Diagnostic command: validates dashboard state against tmux reality.
import { dashboardExists, DASHBOARD_SESSION } from "../session.js";
import { readDashState, writeDashState } from "../dashboard/state.js";
import { readRegistry } from "../dashboard/registry.js";
import { validateAndHeal } from "../dashboard/validate.js";
import {
  paneExists, windowExists, getPanePid, hasClaudeChild,
  listHiddenWorkerWindows,
} from "../dashboard/tmux.js";
import { loadConfig } from "../config.js";

export async function health(args: string[]): Promise<void> {
  const fix = args.includes("--fix");

  if (!dashboardExists()) {
    console.log("Dashboard: not running");
    console.log("Run 'garden dashboard' to start.");
    return;
  }

  console.log(`Dashboard: running (session ${DASHBOARD_SESSION})`);

  const state = readDashState();
  const registry = readRegistry();
  const config = loadConfig();
  const issues: string[] = [];

  // State pane checks
  const panes = [
    { label: "statusPaneId", id: state.statusPaneId },
    { label: "gardenShellPaneId", id: state.gardenShellPaneId },
    { label: "activePaneId", id: state.activePaneId },
  ];

  console.log(`State: activeProject=${state.activeProject ?? "none"}, activePaneType=${state.activePaneType ?? "none"}`);
  console.log("Panes:");
  for (const { label, id } of panes) {
    if (!id) {
      console.log(`  ${label}: not set`);
    } else if (paneExists(id)) {
      console.log(`  ${label} ${id}: alive`);
    } else {
      console.log(`  ${label} ${id}: DEAD`);
      issues.push(`${label} ${id} does not exist in tmux`);
    }
  }

  // Worker checks
  const projectNames = Object.keys(config.projects);
  let totalWorkers = 0;

  console.log("Workers:");
  for (const projectName of projectNames) {
    const entries = registry.workers[projectName] ?? [];
    const hiddenWindows = listHiddenWorkerWindows(projectName);

    for (const entry of entries) {
      totalWorkers++;
      const windowName = `_${projectName}-worker-${entry.name}`;
      const isActive = windowName === state.activeWindowName;
      const hasWindow = windowExists(windowName) || isActive;

      if (!hasWindow) {
        console.log(`  ${projectName}/${entry.name}: MISSING window`);
        issues.push(`Worker ${entry.name} registered but window ${windowName} missing`);
        continue;
      }

      let workerStatus = "window exists";
      if (isActive && state.activePaneId) {
        const pid = getPanePid(state.activePaneId);
        if (pid && hasClaudeChild(pid)) {
          workerStatus = "claude running";
        } else if (pid) {
          workerStatus = "claude exited";
        }
      }

      const task = entry.task ? ` (${entry.task})` : "";
      console.log(`  ${projectName}/${entry.name}: ${workerStatus}${task}`);
    }

    // Check for orphaned windows (in tmux but not in registry)
    const registeredNames = new Set(entries.map(e => e.name));
    for (const win of hiddenWindows) {
      const workerName = win.replace(`_${projectName}-worker-`, "");
      if (!registeredNames.has(workerName) && win !== state.activeWindowName) {
        console.log(`  ${projectName}/${workerName}: ORPHANED window`);
        issues.push(`Orphaned window ${win} not in registry`);
      }
    }
  }

  if (totalWorkers === 0) {
    console.log("  (none)");
  }

  // Summary
  if (issues.length === 0) {
    console.log("\nHealth: OK");
  } else {
    console.log(`\nHealth: ${issues.length} issue${issues.length === 1 ? "" : "s"} found`);
    for (const issue of issues) {
      console.log(`  - ${issue}`);
    }
    if (fix) {
      console.log("\nHealing...");
      const healed = validateAndHeal(state);
      writeDashState(healed);
      console.log("Done. Run 'garden health' again to verify.");
    } else {
      console.log("\nRun 'garden health --fix' to attempt repair.");
    }
  }
}

// Diagnostic command: validates dashboard state against tmux reality.
import { dashboardExists, DASHBOARD_SESSION } from "../session.js";
import { readDashState, writeDashState, withStateLock } from "../dashboard/state.js";
import { readRegistry, updateWorkerFields } from "../dashboard/registry.js";
import { validateAndHeal } from "../dashboard/validate.js";
import {
  paneExists, windowExists, getFirstPaneId, getPanePid,
  listHiddenWorkerWindows,
} from "../dashboard/tmux.js";
import { loadConfig } from "../config.js";
import { workerWindowName as workerWin, parseWorkerSuffix } from "../dashboard/window-names.js";
import { log } from "../dashboard/log.js";

// A worker in `working` state with no hook fire in this long is considered
// stuck. The Stop hook should fire whenever Claude finishes — if 15 minutes
// elapse without one, either Claude crashed mid-response or the hook
// plumbing dropped an event. Either way the user should know.
//
// 15 minutes is intentionally lax: a long-running tool call (e.g., a slow
// build) can legitimately keep Claude in `working` for several minutes.
// Tighten this if false positives are rare in practice.
const STALE_EVENT_MS = 15 * 60 * 1000;

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
      const windowName = workerWin(projectName, entry.name);
      const isActive = windowName === state.activeWindowName;
      const hasWindow = windowExists(windowName) || isActive;

      if (!hasWindow) {
        console.log(`  ${projectName}/${entry.name}: MISSING window`);
        issues.push(`Worker ${entry.name} registered but window ${windowName} missing`);
        continue;
      }

      // Liveness comes from the registry's agentStatus, written by Claude
      // Code hooks and the tmux pane-died handler. The registry is the
      // single source of truth per STATUS.md.
      const workerStatus = entry.agentStatus ?? "unknown";
      const task = entry.task ? ` (${entry.task})` : "";
      console.log(`  ${projectName}/${entry.name}: ${workerStatus}${task}`);

      // Stale-hook detection: a worker that has been "working" for longer
      // than STALE_EVENT_MS without any hook fire is suspicious. Either Claude
      // crashed mid-response, the hook plumbing is broken, or there is a
      // very long-running tool call. Surface to the user so they can
      // investigate. We do not auto-correct — the spec rejects
      // fallback polling as a discovery mechanism.
      if (entry.agentStatus === "working") {
        const lastEventAt = entry.lastEventAt ?? 0;
        const elapsed = Date.now() - lastEventAt;
        if (lastEventAt === 0 || elapsed > STALE_EVENT_MS) {
          const ageMin = lastEventAt === 0 ? "ever" : `${Math.round(elapsed / 60000)}min`;
          issues.push(
            `Worker ${entry.name}: agentStatus=working but last hook ${ageMin} ago`,
          );
        }
      }

      // Dead-pane detection: if the pane PID is gone but agentStatus is
      // not "exited", the tmux pane-died hook missed the death event.
      // With --fix, write agentStatus="exited" to correct the registry.
      if (entry.agentStatus !== "exited") {
        const paneId = isActive
          ? state.activePaneId
          : getFirstPaneId(`${DASHBOARD_SESSION}:${windowName}`);
        if (paneId) {
          const pid = getPanePid(paneId);
          if (pid) {
            let alive = true;
            try { process.kill(parseInt(pid, 10), 0); } catch { alive = false; }
            if (!alive) {
              issues.push(
                `Worker ${entry.name}: pane PID ${pid} is dead but agentStatus=${entry.agentStatus ?? "unknown"}`,
              );
              if (fix) {
                try {
                  updateWorkerFields(projectName, entry.name, { agentStatus: "exited" });
                } catch (err) {
                  log.warn("health", "fix-up update failed", {
                    worker: entry.name,
                    data: { project: projectName, error: String(err) },
                  });
                }
              }
            }
          }
        }
      }
    }

    // Check for orphaned windows (in tmux but not in registry)
    const registeredNames = new Set(entries.map(e => e.name));
    for (const win of hiddenWindows) {
      const workerName = parseWorkerSuffix(win) ?? win;
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
      // Reconcile under the state lock, re-reading fresh so the heal + write is
      // atomic against concurrent hotkey navigation (see ensureDashboard).
      withStateLock(() => {
        const healed = validateAndHeal(readDashState());
        writeDashState(healed);
      });
      console.log("Done. Run 'garden health' again to verify.");
    } else {
      console.log("\nRun 'garden health --fix' to attempt repair.");
    }
  }
}

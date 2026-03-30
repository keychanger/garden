// State validation and self-healing: reconciles dashboard state with tmux reality.
import fs from "node:fs";
import { SESSIONS_DIR, loadConfig } from "../config.js";
import { type DashboardState } from "./state.js";
import { readRegistry, writeRegistry } from "./registry.js";
import { paneExists, windowExists, getFirstPaneId, listHiddenWorkerWindows, killWindowSafe } from "./tmux.js";
import { log } from "./log.js";
import { worktreeExists, removeWorktree, pruneWorktrees, isPRMerged } from "./git.js";
import { startPoller, pollerRunning } from "./poller.js";
import { resolveGardenRunner } from "./create.js";

/**
 * Validate dashboard state against tmux reality and heal inconsistencies.
 * Returns the healed state (may be identical if everything is consistent).
 */
export function validateAndHeal(state: DashboardState): DashboardState {
  const healed = { ...state };
  let changed = false;

  if (healed.statusPaneId && !paneExists(healed.statusPaneId)) {
    log.warn("validate", "statusPaneId is stale", { paneId: healed.statusPaneId });
    healed.statusPaneId = null;
    changed = true;
  }

  if (healed.gardenShellPaneId && !paneExists(healed.gardenShellPaneId)) {
    log.warn("validate", "gardenShellPaneId is stale", { paneId: healed.gardenShellPaneId });
    healed.gardenShellPaneId = null;
    changed = true;
  }

  if (healed.activePaneId && !paneExists(healed.activePaneId)) {
    log.warn("validate", "activePaneId is stale, attempting recovery", {
      paneId: healed.activePaneId,
      windowName: healed.activeWindowName,
    });
    changed = true;

    // Try to recover from the named window
    let recovered = false;
    if (healed.activeWindowName && windowExists(healed.activeWindowName)) {
      const paneId = getFirstPaneId(healed.activeWindowName);
      if (paneId) {
        healed.activePaneId = paneId;
        log.info("validate", "recovered activePaneId from window", {
          windowName: healed.activeWindowName,
          paneId,
        });
        recovered = true;
      }
    }

    // Fall back to any worker window for the active project
    if (!recovered && healed.activeProject) {
      const workers = listHiddenWorkerWindows(healed.activeProject);
      for (const win of workers) {
        const paneId = getFirstPaneId(win);
        if (paneId) {
          healed.activePaneId = paneId;
          healed.activePaneType = "worker";
          healed.activeWindowName = win;
          log.info("validate", "recovered activePaneId from worker window", {
            windowName: win,
            paneId,
          });
          recovered = true;
          break;
        }
      }
    }

    if (!recovered) {
      healed.activePaneId = null;
      healed.activePaneType = null;
      healed.activeWindowName = null;
      log.warn("validate", "could not recover activePaneId");
    }
  }

  // Validate registry against tmux windows
  const registry = readRegistry();
  let registryChanged = false;

  for (const [projectName, entries] of Object.entries(registry.workers)) {
    const before = entries.length;
    registry.workers[projectName] = entries.filter(entry => {
      const windowName = `_${projectName}-worker-${entry.name}`;
      const exists = windowExists(windowName) || windowName === healed.activeWindowName;
      if (!exists) {
        log.info("validate", "removing registry entry for missing window", {
          project: projectName,
          worker: entry.name,
        });
      }
      return exists;
    });
    if (registry.workers[projectName].length === 0) {
      delete registry.workers[projectName];
    }
    if (registry.workers[projectName]?.length !== before) {
      registryChanged = true;
    }
  }

  // Validate worktrees for remaining registry entries
  for (const [projectName, entries] of Object.entries(registry.workers)) {
    for (const entry of entries) {
      if (!entry.worktreePath) continue;
      if (!worktreeExists(entry.worktreePath)) {
        log.warn("validate", "worktree missing for worker", {
          project: projectName,
          worker: entry.name,
          worktreePath: entry.worktreePath,
        });
        if (entry.prNumber && isPRMerged(entry.worktreePath, entry.prNumber)) {
          log.info("validate", "PR already merged, cleaning registry entry", {
            worker: entry.name,
            prNumber: entry.prNumber,
          });
        }
        entry.worktreePath = undefined;
        registryChanged = true;
      }
    }
  }

  if (registryChanged) {
    writeRegistry(registry);
  }

  // Prune orphaned git worktrees
  try {
    const config = loadConfig();
    for (const project of Object.values(config.projects)) {
      pruneWorktrees(project.path);
    }
  } catch { /* best effort */ }

  // Clean stale context files
  cleanContextFiles();

  // Restart poller if it's not running
  if (!pollerRunning()) {
    log.info("validate", "poller not running, restarting");
    startPoller(resolveGardenRunner());
  }

  if (changed) {
    log.info("validate", "state healed", {
      activePaneId: healed.activePaneId,
      activePaneType: healed.activePaneType,
      activeWindowName: healed.activeWindowName,
    });
  }

  return healed;
}

function cleanContextFiles(): void {
  try {
    const config = loadConfig();
    const projectNames = new Set(Object.keys(config.projects));
    const files = fs.readdirSync(SESSIONS_DIR);
    for (const file of files) {
      if (!file.startsWith("dashboard-") || !file.endsWith(".context")) continue;
      const projectName = file.replace("dashboard-", "").replace(".context", "");
      if (!projectNames.has(projectName)) {
        fs.unlinkSync(`${SESSIONS_DIR}/${file}`);
        log.info("validate", "removed stale context file", { file });
      }
    }
  } catch { /* sessions dir might not exist */ }
}

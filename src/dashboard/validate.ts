// State validation and self-healing: reconciles dashboard state with tmux reality.
import fs from "node:fs";
import { SESSIONS_DIR, loadConfig } from "../config.js";
import { type DashboardState, readDashState, writeDashState } from "./state.js";
import { readRegistry, writeRegistry, updateWorkerFields, type WorkerRegistry } from "./registry.js";
import { paneExists, windowExists, getFirstPaneId, listHiddenWorkerWindows, killWindowSafe, tmuxSplit, setPaneTitle, setPaneLabel, tmux, disablePaneInput, renameWindow } from "./tmux.js";
import { log } from "./log.js";
import { worktreeExists, removeWorktree, pruneWorktrees } from "./git.js";
import { startProjectPoller, projectPollerRunning } from "./poller.js";
import { createGardenGrowhouseWindow, USAGE_PANE_HEIGHT } from "./create.js";
import { resolveGardenRunner } from "./runner.js";
import { gardenWindowName, workerWindowName } from "./window-names.js";
import { buildStatusCommand, buildUsageCommand } from "./header.js";
import { gardenRestoreFromHidden } from "./layout.js";
import { addAlert } from "./alerts.js";

/**
 * Recreate the status pane if it's missing. Reads and writes state atomically.
 * Called from the poll loop (every 30s) to catch mid-session disappearances,
 * and also from validateAndHeal on reattach.
 */
export function healStatusPane(): void {
  const state = readDashState();
  let healed = healStatusPaneInState(state);
  healed = healUsagePaneInState(healed);
  if (healed !== state) {
    writeDashState(healed);
  }
}

function healGardenPaneInState(state: DashboardState): DashboardState {
  let healed = state;

  if (healed.gardenShellPaneId && !paneExists(healed.gardenShellPaneId)) {
    log.warn("validate", "gardenShellPaneId is stale");
    healed = { ...healed, gardenShellPaneId: null };
  }

  if (!healed.gardenShellPaneId && healed.statusPaneId && paneExists(healed.statusPaneId)) {
    try {
      const newPaneId = tmuxSplit("-v", "-t", healed.statusPaneId);
      if (newPaneId) {
        setPaneTitle(newPaneId, "growhouse");
        setPaneLabel(newPaneId, "growhouse");

        // gardenRestoreFromHidden mutates state.gardenShellPaneId in-place,
        // so work with a mutable interim object before the final spread.
        const interim = { ...healed, gardenShellPaneId: newPaneId };

        const gardenRunner = resolveGardenRunner();
        const growhouseWin = gardenWindowName("growhouse");
        if (!windowExists(growhouseWin)) {
          createGardenGrowhouseWindow(gardenRunner);
        }
        gardenRestoreFromHidden(growhouseWin, interim);

        healed = {
          ...interim,
          gardenPaneType: "growhouse" as const,
          gardenWindowName: growhouseWin,
        };
        log.info("validate", "recreated growhouse pane");
      }
    } catch (err) {
      log.warn("validate", "failed to recreate garden pane", { data: { error: String(err) } });
    }
  }

  return healed;
}

function healUsagePaneInState(state: DashboardState): DashboardState {
  let healed = state;

  if (healed.usagePaneId && !paneExists(healed.usagePaneId)) {
    log.warn("validate", "usagePaneId is stale");
    healed = { ...healed, usagePaneId: null };
  }

  if (!healed.usagePaneId && healed.statusPaneId && paneExists(healed.statusPaneId)) {
    try {
      const gardenRunner = resolveGardenRunner();
      const usageCmd = buildUsageCommand(gardenRunner);
      const usageId = tmuxSplit("-v", "-b", "-t", healed.statusPaneId, "-l", String(USAGE_PANE_HEIGHT),
        "sh", "-c", usageCmd);

      try { tmux("resize-pane", "-t", usageId, "-y", String(USAGE_PANE_HEIGHT)); } catch { /* ignore */ }
      try { tmux("clear-history", "-t", usageId); } catch { /* ignore */ }
      // Splitting shrinks status pane — flush the ghost rows pushed into scrollback by the resize.
      try { tmux("clear-history", "-t", healed.statusPaneId); } catch { /* ignore */ }
      setPaneTitle(usageId, "garden");
      setPaneLabel(usageId, "🌱 #[fg=green,bold]garden#[default]");
      disablePaneInput(usageId);

      healed = { ...healed, usagePaneId: usageId };
      log.info("validate", "recreated usage pane");
    } catch (err) {
      log.warn("validate", "failed to recreate usage pane", { data: { error: String(err) } });
    }
  }

  return healed;
}

function healStatusPaneInState(state: DashboardState): DashboardState {
  let healed = state;

  if (healed.statusPaneId && !paneExists(healed.statusPaneId)) {
    log.warn("validate", "statusPaneId is stale");
    healed = { ...healed, statusPaneId: null };
  }

  if (!healed.statusPaneId && healed.gardenShellPaneId && paneExists(healed.gardenShellPaneId)) {
    try {
      const gardenRunner = resolveGardenRunner();
      const config = loadConfig();
      const projectCount = Object.keys(config.projects).length;
      // +1 for pane-border-status top, which occupies one row of total pane height.
      const statusHeight = Math.max(4, projectCount * 2 + 2) + 1;
      const statusCmd = buildStatusCommand(gardenRunner);

      const statusId = tmuxSplit("-v", "-b", "-t", healed.gardenShellPaneId, "-l", String(statusHeight),
        "sh", "-c", statusCmd);

      try { tmux("resize-pane", "-t", statusId, "-y", String(statusHeight)); } catch { /* ignore */ }
      try { tmux("clear-history", "-t", statusId); } catch { /* ignore */ }
      setPaneTitle(statusId, "status");
      disablePaneInput(statusId);

      healed = { ...healed, statusPaneId: statusId };
      log.info("validate", "recreated status pane");
    } catch (err) {
      log.warn("validate", "failed to recreate status pane", { data: { error: String(err) } });
    }
  }

  return healed;
}

// Ghost entries: never-bootstrapped workers from a failed handoff or hotkey
// spawn. Identified by the combination of claudeStatus === "loading" (never
// advanced to ready/idle), no tmux window, and no worktree on disk. A genuine
// in-flight worker has a tmux window at this point (tmuxNewWindow creates it
// before bootstrap runs), so this rule doesn't race with normal creation.
// The "never auto-cleanup" rule is about preserving operator work on real
// workers; these never produced any work to preserve.
//
// Mutates `registry` in place; returns true if anything was dropped. Caller
// is responsible for persisting via writeRegistry.
function dropGhostEntries(registry: WorkerRegistry, activeWindowName: string | null): boolean {
  let changed = false;
  for (const projectName of Object.keys(registry.workers)) {
    const entries = registry.workers[projectName];
    const kept = entries.filter(entry => {
      if (entry.claudeStatus !== "loading") return true;
      if (entry.worktreePath && worktreeExists(entry.worktreePath)) return true;
      const windowName = workerWindowName(projectName, entry.name);
      if (windowExists(windowName)) return true;
      if (windowName === activeWindowName) return true;
      log.warn("validate", "removing ghost worker (loading, no worktree, no pane)", {
        worker: entry.name,
        data: { project: projectName },
      });
      return false;
    });
    if (kept.length !== entries.length) {
      registry.workers[projectName] = kept;
      changed = true;
    }
  }
  return changed;
}

/**
 * Cross-project ghost sweep, intended for repeated invocation from a poller.
 * Drops registry entries that the strict ghost rule would have removed at
 * dashboard attach time — handles ghosts that appear mid-session (e.g. a
 * fan-out handoff where some bootstraps crashed) without waiting for the
 * next dashboard restart. Returns true if any entry was dropped.
 */
export function sweepGhostEntries(): boolean {
  const registry = readRegistry();
  const state = readDashState();
  if (!dropGhostEntries(registry, state.activeWindowName)) return false;
  writeRegistry(registry);
  return true;
}

/**
 * Validate dashboard state against tmux reality and heal inconsistencies.
 * Returns the healed state (may be identical if everything is consistent).
 */
export function validateAndHeal(state: DashboardState): DashboardState {
  if (windowExists("_garden-console") && !windowExists("_garden-growhouse")) {
    renameWindow("_garden-console", "_garden-growhouse");
    log.info("validate", "renamed _garden-console to _garden-growhouse");
  }
  if (state.gardenShellPaneId && state.gardenPaneType === "growhouse" && paneExists(state.gardenShellPaneId)) {
    setPaneTitle(state.gardenShellPaneId, "growhouse");
    setPaneLabel(state.gardenShellPaneId, "growhouse");
  }

  let healed = healStatusPaneInState(state);
  healed = healUsagePaneInState(healed);
  healed = healGardenPaneInState(healed);
  let changed = healed !== state;

  if (healed.activePaneId && !paneExists(healed.activePaneId)) {
    log.warn("validate", "activePaneId is stale, attempting recovery");
    changed = true;

    // Try to recover from the named window
    let recovered = false;
    if (healed.activeWindowName && windowExists(healed.activeWindowName)) {
      const paneId = getFirstPaneId(healed.activeWindowName);
      if (paneId) {
        healed.activePaneId = paneId;
        log.info("validate", "recovered activePaneId from window");
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
          log.info("validate", "recovered activePaneId from worker window");
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

  // Validate registry against tmux windows. When a registered worker has
  // no tmux window, the pane process is gone — but the worktree on disk
  // and the branch on origin both persist. The "never auto-cleanup workers"
  // rule (per the operator's standing feedback) means we must NOT remove
  // the registry entry: a transient tmux glitch (server crash + restart)
  // would otherwise discard the worker permanently. Mark `claudeStatus =
  // "exited"` (matching the pane-died hook's effect) and surface an alert
  // so the operator can either resume manually or `⌥x` to clean up.
  const registry = readRegistry();
  let registryChanged = false;

  // Drop ghost entries FIRST. Must run before the "mark exited" pass —
  // that pass would otherwise rewrite claudeStatus from "loading" to
  // "exited" and the ghost would slip through as a preserved exited worker.
  if (dropGhostEntries(registry, healed.activeWindowName)) {
    registryChanged = true;
  }

  for (const [projectName, entries] of Object.entries(registry.workers)) {
    for (const entry of entries) {
      const windowName = workerWindowName(projectName, entry.name);
      const exists = windowExists(windowName) || windowName === healed.activeWindowName;
      if (exists) continue;
      if (entry.claudeStatus === "exited") continue; // already marked
      log.warn("validate", "worker window missing, marking exited (entry preserved)", {
        worker: entry.name,
        data: { project: projectName, prState: entry.prState },
      });
      entry.claudeStatus = "exited";
      registryChanged = true;
      addAlert({
        level: "warn",
        source: "validate",
        project: projectName,
        worker: entry.name,
        message:
          `Worker '${entry.name}' has no tmux pane. The worktree on disk is preserved — ` +
          `restart the dashboard ('garden dashboard exit && garden dashboard') to recreate ` +
          `the pane from the registry, or kill the worker (⌥x) to clean up. ` +
          `'garden bounce' won't work without a live pane.`,
        // Stable key so a single missing pane doesn't spam the badge across
        // every reattach within the dedup window.
        dedupKey: `validate-exited:${projectName}:${entry.name}`,
      });
    }
  }

  // Validate worktrees for registry entries
  for (const [projectName, entries] of Object.entries(registry.workers)) {
    void projectName; // worktreePath is repository-absolute; project is for logs only
    for (const entry of entries) {
      if (!entry.worktreePath) continue;
      if (!worktreeExists(entry.worktreePath)) {
        log.warn("validate", "worktree missing for worker", {
          worker: entry.name,
        });
        entry.worktreePath = undefined;
        registryChanged = true;
      }
    }
  }

  if (registryChanged) {
    writeRegistry(registry);
  }

  // Clean stale lastActiveWorker references pointing to dead windows
  for (const [proj, winName] of Object.entries(healed.lastActiveWorker ?? {})) {
    if (!windowExists(winName) && winName !== healed.activeWindowName) {
      delete healed.lastActiveWorker[proj];
      changed = true;
      log.info("validate", "cleared stale lastActiveWorker", { data: { project: proj, window: winName } });
    }
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

  // Restart per-project pollers if not running
  const gardenRunner = resolveGardenRunner();
  for (const projectName of Object.keys(registry.workers)) {
    if (registry.workers[projectName].length > 0 && !projectPollerRunning(projectName)) {
      log.info("validate", "project poller not running, restarting", { data: { project: projectName } });
      startProjectPoller(projectName, gardenRunner);
    }
  }

  // Clean orphaned review windows
  cleanOrphanedReviewWindows(registry);

  if (changed) {
    log.info("validate", "state healed");
  }

  return healed;
}

function cleanContextFiles(): void {
  try {
    const config = loadConfig();
    const projectNames = new Set(Object.keys(config.projects));
    const files = fs.readdirSync(SESSIONS_DIR);
    for (const file of files) {
      // Clean stale context files
      if (file.startsWith("dashboard-") && file.endsWith(".context")) {
        const projectName = file.replace("dashboard-", "").replace(".context", "");
        if (!projectNames.has(projectName)) {
          fs.unlinkSync(`${SESSIONS_DIR}/${file}`);
          log.info("validate", "removed stale context file", { data: { file } });
        }
        continue;
      }
      // Clean stale review result/prompt files
      if (file.endsWith("-review-result.txt") || file.endsWith("-review-prompt.txt")) {
        fs.unlinkSync(`${SESSIONS_DIR}/${file}`);
        log.info("validate", "removed stale review file", { data: { file } });
      }
    }
  } catch { /* sessions dir might not exist */ }
}

function cleanOrphanedReviewWindows(registry: WorkerRegistry): void {
  // Clear reviewWindowName from entries whose windows no longer exist
  for (const [projectName, entries] of Object.entries(registry.workers)) {
    for (const entry of entries) {
      if (entry.reviewWindowName && !windowExists(entry.reviewWindowName)) {
        updateWorkerFields(projectName, entry.name, { reviewWindowName: undefined });
        log.info("validate", "cleared stale reviewWindowName", {
          worker: entry.name,
        });
      }
    }
  }
}

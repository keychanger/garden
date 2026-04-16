// Pane navigation: project switching, worker/shell focus, cycling.
import { loadConfig, getProject, getFocusedProjectNames } from "../config.js";
import { readDashState, writeDashState, withStateLock } from "./state.js";
import { parkToHidden, swapToHidden, swapDirect } from "./layout.js";
import { restoreFromHidden } from "./layout.js";
import { gardenSwapToHidden, gardenRestoreFromHidden } from "./layout.js";
import { refreshDashboard } from "./header.js";
import {
  tmux, tmuxDisplay,
  paneExists, windowExists,
  listAllWindowNames,
  listHiddenWorkerWindows,
  setPaneLabel,
  setPaneVar,
} from "./tmux.js";
import { findWorkerByName } from "./registry.js";
import { acknowledgeAlerts } from "./alerts.js";
import { log } from "./log.js";
import { createShellWindow, createLogsWindow, createGardenRootWindow, createGardenConsoleWindow, resolveGardenRunner } from "./create.js";
import { parkingWindowName, shellWindowName as shellWin, gardenWindowName, parseWorkerSuffix, isWorkerWindow, type GardenView } from "./window-names.js";

/**
 * Re-apply pane variables after a worker pane is swapped into the visible
 * slot. swap-pane does not carry pane-level user options (@garden_name,
 * @garden_task), so restore them from the window name and registry.
 */
function restoreWorkerPaneVars(paneId: string, project: string, windowName: string): void {
  const workerLabel = parseWorkerSuffix(windowName);
  if (!workerLabel) return;
  setPaneLabel(paneId, workerLabel);
  const entry = findWorkerByName(project, workerLabel);
  if (entry?.task) {
    setPaneVar(paneId, "garden_task", entry.task);
  }
}

export function switchProject(indexArg: string): void {
  log.info("navigate", "switchProject", { data: { index: indexArg } });
  const index = parseInt(indexArg, 10) - 1;
  const config = loadConfig();
  const projectNames = getFocusedProjectNames(config);

  if (index < 0 || index >= projectNames.length) {
    tmuxDisplay(`No project at index ${index + 1}`);
    return;
  }

  const projectName = projectNames[index];
  const project = config.projects[projectName];

  withStateLock(() => {
    const state = readDashState();

    if (state.activeProject === projectName) {
      tmuxDisplay(`Already on ${projectName}`);
      return;
    }

    // Record last active worker for the project we're leaving
    if (state.activeProject && state.activePaneType === "worker" && state.activeWindowName) {
      state.lastActiveWorker[state.activeProject] = state.activeWindowName;
    }

    // Single list-windows call replaces multiple windowExists checks
    const windowNames = listAllWindowNames();
    const has = (name: string) => windowNames.includes(name);

    const parkName = state.activeWindowName ?? parkingWindowName(state.activeProject ?? "none");
    parkToHidden(parkName, state);

    const parkTarget = parkingWindowName(projectName);
    const shellTarget = shellWin(projectName);
    if (has(parkTarget)) {
      restoreFromHidden(parkTarget, state);
      state.activePaneType = "worker";
      state.activeWindowName = parkTarget;
    } else {
      const workerWindows = listHiddenWorkerWindows(projectName, windowNames);
      // Prefer the last-touched worker, fall back to first available
      const preferred = state.lastActiveWorker[projectName];
      const targetWorker = preferred && workerWindows.includes(preferred)
        ? preferred
        : workerWindows[0];
      if (targetWorker) {
        restoreFromHidden(targetWorker, state);
        state.activePaneType = "worker";
        state.activeWindowName = targetWorker;
      } else if (has(shellTarget)) {
        restoreFromHidden(shellTarget, state);
        state.activePaneType = "shell";
        state.activeWindowName = shellTarget;
      } else {
        createShellWindow(projectName, project.path);
        restoreFromHidden(shellTarget, state);
        state.activePaneType = "shell";
        state.activeWindowName = shellTarget;
      }
    }

    if (state.activePaneType === "worker" && state.activePaneId && state.activeWindowName) {
      restoreWorkerPaneVars(state.activePaneId, projectName, state.activeWindowName);
    }

    state.activeProject = projectName;
    writeDashState(state);
    refreshDashboard({ state });
  });
}

export function focusWorker(): void {
  withStateLock(() => {
    const state = readDashState();
    if (!state.activeProject) {
      tmuxDisplay("No project selected.");
      return;
    }

    if (state.activePaneType === "worker") {
      if (state.activePaneId && paneExists(state.activePaneId)) {
        tmux("select-pane", "-t", state.activePaneId);
      }
      return;
    }

    const workerWindows = listHiddenWorkerWindows(state.activeProject);
    if (workerWindows.length === 0) {
      tmuxDisplay("No workers. Press ⌥n to create one.");
      return;
    }

    const preferred = state.lastActiveWorker[state.activeProject];
    const targetWorker = preferred && workerWindows.includes(preferred)
      ? preferred
      : workerWindows[0];

    log.info("navigate", "focusWorker", { data: { target: targetWorker } });

    const parkName = state.activeWindowName ?? parkingWindowName(state.activeProject);
    swapToHidden(parkName, targetWorker, state);

    if (state.activePaneId) {
      restoreWorkerPaneVars(state.activePaneId, state.activeProject, targetWorker);
    }

    state.activePaneType = "worker";
    state.activeWindowName = targetWorker;
    writeDashState(state);
    refreshDashboard({ state });
  });
}

export function focusShell(): void {
  withStateLock(() => {
    const state = readDashState();
    if (!state.activeProject) {
      tmuxDisplay("No project selected.");
      return;
    }

    if (state.activePaneType === "shell") {
      if (state.activePaneId && paneExists(state.activePaneId)) {
        tmux("select-pane", "-t", state.activePaneId);
      }
      return;
    }

    log.info("navigate", "focusShell", { data: { project: state.activeProject } });

    const project = getProject(state.activeProject);
    const shellTarget = shellWin(state.activeProject);

    if (!windowExists(shellTarget)) {
      createShellWindow(state.activeProject, project.path);
    }

    const parkName = state.activeWindowName ?? parkingWindowName(state.activeProject);
    swapToHidden(parkName, shellTarget, state);

    state.activePaneType = "shell";
    state.activeWindowName = shellTarget;
    writeDashState(state);
    refreshDashboard({ state });
  });
}

function ensureGardenView(view: GardenView): void {
  const wn = gardenWindowName(view);
  if (windowExists(wn)) return;
  if (view === "garden") createGardenConsoleWindow(resolveGardenRunner());
  else if (view === "root") createGardenRootWindow();
  else if (view === "logs") createLogsWindow();
}

function switchGardenTo(view: GardenView): void {
  withStateLock(() => {
    const state = readDashState();

    if (state.gardenPaneType === view) {
      if (state.gardenShellPaneId && paneExists(state.gardenShellPaneId)) {
        tmux("select-pane", "-t", state.gardenShellPaneId);
      }
      return;
    }

    log.info("navigate", "switchGardenTo", { data: { view, from: state.gardenPaneType } });

    const parkName = state.gardenWindowName ?? gardenWindowName("garden");
    ensureGardenView(view);
    gardenSwapToHidden(parkName, gardenWindowName(view), state);
    state.gardenPaneType = view;
    state.gardenWindowName = gardenWindowName(view);
    if (state.gardenShellPaneId) setPaneLabel(state.gardenShellPaneId, view);
    writeDashState(state);
    refreshDashboard({ state });

    if (state.gardenShellPaneId && paneExists(state.gardenShellPaneId)) {
      tmux("select-pane", "-t", state.gardenShellPaneId);
    }
  });
}

export function focusGarden(): void {
  switchGardenTo("garden");
}

export function focusRoot(): void {
  switchGardenTo("root");
}

export function focusLogs(): void {
  switchGardenTo("logs");
  acknowledgeAlerts();
}

export function cyclePane(direction: 1 | -1): void {
  // All state mutations must go through withStateLock to prevent races with
  // switchProject/focusWorker/focusShell which hold the same lock.
  withStateLock(() => {
    const lockedState = readDashState();

    if (!lockedState.activeProject) {
      tmuxDisplay("No project selected.");
      return;
    }

    // Single window list for the entire operation
    const windowNames = listAllWindowNames();
    const hiddenWorkers = listHiddenWorkerWindows(lockedState.activeProject, windowNames);
    const currentName = lockedState.activeWindowName;
    const isCurrentWorker = currentName && isWorkerWindow(currentName);

    const allWorkers = isCurrentWorker
      ? [...new Set([currentName, ...hiddenWorkers])].sort()
      : [...hiddenWorkers];

    if (allWorkers.length === 0) {
      tmuxDisplay("No workers to cycle to. Press ⌥n to create one.");
      return;
    }

    const currentIdx = currentName ? allWorkers.indexOf(currentName) : -1;
    let nextIdx: number;
    if (currentIdx === -1) {
      nextIdx = direction === 1 ? 0 : allWorkers.length - 1;
    } else {
      nextIdx = (currentIdx + direction + allWorkers.length) % allWorkers.length;
    }

    const targetWindow = allWorkers[nextIdx];
    if (targetWindow === currentName) return;

    log.info("navigate", "cyclePane", { data: { direction, from: currentName, to: targetWindow } });

    const parkName = currentName ?? parkingWindowName(lockedState.activeProject);

    // Fast path: direct swap (swap-pane + rename, no temp window)
    if (!swapDirect(parkName, targetWindow, lockedState)) {
      swapToHidden(parkName, targetWindow, lockedState);
    }

    if (lockedState.activePaneId && lockedState.activeProject) {
      restoreWorkerPaneVars(lockedState.activePaneId, lockedState.activeProject, targetWindow);
    }

    lockedState.activePaneType = "worker";
    lockedState.activeWindowName = targetWindow;
    if (lockedState.activeProject) {
      lockedState.lastActiveWorker[lockedState.activeProject] = targetWindow;
    }
    writeDashState(lockedState);

    // Update window list in memory: target was renamed to park name
    const updatedNames = windowNames.map(n => n === targetWindow ? parkName : n);
    refreshDashboard({ state: lockedState, windowNames: updatedNames });
  });
}

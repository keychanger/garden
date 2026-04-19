// Pane navigation: project switching, worker/shell focus, cycling.
import { loadConfig, getProject, getFocusedProjectNames, plotsMap, isPlotFocused } from "../config.js";
import { readDashState, writeDashState, withStateLock, type DashboardState } from "./state.js";
import { parkToHidden, swapToHidden, swapDirect } from "./layout.js";
import { restoreFromHidden } from "./layout.js";
import { gardenSwapToHidden, gardenRestoreFromHidden } from "./layout.js";
import { refreshDashboard, refreshDashboardCycle } from "./header.js";
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

// Park the currently visible pane and restore (or create) a pane for
// `projectName`: prefers the parked worker, then any hidden worker, then the
// project shell. Mutates `state` (activeProject, activePaneType,
// activeWindowName, lastActiveWorker) but does NOT writeDashState — the
// caller is responsible for persisting and refreshing.
function swapVisibleToProject(
  projectName: string,
  project: { path: string },
  state: DashboardState,
  windowNames?: string[],
): void {
  if (state.activeProject && state.activePaneType === "worker" && state.activeWindowName) {
    state.lastActiveWorker[state.activeProject] = state.activeWindowName;
  }

  const names = windowNames ?? listAllWindowNames();
  const has = (name: string) => names.includes(name);

  const parkName = state.activeWindowName ?? parkingWindowName(state.activeProject ?? "none");
  parkToHidden(parkName, state);

  const parkTarget = parkingWindowName(projectName);
  const shellTarget = shellWin(projectName);
  if (has(parkTarget)) {
    restoreFromHidden(parkTarget, state);
    state.activePaneType = "worker";
    state.activeWindowName = parkTarget;
  } else {
    const workerWindows = listHiddenWorkerWindows(projectName, names);
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
}

export function switchProject(indexArg: string): void {
  log.info("navigate", "switchProject", { data: { index: indexArg } });
  const index = parseInt(indexArg, 10) - 1;
  const config = loadConfig();
  const initialState = readDashState();
  const projectNames = getFocusedProjectNames(config, initialState.activePlot);

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

    swapVisibleToProject(projectName, project, state);
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

export function cyclePlot(direction: 1 | -1): void {
  withStateLock(() => {
    const config = loadConfig();
    const plots = plotsMap(config);
    const focusedNames = Object.keys(plots).filter(name => isPlotFocused(plots[name]));

    if (focusedNames.length === 0) {
      tmuxDisplay("No focused plots. Use 'garden focus <plot>' to add one to the cycle.");
      return;
    }
    if (focusedNames.length === 1) {
      tmuxDisplay(`Only one focused plot ('${focusedNames[0]}').`);
      return;
    }

    const state = readDashState();
    const currentIdx = state.activePlot ? focusedNames.indexOf(state.activePlot) : -1;
    const nextIdx = currentIdx === -1
      ? (direction === 1 ? 0 : focusedNames.length - 1)
      : (currentIdx + direction + focusedNames.length) % focusedNames.length;

    const target = focusedNames[nextIdx];
    if (target === state.activePlot) return;

    log.info("navigate", "cyclePlot", { data: { direction, from: state.activePlot, to: target } });

    // Snapshot the leaving plot's active project so cycling back restores it
    // instead of clamping to the new plot's first project.
    if (state.activePlot && state.activeProject) {
      state.lastActiveProjectByPlot[state.activePlot] = state.activeProject;
    }

    state.activePlot = target;

    const newProjects = getFocusedProjectNames(config, target);
    const remembered = state.lastActiveProjectByPlot[target];
    const desired =
      (remembered && newProjects.includes(remembered)) ? remembered :
      (state.activeProject && newProjects.includes(state.activeProject)) ? state.activeProject :
      (newProjects[0] ?? null);

    // Swap the visible pane when the target project changes so
    // activeWindowName stays aligned with activeProject (the status pane
    // reads activeWindowName to label the active worker).
    if (desired && desired !== state.activeProject) {
      swapVisibleToProject(desired, config.projects[desired], state);
    } else if (!desired) {
      state.activeProject = null;
    }

    writeDashState(state);
    refreshDashboard({ state });
  });
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
    refreshDashboardCycle({ state: lockedState, windowNames: updatedNames });
  });
}

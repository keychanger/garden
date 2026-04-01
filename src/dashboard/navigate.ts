// Pane navigation: project switching, worker/shell focus, cycling.
import { loadConfig, getProject } from "../config.js";
import { readDashState, writeDashState } from "./state.js";
import { parkToHidden, swapToHidden } from "./layout.js";
import { restoreFromHidden } from "./layout.js";
import { gardenSwapToHidden, gardenRestoreFromHidden } from "./layout.js";
import { refreshDashboard } from "./header.js";
import {
  tmux, tmuxDisplay,
  paneExists, windowExists,
  listHiddenWorkerWindows,
  setPaneLabel,
} from "./tmux.js";
import { log } from "./log.js";
import { createShellWindow, createLogsWindow } from "./create.js";

export function switchProject(indexArg: string): void {
  log.info("navigate", "switchProject", { data: { index: indexArg } });
  const index = parseInt(indexArg, 10) - 1;
  const config = loadConfig();
  const projectNames = Object.keys(config.projects);

  if (index < 0 || index >= projectNames.length) {
    tmuxDisplay(`No project at index ${index + 1}`);
    return;
  }

  const projectName = projectNames[index];
  const project = config.projects[projectName];
  const state = readDashState();

  if (state.activeProject === projectName) {
    tmuxDisplay(`Already on ${projectName}`);
    return;
  }

  const parkName = state.activeWindowName ?? `_${state.activeProject ?? "none"}-active`;
  parkToHidden(parkName, state);

  if (windowExists(`_${projectName}-active`)) {
    restoreFromHidden(`_${projectName}-active`, state);
    state.activePaneType = "worker";
    state.activeWindowName = `_${projectName}-active`;
  } else if (windowExists(`_${projectName}-shell`)) {
    restoreFromHidden(`_${projectName}-shell`, state);
    state.activePaneType = "shell";
    state.activeWindowName = `_${projectName}-shell`;
  } else {
    createShellWindow(projectName, project.path);
    restoreFromHidden(`_${projectName}-shell`, state);
    state.activePaneType = "shell";
    state.activeWindowName = `_${projectName}-shell`;
  }

  state.activeProject = projectName;
  writeDashState(state);
  refreshDashboard();
  tmuxDisplay(`Switched to ${projectName}`);
}

export function focusWorker(): void {
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

  const parkName = state.activeWindowName ?? `_${state.activeProject}-active`;
  swapToHidden(parkName, workerWindows[0], state);

  state.activePaneType = "worker";
  state.activeWindowName = workerWindows[0];
  writeDashState(state);
  refreshDashboard();
}

export function focusShell(): void {
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

  const project = getProject(state.activeProject);
  const shellWindowName = `_${state.activeProject}-shell`;

  if (!windowExists(shellWindowName)) {
    createShellWindow(state.activeProject, project.path);
  }

  const parkName = state.activeWindowName ?? `_${state.activeProject}-active`;
  swapToHidden(parkName, shellWindowName, state);

  state.activePaneType = "shell";
  state.activeWindowName = shellWindowName;
  writeDashState(state);
  refreshDashboard();
}

export function focusGarden(): void {
  const state = readDashState();

  if (state.gardenPaneType === "logs") {
    const shellWindowName = "_garden-shell";
    if (!windowExists(shellWindowName)) {
      tmuxDisplay("Garden shell window missing.");
      return;
    }
    gardenSwapToHidden("_garden-logs", shellWindowName, state);
    state.gardenPaneType = "shell";
    state.gardenWindowName = null;
    writeDashState(state);
    refreshDashboard();
  }

  if (state.gardenShellPaneId && paneExists(state.gardenShellPaneId)) {
    tmux("select-pane", "-t", state.gardenShellPaneId);
  }
}

export function focusLogs(): void {
  const state = readDashState();

  if (state.gardenPaneType === "logs") {
    if (state.gardenShellPaneId && paneExists(state.gardenShellPaneId)) {
      tmux("select-pane", "-t", state.gardenShellPaneId);
    }
    return;
  }

  const logsWindowName = "_garden-logs";
  if (!windowExists(logsWindowName)) {
    createLogsWindow();
  }

  // Park the garden shell to hidden, restore logs
  const parkName = state.gardenWindowName ?? "_garden-shell";
  gardenSwapToHidden(parkName, logsWindowName, state);
  state.gardenPaneType = "logs";
  state.gardenWindowName = "_garden-logs";
  setPaneLabel(state.gardenShellPaneId!, "logs");
  writeDashState(state);
  refreshDashboard();

  if (state.gardenShellPaneId && paneExists(state.gardenShellPaneId)) {
    tmux("select-pane", "-t", state.gardenShellPaneId);
  }
}

export function cycleGardenPane(): void {
  const state = readDashState();
  if (state.gardenPaneType === "logs") {
    focusGarden();
  } else {
    focusLogs();
  }
}

export function cyclePane(direction: 1 | -1): void {
  const state = readDashState();
  if (!state.activeProject) {
    tmuxDisplay("No project selected.");
    return;
  }

  const hiddenWorkers = listHiddenWorkerWindows(state.activeProject);
  const currentName = state.activeWindowName;
  const isCurrentWorker = currentName && currentName.includes("-worker-");

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

  const parkName = currentName ?? `_${state.activeProject}-active`;
  swapToHidden(parkName, targetWindow, state);

  state.activePaneType = "worker";
  state.activeWindowName = targetWindow;
  writeDashState(state);
  refreshDashboard();
}

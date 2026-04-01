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
  listAllWindowNames,
  listHiddenWorkerWindows,
  setPaneLabel,
  getActivePaneId,
} from "./tmux.js";
import { log } from "./log.js";
import { createShellWindow, createLogsWindow, createGardenShellWindow, createGardenConsoleWindow, resolveGardenRunner } from "./create.js";

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

  // Single list-windows call replaces multiple windowExists checks
  const windowNames = listAllWindowNames();
  const has = (name: string) => windowNames.includes(name);

  const parkName = state.activeWindowName ?? `_${state.activeProject ?? "none"}-active`;
  parkToHidden(parkName, state);

  if (has(`_${projectName}-active`)) {
    restoreFromHidden(`_${projectName}-active`, state);
    state.activePaneType = "worker";
    state.activeWindowName = `_${projectName}-active`;
  } else {
    const workerWindows = listHiddenWorkerWindows(projectName, windowNames);
    if (workerWindows.length > 0) {
      restoreFromHidden(workerWindows[0], state);
      state.activePaneType = "worker";
      state.activeWindowName = workerWindows[0];
    } else if (has(`_${projectName}-shell`)) {
      restoreFromHidden(`_${projectName}-shell`, state);
      state.activePaneType = "shell";
      state.activeWindowName = `_${projectName}-shell`;
    } else {
      createShellWindow(projectName, project.path);
      restoreFromHidden(`_${projectName}-shell`, state);
      state.activePaneType = "shell";
      state.activeWindowName = `_${projectName}-shell`;
    }
  }

  state.activeProject = projectName;
  writeDashState(state);
  refreshDashboard({ state });
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
  refreshDashboard({ state });
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
  refreshDashboard({ state });
}

const GARDEN_VIEWS = ["console", "shell", "logs"] as const;
type GardenView = typeof GARDEN_VIEWS[number];

function gardenWindowForView(view: GardenView): string {
  return `_garden-${view}`;
}

function gardenLabelForView(view: GardenView): string {
  return view;
}

function ensureGardenView(view: GardenView): void {
  const windowName = gardenWindowForView(view);
  if (windowExists(windowName)) return;
  if (view === "console") createGardenConsoleWindow(resolveGardenRunner());
  else if (view === "shell") createGardenShellWindow();
  else if (view === "logs") createLogsWindow();
}

function switchGardenTo(view: GardenView): void {
  const state = readDashState();

  if (state.gardenPaneType === view) {
    if (state.gardenShellPaneId && paneExists(state.gardenShellPaneId)) {
      tmux("select-pane", "-t", state.gardenShellPaneId);
    }
    return;
  }

  const parkName = state.gardenWindowName ?? "_garden-console";
  ensureGardenView(view);
  gardenSwapToHidden(parkName, gardenWindowForView(view), state);
  state.gardenPaneType = view;
  state.gardenWindowName = gardenWindowForView(view);
  setPaneLabel(state.gardenShellPaneId!, gardenLabelForView(view));
  writeDashState(state);
  refreshDashboard({ state });

  if (state.gardenShellPaneId && paneExists(state.gardenShellPaneId)) {
    tmux("select-pane", "-t", state.gardenShellPaneId);
  }
}

export function focusGarden(): void {
  switchGardenTo("console");
}

export function focusLogs(): void {
  switchGardenTo("logs");
}

export function cycleGardenPane(direction: 1 | -1): void {
  const state = readDashState();
  const current = state.gardenPaneType ?? "console";
  const currentIdx = GARDEN_VIEWS.indexOf(current as GardenView);
  const nextIdx = (currentIdx + direction + GARDEN_VIEWS.length) % GARDEN_VIEWS.length;
  switchGardenTo(GARDEN_VIEWS[nextIdx]);
}

export function cyclePane(direction: 1 | -1): void {
  const state = readDashState();

  // Context-aware: if focused on the garden pane, cycle garden views
  const focusedPane = getActivePaneId();
  if (focusedPane && focusedPane === state.gardenShellPaneId) {
    return cycleGardenPane(direction);
  }

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
  refreshDashboard({ state });
}

// Pane navigation: project switching, worker/shell focus, cycling.
import fs from "node:fs";
import path from "node:path";
import { loadConfig, getProject, getFocusedProjectNames, SESSIONS_DIR } from "../config.js";
import { readDashState, writeDashState } from "./state.js";
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
import { log } from "./log.js";
import { createShellWindow, createLogsWindow, createGardenRootWindow, createGardenConsoleWindow, resolveGardenRunner } from "./create.js";

const CYCLE_LOCK = path.join(SESSIONS_DIR, "cycle.lock");

function withCycleLock<T>(fn: () => T): T {
  let fd: number | null = null;
  const maxWait = 500;
  const start = Date.now();

  // Spin until we acquire the lock or timeout
  while (true) {
    try {
      fd = fs.openSync(CYCLE_LOCK, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
      break;
    } catch {
      if (Date.now() - start > maxWait) {
        // Stale lock — force acquire
        try { fs.unlinkSync(CYCLE_LOCK); } catch { /* ignore */ }
        continue;
      }
      // Brief spin (1ms)
      const deadline = Date.now() + 1;
      while (Date.now() < deadline) { /* busy wait */ }
    }
  }

  try {
    return fn();
  } finally {
    try { fs.closeSync(fd!); } catch { /* ignore */ }
    try { fs.unlinkSync(CYCLE_LOCK); } catch { /* ignore */ }
  }
}

/**
 * Re-apply pane variables after a worker pane is swapped into the visible
 * slot. swap-pane does not carry pane-level user options (@garden_name,
 * @garden_task), so restore them from the window name and registry.
 */
function restoreWorkerPaneVars(paneId: string, project: string, windowName: string): void {
  const nameMatch = windowName.match(/-worker-(.+)$/);
  if (!nameMatch) return;
  const workerLabel = nameMatch[1];
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

  const parkName = state.activeWindowName ?? `_${state.activeProject ?? "none"}-active`;
  parkToHidden(parkName, state);

  if (has(`_${projectName}-active`)) {
    restoreFromHidden(`_${projectName}-active`, state);
    state.activePaneType = "worker";
    state.activeWindowName = `_${projectName}-active`;
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

  if (state.activePaneType === "worker" && state.activePaneId && state.activeWindowName) {
    restoreWorkerPaneVars(state.activePaneId, projectName, state.activeWindowName);
  }

  state.activeProject = projectName;
  writeDashState(state);
  refreshDashboard({ state });
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

  const preferred = state.lastActiveWorker[state.activeProject];
  const targetWorker = preferred && workerWindows.includes(preferred)
    ? preferred
    : workerWindows[0];

  const parkName = state.activeWindowName ?? `_${state.activeProject}-active`;
  swapToHidden(parkName, targetWorker, state);

  if (state.activePaneId) {
    restoreWorkerPaneVars(state.activePaneId, state.activeProject, targetWorker);
  }

  state.activePaneType = "worker";
  state.activeWindowName = targetWorker;
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

const GARDEN_VIEWS = ["garden", "root", "logs"] as const;
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
  if (view === "garden") createGardenConsoleWindow(resolveGardenRunner());
  else if (view === "root") createGardenRootWindow();
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

  const parkName = state.gardenWindowName ?? "_garden-garden";
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
  switchGardenTo("garden");
}

export function focusRoot(): void {
  switchGardenTo("root");
}

export function focusLogs(): void {
  switchGardenTo("logs");
}

export function cyclePane(direction: 1 | -1): void {
  // Serialize concurrent cycles to prevent race conditions
  withCycleLock(() => {
    // Re-read state inside lock to see updates from any prior queued cycle
    const lockedState = readDashState();

    if (!lockedState.activeProject) {
      tmuxDisplay("No project selected.");
      return;
    }

    // Single window list for the entire operation
    const windowNames = listAllWindowNames();
    const hiddenWorkers = listHiddenWorkerWindows(lockedState.activeProject, windowNames);
    const currentName = lockedState.activeWindowName;
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

    const parkName = currentName ?? `_${lockedState.activeProject}-active`;

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

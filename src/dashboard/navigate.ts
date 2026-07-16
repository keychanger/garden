// Pane navigation: project switching, worker/shell focus, cycling.
import fs from "node:fs";
import path from "node:path";
import { loadConfig, getProject, getFocusedProjectNames, plotsMap, isPlotFocused, SESSIONS_DIR } from "../config.js";
import { readDashState, writeDashState, withStateLock, type DashboardState } from "./state.js";
import { swapToHidden, swapDirect } from "./layout.js";
import { gardenSwapToHidden } from "./layout.js";
import { refreshDashboard, refreshDashboardCycle, refreshDashboardPlotCycle, setPaneProjectColor } from "./header.js";
import {
  tmux, tmuxDisplay,
  paneExists, windowExists,
  getFirstPaneId,
  listAllWindowNames,
  listHiddenWorkerWindows,
  setPaneLabel,
  setPaneVar,
} from "./tmux.js";
import { findWorkerByName, getWorkers, compareWorkerFreshness } from "./registry.js";
import { acknowledgeAlerts } from "./alerts.js";
import { log } from "./log.js";
import { createShellWindow, createLogsWindow, createGardenRootWindow, createGardenGrowhouseWindow, createGardenHistoryWindow, createGardenDiaryWindow } from "./create.js";
import { formatLogsPaneLabel } from "../commands/logs.js";
import { editorIsNano } from "../diary.js";
import { resolveGardenRunner } from "./runner.js";
import { parkingWindowName, shellWindowName as shellWin, gardenWindowName, parseWorkerSuffix, isWorkerWindow, type GardenView } from "./window-names.js";
import { DASHBOARD_SESSION } from "../session.js";

/**
 * Re-apply pane variables after a worker pane is swapped into the visible
 * slot. swap-pane does not carry pane-level user options (@garden_name,
 * @garden_task), so restore them from the window name and registry.
 */
function restoreWorkerPaneVars(paneId: string, project: string, windowName: string): void {
  const workerLabel = parseWorkerSuffix(windowName);
  if (!workerLabel) return;
  setPaneLabel(paneId, workerLabel);
  // Worker panes show a wall clock in their top border's right corner; the
  // pane-border-format gates it on @garden_clock (see setupStatusBar).
  setPaneVar(paneId, "garden_clock", "1");
  setPaneProjectColor(paneId, project);
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
export function swapVisibleToProject(
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

  // Pick the restore target first so we can use swapDirect (single swap-pane +
  // rename) instead of parkToHidden + restoreFromHidden (which creates and
  // destroys a temp window). Matches the fast path in cyclePane.
  const parkTarget = parkingWindowName(projectName);
  const shellTarget = shellWin(projectName);
  let restoreWindow: string;
  let paneType: "worker" | "shell";
  if (has(parkTarget)) {
    restoreWindow = parkTarget;
    paneType = "worker";
  } else {
    const workerWindows = listHiddenWorkerWindows(projectName, names);
    const preferred = state.lastActiveWorker[projectName];
    const targetWorker = preferred && workerWindows.includes(preferred)
      ? preferred
      : workerWindows[0];
    if (targetWorker) {
      restoreWindow = targetWorker;
      paneType = "worker";
    } else if (has(shellTarget)) {
      restoreWindow = shellTarget;
      paneType = "shell";
    } else {
      createShellWindow(projectName, project.path);
      restoreWindow = shellTarget;
      paneType = "shell";
    }
  }

  const parkName = state.activeWindowName ?? parkingWindowName(state.activeProject ?? "none");
  if (!swapDirect(parkName, restoreWindow, state)) {
    swapToHidden(parkName, restoreWindow, state);
  }
  state.activePaneType = paneType;
  state.activeWindowName = restoreWindow;

  if (paneType === "worker" && state.activePaneId) {
    restoreWorkerPaneVars(state.activePaneId, projectName, restoreWindow);
  }

  state.activeProject = projectName;
}

// Coalesce window for the reload below. Nav hotkeys run backgrounded and
// concurrently (`run-shell -b`, hotkeys.ts), so tapping ⌥O/⌥P to cycle injects
// overlapping `C-o Enter C-x` bursts into the editor pane. When a second `^O`
// lands on nano/pico's still-open "File Name to write" prompt, the editor rings
// the terminal bell — surfacing as the macOS "chirp" (tmux passes the BEL
// through; there is no visual-bell surface in fullscreen). The reload is
// idempotent to drop: diary-view.sh re-resolves the focused project on every
// reopen, and the reopen's node cold start outlasts this window, so the
// in-flight reload still lands on the final project. 250ms comfortably covers a
// human double-tap while staying under the reopen delay (no staleness).
const DIARY_RELOAD_COALESCE_MS = 250;

function diaryReloadStampPath(): string {
  return path.join(SESSIONS_DIR, "diary-reload.stamp");
}

// When a project switch happens, the diary editor must re-point at the
// now-focused project's diary. A live modal editor can only be re-targeted by
// restarting it — which would discard unsaved notes — so we drive the editor's
// own save+exit and let diary-view.sh's loop reopen on the new project. Only
// nano/pico (the shipped default) have a key sequence we can drive blindly: ^O
// Enter writes the buffer to its current file, ^X then exits cleanly (the buffer
// is no longer modified, so there is no exit prompt). A custom $EDITOR is left
// untouched; it still reopens on the operator's own exit.
//
// The editor may be live in the visible garden slot (diary is the active view)
// or parked in the hidden _garden-diary window (the operator switched the garden
// pane to another view, but the editor loop keeps running there). The parked
// case matters because re-entering the diary view does not restart the editor —
// without this reload it would show whatever project was focused when it parked.
function reloadDiaryEditor(state: DashboardState): void {
  const pane = state.gardenPaneType === "diary"
    ? state.gardenShellPaneId
    : getFirstPaneId(`${DASHBOARD_SESSION}:${gardenWindowName("diary")}`);
  if (!pane || !paneExists(pane)) return;
  if (!editorIsNano(process.env.EDITOR || "nano")) return;

  // Skip a reload that fires within COALESCE_MS of the previous one. The stamp
  // is cross-process (each backgrounded handler is its own node invocation), so
  // its mtime is the only shared record of the last drive. Best-effort: a
  // missing stamp or fs error falls through to fire.
  const stamp = diaryReloadStampPath();
  try {
    if (Date.now() - fs.statSync(stamp).mtimeMs < DIARY_RELOAD_COALESCE_MS) return;
  } catch { /* no stamp yet -> fire */ }
  try { fs.writeFileSync(stamp, ""); } catch { /* best effort; still fire */ }

  tmux("send-keys", "-t", pane, "C-o", "Enter", "C-x");
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

  // Only the swap + state write must be atomic against a concurrent nav; the
  // read-only repaint and diary reload run after the lock releases. Holding the
  // lock across the full refresh cascade serialized whole keystroke bursts and
  // could exceed the file-lock deadline, silently dropping a keystroke.
  const snapshot = withStateLock(() => {
    const state = readDashState();

    if (state.activeProject === projectName) {
      tmuxDisplay(`Already on ${projectName}`);
      return null;
    }

    swapVisibleToProject(projectName, project, state);
    writeDashState(state);
    return state;
  });

  if (snapshot) {
    refreshDashboard({ state: snapshot });
    reloadDiaryEditor(snapshot);
  }
}

export function focusWorker(): void {
  const snapshot = withStateLock(() => {
    const state = readDashState();
    if (!state.activeProject) {
      tmuxDisplay("No project selected.");
      return null;
    }

    if (state.activePaneType === "worker") {
      if (state.activePaneId && paneExists(state.activePaneId)) {
        tmux("select-pane", "-t", state.activePaneId);
      }
      return null;
    }

    const workerWindows = listHiddenWorkerWindows(state.activeProject);
    if (workerWindows.length === 0) {
      tmuxDisplay("No workers. Press ⌥n to create one.");
      return null;
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
    return state;
  });

  if (snapshot) refreshDashboard({ state: snapshot });
}

export function focusShell(): void {
  const snapshot = withStateLock(() => {
    const state = readDashState();
    if (!state.activeProject) {
      tmuxDisplay("No project selected.");
      return null;
    }

    if (state.activePaneType === "shell") {
      if (state.activePaneId && paneExists(state.activePaneId)) {
        tmux("select-pane", "-t", state.activePaneId);
      }
      return null;
    }

    log.info("navigate", "focusShell", { data: { project: state.activeProject } });

    const project = getProject(state.activeProject);
    const shellTarget = shellWin(state.activeProject);

    if (!windowExists(shellTarget)) {
      createShellWindow(state.activeProject, project.path);
    }

    const parkName = state.activeWindowName ?? parkingWindowName(state.activeProject);
    swapToHidden(parkName, shellTarget, state);

    // The right-pane shell shows the same wall clock as worker panes
    // (gated on @garden_clock; see setupStatusBar).
    if (state.activePaneId) {
      setPaneVar(state.activePaneId, "garden_clock", "1");
      setPaneProjectColor(state.activePaneId, state.activeProject);
    }

    state.activePaneType = "shell";
    state.activeWindowName = shellTarget;
    writeDashState(state);
    return state;
  });

  if (snapshot) refreshDashboard({ state: snapshot });
}

function ensureGardenView(view: GardenView): void {
  const wn = gardenWindowName(view);
  if (windowExists(wn)) return;
  if (view === "growhouse") createGardenGrowhouseWindow(resolveGardenRunner());
  else if (view === "root") createGardenRootWindow();
  else if (view === "logs") createLogsWindow();
  else if (view === "history") createGardenHistoryWindow(resolveGardenRunner());
  else if (view === "diary") createGardenDiaryWindow(resolveGardenRunner());
}

function switchGardenTo(view: GardenView): void {
  const snapshot = withStateLock(() => {
    const state = readDashState();

    if (state.gardenPaneType === view) {
      if (state.gardenShellPaneId && paneExists(state.gardenShellPaneId)) {
        tmux("select-pane", "-t", state.gardenShellPaneId);
      }
      return null;
    }

    log.info("navigate", "switchGardenTo", { data: { view, from: state.gardenPaneType } });

    const parkName = state.gardenWindowName ?? gardenWindowName("growhouse");
    ensureGardenView(view);
    gardenSwapToHidden(parkName, gardenWindowName(view), state);
    state.gardenPaneType = view;
    state.gardenWindowName = gardenWindowName(view);
    if (state.gardenShellPaneId) {
      setPaneLabel(state.gardenShellPaneId, view === "logs" ? formatLogsPaneLabel() : view);
    }
    writeDashState(state);
    return state;
  });

  if (snapshot) {
    refreshDashboard({ state: snapshot });
    if (snapshot.gardenShellPaneId && paneExists(snapshot.gardenShellPaneId)) {
      tmux("select-pane", "-t", snapshot.gardenShellPaneId);
    }
  }
}

export function focusGrowhouse(): void {
  switchGardenTo("growhouse");
}

export function focusRoot(): void {
  switchGardenTo("root");
}

export function focusLogs(): void {
  switchGardenTo("logs");
  acknowledgeAlerts();
}

export function focusHistory(): void {
  switchGardenTo("history");
}

export function focusDiary(): void {
  switchGardenTo("diary");
}

export function cyclePlot(direction: 1 | -1): void {
  const result = withStateLock(() => {
    const config = loadConfig();
    const plots = plotsMap(config);
    const focusedNames = Object.keys(plots).filter(name => isPlotFocused(plots[name]));

    if (focusedNames.length === 0) {
      tmuxDisplay("No focused plots. Use 'garden focus <plot>' to add one to the cycle.");
      return null;
    }
    if (focusedNames.length === 1) {
      tmuxDisplay(`Only one focused plot ('${focusedNames[0]}').`);
      return null;
    }

    const state = readDashState();
    const currentIdx = state.activePlot ? focusedNames.indexOf(state.activePlot) : -1;
    const nextIdx = currentIdx === -1
      ? (direction === 1 ? 0 : focusedNames.length - 1)
      : (currentIdx + direction + focusedNames.length) % focusedNames.length;

    const target = focusedNames[nextIdx];
    if (target === state.activePlot) return null;

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
    const prevProject = state.activeProject;
    if (desired && desired !== state.activeProject) {
      swapVisibleToProject(desired, config.projects[desired], state);
    } else if (!desired) {
      state.activeProject = null;
    }

    writeDashState(state);
    return { state, changedProject: state.activeProject !== prevProject };
  });

  if (result) {
    refreshDashboardPlotCycle({ state: result.state });
    if (result.changedProject) reloadDiaryEditor(result.state);
  }
}

export function cyclePane(direction: 1 | -1): void {
  // All state mutations must go through withStateLock to prevent races with
  // switchProject/focusWorker/focusShell which hold the same lock.
  const result = withStateLock(() => {
    const lockedState = readDashState();

    if (!lockedState.activeProject) {
      tmuxDisplay("No project selected.");
      return null;
    }

    // Single window list for the entire operation
    const windowNames = listAllWindowNames();
    const hiddenWorkers = listHiddenWorkerWindows(lockedState.activeProject, windowNames);
    const currentName = lockedState.activeWindowName;
    const isCurrentWorker = currentName && isWorkerWindow(currentName);

    // Order the cycle by attention/recency so ⌥]/⌥[ matches the visible status
    // list (see compareWorkerFreshness). Resolve each window name to its
    // registry entry via the worker-name suffix; windows with no entry sort
    // last by suffix.
    const entryByLabel = new Map(getWorkers(lockedState.activeProject).map(e => [e.name, e]));
    const labelOf = (w: string | undefined): string => (w ? parseWorkerSuffix(w) ?? w : "");
    const byFreshness = (wa: string | undefined, wb: string | undefined): number => {
      const la = labelOf(wa), lb = labelOf(wb);
      const ea = entryByLabel.get(la);
      const eb = entryByLabel.get(lb);
      if (ea && eb) return compareWorkerFreshness(ea, eb);
      if (ea) return -1;
      if (eb) return 1;
      return la.localeCompare(lb);
    };
    const allWorkers = isCurrentWorker
      ? [...new Set([currentName, ...hiddenWorkers])].sort(byFreshness)
      : [...hiddenWorkers].sort(byFreshness);

    if (allWorkers.length === 0) {
      tmuxDisplay("No workers to cycle to. Press ⌥n to create one.");
      return null;
    }

    const currentIdx = currentName ? allWorkers.indexOf(currentName) : -1;
    let nextIdx: number;
    if (currentIdx === -1) {
      nextIdx = direction === 1 ? 0 : allWorkers.length - 1;
    } else {
      nextIdx = (currentIdx + direction + allWorkers.length) % allWorkers.length;
    }

    const targetWindow = allWorkers[nextIdx];
    if (targetWindow === currentName) return null;

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
    return { state: lockedState, updatedNames };
  });

  if (result) {
    refreshDashboardCycle({ state: result.state, windowNames: result.updatedNames });
  }
}

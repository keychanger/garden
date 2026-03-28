// Worker lifecycle: creation and destruction of Claude worker sessions.
import crypto from "node:crypto";
import { DASHBOARD_SESSION } from "../session.js";
import { getProject } from "../config.js";
import { readDashState, writeDashState } from "./state.js";
import { parkToHidden, restoreFromHidden } from "./layout.js";
import { refreshDashboard } from "./header.js";
import {
  tmux, tmuxDisplay, setPaneLabel,
  getFirstPaneId, paneExists, windowExists,
  listHiddenWorkerWindows, killWindowSafe,
} from "./tmux.js";
import { generateWorkerName } from "./names.js";
import { addWorker, removeWorker, getAllWorkerNames } from "./registry.js";
import { log } from "./log.js";
import { buildWorkerCommand, createShellWindow } from "./create.js";

export function newWorker(): void {
  log.info("workers", "newWorker");
  const state = readDashState();
  if (!state.activeProject) {
    tmuxDisplay("No project selected. Use ⌥1-⌥9 first.");
    return;
  }

  const project = getProject(state.activeProject);
  const existingNames = getAllWorkerNames();
  const workerName = generateWorkerName(existingNames);
  const sessionId = crypto.randomUUID();
  const workerCmd = buildWorkerCommand(project.name, project.path, sessionId);

  const parkName = state.activeWindowName ?? `_${state.activeProject}-active`;
  parkToHidden(parkName, state);

  const workerWindowName = `_${state.activeProject}-worker-${workerName}`;

  tmux("new-window", "-d", "-t", DASHBOARD_SESSION, "-n", workerWindowName, "-c", project.path,
    "sh", "-c", workerCmd);
  const workerPaneId = getFirstPaneId(`${DASHBOARD_SESSION}:${workerWindowName}`);
  if (workerPaneId) setPaneLabel(workerPaneId, workerName);
  restoreFromHidden(workerWindowName, state);

  addWorker(state.activeProject, { name: workerName, sessionId, task: "" });

  state.activePaneType = "worker";
  state.activeWindowName = workerWindowName;
  writeDashState(state);
  refreshDashboard();
}

export function killPane(): void {
  log.info("workers", "killPane");
  const state = readDashState();

  if (state.activePaneType === "shell") {
    tmuxDisplay("Cannot kill project shell. Use ⌥x on workers only.");
    return;
  }

  if (!state.activePaneId || !paneExists(state.activePaneId)) {
    tmuxDisplay("No pane to kill.");
    return;
  }

  if (!state.activeProject) {
    writeDashState(state);
    return;
  }

  const killedWindowName = state.activeWindowName;
  const workerWindows = listHiddenWorkerWindows(state.activeProject);
  const project = getProject(state.activeProject);

  if (workerWindows.length > 0) {
    const targetWindow = workerWindows[0];
    const targetPaneId = getFirstPaneId(`${DASHBOARD_SESSION}:${targetWindow}`);
    if (targetPaneId) {
      tmux("swap-pane", "-s", state.activePaneId, "-t", targetPaneId);
      killWindowSafe(targetWindow);
      state.activePaneId = targetPaneId;
      state.activePaneType = "worker";
      state.activeWindowName = targetWindow;
    }
  } else {
    const shellWindowName = `_${state.activeProject}-shell`;
    if (!windowExists(shellWindowName)) {
      createShellWindow(state.activeProject, project.path);
    }
    const shellPaneId = getFirstPaneId(`${DASHBOARD_SESSION}:${shellWindowName}`);
    if (shellPaneId) {
      tmux("swap-pane", "-s", state.activePaneId, "-t", shellPaneId);
      killWindowSafe(shellWindowName);
      state.activePaneId = shellPaneId;
      state.activePaneType = "shell";
      state.activeWindowName = shellWindowName;
    }
  }

  if (killedWindowName && state.activeProject) {
    const nameMatch = killedWindowName.match(/-worker-(.+)$/);
    if (nameMatch) removeWorker(state.activeProject, nameMatch[1]);
  }

  writeDashState(state);
  refreshDashboard();
}

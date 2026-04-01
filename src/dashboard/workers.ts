// Worker lifecycle: creation and destruction of Claude worker sessions.
import crypto from "node:crypto";
import { DASHBOARD_SESSION } from "../session.js";
import { getProject } from "../config.js";
import { readDashState, writeDashState } from "./state.js";
import { parkToHidden, restoreFromHidden } from "./layout.js";
import { refreshDashboard } from "./header.js";
import {
  tmux, tmuxDisplay, tmuxNewWindow, setPaneLabel, shellEscape,
  getFirstPaneId, paneExists, windowExists,
  listHiddenWorkerWindows, killWindowSafe,
} from "./tmux.js";
import { generateWorkerName } from "./names.js";
import {
  addWorker, removeWorker, findWorkerByName, getAllWorkerNames,
} from "./registry.js";
import { log } from "./log.js";
import { buildWorktreeBootstrapScript, createShellWindow, resolveGardenRunner } from "./create.js";
import { worktreePath, removeWorktree, deleteBranch, resolveBaseBranch } from "./git.js";
import { ensureProjectPoller, killReviewWindow, stopProjectPoller } from "./poller.js";
import { getWorkers } from "./registry.js";

export function newWorker(): void {
  const state = readDashState();
  if (!state.activeProject) {
    tmuxDisplay("No project selected. Use ⌥1-⌥9 first.");
    return;
  }

  const project = getProject(state.activeProject);
  const existingNames = getAllWorkerNames();
  const workerName = generateWorkerName(existingNames);
  const sessionId = crypto.randomUUID();
  const branchName = workerName;
  const wtPath = worktreePath(state.activeProject, workerName);
  const gardenRunner = resolveGardenRunner();

  const baseBranch = resolveBaseBranch(project.path, project);

  // Write the bootstrap script that handles slow setup (git fetch, worktree
  // creation, npm install) inside the tmux pane so the window appears instantly
  // with progress output instead of blocking the hotkey handler.
  const scriptFile = buildWorktreeBootstrapScript(
    project.name, project.path, workerName, branchName, sessionId, wtPath, baseBranch,
  );

  // Show the new pane immediately — bootstrap runs inside it
  const parkName = state.activeWindowName ?? `_${state.activeProject}-active`;
  parkToHidden(parkName, state);

  const workerWindowName = `_${state.activeProject}-worker-${workerName}`;

  const workerPaneId = tmuxNewWindow("-d", "-t", DASHBOARD_SESSION, "-n", workerWindowName, "-c", project.path,
    "sh", "-c", `sh ${shellEscape(scriptFile)}`);
  if (workerPaneId) setPaneLabel(workerPaneId, workerName);
  restoreFromHidden(workerWindowName, state);

  addWorker(state.activeProject, {
    name: workerName,
    sessionId,
    task: "",
    worktreePath: wtPath,
    branchName,
  });

  log.info("workers", "created", {
    worker: workerName,
    data: { project: state.activeProject, branch: branchName },
  });

  ensureProjectPoller(state.activeProject, gardenRunner);

  state.activePaneType = "worker";
  state.activeWindowName = workerWindowName;
  writeDashState(state);
  refreshDashboard({ state });
}

export function killPane(): void {
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
    if (nameMatch) {
      const workerName = nameMatch[1];
      const entry = findWorkerByName(state.activeProject, workerName);
      if (entry) {
        killReviewWindow(state.activeProject, workerName);
        if (entry.worktreePath) {
          removeWorktree(project.path, entry.worktreePath);
        }
        if (entry.branchName) {
          deleteBranch(project.path, entry.branchName);
        }
      }
      removeWorker(state.activeProject, workerName);
      log.info("workers", "killed", {
        worker: workerName,
        data: { project: state.activeProject, branch: entry?.branchName },
      });

      // Stop project poller if no workers remain
      const remaining = getWorkers(state.activeProject);
      if (remaining.length === 0) {
        stopProjectPoller(state.activeProject);
      }
    }
  }

  writeDashState(state);
  refreshDashboard();
}

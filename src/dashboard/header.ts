// Dashboard header and status bar: renders project info and hotkey hints
// in the tmux status line.
import { DASHBOARD_SESSION } from "../session.js";
import { tmux, paneExists, getPanePid, getPaneVar, hasClaudeChild, listHiddenWorkerWindows, setPaneVar } from "./tmux.js";
import { readDashState, type DashboardState } from "./state.js";
import { findWorkerByName } from "./registry.js";

export function setupStatusBar(gardenRunner: string): void {
  const target = DASHBOARD_SESSION;
  try {
    tmux("set-option", "-t", target, "mouse", "on");
    tmux("set-option", "-t", target, "status-right-length", "120");
    tmux("set-option", "-t", target, "status-right", "#{@garden_header}");
    tmux("set-option", "-t", target, "status-interval", "2");
    tmux("set-option", "-t", target, "status-left", "");
    tmux("set-option", "-t", target, "status-left-length", "0");
    tmux("set-option", "-t", target, "window-status-current-format", "garden");
    tmux("set-option", "-t", target, "window-status-format", "");
    tmux("set-option", "-t", target, "pane-border-status", "top");
    tmux("set-option", "-t", target, "pane-border-format",
      " #{?@garden_name,#{@garden_name}#{?@garden_task, - #{@garden_task},},#{pane_title}} ");
  } catch { /* ignore */ }
}

/**
 * Full header update: queries process status, updates pane vars and registry,
 * then sets the @garden_header tmux variable. Called by the status pane's
 * background loop every few seconds for live process detection.
 */
export function printHeader(): void {
  const state = readDashState();

  if (!state.activeProject) {
    const header = "no project selected  [⌥1-⌥9 select]";
    process.stdout.write(header);
    setHeaderVar(header);
    return;
  }

  const projectName = state.activeProject;

  const hiddenWorkers = listHiddenWorkerWindows(projectName);
  let totalWorkers = hiddenWorkers.length;
  let currentWorkerIdx = 0;
  const isOnWorker = state.activePaneType === "worker";
  if (isOnWorker) {
    totalWorkers++;
    const currentName = state.activeWindowName ?? "";
    const allWorkers = [...new Set([currentName, ...hiddenWorkers])].sort();
    currentWorkerIdx = allWorkers.indexOf(currentName) + 1;
  }

  const workerNameMatch = (state.activeWindowName ?? "").match(/-worker-(.+)$/);
  const workerLabel = workerNameMatch ? workerNameMatch[1] : null;

  let paneStatus = "";
  if (state.activePaneId && paneExists(state.activePaneId)) {
    if (state.activePaneType === "shell") {
      paneStatus = "shell";
    } else {
      const pid = getPanePid(state.activePaneId);
      if (pid && hasClaudeChild(pid)) {
        let title = getPaneVar(state.activePaneId!, "garden_task");
        if (!title && workerLabel && state.activeProject) {
          const entry = findWorkerByName(state.activeProject, workerLabel);
          if (entry?.task) {
            title = entry.task;
            setPaneVar(state.activePaneId!, "garden_task", title);
          }
        }
        paneStatus = title ? "working" : "waiting";
      } else {
        paneStatus = "exited";
        setPaneVar(state.activePaneId, "garden_task", "");
      }
    }
  }

  let prState = "";
  if (workerLabel && state.activeProject) {
    const entry = findWorkerByName(state.activeProject, workerLabel);
    if (entry?.prState && entry.prState !== "working") {
      prState = entry.prState;
    }
  }

  const header = formatHeader(projectName, isOnWorker, workerLabel, paneStatus, currentWorkerIdx, totalWorkers, prState);
  process.stdout.write(header);
  setHeaderVar(header);
}

/**
 * Quick header update: builds header from state and tmux window list only
 * (no process detection, no pgrep). Called synchronously after mutations
 * for instant visual feedback. The background loop fills in live status.
 */
export function updateHeaderVar(): void {
  const state = readDashState();

  if (!state.activeProject) {
    setHeaderVar("no project selected  [⌥1-⌥9 select]");
    return;
  }

  const projectName = state.activeProject;

  const hiddenWorkers = listHiddenWorkerWindows(projectName);
  let totalWorkers = hiddenWorkers.length;
  let currentWorkerIdx = 0;
  const isOnWorker = state.activePaneType === "worker";
  if (isOnWorker) {
    totalWorkers++;
    const currentName = state.activeWindowName ?? "";
    const allWorkers = [...new Set([currentName, ...hiddenWorkers])].sort();
    currentWorkerIdx = allWorkers.indexOf(currentName) + 1;
  }

  const workerNameMatch = (state.activeWindowName ?? "").match(/-worker-(.+)$/);
  const workerLabel = workerNameMatch ? workerNameMatch[1] : null;

  const paneStatus = state.activePaneType === "shell" ? "shell" : "";

  let prState = "";
  if (workerLabel && state.activeProject) {
    const entry = findWorkerByName(state.activeProject, workerLabel);
    if (entry?.prState && entry.prState !== "working") {
      prState = entry.prState;
    }
  }

  const header = formatHeader(projectName, isOnWorker, workerLabel, paneStatus, currentWorkerIdx, totalWorkers, prState);
  setHeaderVar(header);
}

function formatHeader(
  projectName: string,
  isOnWorker: boolean,
  workerLabel: string | null,
  paneStatus: string,
  currentWorkerIdx: number,
  totalWorkers: number,
  prState?: string,
): string {
  const parts: string[] = [projectName];

  if (isOnWorker && totalWorkers > 0) {
    const label = workerLabel ?? "worker";
    const statusParts = [paneStatus, prState].filter(Boolean);
    const status = statusParts.length > 0 ? ` (${statusParts.join(", ")})` : "";
    parts.push(`${label}${status} [${currentWorkerIdx}/${totalWorkers}]`);
  } else if (paneStatus) {
    parts.push(paneStatus);
    if (totalWorkers > 0) {
      parts.push(`${totalWorkers} worker${totalWorkers === 1 ? "" : "s"} parked`);
    }
  }

  const info = parts.join(" · ");
  const hints = "⌥n new | ⌥w worker | ⌥s shell | ⌥] next";
  return `${info}  ${hints}`;
}

function setHeaderVar(header: string): void {
  try {
    tmux("set-option", "-t", DASHBOARD_SESSION, "@garden_header", header);
    tmux("refresh-client", "-S");
  } catch { /* no client attached or session gone */ }
}

export function buildStatusCommand(gardenRunner: string): string {
  return `trap true USR1; sleep 1 & wait $!; prev=""; while true; do ${gardenRunner} dashboard _header >/dev/null 2>&1; cur=$(GARDEN_PRETTY=1 ${gardenRunner} status 2>&1); if [ "$cur" != "$prev" ]; then printf '\\033[H\\033[2J\\033[3J%s\\n' "$cur"; prev="$cur"; fi; sleep 2 & wait $!; done`;
}

export function refreshStatusPane(): void {
  const state = readDashState();
  if (!state.statusPaneId) return;
  try {
    const pid = getPanePid(state.statusPaneId);
    if (pid) process.kill(parseInt(pid, 10), "SIGUSR1");
  } catch { /* pane gone or process exited */ }
}

/**
 * Full dashboard refresh: updates header var instantly, then signals
 * the status pane for a content refresh. Call after every mutation.
 */
export function refreshDashboard(): void {
  updateHeaderVar();
  refreshStatusPane();
}

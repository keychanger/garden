// Dashboard header and status bar: renders project info and hotkey hints
// in the tmux status line.
import { DASHBOARD_SESSION } from "../session.js";
import { tmux, paneExists, getPanePid, getPaneTitle, getPaneVar, hasClaudeChild, listHiddenWorkerWindows, setPaneVar } from "./tmux.js";
import { readDashState, type DashboardState } from "./state.js";
import { updateWorkerTask } from "./registry.js";

export function setupStatusBar(gardenRunner: string): void {
  const target = DASHBOARD_SESSION;
  try {
    tmux("set-option", "-t", target, "mouse", "on");
    tmux("set-option", "-t", target, "status-right-length", "120");
    tmux("set-option", "-t", target, "status-right", "#{@garden_header}");
    tmux("set-option", "-t", target, "status-interval", "5");
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
        const title = getPaneVar(state.activePaneId!, "garden_task") ?? getPaneTitle(state.activePaneId);
        paneStatus = title ? "working" : "waiting";
        setPaneVar(state.activePaneId, "garden_task", title ?? "");
        if (workerLabel && state.activeProject && title) {
          updateWorkerTask(state.activeProject, workerLabel, title);
        }
      } else {
        paneStatus = "exited";
        setPaneVar(state.activePaneId, "garden_task", "");
      }
    }
  }

  const header = formatHeader(projectName, isOnWorker, workerLabel, paneStatus, currentWorkerIdx, totalWorkers);
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
  const header = formatHeader(projectName, isOnWorker, workerLabel, paneStatus, currentWorkerIdx, totalWorkers);
  setHeaderVar(header);
}

function formatHeader(
  projectName: string,
  isOnWorker: boolean,
  workerLabel: string | null,
  paneStatus: string,
  currentWorkerIdx: number,
  totalWorkers: number,
): string {
  const parts: string[] = [projectName];

  if (isOnWorker && totalWorkers > 0) {
    const label = workerLabel ?? "worker";
    const status = paneStatus ? ` (${paneStatus})` : "";
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
  return `trap true USR1; sleep 1 & wait $!; prev=""; while true; do ${gardenRunner} dashboard _header >/dev/null 2>&1; ${gardenRunner} dashboard _check-prs >/dev/null 2>&1; cur=$(GARDEN_PRETTY=1 ${gardenRunner} status 2>&1); if [ "$cur" != "$prev" ]; then printf '\\033[H\\033[2J%s\\n' "$cur"; prev="$cur"; fi; sleep 5 & wait $!; done`;
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

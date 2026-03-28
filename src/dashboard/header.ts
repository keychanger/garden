// Dashboard header and status bar: renders project info and hotkey hints
// in the tmux status line.
import { DASHBOARD_SESSION } from "../session.js";
import { tmux, paneExists, getPanePid, getPaneTitle, hasClaudeChild, listHiddenWorkerWindows, setPaneVar } from "./tmux.js";
import { readDashState } from "./state.js";
import { updateWorkerTask } from "./registry.js";

export function setupStatusBar(gardenRunner: string): void {
  const target = DASHBOARD_SESSION;
  const headerCmd = `#(${gardenRunner} dashboard _header 2>/dev/null)`;
  try {
    tmux("set-option", "-t", target, "mouse", "on");
    tmux("set-option", "-t", target, "status-right-length", "120");
    tmux("set-option", "-t", target, "status-right", headerCmd);
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

export function printHeader(): void {
  const state = readDashState();

  if (!state.activeProject) {
    process.stdout.write("no project selected  [⌥1-⌥9 select]");
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
        const title = getPaneTitle(state.activePaneId);
        paneStatus = title ? "working" : "waiting";
        setPaneVar(state.activePaneId, "garden_task", title ?? "");
        if (workerLabel && state.activeProject) {
          updateWorkerTask(state.activeProject, workerLabel, title ?? "");
        }
      } else {
        paneStatus = "exited";
        setPaneVar(state.activePaneId, "garden_task", "");
        if (workerLabel && state.activeProject) {
          updateWorkerTask(state.activeProject, workerLabel, "");
        }
      }
    }
  }

  const parts: string[] = [projectName];

  if (isOnWorker && totalWorkers > 0) {
    const label = workerLabel ?? "worker";
    parts.push(`${label} (${paneStatus}) [${currentWorkerIdx}/${totalWorkers}]`);
  } else if (paneStatus) {
    parts.push(paneStatus);
    if (totalWorkers > 0) {
      parts.push(`${totalWorkers} worker${totalWorkers === 1 ? "" : "s"} parked`);
    }
  }

  const info = parts.join(" · ");
  const hints = "⌥n new | ⌥w worker | ⌥s shell | ⌥] next";
  process.stdout.write(`${info}  ${hints}`);
}

export function buildStatusCommand(gardenRunner: string): string {
  return `trap true USR1; sleep 1; prev=""; while true; do cur=$(GARDEN_PRETTY=1 ${gardenRunner} status 2>&1); if [ "$cur" != "$prev" ]; then printf '\\033[H\\033[2J%s\\n' "$cur"; prev="$cur"; fi; sleep 2 & wait $!; done`;
}

export function refreshStatusPane(): void {
  const state = readDashState();
  if (!state.statusPaneId) return;
  try {
    const pid = getPanePid(state.statusPaneId);
    if (pid) process.kill(parseInt(pid, 10), "SIGUSR1");
  } catch { /* pane gone or process exited */ }
}

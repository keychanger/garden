// Auto-continue for workers that were mid-turn when their pane died.
//
// When the dashboard is killed (or a worker is bounced) while claudeStatus is
// "working", the worker has no way to resume on its own — `claude --resume`
// brings the conversation history back but parks at an empty prompt. The
// pane-died hook records `interruptedWhileWorking` on the registry entry; on
// resume, ensureDashboard fires a delayed subprocess that calls back into
// `dashboard _continue-worker`, which sends a short prompt nudging the worker
// to pick up where it left off.
//
// Living in its own file (rather than workers.ts) so create.ts can dispatch
// the delayed continue without forming a workers↔create circular import.

import { spawn } from "node:child_process";
import { DASHBOARD_SESSION } from "../session.js";
import { readDashState } from "./state.js";
import { findWorkerByName, updateWorkerFields } from "./registry.js";
import {
  tmux, shellEscape, getFirstPaneId, paneExists, windowExists,
} from "./tmux.js";
import { workerWindowName as workerWin } from "./window-names.js";
import { log } from "./log.js";

// The fenced [garden] prefix marks the message as system-injected so the
// worker doesn't mistake it for human direction.
const CONTINUE_PROMPT =
  "[garden] You were interrupted by a restart. Continue from where you left "
  + "off, or say so if your task was already finished.";

function resolveWorkerPaneId(project: string, worker: string): string | null {
  const windowName = workerWin(project, worker);
  const state = readDashState();
  if (state.activeWindowName === windowName && state.activePaneId
      && paneExists(state.activePaneId)) {
    return state.activePaneId;
  }
  if (windowExists(windowName)) {
    return getFirstPaneId(`${DASHBOARD_SESSION}:${windowName}`);
  }
  return null;
}

// Send the continue prompt to a worker pane. Called via the _continue-worker
// internal command after a short delay so Claude --resume has time to take
// over the pane's stdin. Skips if the worker has already started working
// (operator typed something first) to avoid stomping on a real prompt.
export function continueWorker(projectName: string, workerName: string): void {
  const entry = findWorkerByName(projectName, workerName);
  if (!entry) return;
  const paneId = resolveWorkerPaneId(projectName, workerName);
  if (!paneId) {
    log.warn("workers", "continue skipped, no pane", {
      worker: workerName,
      data: { project: projectName },
    });
    return;
  }
  if (entry.claudeStatus === "working" || entry.claudeStatus === "asking") {
    log.info("workers", "continue skipped, worker already active", {
      worker: workerName,
      data: { project: projectName, claudeStatus: entry.claudeStatus },
    });
    updateWorkerFields(projectName, workerName, { interruptedWhileWorking: undefined });
    return;
  }
  try {
    tmux("send-keys", "-t", paneId, "-l", CONTINUE_PROMPT);
    tmux("send-keys", "-t", paneId, "Enter");
  } catch (err) {
    log.warn("workers", "continue send-keys failed", {
      worker: workerName,
      data: { project: projectName, error: String(err) },
    });
    return;
  }
  updateWorkerFields(projectName, workerName, { interruptedWhileWorking: undefined });
  log.info("workers", "continue sent", {
    worker: workerName,
    data: { project: projectName },
  });
}

// Fire-and-forget detached subprocess that delays a few seconds, then invokes
// the _continue-worker internal command. The delay lets `claude --resume` take
// over the pane's stdin before we send keys; without it, keystrokes go to the
// transient `sh -c` wrapper or get eaten during Claude's TUI init.
export function dispatchDelayedContinue(
  gardenRunner: string,
  projectName: string,
  workerName: string,
): void {
  const cmd =
    `sleep 3 && ${gardenRunner} dashboard _continue-worker `
    + `${shellEscape(projectName)} ${shellEscape(workerName)} 2>/dev/null`;
  try {
    const child = spawn("sh", ["-c", cmd], { detached: true, stdio: "ignore" });
    child.unref();
  } catch { /* best effort — operator can re-prompt manually */ }
}

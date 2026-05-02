// Auto-continue prompts for workers.
//
// Two flavors:
//
// 1) Interrupt recovery — when the dashboard is killed (or a worker is
//    bounced) while claudeStatus is "working", the worker has no way to
//    resume on its own. The pane-died hook records `interruptedWhileWorking`
//    on the registry entry; on resume, ensureDashboard fires a delayed
//    subprocess that sends a "continue from where you left off" prompt.
//
// 2) Post-merge auto-continue — when the poller successfully merges a
//    worker's branch into its base, finalizeMerge dispatches a continue
//    prompt so the worker keeps building on the merged base without manual
//    intervention. The worker opts out by writing the .done sentinel file
//    (see `donePath` below).
//
// Living in its own file (rather than workers.ts) so create.ts and poller.ts
// can dispatch the delayed continue without forming circular imports.

import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
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

const MERGE_CONTINUE_PROMPT =
  "[garden] Your previous changes were reviewed and merged. Continue with the "
  + "next phase of the work. If you have finished everything the operator "
  + "asked for, write a sentinel file `.garden-done` at the root of your "
  + "worktree (just `touch .garden-done` from your CWD) before ending your "
  + "turn so future merges do not auto-continue. Do not commit this file — "
  + "leave it untracked.";

// Sentinel file: when present, the post-merge auto-continue is suppressed for
// this worker. Worker writes it on completion; `garden pause` writes it on
// demand; `garden resume` deletes it. Lives at the root of the worker's
// worktree because that is the intersection of "writable by both Claude
// Code's harness sandbox and the OS-level Seatbelt sandbox" and "knowable
// to the poller from the registry entry." /tmp falls out: the harness
// sandbox blocks raw /tmp writes (only $TMPDIR works) and $TMPDIR is
// per-Claude-session, so the poller can't reconstruct it. ~/.garden/sessions
// falls out: would require broadening the worker's write scope to the
// registry and other workers' review-result files. The worktree is the
// only path that satisfies both constraints.
//
// killPane removes the worktree (`git worktree remove --force`), so the
// sentinel dies with the worker — no explicit cleanup needed there.
export function donePath(worktreePath: string): string {
  return path.join(worktreePath, ".garden-done");
}

export function isDoneSet(worktreePath: string | undefined): boolean {
  if (!worktreePath) return false;
  return fs.existsSync(donePath(worktreePath));
}

export function clearDoneSentinel(worktreePath: string | undefined): void {
  if (!worktreePath) return;
  try { fs.unlinkSync(donePath(worktreePath)); } catch { /* not present */ }
}

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

// Send a continue prompt to a worker pane. Called via the _continue-worker
// internal command after a short delay so Claude --resume has time to take
// over the pane's stdin. Skips if the worker has already started working
// (operator typed something first) to avoid stomping on a real prompt.
export function continueWorker(
  projectName: string,
  workerName: string,
  message: string = CONTINUE_PROMPT,
): void {
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
    tmux("send-keys", "-t", paneId, "-l", message);
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

// Send the post-merge continuation prompt. Same machinery as continueWorker
// but with the merge-flavored message. Kept as a separate exported function
// so the wiring in dashboard/index.ts is explicit.
export function continueWorkerAfterMerge(projectName: string, workerName: string): void {
  continueWorker(projectName, workerName, MERGE_CONTINUE_PROMPT);
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

// Post-merge variant. Slightly longer delay because the merge path force-pushes
// the worker's branch and runs postMerge before this fires; we want the worker
// pane to be unambiguously idle (Stop hook returned, no Claude UI redraw in
// progress) before sending keys.
export function dispatchDelayedAutoContinue(
  gardenRunner: string,
  projectName: string,
  workerName: string,
): void {
  const cmd =
    `sleep 5 && ${gardenRunner} dashboard _continue-worker-after-merge `
    + `${shellEscape(projectName)} ${shellEscape(workerName)} 2>/dev/null`;
  try {
    const child = spawn("sh", ["-c", cmd], { detached: true, stdio: "ignore" });
    child.unref();
  } catch { /* best effort — operator can re-prompt manually */ }
}

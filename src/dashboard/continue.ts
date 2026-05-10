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
//    intervention. The worker opts out by writing the .garden-done sentinel file
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
  shellEscape, getFirstPaneId, paneExists, windowExists, pasteAndSubmit,
} from "./tmux.js";
import { workerWindowName as workerWin } from "./window-names.js";
import { log } from "./log.js";

// The fenced [garden] prefix marks the message as system-injected so the
// worker doesn't mistake it for human direction.
const CONTINUE_PROMPT =
  "[garden] You were interrupted by a restart. Continue from where you left "
  + "off, or say so if your task was already finished.";

const MERGE_CONTINUE_BASE =
  "[garden] Your previous changes were reviewed and merged. Continue with the "
  + "next phase. If there's nothing left to do, end your turn with a brief "
  + "acknowledgement — `.garden-done` can't retroactively change the merge "
  + "that just happened (the poller checked it at merge time, not now), so a "
  + "`touch` here is a no-op unless you push again. The proactive moment for "
  + "the sentinel is *before* `git push` on the turn that does your final "
  + "commit; if you skipped that, this round-trip is the cost.";

const MAX_LISTED_FILES = 20;

function buildMergeContinuePrompt(
  changedFiles: string[] | undefined,
  syncFailed: boolean | undefined,
  baseBranch: string | undefined,
): string {
  const parts: string[] = [];
  if (changedFiles && changedFiles.length > 0) {
    const list = changedFiles.length <= MAX_LISTED_FILES
      ? changedFiles.join(", ")
      : `${changedFiles.slice(0, MAX_LISTED_FILES).join(", ")} (and ${changedFiles.length - MAX_LISTED_FILES} more)`;
    parts.push(
      "[garden] During review, the following files were modified before your "
      + `branch was merged: ${list}. Your in-memory understanding of those `
      + "files is now stale — re-read any you plan to touch before editing.",
    );
  }
  if (syncFailed) {
    // Branch ref on origin is gone (deleted post-merge), so target the base
    // branch — its tip equals the merged commit.
    const base = baseBranch ?? "<base-branch>";
    parts.push(
      "[garden] I could not auto-sync your worktree to the merged tip "
      + "(uncommitted changes or git error). Your worker branch was already "
      + "deleted from origin after merge, so commit or stash any local edits "
      + `and run \`git fetch origin ${base} && git reset --hard origin/${base}\` `
      + "before resuming work.",
    );
  }
  parts.push(MERGE_CONTINUE_BASE);
  return parts.join("\n\n");
}

// Sentinel suppressing post-merge auto-continue. Lives at the worktree root —
// the only path writable by both sandbox layers and reconstructible from the
// registry. See DESIGN.md "Auto-Continue Across the Merge Boundary" for why.
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

// Workflow handlers (trellis ALIGNED path) write the sentinel on the
// worker's behalf so finalizeMerge picks `done` instead of `merged`. The
// file is empty — its presence is the signal. See WORKFLOWS.md "Equilibrium
// and termination" / "Aligned" disposition.
export function setDoneSentinel(worktreePath: string | undefined): void {
  if (!worktreePath) return;
  try { fs.writeFileSync(donePath(worktreePath), ""); } catch { /* worktree gone */ }
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
    pasteAndSubmit(paneId, message);
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

// Retry leg of dispatchDelayedContinue. Only re-pastes when the worker is
// still parked at the cold-start "ready" state — meaning the first paste
// never reached Claude's input handler. If Claude has since moved to
// working/asking (paste landed, response in flight) or idle (paste landed,
// response already finished), we leave it alone. continueWorker's gate
// covers working/asking; this wrapper adds the idle exclusion the retry
// leg needs.
export function continueWorkerIfStuck(projectName: string, workerName: string): void {
  const entry = findWorkerByName(projectName, workerName);
  if (!entry) return;
  if (entry.claudeStatus !== "ready") {
    log.info("workers", "continue retry skipped, status moved", {
      worker: workerName,
      data: { project: projectName, claudeStatus: entry.claudeStatus },
    });
    return;
  }
  log.info("workers", "continue retry firing, worker still cold-start ready", {
    worker: workerName,
    data: { project: projectName },
  });
  continueWorker(projectName, workerName);
}

// Send the post-merge continuation prompt. Same machinery as continueWorker
// but with a merge-flavored message that lists files modified during review
// (so Claude re-reads them) and warns when the post-merge worktree sync was
// skipped. Reads the transient pendingContinue* fields written by
// finalizeMerge and clears them after sending.
export function continueWorkerAfterMerge(projectName: string, workerName: string): void {
  const entry = findWorkerByName(projectName, workerName);
  const message = buildMergeContinuePrompt(
    entry?.pendingContinueChangedFiles,
    entry?.pendingContinueSyncFailed,
    entry?.baseBranch,
  );
  continueWorker(projectName, workerName, message);
  if (entry?.pendingContinueChangedFiles || entry?.pendingContinueSyncFailed) {
    updateWorkerFields(projectName, workerName, {
      pendingContinueChangedFiles: undefined,
      pendingContinueSyncFailed: undefined,
    });
  }
}

// Fire-and-forget detached subprocess that defers a few seconds, then invokes
// the _continue-worker internal command. The delay lets `claude --resume` take
// over the pane's stdin before we send keys; without it, keystrokes get eaten
// during Claude's TUI init.
//
// 6s primary + 16s retry: on dashboard rebuild, ~10 workers run `claude
// --resume` concurrently and TUI bootstrap can outlast the SessionStart hook
// — under that load, a 3s paste landed before Claude's input handler bound,
// silently dropping the prompt. The retry fires _continue-worker-if-stuck,
// which re-pastes only if the worker is still at "ready" (cold-start state) —
// meaning the first paste never registered. If status has advanced to
// working/asking/idle, the prompt got through and the retry no-ops.
//
// Two independent detached children, each holding its own delay timer in
// Node via --delay-ms; previously a single `sh -c "sleep N && garden ..."`
// shell wrapper drove the delay. The shell trampoline stays — it's the
// canonical way to invoke a multi-token gardenRunner string ("node /path/cli.js")
// — but the `sleep N &&` prefix is gone, so the shell exec's straight into
// garden and exits. No standalone `sleep` process; no readerless FIFO write
// to block on (the leak that motivated the switch).
function spawnDelayed(gardenRunner: string, delayMs: number, sub: string, ...positional: string[]): void {
  const escaped = positional.map(shellEscape).join(" ");
  const cmd = `${gardenRunner} dashboard ${sub} --delay-ms ${delayMs} ${escaped} 2>/dev/null`;
  try {
    const child = spawn("sh", ["-c", cmd], { detached: true, stdio: "ignore" });
    child.unref();
  } catch { /* best effort — operator can re-prompt manually */ }
}

export function dispatchDelayedContinue(
  gardenRunner: string,
  projectName: string,
  workerName: string,
): void {
  spawnDelayed(gardenRunner, 6000, "_continue-worker", projectName, workerName);
  spawnDelayed(gardenRunner, 16000, "_continue-worker-if-stuck", projectName, workerName);
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
  spawnDelayed(gardenRunner, 5000, "_continue-worker-after-merge", projectName, workerName);
}

// Handoff seed variant. Reads the seed prompt from a file (kept off argv to
// support multi-line briefings) and sends it as the new worker's first user
// prompt. 6s delay covers worktree bootstrap (git fetch + worktree add +
// claude TUI init) — same machinery as auto-continue, just longer because the
// new worker is starting from cold.
export function dispatchDelayedSeed(
  gardenRunner: string,
  projectName: string,
  workerName: string,
  messageFile: string,
): void {
  spawnDelayed(gardenRunner, 6000, "_seed-worker", projectName, workerName, messageFile);
}

// Send a one-shot seed prompt read from a file. The seed dispatch's 6s delay
// usually covers bootstrap (git fetch, worktree add, npm install, claude TUI
// init), but a slow network can run longer; poll while the worker is still
// "loading" and send as soon as it transitions to any other state. Capped at
// 90s. Always deletes the file at the end.
export function seedWorker(
  projectName: string,
  workerName: string,
  messageFile: string,
): void {
  let message: string;
  try {
    message = fs.readFileSync(messageFile, "utf8");
  } catch (err) {
    log.warn("workers", "seed failed to read message file", {
      worker: workerName,
      data: { project: projectName, file: messageFile, error: String(err) },
    });
    return;
  }

  // Seeds route through tmux load-buffer (see pasteAndSubmit); record size
  // so operators tracing a slow / missed seed can correlate with the buffer
  // path instead of guessing.
  log.info("workers", "seed dispatching", {
    worker: workerName,
    data: { project: projectName, bytes: Buffer.byteLength(message, "utf8") },
  });

  const cleanup = (): void => {
    try { fs.unlinkSync(messageFile); } catch { /* already gone */ }
  };

  const deadline = Date.now() + 90_000;
  const poll = (): void => {
    const entry = findWorkerByName(projectName, workerName);
    if (!entry) {
      log.warn("workers", "seed skipped, worker missing", {
        worker: workerName,
        data: { project: projectName },
      });
      cleanup();
      return;
    }
    if (entry.claudeStatus !== "loading") {
      continueWorker(projectName, workerName, message);
      cleanup();
      return;
    }
    if (Date.now() >= deadline) {
      log.warn("workers", "seed timed out, sending anyway", {
        worker: workerName,
        data: { project: projectName, claudeStatus: entry.claudeStatus },
      });
      continueWorker(projectName, workerName, message);
      cleanup();
      return;
    }
    setTimeout(poll, 2000);
  };
  poll();
}

// PR poller: watches GitHub PR state and drives the review/merge lifecycle.
// Runs as a hidden tmux window, invoked every 30s via `garden dashboard _poll`.
import { execFileSync } from "node:child_process";
import { DASHBOARD_SESSION } from "../session.js";
import { tryGetProject } from "../config.js";
import {
  tmux, getFirstPaneId, getPanePid, hasClaudeChild,
  windowExists, killWindowSafe, shellEscape,
} from "./tmux.js";
import {
  readRegistry, getWorkers, updateWorkerFields, findWorkerByName,
  removeWorker, type WorkerEntry,
} from "./registry.js";
import {
  getBranchPR, getPRInfo, convertToDraft, markReady,
  getLatestReview, rebaseBranch, abortRebase,
  forcePushBranch, mergePR, removeWorktree, pruneWorktrees,
  commentOnPR,
  type PRInfo,
} from "./git.js";
import { spawnReviewWorker } from "./review.js";
import { buildWorktreeResumeCommand, resolveGardenRunner } from "./create.js";
import { refreshDashboard } from "./header.js";
import { log } from "./log.js";

const DEBOUNCE_MS = 30_000;
const POLLER_WINDOW = "_garden-pr-poller";

function prComment(projectPath: string, prNumber: number, message: string): void {
  commentOnPR(projectPath, prNumber, `[garden] ${message}`);
}

export function poll(): void {
  const registry = readRegistry();

  for (const [projectName, entries] of Object.entries(registry.workers)) {
    const project = tryGetProject(projectName);
    if (!project) continue;

    for (const entry of entries) {
      if (entry.role === "reviewer") continue;
      try {
        pollWorker(projectName, project.path, entry);
      } catch (err) {
        log.error("poller", "error polling worker", {
          worker: entry.name,
          project: projectName,
          error: String(err),
        });
      }
    }
  }
}

function pollWorker(
  projectName: string,
  projectPath: string,
  entry: WorkerEntry,
): void {
  const state = entry.prState ?? "working";

  // Check for externally closed/merged PRs in any PR-aware state
  if (state !== "working" && entry.prNumber) {
    const info = getPRInfo(projectPath, entry.prNumber);
    if (!info) {
      // gh CLI failed (network, rate limit, etc.) — skip this cycle rather
      // than assuming the PR is gone and destroying the worker.
      log.warn("poller", "getPRInfo failed, skipping cycle", {
        worker: entry.name,
        prNumber: entry.prNumber,
      });
      return;
    }
    if (info.state === "MERGED" || info.state === "CLOSED") {
      log.info("poller", "PR closed/merged externally", {
        worker: entry.name,
        prNumber: entry.prNumber,
        state: info.state,
      });
      cleanupWorker(projectName, projectPath, entry);
      return;
    }
  }

  switch (state) {
    case "working":
      return handleWorking(projectName, projectPath, entry);
    case "open":
      return handleOpen(projectName, projectPath, entry);
    case "in-review":
      return handleInReview(projectName, projectPath, entry);
    case "changes-requested":
      return handleChangesRequested(projectName, projectPath, entry);
    case "updating":
      return handleUpdating(projectName, projectPath, entry);
    case "ready":
      return handleReady(projectName, projectPath, entry);
    case "approved":
      return handleApproved(projectName, projectPath, entry);
    case "merging":
      return; // merge in progress from a previous poll cycle, wait for it to finish
    case "resolving":
      return handleResolving(projectName, projectPath, entry);
  }
}

function handleWorking(
  projectName: string,
  projectPath: string,
  entry: WorkerEntry,
): void {
  const branchName = entry.branchName ?? entry.name;
  const prNumber = getBranchPR(projectPath, branchName);
  if (prNumber === null) return;

  log.info("poller", "PR detected", { worker: entry.name, prNumber });
  updateWorkerFields(projectName, entry.name, {
    prNumber,
    prState: "open",
  });
  refreshDashboard();
}

function handleOpen(
  projectName: string,
  projectPath: string,
  entry: WorkerEntry,
): void {
  // Don't double-spawn a reviewer
  if (entry.reviewerName) {
    if (windowExists(`_${projectName}-worker-${entry.reviewerName}`)) {
      // Reviewer already exists, transition to in-review
      updateWorkerFields(projectName, entry.name, { prState: "in-review" });
      return;
    }
    // Reviewer window is gone, clear the stale reference
    updateWorkerFields(projectName, entry.name, { reviewerName: undefined });
  }

  if (!entry.prNumber) return;

  const reviewerName = spawnReviewWorker(
    projectName,
    projectPath,
    entry,
    entry.prNumber,
  );

  log.info("poller", "spawned reviewer", {
    worker: entry.name,
    reviewer: reviewerName,
    prNumber: entry.prNumber,
  });

  prComment(projectPath, entry.prNumber, `Review started by \`${reviewerName}\`.`);

  updateWorkerFields(projectName, entry.name, {
    prState: "in-review",
    reviewerName,
  });
  refreshDashboard();
}

function handleInReview(
  projectName: string,
  projectPath: string,
  entry: WorkerEntry,
): void {
  if (!entry.prNumber) return;

  // Check reviewer is still alive
  if (entry.reviewerName && !windowExists(`_${projectName}-worker-${entry.reviewerName}`)) {
    log.info("poller", "reviewer window gone, resetting to open", { worker: entry.name });
    removeWorker(projectName, entry.reviewerName);
    updateWorkerFields(projectName, entry.name, {
      prState: "open",
      reviewerName: undefined,
    });
    return;
  }

  const info = getPRInfo(projectPath, entry.prNumber);
  if (!info) return;

  if (info.reviewDecision === "APPROVED") {
    log.info("poller", "PR approved", { worker: entry.name, prNumber: entry.prNumber });
    updateWorkerFields(projectName, entry.name, { prState: "approved" });
    refreshDashboard();
    return;
  }

  if (info.reviewDecision === "CHANGES_REQUESTED") {
    log.info("poller", "changes requested", { worker: entry.name, prNumber: entry.prNumber });
    updateWorkerFields(projectName, entry.name, { prState: "changes-requested" });
    refreshDashboard();
  }
}

function handleChangesRequested(
  projectName: string,
  projectPath: string,
  entry: WorkerEntry,
): void {
  if (!entry.prNumber) return;

  // Convert to draft
  try {
    const info = getPRInfo(projectPath, entry.prNumber);
    if (info && !info.isDraft) {
      convertToDraft(projectPath, entry.prNumber);
      log.info("poller", "converted PR to draft", { prNumber: entry.prNumber });
    }
  } catch (err) {
    log.warn("poller", "failed to convert to draft", { error: String(err) });
  }

  // Get feedback and send to worker (avoid re-sending)
  const review = getLatestReview(projectPath, entry.prNumber);
  if (review && review.id !== entry.lastReviewId) {
    const message = `The reviewer has requested changes on PR #${entry.prNumber}. Here is their feedback:\n\n${review.body}\n\nPlease address these changes. When you are done, commit and push all your changes in a single push.`;
    sendMessage(projectName, entry, message);
    prComment(projectPath, entry.prNumber, `Sending feedback to worker \`${entry.name}\`. PR converted to draft.`);
    updateWorkerFields(projectName, entry.name, { lastReviewId: review.id });
  }

  // Record current SHA for debounce
  const info = getPRInfo(projectPath, entry.prNumber);
  updateWorkerFields(projectName, entry.name, {
    prState: "updating",
    lastSeenSha: info?.headSha ?? undefined,
    lastShaChangeAt: new Date().toISOString(),
  });
  refreshDashboard();
}

function handleUpdating(
  projectName: string,
  projectPath: string,
  entry: WorkerEntry,
): void {
  if (!entry.prNumber) return;

  const info = getPRInfo(projectPath, entry.prNumber);
  if (!info) return;

  if (info.headSha !== entry.lastSeenSha) {
    // New commits, reset debounce
    updateWorkerFields(projectName, entry.name, {
      lastSeenSha: info.headSha,
      lastShaChangeAt: new Date().toISOString(),
    });
    return;
  }

  // Check debounce timeout
  const changeAt = entry.lastShaChangeAt ? new Date(entry.lastShaChangeAt).getTime() : 0;
  if (Date.now() - changeAt >= DEBOUNCE_MS) {
    log.info("poller", "debounce complete, marking ready", { worker: entry.name });
    updateWorkerFields(projectName, entry.name, { prState: "ready" });
  }
}

function handleReady(
  projectName: string,
  projectPath: string,
  entry: WorkerEntry,
): void {
  if (!entry.prNumber) return;

  // Mark PR as ready for review
  try {
    const info = getPRInfo(projectPath, entry.prNumber);
    if (info?.isDraft) {
      markReady(projectPath, entry.prNumber);
      log.info("poller", "marked PR ready", { prNumber: entry.prNumber });
    }
  } catch (err) {
    log.warn("poller", "failed to mark ready", { error: String(err) });
  }

  prComment(projectPath, entry.prNumber, "Worker pushed updates. Re-requesting review.");

  // Notify the reviewer to re-review
  if (entry.reviewerName) {
    const reviewer = findWorkerByName(projectName, entry.reviewerName);
    if (reviewer) {
      const message = `The author has pushed new changes to PR #${entry.prNumber}. Please re-review the PR:\n\n\`gh pr diff ${entry.prNumber}\``;
      sendMessage(projectName, reviewer, message);
    }
  }

  updateWorkerFields(projectName, entry.name, { prState: "in-review" });
  refreshDashboard();
}

function handleApproved(
  projectName: string,
  projectPath: string,
  entry: WorkerEntry,
): void {
  if (!entry.prNumber) return;

  // Serialize merges: only one PR per project can merge at a time
  const projectWorkers = getWorkers(projectName);
  const alreadyMerging = projectWorkers.some(
    w => w.name !== entry.name && w.prState === "merging",
  );
  if (alreadyMerging) {
    log.info("poller", "another PR is merging, waiting", {
      worker: entry.name,
      prNumber: entry.prNumber,
    });
    return;
  }

  updateWorkerFields(projectName, entry.name, { prState: "merging" });
  refreshDashboard();

  const wtPath = entry.worktreePath ?? projectPath;

  // Fetch latest main before rebase
  try {
    execFileSync("git", ["fetch", "origin", "main"], {
      cwd: wtPath,
      stdio: "ignore",
    });
  } catch {
    // best effort
  }

  const rebased = rebaseBranch(wtPath);
  if (!rebased) {
    log.info("poller", "rebase conflict", { worker: entry.name, prNumber: entry.prNumber });
    abortRebase(wtPath);
    prComment(projectPath, entry.prNumber, `Merge conflict with main. Worker \`${entry.name}\` is resolving.`);

    // Notify worker to resolve conflicts
    const message = `Your PR #${entry.prNumber} has been approved but has merge conflicts with main. Please resolve the conflicts:\n\n1. Run: git rebase main\n2. Resolve any conflicts\n3. Run: git rebase --continue\n4. Push all changes when done.`;
    sendMessage(projectName, entry, message);

    updateWorkerFields(projectName, entry.name, {
      prState: "resolving",
      lastSeenSha: undefined,
      lastShaChangeAt: new Date().toISOString(),
    });
    refreshDashboard();
    return;
  }

  try {
    forcePushBranch(wtPath);
    mergePR(projectPath, entry.prNumber);
  } catch (err) {
    log.error("poller", "merge failed", {
      worker: entry.name,
      prNumber: entry.prNumber,
      error: String(err),
    });
    // Reset to approved so it retries next cycle
    updateWorkerFields(projectName, entry.name, { prState: "approved" });
    refreshDashboard();
    return;
  }

  log.info("poller", "PR merged", { worker: entry.name, prNumber: entry.prNumber });
  prComment(projectPath, entry.prNumber, "Merged successfully.");
  cleanupWorker(projectName, projectPath, entry);
}

function handleResolving(
  projectName: string,
  projectPath: string,
  entry: WorkerEntry,
): void {
  if (!entry.prNumber) return;

  const info = getPRInfo(projectPath, entry.prNumber);
  if (!info) return;

  if (info.headSha !== entry.lastSeenSha) {
    // New commits, reset debounce
    updateWorkerFields(projectName, entry.name, {
      lastSeenSha: info.headSha,
      lastShaChangeAt: new Date().toISOString(),
    });
    return;
  }

  // Check debounce timeout
  const changeAt = entry.lastShaChangeAt ? new Date(entry.lastShaChangeAt).getTime() : 0;
  if (Date.now() - changeAt >= DEBOUNCE_MS) {
    log.info("poller", "conflict resolution debounce complete, retrying merge", {
      worker: entry.name,
    });
    updateWorkerFields(projectName, entry.name, { prState: "approved" });
  }
}

function sendMessage(
  projectName: string,
  entry: WorkerEntry,
  message: string,
): void {
  const windowName = `_${projectName}-worker-${entry.name}`;
  if (!windowExists(windowName)) {
    // Worker window is gone, need to resume
    resumeWorkerWithMessage(projectName, entry, message);
    return;
  }

  const paneId = getFirstPaneId(`${DASHBOARD_SESSION}:${windowName}`);
  if (!paneId) {
    resumeWorkerWithMessage(projectName, entry, message);
    return;
  }

  const pid = getPanePid(paneId);
  if (pid && hasClaudeChild(pid)) {
    // Claude is running, send keys
    tmux("send-keys", "-t", paneId, "-l", message);
    tmux("send-keys", "-t", paneId, "Enter");
    log.info("poller", "sent message to running session", { worker: entry.name });
  } else {
    // Claude exited, resume the session
    resumeWorkerWithMessage(projectName, entry, message);
  }
}

function resumeWorkerWithMessage(
  projectName: string,
  entry: WorkerEntry,
  message: string,
): void {
  const project = tryGetProject(projectName);
  if (!project) return;

  const branchName = entry.branchName ?? entry.name;
  const wtPath = entry.worktreePath ?? project.path;
  const gardenRunner = resolveGardenRunner();
  const windowName = `_${projectName}-worker-${entry.name}`;

  // Kill existing window if any
  killWindowSafe(windowName);

  const resumeCmd = buildWorktreeResumeCommand(
    projectName, project.path, entry.name, branchName, entry.sessionId, gardenRunner,
  );

  // Prepend message echo before the claude resume command
  const fullCmd = `echo ${shellEscape(message)} | cat; ${resumeCmd}`;

  tmux("new-window", "-d", "-t", DASHBOARD_SESSION, "-n", windowName, "-c", wtPath,
    "sh", "-c", fullCmd);

  log.info("poller", "resumed worker with message", { worker: entry.name });
}

function cleanupWorker(
  projectName: string,
  projectPath: string,
  entry: WorkerEntry,
): void {
  // Kill worker window
  killWindowSafe(`_${projectName}-worker-${entry.name}`);

  // Kill reviewer window
  if (entry.reviewerName) {
    killWindowSafe(`_${projectName}-worker-${entry.reviewerName}`);
    removeWorker(projectName, entry.reviewerName);
  }

  // Clean up worktree
  if (entry.worktreePath) {
    removeWorktree(projectPath, entry.worktreePath);
  }
  pruneWorktrees(projectPath);

  // Remove from registry
  removeWorker(projectName, entry.name);
  refreshDashboard();
}

export function startPoller(gardenRunner: string): void {
  if (windowExists(POLLER_WINDOW)) return;

  const cmd = `while true; do ${gardenRunner} dashboard _poll 2>/dev/null; sleep 30; done`;
  tmux("new-window", "-d", "-t", DASHBOARD_SESSION, "-n", POLLER_WINDOW,
    "sh", "-c", cmd);

  log.info("poller", "started poller");
}

export function stopPoller(): void {
  killWindowSafe(POLLER_WINDOW);
  log.info("poller", "stopped poller");
}

export function pollerRunning(): boolean {
  return windowExists(POLLER_WINDOW);
}

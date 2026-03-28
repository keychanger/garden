// Review cycle: post-exit handling, review worker spawning, and review loop.
import { DASHBOARD_SESSION } from "../session.js";
import { getProject } from "../config.js";
import {
  tmux, setPaneLabel, getFirstPaneId, tmuxDisplay,
} from "./tmux.js";
import { generateWorkerName } from "./names.js";
import {
  addWorker, removeWorker, findWorkerByName,
  updateWorkerFields, getAllWorkerNames, readRegistry,
} from "./registry.js";
import { readDashState, writeDashState } from "./state.js";
import { refreshDashboard } from "./header.js";
import { log } from "./log.js";
import {
  getBranchPR, isPRMerged, getPRReviewDecision, getPRReviewFeedback,
  removeWorktree, pruneWorktrees,
} from "./git.js";
import { enqueue, processMergeQueue, type MergeQueueEntry } from "./merge-queue.js";
import {
  buildReviewWorkerCommand, buildWorktreeResumeCommand, resolveGardenRunner,
} from "./create.js";

export function handlePostExit(workerName: string, projectName: string): void {
  log.info("review", "handlePostExit", { workerName, projectName });

  const project = getProject(projectName);
  const entry = findWorkerByName(projectName, workerName);
  if (!entry) {
    log.warn("review", "worker not found in registry", { workerName });
    return;
  }

  // Already has a PR and review spawned — idempotency guard
  if (entry.prNumber) {
    log.info("review", "worker already has PR, skipping", { workerName, prNumber: entry.prNumber });
    return;
  }

  const branchName = entry.branchName ?? workerName;
  const prNumber = getBranchPR(project.path, branchName);

  if (prNumber === null) {
    log.info("review", "no PR found, worker exited without opening PR", { workerName });
    tmuxDisplay(`Worker ${workerName} exited without opening a PR.`);
    return;
  }

  updateWorkerFields(projectName, workerName, { prNumber });
  log.info("review", "PR found, spawning review worker", { prNumber, workerName });
  spawnReviewWorker(projectName, project.path, entry, prNumber);
}

/**
 * Poll all workers for PR creation. Called from the status loop to detect
 * PRs without relying on Claude Code exiting (which may not happen).
 */
export function checkWorkerPRs(): void {
  const registry = readRegistry();
  for (const [projectName, entries] of Object.entries(registry.workers)) {
    for (const entry of entries) {
      if (entry.role === "reviewer") continue;
      if (entry.prNumber) continue;
      if (!entry.branchName) continue;

      handlePostExit(entry.name, projectName);
    }
  }
}

export function handlePostReview(reviewerName: string, projectName: string): void {
  log.info("review", "handlePostReview", { reviewerName, projectName });

  const project = getProject(projectName);
  const reviewer = findWorkerByName(projectName, reviewerName);
  if (!reviewer || !reviewer.parentWorker) {
    log.warn("review", "reviewer or parent not found", { reviewerName });
    removeWorker(projectName, reviewerName);
    return;
  }

  const parent = findWorkerByName(projectName, reviewer.parentWorker);
  if (!parent || !parent.prNumber) {
    log.warn("review", "parent worker or PR not found", {
      parentWorker: reviewer.parentWorker,
    });
    removeWorker(projectName, reviewerName);
    return;
  }

  removeWorker(projectName, reviewerName);

  // Handle edge case: PR was merged externally
  if (isPRMerged(project.path, parent.prNumber)) {
    log.info("review", "PR merged, cleaning up", { prNumber: parent.prNumber });
    if (parent.worktreePath) {
      removeWorktree(project.path, parent.worktreePath);
    }
    pruneWorktrees(project.path);
    removeWorker(projectName, parent.name);
    tmuxDisplay(`PR #${parent.prNumber} merged. Worktree cleaned up.`);
    refreshDashboard();
    return;
  }

  // Check if reviewer approved the PR
  const decision = getPRReviewDecision(project.path, parent.prNumber);
  if (decision === "APPROVED") {
    log.info("review", "PR approved, enqueueing for merge", {
      prNumber: parent.prNumber,
      workerName: parent.name,
    });
    enqueue({
      project: projectName,
      prNumber: parent.prNumber,
      workerName: parent.name,
      branchName: parent.branchName ?? parent.name,
      worktreePath: parent.worktreePath ?? project.path,
      projectPath: project.path,
      enqueuedAt: new Date().toISOString(),
    });
    tmuxDisplay(`PR #${parent.prNumber} approved. Queued for merge.`);
    processMergeQueue(projectName, (entry) => {
      resumeWorkerWithFeedback(projectName, project.path, {
        name: entry.workerName,
        sessionId: parent.sessionId,
        worktreePath: entry.worktreePath,
        branchName: entry.branchName,
      });
    });
    refreshDashboard();
    return;
  }

  // Check if reviewer requested changes
  const feedback = getPRReviewFeedback(project.path, parent.prNumber);
  if (feedback) {
    log.info("review", "changes requested, resuming worker", {
      parentWorker: parent.name,
      prNumber: parent.prNumber,
    });
    resumeWorkerWithFeedback(projectName, project.path, parent);
  } else {
    log.info("review", "reviewer exited without action", { reviewerName });
    tmuxDisplay(`Reviewer ${reviewerName} exited without completing review.`);
  }
  refreshDashboard();
}

function spawnReviewWorker(
  projectName: string,
  projectPath: string,
  parent: { name: string; worktreePath?: string; branchName?: string; prNumber?: number },
  prNumber: number,
): void {
  const existingNames = getAllWorkerNames();
  const reviewerName = generateWorkerName(existingNames);
  const branchName = parent.branchName ?? parent.name;
  const wtPath = parent.worktreePath ?? projectPath;
  const gardenRunner = resolveGardenRunner();

  const cmd = buildReviewWorkerCommand(
    projectName, projectPath, branchName, prNumber, gardenRunner, reviewerName,
  );

  const windowName = `_${projectName}-worker-${reviewerName}`;
  tmux("new-window", "-d", "-t", DASHBOARD_SESSION, "-n", windowName, "-c", wtPath,
    "sh", "-c", cmd);

  const paneId = getFirstPaneId(`${DASHBOARD_SESSION}:${windowName}`);
  if (paneId) setPaneLabel(paneId, reviewerName);

  addWorker(projectName, {
    name: reviewerName,
    sessionId: "",
    task: `reviewing PR #${prNumber}`,
    worktreePath: parent.worktreePath,
    branchName,
    prNumber,
    role: "reviewer",
    parentWorker: parent.name,
  });

  const state = readDashState();
  refreshDashboard();
  log.info("review", "review worker spawned", { reviewerName, prNumber });
}

function resumeWorkerWithFeedback(
  projectName: string,
  projectPath: string,
  parent: {
    name: string;
    sessionId: string;
    worktreePath?: string;
    branchName?: string;
  },
): void {
  const branchName = parent.branchName ?? parent.name;
  const wtPath = parent.worktreePath ?? projectPath;
  const gardenRunner = resolveGardenRunner();

  const cmd = buildWorktreeResumeCommand(
    projectName, projectPath, parent.name, branchName, parent.sessionId, gardenRunner,
  );

  const windowName = `_${projectName}-worker-${parent.name}`;
  tmux("new-window", "-d", "-t", DASHBOARD_SESSION, "-n", windowName, "-c", wtPath,
    "sh", "-c", cmd);

  const paneId = getFirstPaneId(`${DASHBOARD_SESSION}:${windowName}`);
  if (paneId) setPaneLabel(paneId, parent.name);

  tmuxDisplay(`Resuming ${parent.name} to address review feedback.`);
}

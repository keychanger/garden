// Merge queue: sequential PR merging to prevent conflicts.
import fs from "node:fs";
import path from "node:path";
import { SESSIONS_DIR } from "../config.js";
import { log } from "./log.js";
import {
  rebaseBranch, abortRebase, forcePushBranch,
  mergePR, removeWorktree, pruneWorktrees,
} from "./git.js";
import { removeWorker } from "./registry.js";
import { tmuxDisplay } from "./tmux.js";
import { refreshDashboard } from "./header.js";

export interface MergeQueueEntry {
  project: string;
  prNumber: number;
  workerName: string;
  branchName: string;
  worktreePath: string;
  projectPath: string;
  enqueuedAt: string;
}

export interface MergeQueue {
  entries: MergeQueueEntry[];
}

export const QUEUE_FILE = path.join(SESSIONS_DIR, "merge-queue.json");

export function readQueue(): MergeQueue {
  try {
    if (fs.existsSync(QUEUE_FILE)) {
      return JSON.parse(fs.readFileSync(QUEUE_FILE, "utf-8"));
    }
  } catch (err) {
    log.warn("merge-queue", "failed to read queue", { error: String(err) });
  }
  return { entries: [] };
}

export function writeQueue(queue: MergeQueue): void {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const tmpFile = QUEUE_FILE + ".tmp";
  fs.writeFileSync(tmpFile, JSON.stringify(queue, null, 2));
  fs.renameSync(tmpFile, QUEUE_FILE);
}

export function enqueue(entry: MergeQueueEntry): void {
  const queue = readQueue();
  queue.entries.push(entry);
  writeQueue(queue);
  log.info("merge-queue", "enqueued PR", {
    project: entry.project,
    prNumber: entry.prNumber,
    workerName: entry.workerName,
  });
}

export function getProjectQueue(project: string): MergeQueueEntry[] {
  return readQueue().entries.filter(e => e.project === project);
}

export function processMergeQueue(
  project: string,
  resumeWorker: (entry: MergeQueueEntry) => void,
): void {
  const queue = readQueue();
  const idx = queue.entries.findIndex(e => e.project === project);
  if (idx === -1) {
    log.info("merge-queue", "queue empty for project", { project });
    return;
  }

  const entry = queue.entries[idx];
  log.info("merge-queue", "processing", {
    project: entry.project,
    prNumber: entry.prNumber,
    workerName: entry.workerName,
  });

  const rebased = rebaseBranch(entry.worktreePath);
  if (!rebased) {
    log.info("merge-queue", "rebase conflict, resuming worker", {
      workerName: entry.workerName,
    });
    abortRebase(entry.worktreePath);
    queue.entries.splice(idx, 1);
    writeQueue(queue);
    resumeWorker(entry);
    return;
  }

  try {
    forcePushBranch(entry.worktreePath);
    mergePR(entry.projectPath, entry.prNumber);
  } catch (err) {
    log.error("merge-queue", "merge failed", {
      prNumber: entry.prNumber,
      error: String(err),
    });
    queue.entries.splice(idx, 1);
    writeQueue(queue);
    tmuxDisplay(`Failed to merge PR #${entry.prNumber}: ${err}`);
    refreshDashboard();
    return;
  }

  log.info("merge-queue", "PR merged", {
    prNumber: entry.prNumber,
    workerName: entry.workerName,
  });

  removeWorktree(entry.projectPath, entry.worktreePath);
  pruneWorktrees(entry.projectPath);
  removeWorker(entry.project, entry.workerName);
  queue.entries.splice(idx, 1);
  writeQueue(queue);
  tmuxDisplay(`PR #${entry.prNumber} merged. Worktree cleaned up.`);
  refreshDashboard();

  // Drain remaining entries for this project
  processMergeQueue(project, resumeWorker);
}

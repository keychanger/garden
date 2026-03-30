// PR poller: watches GitHub PR state and drives the check/merge lifecycle.
// Runs as a hidden tmux window. Wakes on signal via FIFO or 30s timeout.
import { execSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DASHBOARD_SESSION } from "../session.js";
import { tryGetProject, SESSIONS_DIR } from "../config.js";
import {
  tmux, getFirstPaneId, getPanePid, hasClaudeChild,
  windowExists, killWindowSafe,
} from "./tmux.js";
import {
  readRegistry, getWorkers, updateWorkerFields,
  type WorkerEntry,
} from "./registry.js";
import {
  getBranchPR, getPRInfo, rebaseBranch, abortRebase,
  forcePushBranch, mergePR, commentOnPR, fastForwardMain,
} from "./git.js";
import { refreshDashboard } from "./header.js";
import { healStatusPane } from "./validate.js";
import { log } from "./log.js";

const DEBOUNCE_MS = 30_000;
const POLLER_WINDOW = "_garden-pr-poller";
const SIGNAL_FIFO = path.join(SESSIONS_DIR, "poll-signal");

function prComment(projectPath: string, prNumber: number, message: string): void {
  commentOnPR(projectPath, prNumber, `[garden] ${message}`);
}

export function poll(): void {
  healStatusPane();
  const registry = readRegistry();

  for (const [projectName, entries] of Object.entries(registry.workers)) {
    const project = tryGetProject(projectName);
    if (!project) continue;

    for (const entry of entries) {
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

  // Check for externally closed/merged PRs in active PR states.
  // Skip "merged" — handleMerged needs to run to detect new PRs on the branch.
  if (state !== "working" && state !== "merged" && entry.prNumber) {
    const info = getPRInfo(projectPath, entry.prNumber);
    if (!info) {
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
      updateWorkerFields(projectName, entry.name, {
        prState: "merged",
        mergedAt: new Date().toISOString(),
      });
      refreshDashboard();
      return;
    }
  }

  switch (state) {
    case "working":
      return handleWorking(projectName, projectPath, entry);
    case "open":
      return handleOpen(projectName, projectPath, entry);
    case "merging":
      return; // merge in progress from a previous poll cycle
    case "failing":
      return handleFailing(projectName, projectPath, entry);
    case "merged":
      return handleMerged(projectName, entry);
    default:
      // Handle workers stuck in old states (in-review, approved, etc.)
      log.warn("poller", "unknown state, resetting to open", {
        worker: entry.name,
        state,
      });
      updateWorkerFields(projectName, entry.name, { prState: "open" });
      return;
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
  if (!entry.prNumber) return;

  const project = tryGetProject(projectName);
  if (!project) return;

  // Run checks if configured
  if (project.checks) {
    const wtPath = entry.worktreePath ?? projectPath;
    try {
      execSync(project.checks, {
        cwd: wtPath,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 300_000,
      });
      log.info("poller", "checks passed", { worker: entry.name });
    } catch (err: unknown) {
      log.info("poller", "checks failed", { worker: entry.name });
      const stderr = (err as { stderr?: Buffer })?.stderr?.toString() ?? "";
      const truncated = stderr.slice(-500);
      const message = `Checks failed for PR #${entry.prNumber}:\n\n${truncated}\n\nFix the issues and push again.`;
      notifyWorker(projectName, entry, message);
      prComment(projectPath, entry.prNumber, "Checks failed. Worker notified.");

      const info = getPRInfo(projectPath, entry.prNumber);
      updateWorkerFields(projectName, entry.name, {
        prState: "failing",
        lastSeenSha: info?.headSha,
        lastShaChangeAt: new Date().toISOString(),
      });
      refreshDashboard();
      return;
    }
  }

  attemptMerge(projectName, projectPath, entry);
}

function attemptMerge(
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

    const message = `Merge conflict with main on PR #${entry.prNumber}. Please resolve:\n\n1. git rebase main\n2. Resolve conflicts\n3. git rebase --continue\n4. Push when done.`;
    notifyWorker(projectName, entry, message);
    prComment(projectPath, entry.prNumber, `Merge conflict with main. Worker \`${entry.name}\` notified.`);

    const info = getPRInfo(projectPath, entry.prNumber);
    updateWorkerFields(projectName, entry.name, {
      prState: "failing",
      lastSeenSha: info?.headSha,
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
    // Reset to open so it retries next cycle
    updateWorkerFields(projectName, entry.name, { prState: "open" });
    refreshDashboard();
    return;
  }

  log.info("poller", "PR merged", { worker: entry.name, prNumber: entry.prNumber });
  prComment(projectPath, entry.prNumber, "Merged successfully.");
  fastForwardMain(projectPath);
  updateWorkerFields(projectName, entry.name, {
    prState: "merged",
    mergedAt: new Date().toISOString(),
  });
  refreshDashboard();
}

function handleFailing(
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
    log.info("poller", "debounce complete, retrying", { worker: entry.name });
    updateWorkerFields(projectName, entry.name, { prState: "open" });
  }
}

function handleMerged(
  projectName: string,
  entry: WorkerEntry,
): void {
  const project = tryGetProject(projectName);
  if (!project) return;
  const projectPath = project.path;
  const branchName = entry.branchName ?? entry.name;

  // Check if worker opened a new PR on the same branch
  const newPrNumber = getBranchPR(projectPath, branchName);
  if (newPrNumber !== null && newPrNumber !== entry.prNumber) {
    const prevCount = entry.mergeCount ?? 0;
    log.info("poller", "new PR found after merge, resuming", {
      worker: entry.name,
      newPrNumber,
      mergeCount: prevCount + 1,
    });
    updateWorkerFields(projectName, entry.name, {
      prNumber: newPrNumber,
      prState: "open",
      mergeCount: prevCount + 1,
      mergedAt: undefined,
    });
    refreshDashboard();
    return;
  }

  // Check for new commits on branch since merge
  if (entry.mergedAt && entry.worktreePath) {
    try {
      const newCommits = execFileSync("git", [
        "rev-list", "--count", "--after", entry.mergedAt, "HEAD",
      ], {
        cwd: entry.worktreePath,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10_000,
      }).trim();

      if (parseInt(newCommits, 10) > 0) {
        const prevCount = entry.mergeCount ?? 0;
        log.info("poller", "new commits after merge, resuming", {
          worker: entry.name,
          newCommits,
          mergeCount: prevCount + 1,
        });
        updateWorkerFields(projectName, entry.name, {
          prState: "working",
          prNumber: undefined,
          mergeCount: prevCount + 1,
          mergedAt: undefined,
        });
        refreshDashboard();
      }
    } catch {
      // worktree may be gone, ignore
    }
  }
}

function notifyWorker(
  projectName: string,
  entry: WorkerEntry,
  message: string,
): void {
  const windowName = `_${projectName}-worker-${entry.name}`;
  if (!windowExists(windowName)) return;

  const paneId = getFirstPaneId(`${DASHBOARD_SESSION}:${windowName}`);
  if (!paneId) return;

  const pid = getPanePid(paneId);
  if (!pid || !hasClaudeChild(pid)) return;

  tmux("send-keys", "-t", paneId, "-l", message);
  tmux("send-keys", "-t", paneId, "Enter");
  log.info("poller", "notified worker", { worker: entry.name });
}

export function triggerPoll(): void {
  try {
    const fd = fs.openSync(SIGNAL_FIFO, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
    fs.writeSync(fd, "\n");
    fs.closeSync(fd);
    log.info("poller", "triggered immediate poll");
  } catch {
    // FIFO not ready or poller not running — ignore
  }
}

export function startPoller(gardenRunner: string): void {
  if (windowExists(POLLER_WINDOW)) return;

  ensureSignalFifo();
  const fifo = SIGNAL_FIFO.replace(/'/g, "'\\''");
  const cmd = [
    `while true; do`,
    `  ${gardenRunner} dashboard _poll 2>/dev/null;`,
    `  read -t 30 <>'${fifo}' 2>/dev/null || true;`,
    `done`,
  ].join(" ");
  tmux("new-window", "-d", "-t", DASHBOARD_SESSION, "-n", POLLER_WINDOW,
    "bash", "-c", cmd);

  log.info("poller", "started poller");
}

export function stopPoller(): void {
  killWindowSafe(POLLER_WINDOW);
  cleanupSignalFifo();
  log.info("poller", "stopped poller");
}

export function pollerRunning(): boolean {
  return windowExists(POLLER_WINDOW);
}

function ensureSignalFifo(): void {
  try {
    const stat = fs.statSync(SIGNAL_FIFO);
    if (stat.isFIFO()) return;
    fs.unlinkSync(SIGNAL_FIFO);
  } catch { /* doesn't exist */ }
  fs.mkdirSync(path.dirname(SIGNAL_FIFO), { recursive: true });
  execFileSync("mkfifo", [SIGNAL_FIFO]);
}

function cleanupSignalFifo(): void {
  try { fs.unlinkSync(SIGNAL_FIFO); } catch { /* ignore */ }
}

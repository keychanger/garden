// PR poller: watches GitHub PR state and drives the check/merge lifecycle.
// Runs as a hidden tmux window, invoked every 30s via `garden dashboard _poll`.
import { execSync } from "node:child_process";
import { execFileSync } from "node:child_process";
import { DASHBOARD_SESSION } from "../session.js";
import { tryGetProject } from "../config.js";
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
  forcePushBranch, mergePR, commentOnPR,
} from "./git.js";
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
      updateWorkerFields(projectName, entry.name, { prState: "merged" });
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
      return; // merged PRs stay until manually cleaned up via ⌥x
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
  updateWorkerFields(projectName, entry.name, { prState: "merged" });
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

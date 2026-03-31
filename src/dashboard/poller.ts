// PR poller: watches GitHub PR state and drives the check/merge lifecycle.
// Runs as a hidden tmux window. Wakes on signal via FIFO or 30s timeout.
import { execSync, execFileSync, spawnSync } from "node:child_process";
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
  getChangedFiles, getPRDetails, getPRDiff, submitPRReview,
} from "./git.js";
import { buildWorktreeWorkerCommand } from "./create.js";
import { refreshDashboard } from "./header.js";
import { healStatusPane } from "./validate.js";
import { log } from "./log.js";
import { buildRulesContext } from "../rules.js";
import crypto from "node:crypto";

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
  // Deliver pending notification if Claude is alive
  if (entry.pendingNotification) {
    const windowName = `_${projectName}-worker-${entry.name}`;
    if (windowExists(windowName)) {
      const paneId = getFirstPaneId(`${DASHBOARD_SESSION}:${windowName}`);
      if (paneId) {
        const pid = getPanePid(paneId);
        if (pid && hasClaudeChild(pid)) {
          tmux("send-keys", "-t", paneId, "-l", entry.pendingNotification);
          tmux("send-keys", "-t", paneId, "Enter");
          updateWorkerFields(projectName, entry.name, {
            pendingNotification: undefined,
          });
          log.info("poller", "delivered pending notification", {
            worker: entry.name,
          });
        }
      }
    }
  }

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
    case "reviewing":
      return handleReviewing(projectName, projectPath, entry);
    case "failing":
      return handleFailing(projectName, projectPath, entry);
    case "merged":
      return handleMerged(projectName, entry);
    default:
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
  attemptMerge(projectName, projectPath, entry);
}

function attemptMerge(
  projectName: string,
  projectPath: string,
  entry: WorkerEntry,
): void {
  if (!entry.prNumber) return;

  // Don't rebase/merge while Claude is actively running in the worktree
  const workerWindow = `_${projectName}-worker-${entry.name}`;
  if (windowExists(workerWindow)) {
    const paneId = getFirstPaneId(`${DASHBOARD_SESSION}:${workerWindow}`);
    if (paneId) {
      const pid = getPanePid(paneId);
      if (pid && hasClaudeChild(pid)) {
        log.info("poller", "Claude active in worktree, skipping merge", {
          worker: entry.name,
          prNumber: entry.prNumber,
        });
        return;
      }
    }
  }

  // Serialize merges: only one PR per project can merge at a time
  const projectWorkers = getWorkers(projectName);
  const alreadyMerging = projectWorkers.some(
    w => w.name !== entry.name && (w.prState === "merging" || w.prState === "reviewing"),
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

  // Run checks after rebase so they validate the combined state
  const project = tryGetProject(projectName);
  if (project?.checks) {
    try {
      execSync(project.checks, {
        cwd: wtPath,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 300_000,
      });
      log.info("poller", "checks passed after rebase", { worker: entry.name });
    } catch (err: unknown) {
      log.info("poller", "checks failed after rebase", { worker: entry.name });
      const stderr = (err as { stderr?: Buffer })?.stderr?.toString() ?? "";
      const truncated = stderr.slice(-500);
      const message = `Checks failed for PR #${entry.prNumber} after rebase:\n\n${truncated}\n\nFix the issues and push again.`;
      notifyWorker(projectName, entry, message);
      prComment(projectPath, entry.prNumber, "Checks failed after rebase. Worker notified.");

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

  try {
    forcePushBranch(wtPath);
  } catch (err) {
    log.error("poller", "force-push failed", {
      worker: entry.name,
      prNumber: entry.prNumber,
      error: String(err),
    });
    updateWorkerFields(projectName, entry.name, { prState: "open" });
    refreshDashboard();
    return;
  }

  log.info("poller", "force-pushed, transitioning to review", {
    worker: entry.name,
    prNumber: entry.prNumber,
  });
  updateWorkerFields(projectName, entry.name, { prState: "reviewing" });
  refreshDashboard();
}

function handleReviewing(
  projectName: string,
  projectPath: string,
  entry: WorkerEntry,
): void {
  if (!entry.prNumber) return;

  // Live-Claude guard: if the worker started pushing new code, go back to open
  const workerWindow = `_${projectName}-worker-${entry.name}`;
  if (windowExists(workerWindow)) {
    const paneId = getFirstPaneId(`${DASHBOARD_SESSION}:${workerWindow}`);
    if (paneId) {
      const pid = getPanePid(paneId);
      if (pid && hasClaudeChild(pid)) {
        log.info("poller", "Claude active during review, resetting to open", {
          worker: entry.name,
        });
        updateWorkerFields(projectName, entry.name, { prState: "open" });
        refreshDashboard();
        return;
      }
    }
  }

  const review = runClaudeReview(projectName, projectPath, entry);

  if (review === null) {
    log.warn("poller", "review process failed, proceeding with merge", {
      worker: entry.name,
    });
    finalizeMerge(projectName, projectPath, entry);
    return;
  }

  submitPRReview(projectPath, entry.prNumber, review.approved, review.body);
  log.info("poller", "submitted PR review", {
    worker: entry.name,
    prNumber: entry.prNumber,
    approved: review.approved,
  });

  if (review.approved) {
    finalizeMerge(projectName, projectPath, entry);
  } else {
    const message = `PR review requested changes for #${entry.prNumber}:\n\n${review.body}\n\nFix the issues and push again.`;
    notifyWorker(projectName, entry, message);
    prComment(projectPath, entry.prNumber, "Review requested changes. Worker notified.");

    const info = getPRInfo(projectPath, entry.prNumber);
    updateWorkerFields(projectName, entry.name, {
      prState: "failing",
      lastSeenSha: info?.headSha,
      lastShaChangeAt: new Date().toISOString(),
    });
    refreshDashboard();
  }
}

interface ReviewResult {
  approved: boolean;
  body: string;
}

function runClaudeReview(
  projectName: string,
  projectPath: string,
  entry: WorkerEntry,
): ReviewResult | null {
  if (!entry.prNumber) return null;

  let diff: string;
  try {
    diff = getPRDiff(projectPath, entry.prNumber);
  } catch {
    log.warn("poller", "failed to get PR diff for review", { worker: entry.name });
    return null;
  }

  const details = getPRDetails(projectPath, entry.prNumber);
  const rules = buildRulesContext(projectName, projectPath);
  const wtPath = entry.worktreePath ?? projectPath;

  // Include full content of changed doc files so the reviewer can assess quality
  const changedFiles = getChangedFiles(wtPath);
  const docSections: string[] = [];
  for (const file of changedFiles) {
    if (!file.endsWith(".md")) continue;
    const fullPath = path.join(wtPath, file);
    try {
      const content = fs.readFileSync(fullPath, "utf-8");
      docSections.push(`### ${file}\n\n${content}`);
    } catch {
      // file may have been deleted
    }
  }

  const prompt = [
    "Review this pull request diff against the project rules below.",
    "",
    "Check for:",
    "- Adherence to project rules (commit style, code patterns, scope discipline)",
    "- Test coverage for changed behavior",
    "- Documentation quality: if docs were changed, verify they are accurate, complete,",
    "  and consistent with the code changes. If code changes affect commands, architecture,",
    "  file layout, or conventions but no docs were updated, flag that.",
    "- Code quality issues, security concerns, or unnecessary complexity",
    "",
    `## PR #${entry.prNumber}: ${details?.title ?? "Unknown"}`,
    "",
    "## Project Rules",
    "",
    rules,
    "",
    "## Diff",
    "",
    "```diff",
    diff,
    "```",
    ...(docSections.length > 0 ? [
      "",
      "## Full Documentation Files (changed in this PR)",
      "",
      "Use these to assess whether documentation is accurate and complete,",
      "not just whether it was updated.",
      "",
      ...docSections,
    ] : []),
    "",
    "## Output Format",
    "",
    "Your FIRST line must be exactly one of:",
    "APPROVE",
    "REQUEST_CHANGES",
    "",
    "Then provide your review comments explaining your decision.",
  ].join("\n");

  try {
    const proc = spawnSync("claude", ["-p", "--verbose"], {
      input: prompt,
      encoding: "utf-8",
      timeout: 300_000,
      stdio: ["pipe", "pipe", "pipe"],
      cwd: entry.worktreePath ?? projectPath,
    });

    if (proc.status !== 0 || !proc.stdout) {
      log.warn("poller", "claude review process failed", {
        worker: entry.name,
        exitCode: proc.status,
        stderr: proc.stderr?.slice(-200),
      });
      return null;
    }

    const output = proc.stdout.trim();
    const firstLine = output.split("\n")[0].trim().toUpperCase();
    const body = output.split("\n").slice(1).join("\n").trim() || "No additional comments.";

    if (firstLine === "APPROVE") {
      return { approved: true, body };
    }
    if (firstLine === "REQUEST_CHANGES") {
      return { approved: false, body };
    }

    // Could not parse verdict — treat as approval with the full output as body
    log.warn("poller", "could not parse review verdict, treating as approval", {
      worker: entry.name,
      firstLine,
    });
    return { approved: true, body: output };
  } catch (err) {
    log.warn("poller", "claude review threw", {
      worker: entry.name,
      error: String(err),
    });
    return null;
  }
}

function finalizeMerge(
  projectName: string,
  projectPath: string,
  entry: WorkerEntry,
): void {
  if (!entry.prNumber) return;

  try {
    mergePR(projectPath, entry.prNumber);
  } catch (err) {
    log.error("poller", "merge failed", {
      worker: entry.name,
      prNumber: entry.prNumber,
      error: String(err),
    });
    updateWorkerFields(projectName, entry.name, { prState: "open" });
    refreshDashboard();
    return;
  }

  log.info("poller", "PR merged", { worker: entry.name, prNumber: entry.prNumber });
  prComment(projectPath, entry.prNumber, "Merged successfully.");

  notifySiblingWorkers(projectName, projectPath, entry);

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

        // Rebase onto latest main so continued work starts from the tip
        try {
          execFileSync("git", ["fetch", "origin", "main"], {
            cwd: entry.worktreePath,
            stdio: "ignore",
          });
        } catch { /* best effort */ }

        if (!rebaseBranch(entry.worktreePath)) {
          log.warn("poller", "rebase failed on resume after merge", {
            worker: entry.name,
          });
          abortRebase(entry.worktreePath);
        }

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

function notifySiblingWorkers(
  projectName: string,
  projectPath: string,
  mergedEntry: WorkerEntry,
): void {
  if (!mergedEntry.worktreePath || !mergedEntry.prNumber) return;

  const mergedFiles = getChangedFiles(mergedEntry.worktreePath);
  if (mergedFiles.length === 0) return;

  const details = getPRDetails(projectPath, mergedEntry.prNumber);
  const siblings = getWorkers(projectName).filter(
    w => w.name !== mergedEntry.name &&
      (w.prState === "working" || w.prState === "open" || w.prState === "failing"),
  );

  const mergedSet = new Set(mergedFiles);

  for (const sibling of siblings) {
    if (!sibling.worktreePath) continue;
    const siblingFiles = getChangedFiles(sibling.worktreePath);
    const overlap = siblingFiles.filter(f => mergedSet.has(f));
    if (overlap.length === 0) continue;

    const title = details?.title ?? `PR #${mergedEntry.prNumber}`;
    const url = details?.url ?? "";
    const fileList = overlap.join(", ");
    const message = [
      `[garden] PR #${mergedEntry.prNumber} "${title}" just merged into main.`,
      url ? `URL: ${url}` : "",
      `It changed files that overlap with your branch: ${fileList}`,
      "Rebase onto main, review how these changes interact with your work, and make sure you are not reverting their fix. Push when ready.",
    ].filter(Boolean).join("\n");

    const windowName = `_${projectName}-worker-${sibling.name}`;
    if (!windowExists(windowName)) continue;

    const paneId = getFirstPaneId(`${DASHBOARD_SESSION}:${windowName}`);
    if (!paneId) continue;

    const pid = getPanePid(paneId);
    if (pid && hasClaudeChild(pid)) {
      tmux("send-keys", "-t", paneId, "-l", message);
      tmux("send-keys", "-t", paneId, "Enter");
      log.info("poller", "notified sibling of merge overlap", {
        worker: sibling.name,
        mergedWorker: mergedEntry.name,
        overlapFiles: overlap,
      });
    } else {
      relaunchWorker(projectName, projectPath, sibling, message);
    }
  }
}

function relaunchWorker(
  projectName: string,
  projectPath: string,
  entry: WorkerEntry,
  notification: string,
): void {
  const windowName = `_${projectName}-worker-${entry.name}`;
  const paneId = getFirstPaneId(`${DASHBOARD_SESSION}:${windowName}`);
  if (!paneId) return;

  const newSessionId = crypto.randomUUID();
  const branchName = entry.branchName ?? entry.name;
  const wtPath = entry.worktreePath ?? "";
  if (!wtPath) return;

  const launchCmd = buildWorktreeWorkerCommand(
    projectName, projectPath, entry.name, branchName, newSessionId,
  );

  updateWorkerFields(projectName, entry.name, {
    sessionId: newSessionId,
    pendingNotification: notification,
  });

  tmux("send-keys", "-t", paneId, "-l", launchCmd);
  tmux("send-keys", "-t", paneId, "Enter");
  log.info("poller", "relaunched worker for sibling notification", {
    worker: entry.name,
    newSessionId,
  });
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

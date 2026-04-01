// Poller: watches worker branches and drives the review/merge lifecycle.
// Runs as a hidden tmux window. Re-polls immediately on state change (exit 75),
// sleeps until signaled via FIFO or 30s timeout when idle (exit 0).
import { execSync, execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DASHBOARD_SESSION } from "../session.js";
import { tryGetProject, SESSIONS_DIR } from "../config.js";
import {
  tmux, getFirstPaneId, getPanePid, hasClaudeChild, isClaudeWorking,
  windowExists, killWindowSafe,
} from "./tmux.js";
import {
  readRegistry, getWorkers, updateWorkerFields,
  type WorkerEntry,
} from "./registry.js";
import {
  getBranchHeadSha,
  forcePushBranch, mergeToMain, fastForwardMain,
  getChangedFiles, getDiffAgainstMain,
  getCommitSummary, getNewCommitSummary, deleteRemoteBranch,
} from "./git.js";
import { refreshDashboard } from "./header.js";
import { healStatusPane } from "./validate.js";
import { log } from "./log.js";
import { buildRulesContext } from "../rules.js";
import { addAlert } from "./alerts.js";

const DEBOUNCE_MS = 30_000;
const POLLER_WINDOW = "_garden-poller";
export const SIGNAL_FIFO = path.join(SESSIONS_DIR, "poll-signal");

export function poll(): boolean {
  healStatusPane();
  const registry = readRegistry();
  let changed = false;

  for (const [projectName, entries] of Object.entries(registry.workers)) {
    const project = tryGetProject(projectName);
    if (!project) continue;

    for (const entry of entries) {
      try {
        if (pollWorker(projectName, project.path, entry)) {
          changed = true;
        }
      } catch (err) {
        log.error("poller", "error polling worker", {
          worker: entry.name,
          project: projectName,
          error: String(err),
        });
      }
    }
  }

  return changed;
}

function pollWorker(
  projectName: string,
  projectPath: string,
  entry: WorkerEntry,
): boolean {
  const state = entry.prState ?? "working";

  switch (state) {
    case "working":
      return handleWorking(projectName, projectPath, entry);
    case "reviewing":
      return handleReviewing(projectName, projectPath, entry);
    case "failing":
      return handleFailing(projectName, projectPath, entry);
    case "merged":
      return handleMerged(projectName, entry);
    default:
      log.warn("poller", "unknown state, resetting to working", {
        worker: entry.name,
        state,
      });
      updateWorkerFields(projectName, entry.name, { prState: "working" });
      return true;
  }
}

function handleWorking(
  projectName: string,
  projectPath: string,
  entry: WorkerEntry,
): boolean {
  const wtPath = entry.worktreePath ?? projectPath;
  const headSha = getBranchHeadSha(wtPath);
  if (!headSha) return false;

  // No new commits since last check
  if (headSha === entry.lastSeenSha) return false;

  // Don't start review while Claude is actively working
  const workerWindow = `_${projectName}-worker-${entry.name}`;
  if (windowExists(workerWindow)) {
    const paneId = getFirstPaneId(`${DASHBOARD_SESSION}:${workerWindow}`);
    if (paneId) {
      const pid = getPanePid(paneId);
      if (pid && isClaudeWorking(pid)) return false;
    }
  }

  // Check if there are actually commits ahead of main
  const commitSummary = getCommitSummary(wtPath);
  if (!commitSummary) return false;

  // Serialize: only one worker per project in reviewing state
  const projectWorkers = getWorkers(projectName);
  if (projectWorkers.some(w => w.name !== entry.name && w.prState === "reviewing")) {
    return false;
  }

  return attemptReview(projectName, projectPath, entry);
}

function attemptReview(
  projectName: string,
  projectPath: string,
  entry: WorkerEntry,
): boolean {
  // Don't rebase/review while Claude is actively running in the worktree
  const workerWindow = `_${projectName}-worker-${entry.name}`;
  if (windowExists(workerWindow)) {
    const paneId = getFirstPaneId(`${DASHBOARD_SESSION}:${workerWindow}`);
    if (paneId) {
      const pid = getPanePid(paneId);
      if (pid && isClaudeWorking(pid)) {
        log.info("poller", "Claude working in worktree, skipping review", {
          worker: entry.name,
        });
        return false;
      }
    }
  }

  updateWorkerFields(projectName, entry.name, { prState: "reviewing" });
  refreshDashboard();

  const wtPath = entry.worktreePath ?? projectPath;

  // Fetch latest main so the reviewer can rebase onto it
  try {
    execFileSync("git", ["fetch", "origin", "main"], {
      cwd: wtPath,
      stdio: "ignore",
    });
  } catch {
    // best effort
  }

  log.info("poller", "ready for review", { worker: entry.name });
  return true;
}

function handleReviewing(
  projectName: string,
  projectPath: string,
  entry: WorkerEntry,
): boolean {
  // Live-Claude guard: if the worker started pushing new code, go back to working
  const workerWindow = `_${projectName}-worker-${entry.name}`;
  if (windowExists(workerWindow)) {
    const paneId = getFirstPaneId(`${DASHBOARD_SESSION}:${workerWindow}`);
    if (paneId) {
      const pid = getPanePid(paneId);
      if (pid && isClaudeWorking(pid)) {
        log.info("poller", "Claude working during review, resetting to working", {
          worker: entry.name,
        });
        updateWorkerFields(projectName, entry.name, { prState: "working" });
        refreshDashboard();
        return true;
      }
    }
  }

  const review = runClaudeReview(projectName, projectPath, entry);

  if (review === null) {
    log.warn("poller", "review process failed, transitioning to failing", {
      worker: entry.name,
    });
    addAlert({
      level: "error",
      source: "review",
      project: projectName,
      worker: entry.name,
      message: `Review failed for worker ${entry.name}: Claude unavailable or unparseable output`,
    });
    const wtPath = entry.worktreePath ?? projectPath;
    const headSha = getBranchHeadSha(wtPath);
    updateWorkerFields(projectName, entry.name, {
      prState: "failing",
      failCount: (entry.failCount ?? 0) + 1,
      failingSha: undefined,
      lastSeenSha: headSha ?? undefined,
      lastShaChangeAt: new Date().toISOString(),
    });
    refreshDashboard();
    return true;
  }

  log.info("poller", "review complete", {
    worker: entry.name,
    verdict: review.verdict,
    ...(review.verdict === "fixed" && { summary: review.body }),
  });

  if (review.verdict === "clean" || review.verdict === "fixed") {
    const wtPath = entry.worktreePath ?? projectPath;

    // Always force-push: reviewer rebases, so local state diverges from remote
    const branchName = entry.branchName ?? entry.name;
    try {
      forcePushBranch(wtPath, branchName);
    } catch (err) {
      log.error("poller", "force-push after review failed", {
        worker: entry.name,
        error: String(err),
      });
      updateWorkerFields(projectName, entry.name, { prState: "working" });
      refreshDashboard();
      return true;
    }

    finalizeMerge(projectName, projectPath, entry);
  } else {
    // "failed" — reviewer couldn't fix the issues
    log.error("poller", "reviewer could not fix issues", {
      worker: entry.name,
      body: review.body,
    });
    addAlert({
      level: "error",
      source: "review",
      project: projectName,
      worker: entry.name,
      message: `Reviewer could not fix issues for worker ${entry.name}: ${review.body.slice(0, 300)}`,
    });

    const wtPath = entry.worktreePath ?? projectPath;
    const headSha = getBranchHeadSha(wtPath);
    updateWorkerFields(projectName, entry.name, {
      prState: "failing",
      failCount: (entry.failCount ?? 0) + 1,
      failingSha: headSha ?? undefined,
      lastSeenSha: headSha ?? undefined,
      lastShaChangeAt: new Date().toISOString(),
    });
    refreshDashboard();
  }
  return true;
}

interface ReviewResult {
  verdict: "clean" | "fixed" | "failed";
  body: string;
}

function runClaudeReview(
  projectName: string,
  projectPath: string,
  entry: WorkerEntry,
): ReviewResult | null {
  const wtPath = entry.worktreePath ?? projectPath;

  let diff: string;
  try {
    diff = getDiffAgainstMain(wtPath);
  } catch {
    log.warn("poller", "failed to get diff for review", { worker: entry.name });
    return null;
  }

  const commitSummary = getCommitSummary(wtPath);
  const branchName = entry.branchName ?? entry.name;
  const rules = buildRulesContext(projectName, projectPath);
  const project = tryGetProject(projectName);
  const checksCommand = project?.checks;

  const changedFiles = getChangedFiles(wtPath);

  // Always include canonical docs so the reviewer can verify accuracy
  const docSections: string[] = [];
  for (const docFile of ["DESIGN.md", "CLAUDE.md"]) {
    const fullPath = path.join(wtPath, docFile);
    try {
      const content = fs.readFileSync(fullPath, "utf-8");
      docSections.push(`### ${docFile}\n\n${content}`);
    } catch {
      // file may not exist in this project
    }
  }

  // Include test files that correspond to changed source files
  const testSections: string[] = [];
  for (const file of changedFiles) {
    const basename = path.basename(file, path.extname(file));
    const testFile = path.join(wtPath, "test", `${basename}.test.ts`);
    try {
      const content = fs.readFileSync(testFile, "utf-8");
      testSections.push(`### test/${basename}.test.ts\n\n${content}`);
    } catch {
      // no corresponding test file
    }
  }

  // Build step numbering dynamically based on whether checks are configured
  let stepNum = 1;
  const rebaseStep = stepNum++;
  const checksStep = checksCommand ? stepNum++ : null;
  const reviewStep = stepNum;

  const prompt = [
    "You are reviewing a branch before merge. Complete these steps in order:",
    "",
    `## Step ${rebaseStep}: Rebase onto main`,
    "",
    "Run \`git rebase main\` in the worktree. If there are conflicts:",
    "- Resolve them sensibly (preserve the intent of both sides)",
    "- \`git add\` resolved files and \`git rebase --continue\`",
    "- If a conflict is truly unresolvable, abort the rebase and report FAILED",
    "",
    ...(checksCommand ? [
      `## Step ${checksStep}: Run checks`,
      "",
      `Run: \`${checksCommand}\``,
      "",
      "If checks fail, fix the issues and re-run until they pass.",
      "If you cannot fix them, report FAILED.",
      "",
    ] : []),
    `## Step ${reviewStep}: Code review`,
    "",
    "Review the branch diff against the project rules below.",
    "",
    "Check for:",
    "- Adherence to project rules (commit style, code patterns, scope discipline)",
    "- Code quality issues, security concerns, or unnecessary complexity",
    "- Documentation accuracy: read DESIGN.md and CLAUDE.md below. After applying this",
    "  diff, are they still accurate and complete? Flag any claims that are now wrong,",
    "  missing sections for new behavior, or stale descriptions. Not every change needs a",
    "  doc change — only flag docs that are actually inaccurate after this diff.",
    "- Test quality: read the test files below. Check three things:",
    "  1. Accuracy — do existing tests still assert correct behavior after this diff?",
    "     Flag tests that now assert stale or wrong behavior.",
    "  2. Coverage — are the new/changed code paths exercised by tests? Flag significant",
    "     new logic (branching, error handling, state transitions) that has no test.",
    "  3. Completeness — do the tests cover edge cases and failure modes, not just the",
    "     happy path? Flag obvious gaps. Not every change needs a test change — only flag",
    "     tests that are actually wrong or insufficient for the behavior this diff changes.",
    "",
    "If you find issues, fix them directly in the worktree. Edit files, update tests,",
    "update docs as needed. Make focused, minimal fixes — do not refactor or improve code",
    "beyond what the review requires. Commit your fixes with a clear message prefixed with",
    '"review: " (e.g., "review: add missing tests for error handling").',
    "",
    `## Branch: ${branchName}`,
    "",
    commitSummary ? `### Commits\n\n\`\`\`\n${commitSummary}\n\`\`\`` : "",
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
    "",
    "## Documentation (current state in the worktree)",
    "",
    "Verify these are still accurate after the diff above.",
    "",
    ...docSections,
    ...(testSections.length > 0 ? [
      "",
      "## Test Files (corresponding to changed source files)",
      "",
      "Verify these still correctly cover the changed behavior.",
      "",
      ...testSections,
    ] : []),
    "",
    "## Output Format",
    "",
    "Your LAST line of output must be exactly one of:",
    "CLEAN — no issues found, code is ready to merge as-is",
    "FIXED — issues were found and fixed in the worktree",
    "FAILED — issues were found but could not be fixed (explain above)",
  ].join("\n");

  try {
    const proc = spawnSync("claude", ["-p", "--dangerously-skip-permissions"], {
      input: prompt,
      encoding: "utf-8",
      timeout: 600_000,
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
    const lines = output.split("\n");
    const lastLine = lines[lines.length - 1].trim().toUpperCase();
    const body = lines.slice(0, -1).join("\n").trim() || "No additional comments.";

    if (lastLine === "CLEAN") {
      return { verdict: "clean", body };
    }
    if (lastLine === "FIXED") {
      return { verdict: "fixed", body };
    }
    if (lastLine === "FAILED") {
      return { verdict: "failed", body };
    }

    // Could not parse verdict — treat as failure so it surfaces for retry
    log.warn("poller", "could not parse review verdict", {
      worker: entry.name,
      lastLine,
    });
    return null;
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
  const branchName = entry.branchName ?? entry.name;

  try {
    mergeToMain(projectPath, branchName);
  } catch (err) {
    log.error("poller", "merge failed", {
      worker: entry.name,
      error: String(err),
    });
    addAlert({
      level: "error",
      source: "poller",
      project: projectName,
      worker: entry.name,
      message: `Merge failed for worker ${entry.name}: ${String(err).slice(0, 200)}`,
    });
    updateWorkerFields(projectName, entry.name, { prState: "working" });
    refreshDashboard();
    return;
  }

  log.info("poller", "merged to main", { worker: entry.name });

  notifySiblingWorkers(projectName, entry);

  runPostMerge(projectName, projectPath);
  updateWorkerFields(projectName, entry.name, {
    prState: "merged",
    mergedAt: new Date().toISOString(),
    failCount: 0,
  });
  refreshDashboard();
}

function getHeadCommit(projectPath: string): string {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: projectPath, encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
}

function runPostMerge(projectName: string, projectPath: string): void {
  const project = tryGetProject(projectName);
  if (!project?.postMerge) return;

  const commit = getHeadCommit(projectPath);

  try {
    execSync(project.postMerge, {
      cwd: projectPath,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
    if (projectName === "garden") {
      log.info("poller", "garden rebuilt", { commit });
    } else {
      log.info("poller", "postMerge completed", { project: projectName, commit });
    }
  } catch (err) {
    const message = projectName === "garden"
      ? `Garden rebuild failed at commit ${commit}: ${String(err).slice(0, 200)}`
      : `postMerge failed at commit ${commit}: ${String(err).slice(0, 200)}`;
    log.error("poller", "postMerge failed", {
      project: projectName,
      commit,
      error: String(err),
    });
    addAlert({
      level: "error",
      source: "poller",
      project: projectName,
      message,
    });
  }
}

function handleFailing(
  projectName: string,
  projectPath: string,
  entry: WorkerEntry,
): boolean {
  const wtPath = entry.worktreePath ?? projectPath;
  const headSha = getBranchHeadSha(wtPath);
  if (!headSha) return false;

  if (headSha !== entry.lastSeenSha) {
    // New commits pushed — track the change
    const commitLog = getNewCommitSummary(wtPath, entry.failingSha ?? entry.lastSeenSha);
    if (commitLog) {
      log.info("poller", "new commits detected in failing worker", {
        worker: entry.name,
        commits: commitLog,
      });
    }

    updateWorkerFields(projectName, entry.name, {
      lastSeenSha: headSha,
      lastShaChangeAt: new Date().toISOString(),
    });
    return false;
  }

  // If failingSha is set, new commits are required before retrying.
  // This prevents re-reviewing unchanged code after changes-requested,
  // check failures, or rebase conflicts. Transient failures (review
  // process errors) clear failingSha so debounce-only retry still works.
  if (entry.failingSha && headSha === entry.failingSha) {
    return false;
  }

  // Check debounce timeout
  const changeAt = entry.lastShaChangeAt ? new Date(entry.lastShaChangeAt).getTime() : 0;
  if (Date.now() - changeAt >= DEBOUNCE_MS) {
    log.info("poller", "debounce complete, retrying", { worker: entry.name });

    if ((entry.failCount ?? 0) >= 3) {
      addAlert({
        level: "error",
        source: "poller",
        project: projectName,
        worker: entry.name,
        message: `Worker ${entry.name} has failed ${entry.failCount} times -- may need manual attention`,
      });
    }

    updateWorkerFields(projectName, entry.name, {
      prState: "working",
      failingSha: undefined,
    });
    return true;
  }
  return false;
}

function handleMerged(
  projectName: string,
  entry: WorkerEntry,
): boolean {
  const wtPath = entry.worktreePath;
  if (!wtPath) return false;

  // Check if the worker has new commits ahead of main
  const commitSummary = getCommitSummary(wtPath);
  if (!commitSummary) return false;

  const prevCount = entry.mergeCount ?? 0;
  log.info("poller", "new commits after merge, resuming", {
    worker: entry.name,
    mergeCount: prevCount + 1,
  });
  updateWorkerFields(projectName, entry.name, {
    prState: "working",
    mergeCount: prevCount + 1,
    mergedAt: undefined,
    lastSeenSha: undefined,
  });
  refreshDashboard();
  return true;
}

function notifySiblingWorkers(
  projectName: string,
  mergedEntry: WorkerEntry,
): void {
  if (!mergedEntry.worktreePath) return;

  const mergedFiles = getChangedFiles(mergedEntry.worktreePath);
  if (mergedFiles.length === 0) return;

  const commitSummary = getCommitSummary(mergedEntry.worktreePath);
  const siblings = getWorkers(projectName).filter(
    w => w.name !== mergedEntry.name &&
      (w.prState === "working" || w.prState === "failing"),
  );

  const mergedSet = new Set(mergedFiles);

  for (const sibling of siblings) {
    if (!sibling.worktreePath) continue;
    const siblingFiles = getChangedFiles(sibling.worktreePath);
    const overlap = siblingFiles.filter(f => mergedSet.has(f));
    if (overlap.length === 0) continue;

    const title = commitSummary?.split("\n")[0] ?? `worker ${mergedEntry.name}`;
    const fileList = overlap.join(", ");
    const message = [
      `[garden] Worker \`${mergedEntry.name}\` just merged into main: ${title}`,
      `It changed files that overlap with your branch: ${fileList}`,
      "Rebase onto main, review how these changes interact with your work, and make sure you are not reverting their fix. Push when ready.",
    ].join("\n");

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
      log.info("poller", "skipping dead sibling for merge overlap notification", {
        worker: sibling.name,
        mergedWorker: mergedEntry.name,
      });
    }
  }
}

export function postPush(): void {
  triggerPoll();
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
    `  if [ $? -eq 0 ]; then read -t 30 <>'${fifo}' 2>/dev/null || true; fi;`,
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

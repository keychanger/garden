// Poller: watches worker branches and drives the review/merge lifecycle.
// Each project gets its own poller running in a hidden tmux window.
// Reviews run asynchronously in separate tmux windows. Merges are serialized.
import { execSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DASHBOARD_SESSION } from "../session.js";
import { tryGetProject, loadConfig, SESSIONS_DIR } from "../config.js";
import {
  tmux, getFirstPaneId, getPanePid, hasClaudeChild,
  windowExists, killWindowSafe,
} from "./tmux.js";
import {
  readRegistry, getWorkers, updateWorkerFields, findWorkerByName,
  type WorkerEntry,
} from "./registry.js";
import {
  getBranchHeadSha,
  rebaseBranch, abortRebase, cleanWorktree,
  forcePushBranch, mergeToBase, deleteRemoteBranch,
  getChangedFiles, getDiffAgainstBase,
  getCommitSummary, getNewCommitSummary,
  resolveBaseBranch,
  type RebaseResult,
} from "./git.js";
import { refreshDashboard, setupStatusBar, removeClaudeActiveMarker } from "./header.js";
import { isWorkerWorking } from "./detect.js";
import { readDashState } from "./state.js";
import { setupKeybindings } from "./hotkeys.js";
import { resolveGardenRunner } from "./create.js";
import { healStatusPane } from "./validate.js";
import { log } from "./log.js";
import { buildRulesContext } from "../rules.js";
import { addAlert } from "./alerts.js";

const DEBOUNCE_MS = 30_000;

// Per-project naming helpers
export function pollerWindowName(project: string): string {
  return `_${project}-poller`;
}

export function signalFifoPath(project: string): string {
  return path.join(SESSIONS_DIR, `${project}-poll-signal`);
}

function reviewWindowName(project: string, worker: string): string {
  return `_${project}-review-${worker}`;
}

function reviewResultPath(project: string, worker: string): string {
  return path.join(SESSIONS_DIR, `${project}-${worker}-review-result.txt`);
}

function reviewPromptPath(project: string, worker: string): string {
  return path.join(SESSIONS_DIR, `${project}-${worker}-review-prompt.txt`);
}

// Main poll entry point — called by `garden dashboard _poll <project>`
export function poll(projectName: string): boolean {
  healStatusPane();
  return pollProject(projectName);
}

function pollProject(projectName: string): boolean {
  const project = tryGetProject(projectName);
  if (!project) return false;

  const baseBranch = resolveBaseBranch(project.path, project);
  const workers = getWorkers(projectName);
  let changed = false;

  for (const entry of workers) {
    try {
      if (pollWorker(projectName, project.path, baseBranch, entry)) {
        changed = true;
      }
    } catch (err) {
      log.error("poller", "error polling worker", {
        worker: entry.name,
        data: { error: String(err) },
      });
    }
  }

  return changed;
}

function pollWorker(
  projectName: string,
  projectPath: string,
  baseBranch: string,
  entry: WorkerEntry,
): boolean {
  const state = entry.prState ?? "working";

  switch (state) {
    case "working":
      return handleWorking(projectName, projectPath, baseBranch, entry);
    case "pushed":
      return handlePushed(projectName, projectPath, baseBranch, entry);
    case "reviewing":
      return handleReviewing(projectName, projectPath, baseBranch, entry);
    case "merge-pending":
      return handleMergePending(projectName, projectPath, baseBranch, entry);
    case "failing":
      return handleFailing(projectName, projectPath, baseBranch, entry);
    case "merged":
      return handleMerged(projectName, baseBranch, entry);
    default:
      log.warn("poller", "unknown state, resetting to working", {
        worker: entry.name,
        data: { state },
      });
      updateWorkerFields(projectName, entry.name, { prState: "working" });
      return true;
  }
}

// --- State handlers ---

function handleWorking(
  projectName: string,
  projectPath: string,
  baseBranch: string,
  entry: WorkerEntry,
): boolean {
  // Self-heal: if prState was lost (concurrent registry write race) but this
  // worker has previously merged and has no new work, restore merged state.
  // mergeCount is set atomically with prState by finalizeMerge, so if the
  // race clobbered both, mergeCount > 0 won't be true and we skip this.
  if (!entry.prState && entry.mergeCount && entry.mergeCount > 0) {
    const wtPath = entry.worktreePath ?? projectPath;
    const commitSummary = getCommitSummary(wtPath, baseBranch);
    if (!commitSummary) {
      log.warn("poller", "restoring lost merged state", { worker: entry.name });
      updateWorkerFields(projectName, entry.name, { prState: "merged" });
      refreshDashboard();
      return true;
    }
  }

  const wtPath = entry.worktreePath ?? projectPath;
  const headSha = getBranchHeadSha(wtPath);
  if (!headSha) return false;

  // No new commits since last check
  if (headSha === entry.lastSeenSha) return false;

  // Check if there are actually commits ahead of base branch
  const commitSummary = getCommitSummary(wtPath, baseBranch);
  if (!commitSummary) return false;

  // Transition to pushed — review will launch from handlePushed
  updateWorkerFields(projectName, entry.name, {
    prState: "pushed",
    lastSeenSha: headSha,
    lastShaChangeAt: new Date().toISOString(),
  });
  refreshDashboard();
  return true;
}

function handlePushed(
  projectName: string,
  projectPath: string,
  baseBranch: string,
  entry: WorkerEntry,
): boolean {
  // Don't launch a review while Claude is actively working — it would review
  // stale code. Keep prState as "pushed" (the display layer shows "working"
  // when the process is active in a pushed state). Mutating prState to
  // "working" here creates a stuck state: when Claude stops without making
  // new commits, handleWorking gates on SHA and can never transition back.
  if (isWorkerClaudeWorking(projectName, entry.name)) {
    // Track new commits so handleReviewing won't treat pre-review commits
    // as "new work" and spuriously abort the review once it launches.
    const wtPath = entry.worktreePath ?? projectPath;
    const headSha = getBranchHeadSha(wtPath);
    if (headSha && headSha !== entry.lastSeenSha) {
      updateWorkerFields(projectName, entry.name, {
        lastSeenSha: headSha,
        lastShaChangeAt: new Date().toISOString(),
      });
      refreshDashboard();
      return true;
    }
    return false;
  }

  return launchReview(projectName, projectPath, baseBranch, entry, false);
}

function handleReviewing(
  projectName: string,
  projectPath: string,
  baseBranch: string,
  entry: WorkerEntry,
): boolean {
  // Live-Claude guard: if the worker pushed new commits, abort the review
  // so it doesn't review stale code. We check for actual SHA changes rather
  // than just isWorkerWorking, because transient child processes (e.g. from
  // navigation swaps) can produce false positives that kill valid reviews.
  if (isWorkerClaudeWorking(projectName, entry.name)) {
    const wtPath = entry.worktreePath ?? projectPath;
    const headSha = getBranchHeadSha(wtPath);
    if (headSha && headSha !== entry.lastSeenSha) {
      log.info("poller", "new commits during review, resetting to working", {
        worker: entry.name,
      });
      killReviewWindow(projectName, entry.name);
      // Do NOT update lastSeenSha here — handleWorking needs to see the
      // new SHA so it transitions back to "pushed" for a fresh review.
      updateWorkerFields(projectName, entry.name, {
        prState: "working",
        lastShaChangeAt: new Date().toISOString(),
        reviewWindowName: undefined,
      });
      refreshDashboard();
      return true;
    }
  }

  // Check if review is still running
  const revWindow = entry.reviewWindowName;
  if (revWindow && windowExists(revWindow)) {
    return false; // still in-flight
  }

  // Review window is gone — read result
  const resultFile = reviewResultPath(projectName, entry.name);
  const review = readReviewResult(projectName, entry);

  // Clean up files
  cleanReviewFiles(projectName, entry.name);

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
      reviewWindowName: undefined,
    });
    refreshDashboard();
    return true;
  }

  log.info("poller", "review complete", {
    worker: entry.name,
    data: { verdict: review.verdict },
  });

  if (review.verdict === "clean" || review.verdict === "fixed") {
    const wtPath = entry.worktreePath ?? projectPath;

    // Force-push: reviewer rebases, so local state diverges from remote
    const branchName = entry.branchName ?? entry.name;
    try {
      forcePushBranch(wtPath, branchName);
    } catch (err) {
      log.error("poller", "force-push after review failed", {
        worker: entry.name,
        data: { error: String(err) },
      });
      updateWorkerFields(projectName, entry.name, {
        prState: "working",
        reviewWindowName: undefined,
      });
      refreshDashboard();
      return true;
    }

    // Transition to merge-pending instead of merging directly
    updateWorkerFields(projectName, entry.name, {
      prState: "merge-pending",
      mergePendingAt: new Date().toISOString(),
      lastReviewBody: review.body,
      reviewWindowName: undefined,
    });
    refreshDashboard();
  } else {
    // "failed" — reviewer couldn't fix the issues
    log.error("poller", "reviewer could not fix issues", {
      worker: entry.name,
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
      reviewWindowName: undefined,
    });
    refreshDashboard();
  }
  return true;
}

function handleMergePending(
  projectName: string,
  projectPath: string,
  baseBranch: string,
  entry: WorkerEntry,
): boolean {
  // Serial merge gate: only the earliest merge-pending worker proceeds
  const projectWorkers = getWorkers(projectName);
  const olderPending = projectWorkers.some(w =>
    w.name !== entry.name &&
    w.prState === "merge-pending" &&
    (w.mergePendingAt ?? "") < (entry.mergePendingAt ?? ""),
  );
  if (olderPending) return false;

  const wtPath = entry.worktreePath ?? projectPath;

  // Fetch latest base branch
  try {
    execFileSync("git", ["fetch", "origin", baseBranch], {
      cwd: wtPath,
      stdio: "ignore",
    });
  } catch { /* best effort */ }

  // Clean tooling artifacts (Claude settings, hook dirs) left by the reviewer.
  // By this point all meaningful changes are committed — anything left is noise.
  cleanWorktree(wtPath);

  // Rebase onto current base branch
  const rebaseResult = rebaseBranch(wtPath, baseBranch);
  if (rebaseResult === "conflict") {
    abortRebase(wtPath);
    // A re-review needs Claude to be idle (it runs in the worktree).
    // If Claude is working, just wait — don't spin launching reviews
    // that will immediately bail on the working check.
    if (isWorkerClaudeWorking(projectName, entry.name)) return false;
    log.warn("poller", "rebase conflicts in merge queue, launching re-review", {
      worker: entry.name,
    });
    launchReview(projectName, projectPath, baseBranch, entry, true);
    return true;
  }
  if (rebaseResult === "error") {
    abortRebase(wtPath);
    addAlert({
      level: "error",
      source: "poller",
      project: projectName,
      worker: entry.name,
      message: `Rebase failed (not a conflict) — manual intervention needed`,
    });
    return false;
  }

  // Force-push rebased branch
  const branchName = entry.branchName ?? entry.name;
  try {
    forcePushBranch(wtPath, branchName);
  } catch (err) {
    log.error("poller", "force-push failed in merge queue", {
      worker: entry.name,
      data: { error: String(err) },
    });
    updateWorkerFields(projectName, entry.name, {
      prState: "working",
      mergePendingAt: undefined,
    });
    refreshDashboard();
    return true;
  }

  // Merge to base branch
  finalizeMerge(projectName, projectPath, baseBranch, entry);
  return true;
}

function handleFailing(
  projectName: string,
  projectPath: string,
  baseBranch: string,
  entry: WorkerEntry,
): boolean {
  const wtPath = entry.worktreePath ?? projectPath;
  const headSha = getBranchHeadSha(wtPath);
  if (!headSha) return false;

  if (headSha !== entry.lastSeenSha) {
    // New commits pushed — track the change
    const commitLog = getNewCommitSummary(wtPath, entry.failingSha ?? entry.lastSeenSha);
    if (commitLog) {
      log.info("poller", "new commits in failing worker", {
        worker: entry.name,
        data: { commits: commitLog },
      });
    }

    updateWorkerFields(projectName, entry.name, {
      lastSeenSha: headSha,
      lastShaChangeAt: new Date().toISOString(),
    });
    return false;
  }

  // If failingSha is set, new commits are required before retrying.
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
      lastSeenSha: undefined,
    });
    return true;
  }
  return false;
}

function handleMerged(
  projectName: string,
  baseBranch: string,
  entry: WorkerEntry,
): boolean {
  const wtPath = entry.worktreePath;
  if (!wtPath) return false;

  // Only transition out of merged when new commits appear, indicating a new
  // work cycle. Claude being active alone (e.g. answering questions) should
  // not clear the merged indicator — "merged" is sticky until new work starts.
  const commitSummary = getCommitSummary(wtPath, baseBranch);

  if (!commitSummary) return false;

  log.info("poller", "new commits after merge, resuming", {
    worker: entry.name,
  });
  updateWorkerFields(projectName, entry.name, {
    prState: "working",
    mergedAt: undefined,
    lastSeenSha: undefined,
  });
  refreshDashboard();
  return true;
}

// --- Review launching and result parsing ---

function launchReview(
  projectName: string,
  projectPath: string,
  baseBranch: string,
  entry: WorkerEntry,
  isReReview: boolean,
): boolean {
  // Don't launch while Claude is actively working in the worktree
  if (isWorkerClaudeWorking(projectName, entry.name)) {
    log.info("poller", "Claude working in worktree, skipping review", {
      worker: entry.name,
    });
    return false;
  }

  const wtPath = entry.worktreePath ?? projectPath;

  // Fetch latest base branch so the reviewer can rebase onto it
  try {
    execFileSync("git", ["fetch", "origin", baseBranch], {
      cwd: wtPath,
      stdio: "ignore",
    });
  } catch { /* best effort */ }

  // Build the review prompt
  const prompt = isReReview
    ? buildReReviewPrompt(projectName, projectPath, baseBranch, entry)
    : buildReviewPrompt(projectName, projectPath, baseBranch, entry);

  if (prompt === null) {
    log.warn("poller", "failed to build review prompt", { worker: entry.name });
    return false;
  }

  // Write prompt to file
  const promptFile = reviewPromptPath(projectName, entry.name);
  const resultFile = reviewResultPath(projectName, entry.name);
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.writeFileSync(promptFile, prompt);

  // Clean any stale result file
  try { fs.unlinkSync(resultFile); } catch { /* ignore */ }

  // Launch review in a hidden tmux window
  const revWindow = reviewWindowName(projectName, entry.name);
  const escapedPrompt = promptFile.replace(/'/g, "'\\''");
  const escapedResult = resultFile.replace(/'/g, "'\\''");
  const escapedFifo = signalFifoPath(projectName).replace(/'/g, "'\\''");
  const cmd = `claude -p --dangerously-skip-permissions < '${escapedPrompt}' > '${escapedResult}' 2>&1; [ -p '${escapedFifo}' ] && (echo > '${escapedFifo}') 2>/dev/null`;

  // Kill any leftover review window
  if (windowExists(revWindow)) {
    killWindowSafe(revWindow);
  }

  tmux("new-window", "-d", "-t", DASHBOARD_SESSION, "-n", revWindow,
    "-c", wtPath, "bash", "-c", cmd);

  updateWorkerFields(projectName, entry.name, {
    prState: "reviewing",
    reviewWindowName: revWindow,
    mergePendingAt: isReReview ? undefined : entry.mergePendingAt,
  });
  refreshDashboard();

  log.info("poller", isReReview ? "launched re-review" : "launched review", {
    worker: entry.name,
  });
  return true;
}

interface ReviewResult {
  verdict: "clean" | "fixed" | "failed";
  body: string;
}

function readReviewResult(
  projectName: string,
  entry: WorkerEntry,
): ReviewResult | null {
  const resultFile = reviewResultPath(projectName, entry.name);

  try {
    if (!fs.existsSync(resultFile)) {
      log.warn("poller", "review result file missing", { worker: entry.name });
      return null;
    }

    const output = fs.readFileSync(resultFile, "utf-8").trim();
    if (!output) {
      log.warn("poller", "review result file empty", { worker: entry.name });
      return null;
    }

    return parseReviewResult(output, entry.name);
  } catch (err) {
    log.warn("poller", "failed to read review result", {
      worker: entry.name,
      data: { error: String(err) },
    });
    return null;
  }
}

function parseReviewResult(output: string, workerName: string): ReviewResult | null {
  const lines = output.split("\n");
  const lastLine = lines[lines.length - 1].trim().toUpperCase();
  const body = lines.slice(0, -1).join("\n").trim() || "No additional comments.";

  if (lastLine === "CLEAN") return { verdict: "clean", body };
  if (lastLine === "FIXED") return { verdict: "fixed", body };
  if (lastLine === "FAILED") return { verdict: "failed", body };

  log.warn("poller", "could not parse review verdict", {
    worker: workerName,
    data: { lastLine },
  });
  return null;
}

function buildReviewPrompt(
  projectName: string,
  projectPath: string,
  baseBranch: string,
  entry: WorkerEntry,
): string | null {
  const wtPath = entry.worktreePath ?? projectPath;

  let diff: string;
  try {
    diff = getDiffAgainstBase(wtPath, baseBranch);
  } catch {
    log.warn("poller", "failed to get diff for review", { worker: entry.name });
    return null;
  }

  const commitSummary = getCommitSummary(wtPath, baseBranch);
  const branchName = entry.branchName ?? entry.name;
  const rules = buildRulesContext(projectName, projectPath);
  const project = tryGetProject(projectName);
  const checksCommand = project?.checks;
  const changedFiles = getChangedFiles(wtPath, baseBranch);

  const docSections = readDocSections(wtPath);
  const testSections = readTestSections(wtPath, changedFiles);
  const specFiles = findSpecFiles(wtPath, changedFiles);
  const specWarning = buildSpecWarning(specFiles);

  let stepNum = 1;
  const rebaseStep = stepNum++;
  const checksStep = checksCommand ? stepNum++ : null;
  const reviewStep = stepNum;

  const prompt = [
    "You are reviewing a branch before merge. Complete these steps in order:",
    "",
    ...specWarning,
    `## Step ${rebaseStep}: Rebase onto ${baseBranch}`,
    "",
    `Run \`git rebase ${baseBranch}\` in the worktree. If there are conflicts:`,
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
    "  doc change — only flag docs that are actually inaccurate after this diff. This",
    "  bullet applies *only* to descriptive documents (DESIGN.md, CLAUDE.md) — not to",
    "  specification files (those marked as a source of truth, see the warning above if",
    "  any are in this diff). Specs drive the code; do not edit them to match code.",
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
    ...(entry.task ? [`### Worker task\n\n${entry.task}`, ""] : []),
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

  return prompt;
}

function buildReReviewPrompt(
  projectName: string,
  projectPath: string,
  baseBranch: string,
  entry: WorkerEntry,
): string | null {
  const wtPath = entry.worktreePath ?? projectPath;

  let diff: string;
  try {
    diff = getDiffAgainstBase(wtPath, baseBranch);
  } catch {
    log.warn("poller", "failed to get diff for re-review", { worker: entry.name });
    return null;
  }

  const commitSummary = getCommitSummary(wtPath, baseBranch);
  const branchName = entry.branchName ?? entry.name;
  const rules = buildRulesContext(projectName, projectPath);
  const project = tryGetProject(projectName);
  const checksCommand = project?.checks;
  const changedFiles = getChangedFiles(wtPath, baseBranch);

  const docSections = readDocSections(wtPath);
  const testSections = readTestSections(wtPath, changedFiles);
  const specFiles = findSpecFiles(wtPath, changedFiles);
  const specWarning = buildSpecWarning(specFiles);

  let stepNum = 1;
  const rebaseStep = stepNum++;
  const checksStep = checksCommand ? stepNum++ : null;
  const reviewStep = stepNum;

  const prompt = [
    "You are re-reviewing a branch that was previously reviewed and approved.",
    `It is being re-reviewed because ${baseBranch} advanced and a rebase is needed before merge.`,
    "",
    ...specWarning,
    "## Context",
    "",
    ...(entry.task ? [`**Worker task:** ${entry.task}`, ""] : []),
    ...(entry.lastReviewBody ? [
      "**Previous review (approved):**",
      "",
      entry.lastReviewBody,
      "",
    ] : []),
    `Focus on rebasing onto ${baseBranch}, resolving any conflicts while preserving the`,
    "intent of both sides, and verifying the merged result still works.",
    "",
    `## Step ${rebaseStep}: Rebase onto ${baseBranch}`,
    "",
    `Run \`git rebase ${baseBranch}\` in the worktree. If there are conflicts:`,
    "- Resolve them sensibly (preserve the intent of both sides)",
    "- Read the commit messages carefully — they describe the intent of each change",
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
    `## Step ${reviewStep}: Verify correctness after rebase`,
    "",
    "This branch was already reviewed. Focus on:",
    "- Whether conflict resolution preserved the intent of both sides",
    `- Whether the rebased code still works correctly with the new ${baseBranch}`,
    "- Whether tests still pass after rebase",
    "",
    "If you find issues, fix them directly in the worktree. Commit fixes with a",
    'message prefixed with "review: ".',
    "",
    `## Branch: ${branchName}`,
    "",
    ...(entry.task ? [`### Worker task\n\n${entry.task}`, ""] : []),
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
    ...docSections,
    ...(testSections.length > 0 ? [
      "",
      "## Test Files (corresponding to changed source files)",
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

  return prompt;
}

// --- Merge ---

function finalizeMerge(
  projectName: string,
  projectPath: string,
  baseBranch: string,
  entry: WorkerEntry,
): void {
  const branchName = entry.branchName ?? entry.name;

  try {
    mergeToBase(projectPath, branchName, baseBranch);
  } catch (err) {
    log.error("poller", "merge failed", {
      worker: entry.name,
      data: { error: String(err) },
    });
    addAlert({
      level: "error",
      source: "poller",
      project: projectName,
      worker: entry.name,
      message: `Merge failed for worker ${entry.name}: ${String(err).slice(0, 200)}`,
    });
    updateWorkerFields(projectName, entry.name, {
      prState: "working",
      mergePendingAt: undefined,
    });
    refreshDashboard();
    return;
  }

  log.info("poller", "merged to base branch", { worker: entry.name, data: { baseBranch } });
  deleteRemoteBranch(projectPath, branchName);
  removeClaudeActiveMarker(projectName, entry.name);

  notifySiblingWorkers(projectName, baseBranch, entry);

  runPostMerge(projectName, projectPath);

  const mergedFields = {
    prState: "merged" as const,
    mergeCount: (entry.mergeCount ?? 0) + 1,
    mergedAt: new Date().toISOString(),
    failCount: 0,
    mergePendingAt: undefined,
    reviewWindowName: undefined,
    lastReviewBody: undefined,
  };
  updateWorkerFields(projectName, entry.name, mergedFields);

  // Verify: concurrent status/header writers can race with this write
  // (they read-modify-write the whole registry to cache claudeStatus).
  // If our prState was clobbered, re-write it. The double-check makes
  // the race window astronomically small.
  const written = findWorkerByName(projectName, entry.name);
  if (written && written.prState !== "merged") {
    log.warn("poller", "merged state clobbered by concurrent write, retrying", {
      worker: entry.name,
      data: { found: written.prState ?? "undefined" },
    });
    updateWorkerFields(projectName, entry.name, mergedFields);
  }

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
      log.info("poller", "garden rebuilt", { data: { commit } });
    } else {
      log.info("poller", "postMerge completed", { data: { commit } });
    }
    // After rebuilding garden itself, refresh tmux keybindings and status bar
    // so the running dashboard picks up any changes from the new CLI binary.
    if (projectName === "garden") {
      try {
        const gr = resolveGardenRunner();
        setupKeybindings(gr);
        setupStatusBar(gr);
      } catch { /* dashboard may not be running */ }
    }
  } catch (err) {
    const message = projectName === "garden"
      ? `Garden rebuild failed at commit ${commit}: ${String(err).slice(0, 200)}`
      : `postMerge failed at commit ${commit}: ${String(err).slice(0, 200)}`;
    log.error("poller", "postMerge failed", {
      data: { commit, error: String(err) },
    });
    addAlert({
      level: "error",
      source: "poller",
      project: projectName,
      message,
    });
  }
}

// --- Sibling notification ---

function notifySiblingWorkers(
  projectName: string,
  baseBranch: string,
  mergedEntry: WorkerEntry,
): void {
  if (!mergedEntry.worktreePath) return;

  const mergedFiles = getChangedFiles(mergedEntry.worktreePath, baseBranch);
  if (mergedFiles.length === 0) return;

  const commitSummary = getCommitSummary(mergedEntry.worktreePath, baseBranch);
  const siblings = getWorkers(projectName).filter(
    w => w.name !== mergedEntry.name &&
      (w.prState === "working" || w.prState === "pushed" || w.prState === "failing"),
  );

  const mergedSet = new Set(mergedFiles);

  for (const sibling of siblings) {
    if (!sibling.worktreePath) continue;
    const siblingFiles = getChangedFiles(sibling.worktreePath, baseBranch);
    const overlap = siblingFiles.filter(f => mergedSet.has(f));
    if (overlap.length === 0) continue;

    const title = commitSummary?.split("\n")[0] ?? `worker ${mergedEntry.name}`;
    const fileList = overlap.join(", ");
    const message = [
      `[garden] Worker \`${mergedEntry.name}\` just merged into ${baseBranch}: ${title}`,
      `It changed files that overlap with your branch: ${fileList}`,
      `Rebase onto ${baseBranch}, review how these changes interact with your work, and make sure you are not reverting their fix. Push when ready.`,
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
        data: { mergedWorker: mergedEntry.name, overlapFiles: overlap },
      });
    } else {
      log.info("poller", "skipping dead sibling", {
        worker: sibling.name,
        data: { mergedWorker: mergedEntry.name },
      });
    }
  }
}

// --- Helpers ---

function isWorkerClaudeWorking(projectName: string, workerName: string): boolean {
  const paneId = resolveWorkerPaneId(projectName, workerName);
  if (!paneId) return false;
  return isWorkerWorking(paneId, projectName, workerName);
}

function resolveWorkerPaneId(projectName: string, workerName: string): string | null {
  const workerWindow = `_${projectName}-worker-${workerName}`;
  if (windowExists(workerWindow)) {
    return getFirstPaneId(`${DASHBOARD_SESSION}:${workerWindow}`);
  }
  // Worker may be visible in the right pane (hidden window killed after swap)
  const state = readDashState();
  if (state.activeWindowName === workerWindow && state.activePaneId) {
    return state.activePaneId;
  }
  return null;
}

function killReviewWindow(projectName: string, workerName: string): void {
  const revWindow = reviewWindowName(projectName, workerName);
  if (windowExists(revWindow)) {
    killWindowSafe(revWindow);
  }
  cleanReviewFiles(projectName, workerName);
}

function cleanReviewFiles(projectName: string, workerName: string): void {
  try { fs.unlinkSync(reviewResultPath(projectName, workerName)); } catch { /* ignore */ }
  try { fs.unlinkSync(reviewPromptPath(projectName, workerName)); } catch { /* ignore */ }
}

function readDocSections(wtPath: string): string[] {
  const sections: string[] = [];
  for (const docFile of ["DESIGN.md", "CLAUDE.md"]) {
    const fullPath = path.join(wtPath, docFile);
    try {
      const content = fs.readFileSync(fullPath, "utf-8");
      sections.push(`### ${docFile}\n\n${content}`);
    } catch { /* file may not exist */ }
  }
  return sections;
}

// A specification file is a markdown file that opens with the source-of-truth
// marker phrase. The reviewer must treat these differently from descriptive
// docs (DESIGN.md, CLAUDE.md): the spec drives the code, not the other way
// around. Past regressions have all involved the reviewer "fixing" a spec
// file to match the current implementation, inverting the spec relationship.
const SPEC_MARKER = "the code is wrong";

function findSpecFiles(wtPath: string, changedFiles: string[]): string[] {
  const specs: string[] = [];
  for (const file of changedFiles) {
    if (!file.endsWith(".md")) continue;
    try {
      const content = fs.readFileSync(path.join(wtPath, file), "utf-8");
      if (content.slice(0, 2000).includes(SPEC_MARKER)) {
        specs.push(file);
      }
    } catch { /* file may have been renamed or deleted in the diff */ }
  }
  return specs;
}

function buildSpecWarning(specFiles: string[]): string[] {
  if (specFiles.length === 0) return [];
  return [
    "## WARNING: Specification files in this diff",
    "",
    "This diff modifies one or more **specification** files — documents that",
    "are the *source of truth* for their respective systems:",
    "",
    ...specFiles.map(f => `- \`${f}\``),
    "",
    "When reviewing changes to a specification:",
    "",
    "- **Do not revert spec changes to match the current implementation.**",
    "  The spec drives the code, not the other way around. The spec opens",
    "  with the statement that if the code disagrees, the code is wrong —",
    "  that is the contract, and your job is to honor it.",
    "- **Do flag implementation code in this diff that contradicts the spec.**",
    "  Code-vs-spec mismatches must be fixed by changing the code, never the",
    "  spec.",
    "- **If the spec contradicts code OUTSIDE this diff,** that is a known",
    "  gap the user is intentionally documenting. Do not \"fix\" the spec to",
    "  match the legacy code. The user is using the spec to guide future work.",
    "- **Treat spec changes the way you would treat user instructions.**",
    "  Verify clarity, internal consistency, and grammar. Never rewrite design",
    "  intent. Never \"correct\" the spec by editing prose to describe what",
    "  the code currently does.",
    "",
    "If you genuinely believe a spec change is wrong (e.g., logically",
    "self-contradictory, or impossible to implement), flag it in your review",
    "output rather than silently editing it. Editing a spec to match code is",
    "the exact mistake this section exists to prevent.",
    "",
  ];
}

function readTestSections(wtPath: string, changedFiles: string[]): string[] {
  const sections: string[] = [];
  for (const file of changedFiles) {
    const basename = path.basename(file, path.extname(file));
    const testFile = path.join(wtPath, "test", `${basename}.test.ts`);
    try {
      const content = fs.readFileSync(testFile, "utf-8");
      sections.push(`### test/${basename}.test.ts\n\n${content}`);
    } catch { /* no corresponding test file */ }
  }
  return sections;
}

// --- Per-project poller lifecycle ---

export function postPush(projectName?: string): void {
  if (projectName) {
    triggerProjectPoll(projectName);
  } else {
    triggerAllPollers();
  }
}

export function triggerProjectPoll(projectName: string): void {
  const fifo = signalFifoPath(projectName);
  try {
    const fd = fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
    fs.writeSync(fd, "\n");
    fs.closeSync(fd);
    log.info("poller", "triggered poll", { data: { project: projectName } });
  } catch {
    // FIFO not ready or poller not running
  }
}

function triggerAllPollers(): void {
  const config = loadConfig();
  for (const projectName of Object.keys(config.projects)) {
    triggerProjectPoll(projectName);
  }
}

export function startProjectPoller(projectName: string, gardenRunner: string): void {
  const window = pollerWindowName(projectName);
  if (windowExists(window)) return;

  const fifo = signalFifoPath(projectName);
  ensureSignalFifo(fifo);
  const escapedFifo = fifo.replace(/'/g, "'\\''");
  const escapedProject = projectName.replace(/'/g, "'\\''");
  const cmd = [
    `while true; do`,
    `  ${gardenRunner} dashboard _poll '${escapedProject}' 2>/dev/null;`,
    `  if [ $? -eq 0 ]; then read -t 10 <>'${escapedFifo}' 2>/dev/null || true; fi;`,
    `done`,
  ].join(" ");
  tmux("new-window", "-d", "-t", DASHBOARD_SESSION, "-n", window,
    "bash", "-c", cmd);

  log.info("poller", "started", { data: { project: projectName } });
}

export function stopProjectPoller(projectName: string): void {
  const window = pollerWindowName(projectName);
  killWindowSafe(window);
  const fifo = signalFifoPath(projectName);
  try { fs.unlinkSync(fifo); } catch { /* ignore */ }
  log.info("poller", "stopped", { data: { project: projectName } });
}

export function stopAllPollers(): void {
  const config = loadConfig();
  for (const projectName of Object.keys(config.projects)) {
    stopProjectPoller(projectName);
  }
}

export function ensureProjectPoller(projectName: string, gardenRunner: string): void {
  if (projectPollerRunning(projectName)) return;
  startProjectPoller(projectName, gardenRunner);
}

export function projectPollerRunning(projectName: string): boolean {
  return windowExists(pollerWindowName(projectName));
}

// Exported for review window cleanup in workers.ts and validate.ts
export { killReviewWindow, reviewWindowName };

function ensureSignalFifo(fifoPath: string): void {
  try {
    const stat = fs.statSync(fifoPath);
    if (stat.isFIFO()) return;
    fs.unlinkSync(fifoPath);
  } catch { /* doesn't exist */ }
  fs.mkdirSync(path.dirname(fifoPath), { recursive: true });
  execFileSync("mkfifo", [fifoPath]);
}

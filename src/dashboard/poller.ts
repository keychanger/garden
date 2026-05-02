// Poller: watches worker branches and drives the review/merge lifecycle.
// Each project gets its own poller running in a hidden tmux window.
// Reviews run asynchronously in separate tmux windows. Merges are serialized.
import { execSync, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DASHBOARD_SESSION } from "../session.js";
import {
  tryGetProject, loadConfig, SESSIONS_DIR,
  getAutoContinueConfig, setAutoContinueConfig,
} from "../config.js";
import { readUsageSnapshot } from "./usage.js";
import {
  tmux, getFirstPaneId,
  windowExists, killWindowSafe,
} from "./tmux.js";
import {
  readRegistry, getWorkers, updateWorkerFields, findWorkerByName,
  type WorkerEntry, type PrState,
} from "./registry.js";
import {
  getBranchHeadSha, getRemoteTrackingSha,
  rebaseBranch, abortRebase, cleanWorktree,
  forcePushBranch, mergeToBase, fastForwardBase, deleteRemoteBranch,
  getChangedFiles, getChangedFilesBetween, getCommitSummary, getNewCommitSummary,
  getWorkerBaseBranch, syncWorktreeToRemote,
  ensureNoRebaseInProgress, hasRebaseInProgress, isAncestor, getUnmergedFiles,
} from "./git.js";
import { refreshDashboard, setupStatusBar } from "./header.js";
import { readDashState } from "./state.js";
import { setupKeybindings } from "./hotkeys.js";
import { resolveGardenRunner } from "./create.js";
import { healStatusPane } from "./validate.js";
import { log } from "./log.js";
import { addAlert } from "./alerts.js";
import { recordFindings } from "./findings.js";
import { pollerWindowName, reviewWindowName, workerWindowName } from "./window-names.js";
import { buildReviewPrompt, buildResolvePrompt } from "./prompts.js";
import { claudeEnvPrefix } from "./claude-env.js";
import { stopUsagePoller, startUsagePoller } from "./usage-poller.js";
import { dispatchDelayedAutoContinue, isDoneSet } from "./continue.js";

const AUTO_CONTINUE_DEBOUNCE_MS = 10_000;

const RESOLVE_BUDGET = 2;

const DEBOUNCE_MS = 30_000;

// Wall-clock ceiling on a single reviewer or resolver run. If the tmux window
// is still alive past this, the poller kills it and escalates to `failing`.
// Catches hung subprocesses the reviewer can't escape from (e.g. a `npm test`
// that blocks forever because tests have no timeout and the sandbox silently
// denies their network calls).
const REVIEW_TIMEOUT_MS = 30 * 60 * 1000;

// Valid state transitions per STATUS.md. transitionState warns (but does not
// block) if a transition is not in this table, surfacing bugs in the log
// without breaking production.
const VALID_TRANSITIONS: Record<PrState, PrState[]> = {
  working:         ["reviewing"],
  reviewing:       ["merge-pending", "working", "failing"],
  "merge-pending": ["merged", "done", "resolving", "working"],
  resolving:       ["merge-pending", "working", "failing"],
  failing:         ["working"],
  merged:          ["working", "done"],
  done:            ["working"],
};

function transitionState(
  projectName: string,
  workerName: string,
  toState: PrState,
  extraFields?: Partial<Omit<WorkerEntry, "name" | "prState">>,
): void {
  const entry = findWorkerByName(projectName, workerName);
  const fromState: PrState = entry?.prState ?? "working";
  if (!VALID_TRANSITIONS[fromState]?.includes(toState)) {
    log.warn("poller", `invalid state transition: ${fromState} -> ${toState}`, { worker: workerName });
  }
  updateWorkerFields(projectName, workerName, { ...extraFields, prState: toState });
}

export function signalFifoPath(project: string): string {
  return path.join(SESSIONS_DIR, `${project}-poll-signal`);
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

  const workers = getWorkers(projectName);
  let changed = false;

  // Debug: fires on every FIFO poke, most of which produce no transition.
  // Real state changes log at info via updateWorkerFields (registry.ts).
  log.debug("poller", "poll cycle", {
    data: { project: projectName, workers: workers.map(w => w.name) },
  });

  for (const entry of workers) {
    // baseBranch is pinned per-worker at creation (entry.baseBranch); legacy
    // workers without the field fall back to the current main-checkout branch.
    const baseBranch = getWorkerBaseBranch(entry, project.path);
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
  // pollWorker is called when the FIFO is poked. It dispatches on prState
  // and runs one unit of work. Per STATUS.md invariant 6, every transition
  // is event-triggered — pollWorker never schedules a re-check.
  const state = entry.prState ?? "working";

  switch (state) {
    case "working":
      return handleWorking(projectName, projectPath, baseBranch, entry);
    case "reviewing":
      return handleReviewing(projectName, projectPath, baseBranch, entry);
    case "merge-pending":
      return handleMergePending(projectName, projectPath, baseBranch, entry);
    case "resolving":
      return handleResolving(projectName, projectPath, baseBranch, entry);
    case "failing":
      return handleFailing(projectName, projectPath, baseBranch, entry);
    case "merged":
      return handleMerged(projectName, baseBranch, entry);
    case "done":
      return handleDone(projectName, baseBranch, entry);
    default: {
      const _exhaustive: never = state;
      log.warn("poller", `unknown prState: ${_exhaustive}`, { worker: entry.name });
      return false;
    }
  }
}

// --- State handlers ---

// `working` worker: the Stop-hook FIFO poke gets us here. The Stop hook
// sets pendingReviewAt only when it observed commits ahead of base, so this
// handler only launches a review for workers whose Stop hook *just* fired
// with new commits. Idle workers with stale commits do not get reviewed —
// per STATUS.md invariant 2, you cannot enter the review cycle from idle.
function handleWorking(
  projectName: string,
  projectPath: string,
  baseBranch: string,
  entry: WorkerEntry,
): boolean {
  if (!entry.pendingReviewAt) return false;

  // Already reviewing? (defensive — handleReviewing should be the dispatch)
  if (entry.reviewWindowName && windowExists(entry.reviewWindowName)) return false;

  // Don't launch a review while Claude is mid-response. The Stop hook is
  // what sets pendingReviewAt, so claudeStatus should already be "idle" by
  // the time we get here — this guard catches the race where a fresh
  // UserPromptSubmit landed between the Stop and the poller wake.
  if (entry.claudeStatus === "working") return false;

  const wtPath = entry.worktreePath ?? projectPath;
  const commitSummary = getCommitSummary(wtPath, baseBranch);
  if (!commitSummary) {
    // Stop hook said commits existed; they no longer do (force-pushed away,
    // base advanced past us, etc.). Clear the flag — nothing to review.
    updateWorkerFields(projectName, entry.name, { pendingReviewAt: undefined });
    return false;
  }

  return launchReview(projectName, projectPath, baseBranch, entry);
}

function handleReviewing(
  projectName: string,
  projectPath: string,
  baseBranch: string,
  entry: WorkerEntry,
): boolean {
  if (isReviewTimedOut(entry)) {
    return handleReviewTimeout(projectName, projectPath, entry, "review");
  }

  // If the reviewer window is alive, the reviewer is still working — any SHA
  // change we might observe is the reviewer's own push, not a worker push.
  // Check window existence FIRST so we do not falsely reset to working because
  // the reviewer pushed mid-session (see the stuck-loop bug fixed in 2026-04).
  const revWindow = entry.reviewWindowName;
  if (revWindow && windowExists(revWindow)) {
    return false; // still in-flight
  }

  // Reviewer has exited. A SHA change against the baseline captured at launch
  // now unambiguously means the worker pushed during review — the reviewer is
  // gone. Abort and let the normal working-state path pick up the new commits.
  const wtPath = entry.worktreePath ?? projectPath;
  const branchName = entry.branchName ?? entry.name;
  const remoteSha = getRemoteTrackingSha(wtPath, branchName);
  if (remoteSha && entry.lastSeenSha && remoteSha !== entry.lastSeenSha) {
    resetToWorkingOnWorkerPush(projectName, wtPath, baseBranch, entry, "review");
    return true;
  }

  // Review window is gone — read result
  const resultFile = reviewResultPath(projectName, entry.name);
  const review = readReviewResult(projectName, entry);

  // Clean up files
  cleanReviewFiles(projectName, entry.name);

  if (review === null) {
    const wtPath = entry.worktreePath ?? projectPath;
    const headSha = getBranchHeadSha(wtPath);
    const headAdvanced = headSha !== null && entry.preReviewSha !== undefined &&
      headSha !== entry.preReviewSha;
    const alreadyRetried = entry.unparseableReviewAt !== undefined;

    // Non-destructive recovery: if the reviewer's output didn't emit a
    // recognizable verdict but the reviewer did commit something (rebase or
    // fixes), push those commits and re-queue one more review. The second
    // reviewer sees a clean state and typically emits CLEAN. Capped at one
    // retry so a reviewer that repeatedly fails to verbalize doesn't loop.
    if (headAdvanced && !alreadyRetried) {
      const branchName = entry.branchName ?? entry.name;
      try {
        forcePushBranch(wtPath, branchName);
      } catch (err) {
        log.error("poller", "force-push on unparseable-verdict retry failed", {
          worker: entry.name,
          data: { error: String(err) },
        });
        transitionState(projectName, entry.name, "failing", {
          failCount: (entry.failCount ?? 0) + 1,
          failingSha: undefined,
          lastSeenSha: headSha ?? undefined,
          lastShaChangeAt: new Date().toISOString(),
          reviewWindowName: undefined,
          reviewStartedAt: undefined,
        });
        refreshDashboard();
        return true;
      }
      log.info("poller", "unparseable verdict with reviewer commits; re-queueing review", {
        worker: entry.name,
      });
      transitionState(projectName, entry.name, "working", {
        pendingReviewAt: Date.now(),
        unparseableReviewAt: Date.now(),
        lastSeenSha: headSha ?? undefined,
        lastShaChangeAt: new Date().toISOString(),
        reviewWindowName: undefined,
        reviewStartedAt: undefined,
        preReviewSha: undefined,
      });
      refreshDashboard();
      scheduleDelayedPoke(projectName, 0);
      return true;
    }

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
    transitionState(projectName, entry.name, "failing", {
      failCount: (entry.failCount ?? 0) + 1,
      failingSha: undefined,
      lastSeenSha: headSha ?? undefined,
      lastShaChangeAt: new Date().toISOString(),
      reviewWindowName: undefined,
      reviewStartedAt: undefined,
    });
    refreshDashboard();
    return true;
  }

  log.info("poller", "review complete", {
    worker: entry.name,
    data: { verdict: review.verdict },
  });

  if (review.verdict === "fixed" || review.verdict === "failed") {
    try {
      recordFindings({
        project: projectName,
        worker: entry.name,
        verdict: review.verdict,
        body: review.body,
      });
    } catch (err) {
      log.warn("poller", "failed to record review findings", {
        worker: entry.name,
        data: { error: String(err) },
      });
    }
  }

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
      transitionState(projectName, entry.name, "working", {
        reviewWindowName: undefined,
        reviewStartedAt: undefined,
      });
      refreshDashboard();
      return true;
    }

    // Transition to merge-pending instead of merging directly. preReviewSha
    // intentionally survives this transition: finalizeMerge needs it to diff
    // the worker's pre-review HEAD against the merged tip and tell the worker
    // which files the reviewer touched. finalizeMerge clears it.
    transitionState(projectName, entry.name, "merge-pending", {
      mergePendingAt: new Date().toISOString(),
      lastReviewBody: review.body,
      reviewWindowName: undefined,
      reviewStartedAt: undefined,
      unparseableReviewAt: undefined,
    });
    refreshDashboard();
    // The poller is event-driven and will block on the FIFO after this tick.
    // Poke it so the next tick processes handleMergePending.
    scheduleDelayedPoke(projectName, 0);
  } else {
    // "failed" — reviewer couldn't fix the issues. addAlert also logs.
    addAlert({
      level: "error",
      source: "review",
      project: projectName,
      worker: entry.name,
      message: `Reviewer could not fix issues for worker ${entry.name}: ${review.body.slice(0, 300)}`,
    });

    const wtPath = entry.worktreePath ?? projectPath;
    const headSha = getBranchHeadSha(wtPath);
    transitionState(projectName, entry.name, "failing", {
      failCount: (entry.failCount ?? 0) + 1,
      failingSha: headSha ?? undefined,
      lastSeenSha: headSha ?? undefined,
      lastShaChangeAt: new Date().toISOString(),
      reviewWindowName: undefined,
      reviewStartedAt: undefined,
      preReviewSha: undefined,
      unparseableReviewAt: undefined,
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
  } catch (err) {
    log.debug("poller", "fetch before merge failed", { worker: entry.name, data: { error: String(err) } });
  }

  // Clear any leftover rebase state (e.g., from a prior resolver that crashed).
  // Without this, the next `git rebase` can surface confusing errors that the
  // poller would misinterpret.
  ensureNoRebaseInProgress(wtPath);

  // Clean tooling artifacts (Claude settings, hook dirs) left by the reviewer.
  // By this point all meaningful changes are committed — anything left is noise.
  cleanWorktree(wtPath);

  // Rebase onto current base branch
  const rebaseResult = rebaseBranch(wtPath, baseBranch);
  if (rebaseResult.kind === "conflict") {
    abortRebase(wtPath);
    return launchResolver(projectName, projectPath, baseBranch, entry);
  }
  if (rebaseResult.kind === "error") {
    abortRebase(wtPath);
    const detail = rebaseResult.error.slice(0, 300);
    addAlert({
      level: "error",
      source: "poller",
      project: projectName,
      worker: entry.name,
      message: `Rebase failed (not a conflict) — manual intervention needed: ${detail}`,
    });
    const headSha = getBranchHeadSha(wtPath);
    transitionState(projectName, entry.name, "failing", {
      failCount: (entry.failCount ?? 0) + 1,
      failingSha: headSha ?? undefined,
      lastSeenSha: headSha ?? undefined,
      lastShaChangeAt: new Date().toISOString(),
      mergePendingAt: undefined,
    });
    refreshDashboard();
    return true;
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
    transitionState(projectName, entry.name, "working", {
      mergePendingAt: undefined,
    });
    refreshDashboard();
    return true;
  }

  // Merge to base branch
  finalizeMerge(projectName, projectPath, baseBranch, entry);
  return true;
}

// Launch a resolver to fix a merge-queue rebase conflict. Budget is 2 attempts
// per merge; if exhausted, escalate to `failing` with an operator alert. If
// the worker's Claude is currently working we cannot share the worktree, so
// defer — the next event will re-poll.
function launchResolver(
  projectName: string,
  projectPath: string,
  baseBranch: string,
  entry: WorkerEntry,
): boolean {
  const wtPath = entry.worktreePath ?? projectPath;
  const attempts = entry.resolveAttempts ?? 0;

  if (attempts >= RESOLVE_BUDGET) {
    escalateResolveBudget(projectName, wtPath, entry);
    return true;
  }

  if (isWorkerClaudeWorking(projectName, entry.name)) return false;

  const prompt = buildResolvePrompt(projectName, projectPath, baseBranch, entry);
  if (prompt === null) {
    log.warn("poller", "failed to build resolve prompt", { worker: entry.name });
    return false;
  }

  const promptFile = reviewPromptPath(projectName, entry.name);
  const resultFile = reviewResultPath(projectName, entry.name);
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.writeFileSync(promptFile, prompt);
  try { fs.unlinkSync(resultFile); } catch { /* ignore */ }

  const revWindow = reviewWindowName(projectName, entry.name);
  const escapedPrompt = promptFile.replace(/'/g, "'\\''");
  const escapedResult = resultFile.replace(/'/g, "'\\''");
  const escapedFifo = signalFifoPath(projectName).replace(/'/g, "'\\''");
  const envPrefix = claudeEnvPrefix(tryGetProject(projectName) ?? {});
  const cmd = `GARDEN_REVIEWER=1 ${envPrefix}claude -p < '${escapedPrompt}' > '${escapedResult}' 2>&1; [ -p '${escapedFifo}' ] && (echo > '${escapedFifo}') 2>/dev/null`;

  if (windowExists(revWindow)) {
    killWindowSafe(revWindow);
  }

  tmux("new-window", "-d", "-t", DASHBOARD_SESSION, "-n", revWindow,
    "-c", wtPath, "bash", "-c", cmd);
  scheduleReviewTimeoutPoke(projectName);

  const preResolveSha = getBranchHeadSha(wtPath);
  const launchSha = getRemoteTrackingSha(wtPath, entry.branchName ?? entry.name)
    ?? preResolveSha ?? entry.lastSeenSha;

  transitionState(projectName, entry.name, "resolving", {
    reviewWindowName: revWindow,
    reviewStartedAt: Date.now(),
    preResolveSha: preResolveSha ?? undefined,
    resolveAttempts: attempts + 1,
    lastSeenSha: launchSha,
    lastShaChangeAt: new Date().toISOString(),
    mergePendingAt: undefined,
  });
  refreshDashboard();

  log.info("poller", "launched resolver", {
    worker: entry.name,
    data: { attempt: attempts + 1, budget: RESOLVE_BUDGET },
  });
  return true;
}

function escalateResolveBudget(
  projectName: string,
  wtPath: string,
  entry: WorkerEntry,
): void {
  const conflictFiles = getUnmergedFiles(wtPath);
  const fileList = conflictFiles.length > 0
    ? conflictFiles.join(", ")
    : "(no unmerged paths reported; rebase was aborted between runs)";
  const bodyTail = entry.lastResolveBody
    ? `\n\nLast resolver output:\n${entry.lastResolveBody.slice(0, 500)}`
    : "";
  log.error("poller", "resolver budget exhausted", {
    worker: entry.name,
    data: { budget: RESOLVE_BUDGET, conflictFiles },
  });
  addAlert({
    level: "error",
    source: "poller",
    project: projectName,
    worker: entry.name,
    message: `Worker ${entry.name}: resolver could not fix the merge-queue rebase conflict after ${RESOLVE_BUDGET} attempts. Conflict files: ${fileList}. A new worker push will reset the retry budget.${bodyTail}`,
  });
  const headSha = getBranchHeadSha(wtPath);
  transitionState(projectName, entry.name, "failing", {
    failCount: (entry.failCount ?? 0) + 1,
    failingSha: headSha ?? undefined,
    lastSeenSha: headSha ?? undefined,
    lastShaChangeAt: new Date().toISOString(),
    reviewWindowName: undefined,
    reviewStartedAt: undefined,
    mergePendingAt: undefined,
  });
  refreshDashboard();
}

// Resolver handler: waits for the resolver window to exit, then verifies the
// rebase actually landed (STATUS.md invariant 7). On pass → force-push and
// merge-pending. On fail → count the attempt, retry or escalate per budget.
function handleResolving(
  projectName: string,
  projectPath: string,
  baseBranch: string,
  entry: WorkerEntry,
): boolean {
  if (isReviewTimedOut(entry)) {
    return handleReviewTimeout(projectName, projectPath, entry, "resolve");
  }

  const revWindow = entry.reviewWindowName;
  if (revWindow && windowExists(revWindow)) {
    return false; // still in-flight
  }

  const wtPath = entry.worktreePath ?? projectPath;
  const branchName = entry.branchName ?? entry.name;

  // Worker-authored push during resolution: abort, reset budget, let the
  // normal working→reviewing flow re-enter from the new SHA.
  const remoteSha = getRemoteTrackingSha(wtPath, branchName);
  if (remoteSha && entry.lastSeenSha && remoteSha !== entry.lastSeenSha) {
    resetToWorkingOnWorkerPush(projectName, wtPath, baseBranch, entry, "resolve");
    return true;
  }

  const resolveResult = readResolveResult(projectName, entry);
  cleanReviewFiles(projectName, entry.name);

  if (resolveResult) {
    updateWorkerFields(projectName, entry.name, {
      lastResolveBody: resolveResult.body,
    });
  }

  const verdictFailed = resolveResult === null || resolveResult.verdict === "failed";

  // Programmatic verification — STATUS.md invariant 7. The verdict text is
  // advisory; the worktree state is the ground truth.
  const rebaseStuck = hasRebaseInProgress(wtPath);
  const headSha = getBranchHeadSha(wtPath);
  const rebased = headSha !== null &&
    isAncestor(wtPath, `origin/${baseBranch}`, headSha);
  const madeProgress = headSha !== null && entry.preResolveSha !== undefined &&
    headSha !== entry.preResolveSha;

  const verificationPassed = !verdictFailed && !rebaseStuck && rebased && madeProgress;

  if (!verificationPassed) {
    log.warn("poller", "resolver verification failed", {
      worker: entry.name,
      data: {
        verdict: resolveResult?.verdict ?? "missing",
        rebaseStuck,
        rebased,
        madeProgress,
      },
    });
    // Abort any lingering rebase so the next attempt starts clean.
    if (rebaseStuck) abortRebase(wtPath);

    // Try again if budget allows. Budget is checked inside launchResolver —
    // it escalates itself when exhausted. But we need to re-enter from
    // merge-pending so the rebase attempt is fresh.
    const attempts = entry.resolveAttempts ?? 0;
    if (attempts >= RESOLVE_BUDGET) {
      escalateResolveBudget(projectName, wtPath, entry);
      return true;
    }

    // Re-enter merge-pending with the same mergePendingAt so queue order is
    // preserved. The next poll cycle will re-attempt the rebase and, on
    // conflict, launch another resolver (counting toward the budget).
    transitionState(projectName, entry.name, "merge-pending", {
      mergePendingAt: entry.mergePendingAt ?? new Date().toISOString(),
      reviewWindowName: undefined,
      reviewStartedAt: undefined,
    });
    refreshDashboard();
    scheduleDelayedPoke(projectName, 0);
    return true;
  }

  // Verification passed. Force-push and transition to merge-pending so the
  // serial merge queue picks it up.
  log.info("poller", "resolver verified", {
    worker: entry.name,
    data: { attempts: entry.resolveAttempts ?? 0 },
  });

  try {
    forcePushBranch(wtPath, branchName);
  } catch (err) {
    log.error("poller", "force-push after resolve failed", {
      worker: entry.name,
      data: { error: String(err) },
    });
    transitionState(projectName, entry.name, "working", {
      reviewWindowName: undefined,
      reviewStartedAt: undefined,
      mergePendingAt: undefined,
    });
    refreshDashboard();
    return true;
  }

  transitionState(projectName, entry.name, "merge-pending", {
    mergePendingAt: entry.mergePendingAt ?? new Date().toISOString(),
    reviewWindowName: undefined,
    reviewStartedAt: undefined,
  });
  refreshDashboard();
  scheduleDelayedPoke(projectName, 0);
  return true;
}

// Reset a worker to `working` after a worker-authored push during review or
// resolution. Resets the resolver budget (this is a fresh cycle) and sets
// pendingReviewAt if commits are ahead of base so handleWorking picks it up —
// without this, the worker would stall in `working` with no trigger to
// advance (see the 2026-04 stuck-loop fix).
function resetToWorkingOnWorkerPush(
  projectName: string,
  wtPath: string,
  baseBranch: string,
  entry: WorkerEntry,
  context: "review" | "resolve",
): void {
  log.info(
    "poller",
    context === "review"
      ? "new commits during review, resetting to working"
      : "new commits during resolve, resetting to working",
    { worker: entry.name },
  );
  killReviewWindow(projectName, entry.name);

  const commitSummary = getCommitSummary(wtPath, baseBranch);
  const hasCommitsAhead = commitSummary.length > 0;

  transitionState(projectName, entry.name, "working", {
    lastShaChangeAt: new Date().toISOString(),
    reviewWindowName: undefined,
    reviewStartedAt: undefined,
    resolveAttempts: 0,
    preResolveSha: undefined,
    lastResolveBody: undefined,
    mergePendingAt: undefined,
    pendingReviewAt: hasCommitsAhead ? Date.now() : entry.pendingReviewAt,
  });
  refreshDashboard();
  // The FIFO poke that woke us dispatched to the prior state's handler, not
  // handleWorking. Schedule an immediate re-poke so the next tick picks up
  // pendingReviewAt via handleWorking.
  scheduleDelayedPoke(projectName, 0);
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
    // Schedule a one-shot wake-up so the debounce check fires after DEBOUNCE_MS.
    // Without this, the event-driven poller sleeps on the FIFO indefinitely —
    // nothing else pokes it, so the failing → working transition never fires.
    scheduleDelayedPoke(projectName, DEBOUNCE_MS);
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

    transitionState(projectName, entry.name, "working", {
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

  // Recovery path: if commits appear before UserPromptSubmit clears the
  // transient `merged`, treat that as a new work cycle and resume.
  const commitSummary = getCommitSummary(wtPath, baseBranch);
  if (!commitSummary) return false;

  log.info("poller", "new commits after merge, resuming", {
    worker: entry.name,
  });
  transitionState(projectName, entry.name, "working", {
    mergedAt: undefined,
    lastSeenSha: undefined,
  });
  refreshDashboard();
  return true;
}

// Mirror of handleMerged for the terminal "done" cleanup signal. Symmetric
// behavior: if the operator nudges the worker into a new work cycle (commits
// appear) without going through UserPromptSubmit, recover into `working`.
function handleDone(
  projectName: string,
  baseBranch: string,
  entry: WorkerEntry,
): boolean {
  const wtPath = entry.worktreePath;
  if (!wtPath) return false;
  const commitSummary = getCommitSummary(wtPath, baseBranch);
  if (!commitSummary) return false;
  log.info("poller", "new commits after done, resuming", { worker: entry.name });
  transitionState(projectName, entry.name, "working", {
    mergedAt: undefined,
    lastSeenSha: undefined,
  });
  refreshDashboard();
  return true;
}

// --- Review launching and result parsing ---

// Spawn a detached timer that pokes the project's FIFO after REVIEW_TIMEOUT_MS.
// The poller is event-driven and only wakes on pokes — a hung reviewer produces
// no events on its own, so without this the timeout check below would never
// run. Spurious pokes after normal completion are harmless (the handlers no-op).
function scheduleReviewTimeoutPoke(projectName: string): void {
  const fifo = signalFifoPath(projectName);
  const escapedFifo = fifo.replace(/'/g, "'\\''");
  const seconds = Math.ceil(REVIEW_TIMEOUT_MS / 1000);
  const cmd = `sleep ${seconds} && [ -p '${escapedFifo}' ] && (echo > '${escapedFifo}') 2>/dev/null`;
  const child = spawn("bash", ["-c", cmd], { detached: true, stdio: "ignore" });
  child.unref();
}

function isReviewTimedOut(entry: WorkerEntry): boolean {
  if (!entry.reviewStartedAt || !entry.reviewWindowName) return false;
  if (!windowExists(entry.reviewWindowName)) return false;
  return Date.now() - entry.reviewStartedAt > REVIEW_TIMEOUT_MS;
}

function handleReviewTimeout(
  projectName: string,
  projectPath: string,
  entry: WorkerEntry,
  kind: "review" | "resolve",
): boolean {
  const elapsedMs = Date.now() - (entry.reviewStartedAt ?? 0);
  log.warn("poller", "review timed out, killing window", {
    worker: entry.name,
    data: { kind, elapsedMs, timeoutMs: REVIEW_TIMEOUT_MS },
  });
  if (entry.reviewWindowName) killWindowSafe(entry.reviewWindowName);
  cleanReviewFiles(projectName, entry.name);
  addAlert({
    level: "error",
    source: "review",
    project: projectName,
    worker: entry.name,
    message: `${kind === "review" ? "Reviewer" : "Resolver"} for ${entry.name} exceeded ${Math.floor(REVIEW_TIMEOUT_MS / 60000)}-minute timeout and was killed. Check the worktree for hung subprocesses (commonly tests with no timeout blocked by the sandbox).`,
  });
  const wtPath = entry.worktreePath ?? projectPath;
  const headSha = getBranchHeadSha(wtPath);
  transitionState(projectName, entry.name, "failing", {
    failCount: (entry.failCount ?? 0) + 1,
    failingSha: headSha ?? undefined,
    lastSeenSha: headSha ?? undefined,
    lastShaChangeAt: new Date().toISOString(),
    reviewWindowName: undefined,
    reviewStartedAt: undefined,
    mergePendingAt: kind === "resolve" ? undefined : entry.mergePendingAt,
  });
  refreshDashboard();
  return true;
}

function launchReview(
  projectName: string,
  projectPath: string,
  baseBranch: string,
  entry: WorkerEntry,
): boolean {
  // The caller (handleWorking) is responsible for the "claude must be idle"
  // check. We don't repeat it here.
  const wtPath = entry.worktreePath ?? projectPath;

  // Fetch latest base branch so the reviewer can rebase onto it
  try {
    execFileSync("git", ["fetch", "origin", baseBranch], {
      cwd: wtPath,
      stdio: "ignore",
    });
  } catch (err) {
    log.debug("poller", "fetch before review failed", { worker: entry.name, data: { error: String(err) } });
  }

  // Build the review prompt
  const prompt = buildReviewPrompt(projectName, projectPath, baseBranch, entry);

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
  // GARDEN_REVIEWER=1 marks this Claude as the reviewer so its hooks
  // (sessionstart/prompt/stop fired from the same worktree as the worker)
  // can be distinguished from worker hooks and short-circuited by the
  // hook handler. Without this, the reviewer's Stop hook would be treated
  // as the worker's Stop hook and would (a) write claudeStatus="idle" for
  // the worker, and (b) poke the poller to start another review.
  const envPrefix = claudeEnvPrefix(tryGetProject(projectName) ?? {});
  const cmd = `GARDEN_REVIEWER=1 ${envPrefix}claude -p < '${escapedPrompt}' > '${escapedResult}' 2>&1; [ -p '${escapedFifo}' ] && (echo > '${escapedFifo}') 2>/dev/null`;

  // Kill any leftover review window
  if (windowExists(revWindow)) {
    killWindowSafe(revWindow);
  }

  tmux("new-window", "-d", "-t", DASHBOARD_SESSION, "-n", revWindow,
    "-c", wtPath, "bash", "-c", cmd);
  scheduleReviewTimeoutPoke(projectName);

  // Capture the remote tracking SHA at launch time. handleReviewing compares
  // origin/<branch> against this baseline to detect mid-review pushes. We use
  // the remote ref (not local HEAD) because the reviewer rebases locally,
  // which changes HEAD but not origin/<branch>.
  const branchName = entry.branchName ?? entry.name;
  const launchSha = getRemoteTrackingSha(wtPath, branchName) ?? getBranchHeadSha(wtPath) ?? entry.lastSeenSha;
  const preReviewSha = getBranchHeadSha(wtPath) ?? undefined;
  transitionState(projectName, entry.name, "reviewing", {
    reviewWindowName: revWindow,
    reviewStartedAt: Date.now(),
    lastSeenSha: launchSha,
    lastShaChangeAt: new Date().toISOString(),
    pendingReviewAt: undefined,
    mergePendingAt: entry.mergePendingAt,
    preReviewSha,
  });
  refreshDashboard();

  log.info("poller", "launched review", {
    worker: entry.name,
  });
  return true;
}

interface ReviewResult {
  verdict: "clean" | "fixed" | "failed";
  body: string;
}

interface ResolveResult {
  verdict: "done" | "failed";
  body: string;
}

function readResolveResult(
  projectName: string,
  entry: WorkerEntry,
): ResolveResult | null {
  const resultFile = reviewResultPath(projectName, entry.name);
  try {
    if (!fs.existsSync(resultFile)) {
      log.warn("poller", "resolve result file missing", { worker: entry.name });
      return null;
    }
    const output = fs.readFileSync(resultFile, "utf-8").trim();
    if (!output) {
      log.warn("poller", "resolve result file empty", { worker: entry.name });
      return null;
    }
    const lines = output.split("\n");
    let lastLineIdx = lines.length - 1;
    while (lastLineIdx >= 0 && !lines[lastLineIdx].trim()) lastLineIdx--;
    if (lastLineIdx < 0) return null;
    const lastLine = lines[lastLineIdx].trim().toUpperCase().replace(/[.\s!]+$/, "");
    const body = lines.slice(0, lastLineIdx).join("\n").trim() || "No additional comments.";
    if (lastLine === "DONE") return { verdict: "done", body };
    if (lastLine === "FAILED") return { verdict: "failed", body };
    log.warn("poller", "could not parse resolve verdict", {
      worker: entry.name,
      data: { lastLine },
    });
    return null;
  } catch (err) {
    log.warn("poller", "failed to read resolve result", {
      worker: entry.name,
      data: { error: String(err) },
    });
    return null;
  }
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

// Scan the last N non-empty lines for a line that is a standalone verdict
// token (optionally with trailing punctuation). Reviewers sometimes emit the
// verdict and then add trailing summary output; they also sometimes forget
// the fenced verdict entirely. Looking at the last N lines handles the first
// case. The second case is handled in handleReviewing by detecting HEAD
// advancement and re-queueing the review.
const VERDICT_SCAN_LINES = 20;
const VERDICT_LINE = /^(CLEAN|FIXED|FAILED)[.\s!]*$/i;

function parseReviewResult(output: string, workerName: string): ReviewResult | null {
  const lines = output.split("\n");
  let lastLineIdx = lines.length - 1;
  while (lastLineIdx >= 0 && !lines[lastLineIdx].trim()) lastLineIdx--;
  if (lastLineIdx < 0) {
    log.warn("poller", "review output is empty", { worker: workerName });
    return null;
  }

  const scanStart = Math.max(0, lastLineIdx - VERDICT_SCAN_LINES + 1);
  for (let i = lastLineIdx; i >= scanStart; i--) {
    const match = lines[i].trim().match(VERDICT_LINE);
    if (!match) continue;
    const verdict = match[1].toUpperCase();
    const body = lines.slice(0, i).join("\n").trim() || "No additional comments.";
    if (verdict === "CLEAN") return { verdict: "clean", body };
    if (verdict === "FIXED") return { verdict: "fixed", body };
    if (verdict === "FAILED") return { verdict: "failed", body };
  }

  log.warn("poller", "could not parse review verdict", {
    worker: workerName,
    data: { lastLine: lines[lastLineIdx].trim() },
  });
  return null;
}

// --- Merge ---

function finalizeMerge(
  projectName: string,
  projectPath: string,
  baseBranch: string,
  entry: WorkerEntry,
): void {
  const branchName = entry.branchName ?? entry.name;

  // Snapshot changed files BEFORE merge — after mergeToBase pushes, the
  // remote tracking ref advances to include our commits and the diff is empty.
  const preMergeChangedFiles = entry.worktreePath
    ? getChangedFiles(entry.worktreePath, baseBranch)
    : [];

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
    // Set pendingReviewAt so the worker gets re-reviewed instead of being
    // stuck in "working" with no trigger to advance.
    transitionState(projectName, entry.name, "working", {
      pendingReviewAt: Date.now(),
      mergePendingAt: undefined,
    });
    refreshDashboard();
    scheduleDelayedPoke(projectName, 5_000);
    return;
  }

  log.info("poller", "merged to base branch", { worker: entry.name, data: { baseBranch } });

  // Sync the worker's worktree to the merged tip BEFORE deleteRemoteBranch:
  // worktrees share refs with the main repo, so once origin/<branch> is gone
  // both `git fetch origin <branch>` and `git reset --hard origin/<branch>`
  // fail. Diff pre-review HEAD against the post-sync tip so the auto-continue
  // prompt can list the files the reviewer touched. Skip the sync when the
  // worker self-declared done — auto-continue will not fire, and the
  // .garden-done sentinel itself shows as untracked which would always trip
  // the dirty check and fire a misleading alert.
  const sentinelPresent = isDoneSet(entry.worktreePath);
  let changedDuringReview: string[] = [];
  let syncFailed = false;
  if (entry.worktreePath && !sentinelPresent) {
    const fromSha = entry.preReviewSha;
    const sync = syncWorktreeToRemote(entry.worktreePath, branchName);
    if (sync.ok) {
      log.info("poller", "synced worktree to merged tip", {
        worker: entry.name,
        data: { branch: branchName },
      });
      const toSha = getBranchHeadSha(entry.worktreePath);
      if (fromSha && toSha && fromSha !== toSha) {
        changedDuringReview = getChangedFilesBetween(entry.worktreePath, fromSha, toSha);
      }
    } else {
      syncFailed = true;
      const logData = { branch: branchName, reason: sync.reason, error: sync.error };
      const alertMessage = sync.reason === "dirty"
        ? `Could not sync worker ${entry.name} after merge: worktree has uncommitted changes. Worker resumes on stale HEAD until cleaned up.`
        : `Post-merge sync failed for worker ${entry.name} (${sync.reason}): ${(sync.error ?? "").slice(0, 200)}`;
      if (sync.reason === "dirty") {
        log.warn("poller", "post-merge worktree sync failed", { worker: entry.name, data: logData });
        addAlert({ level: "warn", source: "poller", project: projectName, worker: entry.name, message: alertMessage });
      } else {
        log.error("poller", "post-merge worktree sync failed", { worker: entry.name, data: logData });
        addAlert({ level: "error", source: "poller", project: projectName, worker: entry.name, message: alertMessage });
      }
    }
  }

  deleteRemoteBranch(projectPath, branchName);

  // Update the main checkout so postMerge (e.g. npm run build) runs
  // against the newly merged code, not stale working-tree files.
  // mergeToBase only pushes to the remote via refspec — it never touches
  // the local checkout.
  const advanced = fastForwardBase(projectPath, baseBranch, { project: projectName, worker: entry.name });

  notifySiblingWorkers(projectName, baseBranch, entry, preMergeChangedFiles);

  if (advanced) {
    runPostMerge(projectName, projectPath);
  } else {
    // Always alert: checkout drift rots manual workflow regardless of postMerge config.
    const postMergeNote = tryGetProject(projectName)?.postMerge
      ? " postMerge was skipped."
      : "";
    log.error("poller", "local base checkout did not fast-forward after merge", {
      worker: entry.name,
      data: { projectPath, baseBranch },
    });
    addAlert({
      level: "error",
      source: "poller",
      project: projectName,
      worker: entry.name,
      message: `Local ${baseBranch} checkout at ${projectPath} did not fast-forward after merge (likely a dirty working tree or divergent branch).${postMergeNote} Clean the checkout so it stays current with merged work.`,
    });
  }

  // Per STATUS.md invariant 4: pick `done` when the worker wrote `.garden-done`
  // before its final push (skip the transient `merged` beat and go straight to
  // the operator-actionable cleanup signal). Otherwise set `merged` — auto-
  // continue will clear it on the next prompt.
  const terminalState: PrState = sentinelPresent ? "done" : "merged";
  transitionState(projectName, entry.name, terminalState, {
    mergedAt: new Date().toISOString(),
    failCount: 0,
    mergePendingAt: undefined,
    reviewWindowName: undefined,
    reviewStartedAt: undefined,
    lastReviewBody: undefined,
    resolveAttempts: 0,
    preResolveSha: undefined,
    lastResolveBody: undefined,
    preReviewSha: undefined,
    pendingContinueChangedFiles: changedDuringReview.length ? changedDuringReview : undefined,
    pendingContinueSyncFailed: syncFailed ? true : undefined,
  });

  // STATUS.md invariant 4 race: prompt hook can't clear active pipeline states,
  // so if the worker is already working, clear the stale terminal state immediately.
  const fresh = findWorkerByName(projectName, entry.name);
  if (fresh?.claudeStatus === "working") {
    log.info("poller", "worker already active after merge, clearing terminal state", {
      worker: entry.name,
      data: { clearedFrom: terminalState },
    });
    transitionState(projectName, entry.name, "working", {
      mergedAt: undefined,
      lastSeenSha: undefined,
    });
  }

  maybeAutoContinue(projectName, branchName, fresh ?? entry);

  refreshDashboard();
}

// After a clean merge, send the worker a "please proceed" prompt so multi-phase
// work continues without manual intervention. The worker opts out by writing
// the .garden-done sentinel (see continue.ts donePath); pause/resume commands toggle
// the same file. Skips when the worker is already mid-turn or when the same
// merge event would re-fire within AUTO_CONTINUE_DEBOUNCE_MS.
function maybeAutoContinue(
  projectName: string,
  branchName: string,
  entry: WorkerEntry,
): void {
  const perWorkerReason = autoContinueSkipReason(entry);
  if (perWorkerReason) {
    log.debug("poller", "auto-continue skipped", {
      worker: entry.name,
      data: { project: projectName, reason: perWorkerReason },
    });
    return;
  }
  const gateReason = autoContinueGateReason();
  if (gateReason) {
    log.info("poller", "auto-continue blocked by global gate", {
      worker: entry.name,
      data: { project: projectName, reason: gateReason },
    });
    return;
  }
  updateWorkerFields(projectName, entry.name, { lastAutoContinueAt: Date.now() });
  log.info("poller", "auto-continued worker after merge", {
    worker: entry.name,
    data: { project: projectName, branch: branchName },
  });
  dispatchDelayedAutoContinue(resolveGardenRunner(), projectName, entry.name);
}

function autoContinueSkipReason(entry: WorkerEntry): string | null {
  if (isDoneSet(entry.worktreePath)) return "done-sentinel";
  if (entry.claudeStatus === "working" || entry.claudeStatus === "asking") {
    return `claude-${entry.claudeStatus}`;
  }
  if (entry.lastAutoContinueAt
      && Date.now() - entry.lastAutoContinueAt < AUTO_CONTINUE_DEBOUNCE_MS) {
    return "idempotency-window";
  }
  return null;
}

// Global auto-continue gate. Mutates config when it auto-resumes after a
// usage-window reset or auto-disables after a threshold cross. Returns null
// when auto-continue is allowed to proceed; otherwise a short reason tag.
export function autoContinueGateReason(): string | null {
  let cfg = getAutoContinueConfig();

  if (!cfg.enabled && cfg.pausedUntil && cfg.resumeAfterReset) {
    const resetMs = Date.parse(cfg.pausedUntil);
    if (Number.isFinite(resetMs) && Date.now() >= resetMs) {
      cfg = setAutoContinueConfig({
        enabled: true,
        pausedUntil: undefined,
        pausedReason: undefined,
      });
      log.info("poller", "auto-continue re-enabled after usage window reset", {});
    }
  }

  if (!cfg.enabled) {
    return cfg.pausedUntil ? "usage-paused" : "globally-disabled";
  }

  const tripped = checkUsageThreshold(cfg.usageThreshold);
  if (tripped) {
    setAutoContinueConfig({
      enabled: false,
      pausedUntil: tripped.pausedUntil,
      pausedReason: tripped.reason,
    });
    addAlert({
      level: "warn",
      source: "usage",
      project: "garden",
      message: `Auto-continue disabled: ${tripped.reason}. Run 'garden auto on' to re-enable.`,
    });
    log.warn("poller", "auto-continue auto-disabled by usage threshold", {
      data: { reason: tripped.reason, pausedUntil: tripped.pausedUntil },
    });
    return "usage-threshold";
  }

  return null;
}

// Sonnet is intentionally excluded — the operator runs Opus, sonnet quota is
// unused. When multiple meters trip, pause until the latest reset so we don't
// re-enable into a still-tripped meter.
export function checkUsageThreshold(threshold: number): { pausedUntil: string; reason: string } | null {
  const snap = readUsageSnapshot();
  if (!snap?.data) return null;
  const candidates: Array<{ label: string; pct: number; resetsAt: string }> = [];
  if (snap.data.fiveHour) candidates.push({ label: "5h", ...snap.data.fiveHour });
  if (snap.data.weekly)   candidates.push({ label: "week", ...snap.data.weekly });
  const tripped = candidates.filter(c => c.pct >= threshold);
  if (tripped.length === 0) return null;
  const latest = tripped.reduce((a, b) =>
    Date.parse(a.resetsAt) > Date.parse(b.resetsAt) ? a : b);
  const reason = tripped.map(c => `${c.label} at ${Math.round(c.pct)}%`).join(", ");
  return { pausedUntil: latest.resetsAt, reason };
}

function runPostMerge(projectName: string, projectPath: string): void {
  const project = tryGetProject(projectName);
  if (!project?.postMerge) return;

  const commit = getBranchHeadSha(projectPath)?.slice(0, 7) ?? "unknown";

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
    // Detached handoff via the rebuilt binary — this process still has pre-rebuild code in memory
    if (projectName === "garden") {
      try {
        const gr = resolveGardenRunner();
        setupKeybindings(gr);
        setupStatusBar(gr);
        spawn("sh", ["-c", `${gr} dashboard _post-rebuild-refresh 2>/dev/null`], {
          detached: true,
          stdio: "ignore",
        }).unref();
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
  mergedFiles: string[],
): void {
  if (!mergedEntry.worktreePath) return;
  if (mergedFiles.length === 0) return;

  const commitSummary = getCommitSummary(mergedEntry.worktreePath, baseBranch);
  // pushed is no longer a state in the new model — workers go straight from
  // working to reviewing via the Stop hook poke. The siblings to notify are
  // those whose code is still in flight.
  const siblings = getWorkers(projectName).filter(
    w => w.name !== mergedEntry.name &&
      (!w.prState || w.prState === "working" || w.prState === "failing"),
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

    const windowName = workerWindowName(projectName, sibling.name);
    if (!windowExists(windowName)) continue;

    const paneId = getFirstPaneId(`${DASHBOARD_SESSION}:${windowName}`);
    if (!paneId) continue;

    // Liveness from the registry (claudeStatus is hook-driven). A sibling
    // marked exited is dead — skip.
    if (sibling.claudeStatus === "exited") {
      log.info("poller", "skipping dead sibling", {
        worker: sibling.name,
        data: { mergedWorker: mergedEntry.name },
      });
      continue;
    }

    tmux("send-keys", "-t", paneId, "-l", message);
    tmux("send-keys", "-t", paneId, "Enter");
    log.info("poller", "notified sibling of merge overlap", {
      worker: sibling.name,
      data: { mergedWorker: mergedEntry.name, overlapFiles: overlap },
    });
  }
}

// --- Helpers ---

// Worker liveness is now read from the registry (set by Claude Code hooks),
// not by inspecting tmux pane child processes. The registry is the single
// source of truth per STATUS.md.
function isWorkerClaudeWorking(projectName: string, workerName: string): boolean {
  const entry = findWorkerByName(projectName, workerName);
  return entry?.claudeStatus === "working";
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
    log.debug("poller", "triggered poll", { data: { project: projectName } });
  } catch {
    // FIFO not ready or poller not running
  }
}

function scheduleDelayedPoke(projectName: string, delayMs: number): void {
  const fifo = signalFifoPath(projectName);
  const delaySec = Math.ceil(delayMs / 1000);
  const escapedFifo = fifo.replace(/'/g, "'\\''");
  spawn("bash", ["-c", `sleep ${delaySec} && echo > '${escapedFifo}' 2>/dev/null`], {
    detached: true,
    stdio: "ignore",
  }).unref();
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
  // Event-driven poller loop: poll once, then block on the FIFO until an
  // event arrives. Per STATUS.md invariant 6, there is no fallback poll.
  // Every transition is delivered by an event from one of four sources:
  // Claude Code hooks, worker push hook, merge queue completion, or tmux
  // pane-died. The poller is a pure dispatcher that does one unit of work
  // per wake.
  const cmd = [
    `while true; do`,
    `  ${gardenRunner} dashboard _poll '${escapedProject}' 2>/dev/null;`,
    `  read <>'${escapedFifo}' 2>/dev/null || true;`,
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

// Pokes that land during the brief kill→spawn gap are dropped; the next event re-pokes.
export function restartLongLivedPollers(gardenRunner: string): void {
  try {
    stopUsagePoller();
    startUsagePoller(gardenRunner);
  } catch (err) {
    log.warn("poller", "failed to restart usage poller", { data: { error: String(err) } });
  }

  const registry = readRegistry();
  for (const [projectName, entries] of Object.entries(registry.workers)) {
    if (entries.length === 0) continue;
    try {
      stopProjectPoller(projectName);
      startProjectPoller(projectName, gardenRunner);
    } catch (err) {
      log.warn("poller", "failed to restart project poller", {
        data: { project: projectName, error: String(err) },
      });
    }
  }
}

// Exported for review window cleanup in workers.ts
export { killReviewWindow };

function ensureSignalFifo(fifoPath: string): void {
  try {
    const stat = fs.statSync(fifoPath);
    if (stat.isFIFO()) return;
    fs.unlinkSync(fifoPath);
  } catch { /* doesn't exist */ }
  fs.mkdirSync(path.dirname(fifoPath), { recursive: true });
  execFileSync("mkfifo", [fifoPath]);
}

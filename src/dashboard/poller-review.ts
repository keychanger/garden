// Review lifecycle: launching reviewers, parsing verdicts, handling the
// reviewing-state events, retries on unparseable output, timeouts.
//
// The reviewer is a separate Claude process running `claude -p` inside the
// worker's worktree, in a hidden tmux window. GARDEN_REVIEWER=1 marks its
// hooks so they don't get treated as worker hooks.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { tryGetProject, SESSIONS_DIR } from "../config.js";
import { addAlert } from "./alerts.js";
import { claudeEnvPrefix } from "./claude-env.js";
import { setDoneSentinel } from "./continue.js";
import {
  forcePushBranch, getBranchHeadSha, getCommitSummary, getRemoteTrackingSha,
} from "./git.js";
import { refreshDashboard } from "./header.js";
import { launchHeadlessAgent } from "./headless-agent.js";
import { log } from "./log.js";
import { buildReviewPrompt } from "./prompts.js";
import {
  findWorkerByName, updateWorkerFields,
  type WorkerEntry,
} from "./registry.js";
import { windowExists, killWindowSafe, shellEscape } from "./tmux.js";
import { buildTrellisReviewPrompt } from "./trellis-prompts.js";
import {
  parseTrellisVerdict, parseDriftList, parseFlaggedClauses, renderDriftItem,
  type TrellisVerdictResult,
} from "./trellis-verdict.js";
import { parseLastLineVerdict } from "./verdict.js";
import { reviewWindowName } from "./window-names.js";
import { signalFifoPath, scheduleDelayedPoke } from "./poller-fifo.js";
import { transitionState } from "./poller-state.js";
import { getWorkflow } from "./workflows/index.js";

// Wall-clock ceiling on a single reviewer or resolver run. If the tmux window
// is still alive past this, the poller kills it and escalates to `failing`.
// Catches hung subprocesses the reviewer can't escape from (e.g. a `npm test`
// that blocks forever because tests have no timeout and the sandbox silently
// denies their network calls).
export const REVIEW_TIMEOUT_MS = 30 * 60 * 1000;

const REVIEW_VERDICT_VOCAB = ["CLEAN", "FIXED", "FAILED"] as const;

export interface ReviewResult {
  verdict: "clean" | "fixed" | "failed";
  body: string;
}

export function reviewResultPath(project: string, worker: string): string {
  return path.join(SESSIONS_DIR, `${project}-${worker}-review-result.txt`);
}

export function reviewPromptPath(project: string, worker: string): string {
  return path.join(SESSIONS_DIR, `${project}-${worker}-review-prompt.txt`);
}

// `working` worker: the Stop-hook FIFO poke gets us here. The Stop hook
// sets pendingReviewAt only when it observed commits ahead of base, so this
// handler only launches a review for workers whose Stop hook *just* fired
// with new commits. Idle workers with stale commits do not get reviewed —
// per STATUS.md invariant 2, you cannot enter the review cycle from idle.
export function handleWorking(
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

export function handleReviewing(
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

  // Review window is gone — read result. The trellis workflow has its own
  // verdict vocabulary (ALIGNED/DRIFT/FAILED/FLAGGED); default keeps
  // CLEAN/FIXED/FAILED. Unparseable handling below is workflow-agnostic.
  const isTrellis = entry.workflow === "trellis";
  const review = isTrellis
    ? readTrellisReviewResult(projectName, entry)
    : readReviewResult(projectName, entry);

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
          failingReason: "code",
          // Pin the failing SHA so handleFailing's debounce gate refuses
          // to retry until a new commit actually arrives.
          failingSha: headSha ?? undefined,
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
      // Q9 retrofit: unparseable-verdict is its own failingReason, distinct
      // from "code" failures. Both default and trellis paths funnel through
      // here; the renderer distinguishes them in phase 4.
      failingReason: "unparseable-verdict",
      // Pin the failing SHA so handleFailing's debounce gate refuses to
      // retry until a new commit actually arrives.
      failingSha: headSha ?? undefined,
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

  if (isTrellis) {
    return dispatchTrellisVerdict(
      projectName, projectPath, entry, review as TrellisVerdictResult,
    );
  }
  return dispatchDefaultVerdict(
    projectName, projectPath, entry, review as ReviewResult,
  );
}

// Default workflow verdict dispatcher. Pre-trellis, this logic was inline
// in handleReviewing; phase 2 extracted it so the trellis dispatcher
// can sit beside it without growing handleReviewing into a giant branch.
function dispatchDefaultVerdict(
  projectName: string,
  projectPath: string,
  entry: WorkerEntry,
  review: ReviewResult,
): boolean {
  if (review.verdict === "clean" || review.verdict === "fixed") {
    const wtPath = entry.worktreePath ?? projectPath;
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
    return true;
  }
  // "failed" — reviewer couldn't fix the issues. addAlert also logs.
  addAlert({
    level: "error",
    source: "review",
    project: projectName,
    worker: entry.name,
    message: `Reviewer could not fix issues for worker ${entry.name}: ${review.body.slice(0, 300)}`,
    // The review body changes between runs, so the default key would
    // never collapse identical failure modes. Key on worker only.
    dedupKey: `review-failed:${projectName}:${entry.name}`,
  });
  const wtPath = entry.worktreePath ?? projectPath;
  const headSha = getBranchHeadSha(wtPath);
  transitionState(projectName, entry.name, "failing", {
    failCount: (entry.failCount ?? 0) + 1,
    failingReason: "code",
    failingSha: headSha ?? undefined,
    lastSeenSha: headSha ?? undefined,
    lastShaChangeAt: new Date().toISOString(),
    reviewWindowName: undefined,
    reviewStartedAt: undefined,
    preReviewSha: undefined,
    unparseableReviewAt: undefined,
  });
  refreshDashboard();
  return true;
}

// Trellis verdict dispatcher. See TRELLIS.md "One iteration, in detail" /
// "Branch on verdict" for the contract on each disposition.
//
// ALIGNED → write `.garden-done`, force-push, merge-pending; finalizeMerge
//   picks `done` and skips auto-continue, terminating the loop.
// DRIFT   → force-push, merge-pending. finalizeMerge sets `merged`,
//   resets the worker's Claude context, and dispatches the trellis
//   continue prompt with the drift list.
// FLAGGED → failing with failingReason="trellis-flagged". The
//   handleFailing push debounce skips this state — only `garden trellis
//   resume` clears it.
// FAILED  → failing with failingReason="code". Same shape as default.
function dispatchTrellisVerdict(
  projectName: string,
  projectPath: string,
  entry: WorkerEntry,
  review: TrellisVerdictResult,
): boolean {
  const wtPath = entry.worktreePath ?? projectPath;
  const branchName = entry.branchName ?? entry.name;

  if (review.verdict === "ALIGNED") {
    try {
      forcePushBranch(wtPath, branchName);
    } catch (err) {
      log.error("poller", "force-push after trellis review failed", {
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
    // Write the sentinel only after the force-push succeeds. If we wrote it
    // earlier and the push failed, the sentinel would persist on disk; a
    // later DRIFT-then-merge cycle would then have finalizeMerge pick `done`
    // off the stale sentinel even though alignment had been lost.
    setDoneSentinel(entry.worktreePath);
    transitionState(projectName, entry.name, "merge-pending", {
      mergePendingAt: new Date().toISOString(),
      lastReviewBody: review.body,
      trellisLastVerdict: "ALIGNED",
      // trellisAligned distinguishes reviewer-declared success from
      // operator sentinel-set; finalizeMerge preserves it into `done`.
      trellisAligned: true,
      // Clear the drift list — the loop converged.
      trellisLastDrift: undefined,
      reviewWindowName: undefined,
      reviewStartedAt: undefined,
      unparseableReviewAt: undefined,
    });
    refreshDashboard();
    scheduleDelayedPoke(projectName, 0);
    return true;
  }

  if (review.verdict === "DRIFT") {
    const drift = parseDriftList(review.body);
    const driftLines = drift.items.map((it, i) => renderDriftItem(it, i));
    try {
      forcePushBranch(wtPath, branchName);
    } catch (err) {
      log.error("poller", "force-push after trellis DRIFT failed", {
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
    transitionState(projectName, entry.name, "merge-pending", {
      mergePendingAt: new Date().toISOString(),
      lastReviewBody: review.body,
      trellisLastVerdict: "DRIFT",
      trellisLastDrift: driftLines,
      trellisAlignedCount: drift.alignedCount,
      reviewWindowName: undefined,
      reviewStartedAt: undefined,
      unparseableReviewAt: undefined,
    });
    refreshDashboard();
    scheduleDelayedPoke(projectName, 0);
    return true;
  }

  if (review.verdict === "FLAGGED") {
    const clauses = parseFlaggedClauses(review.body);
    const detail = clauses.length > 0
      ? clauses.join(", ")
      : review.body.slice(0, 200);
    addAlert({
      level: "error",
      source: "trellis",
      project: projectName,
      worker: entry.name,
      message:
        `Trellis '${entry.trellisName ?? "?"}' flagged for worker ${entry.name}: ${detail}. ` +
        `Run 'garden trellis amend ${projectName} ${entry.trellisName ?? "<name>"}' or ` +
        `'garden trellis resume ${entry.name}' (override) to continue.`,
      // Stable key — body and clauses vary across runs; one alert per
      // flagged transition is enough.
      dedupKey: `trellis-flagged:${projectName}:${entry.name}`,
    });
    const headSha = getBranchHeadSha(wtPath);
    transitionState(projectName, entry.name, "failing", {
      failCount: (entry.failCount ?? 0) + 1,
      failingReason: "trellis-flagged",
      failingSha: headSha ?? undefined,
      lastSeenSha: headSha ?? undefined,
      lastShaChangeAt: new Date().toISOString(),
      trellisLastVerdict: "FLAGGED",
      trellisFlaggedClauses: clauses.length > 0 ? clauses : undefined,
      reviewWindowName: undefined,
      reviewStartedAt: undefined,
      preReviewSha: undefined,
      unparseableReviewAt: undefined,
    });
    refreshDashboard();
    return true;
  }

  // FAILED — same shape as default's "failed" verdict, with trellis fields
  // updated and failingReason: "code" so the renderer doesn't mistake it
  // for a flagged or budget-exhausted vine.
  addAlert({
    level: "error",
    source: "review",
    project: projectName,
    worker: entry.name,
    message: `Trellis reviewer could not fix issues for worker ${entry.name}: ${review.body.slice(0, 300)}`,
    dedupKey: `review-failed:${projectName}:${entry.name}`,
  });
  const headSha = getBranchHeadSha(wtPath);
  transitionState(projectName, entry.name, "failing", {
    failCount: (entry.failCount ?? 0) + 1,
    failingReason: "code",
    failingSha: headSha ?? undefined,
    lastSeenSha: headSha ?? undefined,
    lastShaChangeAt: new Date().toISOString(),
    trellisLastVerdict: "FAILED",
    reviewWindowName: undefined,
    reviewStartedAt: undefined,
    preReviewSha: undefined,
    unparseableReviewAt: undefined,
  });
  refreshDashboard();
  return true;
}

// Reset a worker to `working` after a worker-authored push during review or
// resolution. Resets the resolver budget (this is a fresh cycle) and sets
// pendingReviewAt if commits are ahead of base so handleWorking picks it up —
// without this, the worker would stall in `working` with no trigger to
// advance (see the 2026-04 stuck-loop fix).
export function resetToWorkingOnWorkerPush(
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

// Spawn a detached timer that pokes the project's FIFO after REVIEW_TIMEOUT_MS.
// The poller is event-driven and only wakes on pokes — a hung reviewer produces
// no events on its own, so without this the timeout check below would never
// run. Spurious pokes after normal completion are harmless (the handlers no-op).
export function scheduleReviewTimeoutPoke(projectName: string): void {
  const fifo = signalFifoPath(projectName);
  const fifoLit = shellEscape(fifo);
  const seconds = Math.ceil(REVIEW_TIMEOUT_MS / 1000);
  const cmd = `sleep ${seconds} && [ -p ${fifoLit} ] && (echo > ${fifoLit}) 2>/dev/null`;
  const child = spawn("bash", ["-c", cmd], { detached: true, stdio: "ignore" });
  child.unref();
}

export function isReviewTimedOut(entry: WorkerEntry): boolean {
  if (!entry.reviewStartedAt || !entry.reviewWindowName) return false;
  if (!windowExists(entry.reviewWindowName)) return false;
  return Date.now() - entry.reviewStartedAt > REVIEW_TIMEOUT_MS;
}

export function handleReviewTimeout(
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
    failingReason: "code",
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
  const isTrellis = entry.workflow === "trellis";

  // Trellis workflow: increment iteration counter *before* the budget check
  // and *before* dispatch (TRELLIS.md "One iteration, in detail" / step 5).
  // After the increment, the counter reflects the iteration about to be
  // reviewed (1 during the first review, 2 during the second, etc.). When
  // the increment exceeds maxIterations, short-circuit to failing with
  // failingReason="iteration-budget" — the iteration cap is the primary
  // safety net (Invariant 4).
  if (isTrellis) {
    const nextIter = (entry.trellisIteration ?? 0) + 1;
    const cap = entry.trellisMaxIterations ?? 30;
    if (nextIter > cap) {
      const headSha = getBranchHeadSha(wtPath);
      const lastDriftPreview = (entry.trellisLastDrift ?? []).slice(0, 3).join("; ");
      addAlert({
        level: "error",
        source: "trellis",
        project: projectName,
        worker: entry.name,
        message:
          `Trellis '${entry.trellisName ?? "?"}' iteration budget exhausted ` +
          `(${cap} iterations). Last drift: ${lastDriftPreview || "none"}. ` +
          `Inspect, then amend trellis & retry, raise budget, or kill.`,
        dedupKey: `trellis-budget:${projectName}:${entry.name}`,
      });
      transitionState(projectName, entry.name, "failing", {
        failCount: (entry.failCount ?? 0) + 1,
        failingReason: "iteration-budget",
        failingSha: headSha ?? undefined,
        lastSeenSha: headSha ?? undefined,
        lastShaChangeAt: new Date().toISOString(),
        // Don't increment the counter past the cap — leave it at the
        // last completed iteration. The renderer reads it for "N/M".
        pendingReviewAt: undefined,
      });
      refreshDashboard();
      return true;
    }
    // Persist the increment before dispatch so handleReviewing's verdict
    // logging and any concurrent `garden trellis status` see the right
    // iteration number.
    updateWorkerFields(projectName, entry.name, { trellisIteration: nextIter });
    entry.trellisIteration = nextIter;
  }

  // Fetch latest base branch so the reviewer can rebase onto it
  try {
    execFileSync("git", ["fetch", "origin", baseBranch], {
      cwd: wtPath,
      stdio: "ignore",
    });
  } catch (err) {
    log.debug("poller", "fetch before review failed", { worker: entry.name, data: { error: String(err) } });
  }

  // Build the review prompt with the workflow-appropriate vocabulary.
  const prompt = isTrellis
    ? buildTrellisReviewPrompt(projectName, projectPath, baseBranch, entry)
    : buildReviewPrompt(projectName, projectPath, baseBranch, entry);

  if (prompt === null) {
    log.warn("poller", "failed to build review prompt", { worker: entry.name });
    return false;
  }

  // GARDEN_REVIEWER=1 marks this Claude as the reviewer so its hooks
  // (sessionstart/prompt/stop fired from the same worktree as the worker)
  // can be distinguished from worker hooks and short-circuited by the
  // hook handler. Without this, the reviewer's Stop hook would be treated
  // as the worker's Stop hook and would (a) write claudeStatus="idle" for
  // the worker, and (b) poke the poller to start another review.
  //
  // Reviewer model: trellis pins to workflow.reviewerModel ("opus") per
  // Invariant 10 — reviewer quality is non-negotiable, never falls back.
  // Default workflow leaves reviewerModel unset and the account default
  // applies (today: Opus). No model flag is added in that case.
  const reviewerModel = getWorkflow(entry.workflow ?? "default").reviewerModel;
  const revWindow = reviewWindowName(projectName, entry.name);
  launchHeadlessAgent({
    cwd: wtPath,
    windowName: revWindow,
    prompt,
    promptFile: reviewPromptPath(projectName, entry.name),
    resultFile: reviewResultPath(projectName, entry.name),
    envPrefix: claudeEnvPrefix(tryGetProject(projectName) ?? {}),
    envVars: { GARDEN_REVIEWER: "1" },
    signalFifo: signalFifoPath(projectName),
    onLaunched: () => scheduleReviewTimeoutPoke(projectName),
    model: reviewerModel,
  });

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
    data: isTrellis ? { iteration: entry.trellisIteration } : undefined,
  });
  return true;
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
  const parsed = parseLastLineVerdict(output, REVIEW_VERDICT_VOCAB);
  if (!parsed) {
    const lastLine = output.split("\n").reverse().find(l => l.trim()) ?? "";
    log.warn("poller", "could not parse review verdict", {
      worker: workerName,
      data: { lastLine: lastLine.trim() },
    });
    return null;
  }
  const body = parsed.body || "No additional comments.";
  return { verdict: parsed.verdict.toLowerCase() as ReviewResult["verdict"], body };
}

// Trellis variant of readReviewResult — same file I/O contract, parses with
// the trellis vocabulary (ALIGNED/DRIFT/FAILED/FLAGGED). Returns null on
// missing file, empty file, or unparseable output; the caller's existing
// unparseable-verdict retry path handles all three identically.
function readTrellisReviewResult(
  projectName: string,
  entry: WorkerEntry,
): TrellisVerdictResult | null {
  const resultFile = reviewResultPath(projectName, entry.name);
  try {
    if (!fs.existsSync(resultFile)) {
      log.warn("poller", "trellis review result file missing", { worker: entry.name });
      return null;
    }
    const output = fs.readFileSync(resultFile, "utf-8").trim();
    if (!output) {
      log.warn("poller", "trellis review result file empty", { worker: entry.name });
      return null;
    }
    const parsed = parseTrellisVerdict(output);
    if (!parsed) {
      const lastLine = output.split("\n").reverse().find(l => l.trim()) ?? "";
      log.warn("poller", "could not parse trellis verdict", {
        worker: entry.name,
        data: { lastLine: lastLine.trim() },
      });
      return null;
    }
    return { verdict: parsed.verdict, body: parsed.body || "No additional comments." };
  } catch (err) {
    log.warn("poller", "failed to read trellis review result", {
      worker: entry.name,
      data: { error: String(err) },
    });
    return null;
  }
}

export function killReviewWindow(projectName: string, workerName: string): void {
  const revWindow = reviewWindowName(projectName, workerName);
  if (windowExists(revWindow)) {
    killWindowSafe(revWindow);
  }
  cleanReviewFiles(projectName, workerName);
}

export function cleanReviewFiles(projectName: string, workerName: string): void {
  try { fs.unlinkSync(reviewResultPath(projectName, workerName)); } catch { /* ignore */ }
  try { fs.unlinkSync(reviewPromptPath(projectName, workerName)); } catch { /* ignore */ }
}

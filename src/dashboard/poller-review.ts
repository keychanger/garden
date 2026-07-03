// Review lifecycle: launching reviewers, parsing verdicts, handling the
// reviewing-state events, retries on unparseable output, timeouts.
//
// The reviewer is a separate Claude process running `claude -p` inside the
// worker's worktree, in a hidden tmux window. GARDEN_REVIEWER=1 marks its
// hooks so they don't get treated as worker hooks.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { tryGetProject, SESSIONS_DIR } from "../config.js";
import { addAlert } from "./alerts.js";
import { resolveReviewRole } from "./roles.js";
import { codexStderrSidecar } from "./harness/codex-core.js";
import { getHarnessCore } from "./harness/core.js";
import { setDoneSentinel } from "./continue.js";
import {
  forcePushBranch, getBranchHeadSha, getCommitSummary, getRemoteTrackingSha,
  hasCommitsAhead,
} from "./git.js";
import { refreshDashboard } from "./header.js";
import { launchHeadlessAgent } from "./headless-agent.js";
import { log } from "./log.js";
import { persistIteration } from "./loop.js";
import { buildReviewPrompt } from "./prompts.js";
import {
  findWorkerByName, updateWorkerFields,
  type WorkerEntry,
} from "./registry.js";
import { windowExists, killWindowSafe } from "./tmux.js";
import { growLoopHooks } from "./grow-continue.js";
import { trellisLoopHooks } from "./trellis-continue.js";
import { buildTrellisReviewPrompt } from "./trellis-prompts.js";
import {
  parseTrellisVerdict, parseDriftList, parseFlaggedClauses, renderDriftItem,
  type TrellisVerdictResult,
} from "./trellis-verdict.js";
import { parseLastLineVerdict } from "./verdict.js";
import { reviewWindowName } from "./window-names.js";
import { signalFifoPath, scheduleDelayedPoke } from "./poller-fifo.js";
import { transitionState } from "./poller-state.js";

// Wall-clock ceiling on a single reviewer or resolver run. If the tmux window
// is still alive past this, the poller kills it and escalates to `failing`.
// Catches hung subprocesses the reviewer can't escape from (e.g. a `npm test`
// that blocks forever because tests have no timeout and the sandbox silently
// denies their network calls).
export const REVIEW_TIMEOUT_MS = 60 * 60 * 1000;

// Transient-review auto-retry budget. When the reviewer's output ends in an
// Anthropic API error (5xx / 429 / 529 / overloaded_error / rate_limit_error)
// and the reviewer didn't commit anything, handleTransientReviewFailure
// re-queues the review on this schedule instead of escalating immediately.
// The backoffs array is indexed by attempt number (1-based), so we read
// TRANSIENT_REVIEW_BACKOFFS_MS[reviewRetryCount] *after* incrementing the
// counter. Past the budget, we fall through to `failing` with
// failingReason="transient-review" — operator can `garden kick` to retry.
export const MAX_TRANSIENT_REVIEW_RETRIES = 3;
export const TRANSIENT_REVIEW_BACKOFFS_MS: readonly number[] = [
  30_000,    // 30s
  120_000,   // 2m
  300_000,   // 5m
];

// Threshold past which `agentStatus="working"` is treated as stale in
// handleWorking — i.e. the worker's Claude is hung (sandbox-killed, network
// died mid-stream, in-flight bug). Hooks fire on every tool use and on Stop,
// so a healthy working Claude emits something well inside this window;
// silence past the threshold means the status is no longer accurate.
// Tuned conservative enough that a slow think-then-act turn won't trip it.
export const STALE_AGENT_STATUS_MS = 15 * 60 * 1000;

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
  // what sets pendingReviewAt, so agentStatus should already be "idle" by
  // the time we get here — this guard catches the race where a fresh
  // UserPromptSubmit landed between the Stop and the poller wake.
  //
  // Stale-status escape hatch: hooks fire on every tool use, so even a
  // long-running Claude turn emits something every few minutes. If
  // agentStatus has been pinned to "working" with no hook activity past
  // STALE_AGENT_STATUS_MS, the worker's Claude is hung (crashed mid-stream,
  // sandbox-killed, etc.). Without this escape hatch, `garden kick` on a
  // failing worker whose Claude is stuck would re-arm pendingReviewAt but
  // the review would still never launch — exactly the wedged state the
  // operator hit. We log a warn so the staleness is visible.
  if (entry.agentStatus === "working") {
    const stale = entry.lastEventAt !== undefined
      && Date.now() - entry.lastEventAt >= STALE_AGENT_STATUS_MS;
    if (!stale) return false;
    log.warn("poller", "agentStatus=working is stale; proceeding with review launch", {
      worker: entry.name,
      data: {
        project: projectName,
        lastEventAt: entry.lastEventAt,
        ageMs: entry.lastEventAt ? Date.now() - entry.lastEventAt : null,
      },
    });
  }

  // Transient-review backoff gate. handleTransientReviewFailure schedules a
  // delayed poke at reviewRetryAt, but the FIFO can also be poked by sibling
  // events (another worker's Stop hook, an operator kick) before the backoff
  // elapses. Without this check, an early poke would launch the review
  // immediately and burn the budget on the same transient outage.
  if (entry.reviewRetryAt && entry.reviewRetryAt > Date.now()) {
    const remaining = entry.reviewRetryAt - Date.now();
    scheduleDelayedPoke(projectName, remaining);
    return false;
  }

  const wtPath = entry.worktreePath ?? projectPath;
  const ahead = hasCommitsAhead(wtPath, baseBranch);
  if (ahead === null) {
    // The git call failed (transient error/timeout), NOT "no commits". Clearing
    // pendingReviewAt here would silently cancel a review that should still
    // happen. Leave it set and re-poke so the next cycle retries the check.
    scheduleDelayedPoke(projectName, 30_000);
    return false;
  }
  if (!ahead) {
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

  // Reviewer window is gone — read result. Read BEFORE the worker-pushed-SHA
  // check below: a FIXED verdict where the reviewer pushed its fix and then
  // exited produces the same "window gone + SHA changed" predicate as a
  // worker push, so checking SHA first would silently drop the reviewer's
  // verdict and loop the review. The result file is the unambiguous signal
  // that the reviewer completed its turn.
  //
  // The trellis workflow has its own verdict vocabulary
  // (ALIGNED/DRIFT/FAILED/FLAGGED); default keeps CLEAN/FIXED/FAILED.
  // Unparseable handling below is workflow-agnostic. We read the raw output
  // once up front so transient-failure detection
  // (handleTransientReviewFailure) and the unparseable-verdict path can both
  // introspect it without re-reading after cleanReviewFiles deletes the file.
  const wtPath = entry.worktreePath ?? projectPath;
  const branchName = entry.branchName ?? entry.name;
  const isTrellis = entry.workflow === "trellis";
  const rawOutput = readReviewOutputRaw(projectName, entry);
  // Read the stderr sidecar up front too: cleanReviewFiles below deletes it,
  // and a non-claude reviewer's transient error lands only there (empty when
  // absent, e.g. claude-code, which has no sidecar).
  const rawStderrSidecar = readReviewStderrSidecar(projectName, entry);
  const review = rawOutput === null
    ? null
    : isTrellis
      ? parseTrellisReviewResult(rawOutput, entry.name, projectName)
      : parseReviewResult(rawOutput, entry.name, projectName);

  // Clean up files
  cleanReviewFiles(projectName, entry.name);

  if (review !== null) {
    log.info("poller", "review complete", {
      worker: entry.name,
      data: { project: projectName, verdict: review.verdict },
    });

    if (isTrellis) {
      return dispatchTrellisVerdict(
        projectName, projectPath, entry, review as TrellisVerdictResult,
      );
    }
    return dispatchDefaultVerdict(
      projectName, projectPath, baseBranch, entry, review as ReviewResult,
    );
  }

  // No parseable verdict. If the result file was genuinely absent AND the
  // remote SHA moved past the launch baseline, attribute the push to the
  // worker (the reviewer never wrote anything, so the SHA change can't be
  // its work) and reset to working. This is the original 2026-04 stuck-loop
  // repair, narrowed to the case where the reviewer left no trace.
  const remoteSha = getRemoteTrackingSha(wtPath, branchName);
  if (
    rawOutput === null
    && remoteSha
    && entry.lastSeenSha
    && remoteSha !== entry.lastSeenSha
  ) {
    resetToWorkingOnWorkerPush(projectName, wtPath, baseBranch, entry, "review");
    return true;
  }

  // Reviewer output is unparseable. If the tail matches an Anthropic API
  // error (5xx / 429 / overloaded_error / rate_limit_error) AND the reviewer
  // didn't commit anything (head not advanced past preReviewSha), treat it as
  // a transient failure: re-queue the review on a backoff. Anything else —
  // missing file, empty file, reviewer went off-rails, reviewer committed
  // work but skipped the verdict line — flows through the existing
  // unparseable-verdict path.
  // The reviewer's harness (independent of the worker's) knows its backend's
  // transient-error shapes. Codex sends the verdict to stdout (rawOutput) and
  // errors to a stderr sidecar, so inspect the sidecar too for a non-claude
  // reviewer; claude-code merges both into rawOutput (2>&1). Gate on the
  // combined source, NOT on rawOutput alone: a Codex transient backend error
  // typically writes nothing to stdout (rawOutput === null) and lands only in
  // the sidecar, so keying off rawOutput would skip the retry in exactly that
  // case. transientSource collapses to null when neither stream has content.
  const reviewerHarness = resolveReviewRole(
    tryGetProject(projectName) ?? {}, entry.workflow ?? "default", "reviewer",
  ).harness;
  const transientSource = (reviewerHarness === "claude-code"
    ? rawOutput
    : [rawOutput, rawStderrSidecar].filter(Boolean).join("\n")
  ) || null;
  if (
    transientSource !== null
    && getHarnessCore(reviewerHarness).isTransientError(transientSource)
    && !didReviewerAdvanceHead(projectPath, entry)
  ) {
    return handleTransientReviewFailure(projectName, projectPath, entry, transientSource);
  }
  return handleUnparseableReview(projectName, projectPath, entry);
}

// Did the reviewer's run move HEAD past the SHA captured at launch? The
// transient path only fires when the reviewer accomplished nothing — if HEAD
// advanced, the reviewer-committed-work recovery path in handleUnparseableReview
// is the right home (it force-pushes and re-queues, capturing whatever fix
// the reviewer did manage before the API blip).
function didReviewerAdvanceHead(projectPath: string, entry: WorkerEntry): boolean {
  const wtPath = entry.worktreePath ?? projectPath;
  const headSha = getBranchHeadSha(wtPath);
  return headSha !== null && entry.preReviewSha !== undefined
    && headSha !== entry.preReviewSha;
}

// Re-queue a review after a transient Anthropic API error in the reviewer's
// output. Up to MAX_TRANSIENT_REVIEW_RETRIES attempts on a backoff schedule;
// past that, the worker transitions to `failing` with
// failingReason="transient-review" — `garden kick` accepts that reason and
// re-queues without requiring new commits.
//
// The retry counter and next-attempt timestamp live on the WorkerEntry
// (reviewRetryCount / reviewRetryAt). handleWorking honors reviewRetryAt to
// avoid relaunching before the backoff elapses even if the FIFO is poked
// early by a sibling event. Both fields clear on any parseable verdict
// (dispatchDefaultVerdict / dispatchTrellisVerdict), on the non-transient
// unparseable path (handleUnparseableReview), on review timeout, and on a
// mid-review worker push (resetToWorkingOnWorkerPush).
function handleTransientReviewFailure(
  projectName: string,
  projectPath: string,
  entry: WorkerEntry,
  rawOutput: string,
): boolean {
  const wtPath = entry.worktreePath ?? projectPath;
  const headSha = getBranchHeadSha(wtPath);
  const prior = entry.reviewRetryCount ?? 0;
  const next = prior + 1;
  const tail = rawOutput.split("\n").reverse().find(l => l.trim())?.trim() ?? "";

  if (next > MAX_TRANSIENT_REVIEW_RETRIES) {
    log.warn("poller", "transient review retries exhausted, transitioning to failing", {
      worker: entry.name,
      data: { project: projectName, attempts: prior, lastLine: tail },
    });
    addAlert({
      level: "error",
      source: "review",
      project: projectName,
      worker: entry.name,
      message:
        `Review for worker ${entry.name} failed ${prior} times due to ` +
        `Anthropic API errors. Run \`garden kick ${entry.name}\` once the ` +
        `Anthropic API recovers, or investigate via the reviewer log.`,
      // Tail content varies per attempt; pin the dedup key to the worker so
      // repeated exhaustions don't spam.
      dedupKey: `transient-review-exhausted:${projectName}:${entry.name}`,
    });
    transitionState(projectName, entry.name, "failing", {
      failCount: (entry.failCount ?? 0) + 1,
      failingReason: "transient-review",
      failingSha: headSha ?? undefined,
      lastSeenSha: headSha ?? undefined,
      lastShaChangeAt: new Date().toISOString(),
      reviewWindowName: undefined,
      reviewStartedAt: undefined,
      reviewRetryCount: undefined,
      reviewRetryAt: undefined,
    });
    refreshDashboard();
    return true;
  }

  // Schedule the next attempt. The backoffs array is 0-indexed by prior count
  // (first retry uses [0], second uses [1], ...). The poke wakes the poller
  // at +backoffMs; handleWorking sees pendingReviewAt set, checks reviewRetryAt
  // for backoff readiness, and launches the review.
  const backoffMs = TRANSIENT_REVIEW_BACKOFFS_MS[prior] ?? TRANSIENT_REVIEW_BACKOFFS_MS[TRANSIENT_REVIEW_BACKOFFS_MS.length - 1];
  const nextAt = Date.now() + backoffMs;
  log.info("poller", "transient review failure; scheduling retry", {
    worker: entry.name,
    data: {
      project: projectName,
      attempt: next,
      maxAttempts: MAX_TRANSIENT_REVIEW_RETRIES,
      backoffMs,
      lastLine: tail,
    },
  });
  transitionState(projectName, entry.name, "working", {
    pendingReviewAt: Date.now(),
    reviewRetryCount: next,
    reviewRetryAt: nextAt,
    reviewWindowName: undefined,
    reviewStartedAt: undefined,
    preReviewSha: undefined,
  });
  refreshDashboard();
  scheduleDelayedPoke(projectName, backoffMs);
  return true;
}

// The reviewer exited but its output didn't emit a recognizable verdict.
// Two recovery paths, in order:
//
//  1. The reviewer DID commit something (rebase, fixes) — head advanced past
//     entry.preReviewSha — and we haven't already retried. Force-push the
//     reviewer's work and re-queue one more review. The second reviewer
//     usually sees a clean state and emits CLEAN.
//
//  2. Otherwise (no advance, or already retried once): transition to
//     `failing` with reason "unparseable-verdict" and an operator alert.
//     Capped at one retry per cycle so a reviewer that can't verbalize
//     doesn't loop forever.
function handleUnparseableReview(
  projectName: string,
  projectPath: string,
  entry: WorkerEntry,
): boolean {
  const wtPath = entry.worktreePath ?? projectPath;
  const headSha = getBranchHeadSha(wtPath);
  const headAdvanced = headSha !== null && entry.preReviewSha !== undefined &&
    headSha !== entry.preReviewSha;
  const alreadyRetried = entry.unparseableReviewAt !== undefined;

  if (headAdvanced && !alreadyRetried) {
    const branchName = entry.branchName ?? entry.name;
    try {
      forcePushBranch(wtPath, branchName);
    } catch (err) {
      log.error("poller", "force-push on unparseable-verdict retry failed", {
        worker: entry.name,
        data: { project: projectName, error: String(err) },
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
        reviewRetryCount: undefined,
        reviewRetryAt: undefined,
      });
      refreshDashboard();
      return true;
    }
    log.info("poller", "unparseable verdict with reviewer commits; re-queueing review", {
      worker: entry.name,
      data: { project: projectName },
    });
    transitionState(projectName, entry.name, "working", {
      pendingReviewAt: Date.now(),
      unparseableReviewAt: Date.now(),
      lastSeenSha: headSha ?? undefined,
      lastShaChangeAt: new Date().toISOString(),
      reviewWindowName: undefined,
      reviewStartedAt: undefined,
      preReviewSha: undefined,
      reviewRetryCount: undefined,
      reviewRetryAt: undefined,
    });
    refreshDashboard();
    scheduleDelayedPoke(projectName, 0);
    return true;
  }

  log.warn("poller", "review process failed, transitioning to failing", {
    worker: entry.name,
    data: { project: projectName },
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
    reviewRetryCount: undefined,
    reviewRetryAt: undefined,
  });
  refreshDashboard();
  return true;
}

// Force-push the worker's branch after a passing/aligned/drift verdict.
// On failure: log, bounce the worker back to `working` (clearing review
// fields so the next cycle starts cleanly), refresh the dashboard, and
// return false so the caller can early-return without further state work.
// Returns true on success.
//
// `context` is a short tag for the log line ("review", "trellis review",
// "trellis DRIFT") so an operator grepping logs can tell which verdict
// path failed to push.
function tryForcePushAfterReview(
  projectName: string,
  entry: WorkerEntry,
  wtPath: string,
  branchName: string,
  context: string,
): boolean {
  try {
    forcePushBranch(wtPath, branchName);
    return true;
  } catch (err) {
    log.error("poller", `force-push after ${context} failed`, {
      worker: entry.name,
      data: { project: projectName, error: String(err) },
    });
    // Do NOT leave the worker in an unwatched `working` state with the verdict
    // discarded — that strands the pipeline silently. Re-arm for a retry
    // (pendingReviewAt + a delayed poke) so a transient push failure (network,
    // or a lease mismatch from a push on another machine) self-heals via a
    // fresh review, and alert so a persistent failure (e.g. branch protection)
    // is visible. The deduped alert fires at most once per window and the 30s
    // poke floor keeps a permanent failure from tight-looping a review per poke.
    addAlert({
      level: "warn",
      source: "poller",
      project: projectName,
      worker: entry.name,
      message: `Force-push after ${context} failed for '${entry.name}'; re-queuing a review to retry. ${String(err).slice(0, 200)}`,
      dedupKey: `push-failed:${projectName}:${entry.name}`,
    });
    transitionState(projectName, entry.name, "working", {
      pendingReviewAt: Date.now(),
      reviewWindowName: undefined,
      reviewStartedAt: undefined,
      // Fresh cycle: reset the resolver budget and stale resolve state, matching
      // resetToWorkingOnWorkerPush / finalizeMerge, so a re-reviewed worker never
      // inherits a prior cycle's exhausted budget.
      resolveAttempts: 0,
      preResolveSha: undefined,
      lastResolveBody: undefined,
    });
    refreshDashboard();
    scheduleDelayedPoke(projectName, 30_000);
    return false;
  }
}

// Default workflow verdict dispatcher. Pre-trellis, this logic was inline
// in handleReviewing; phase 2 extracted it so the trellis dispatcher
// can sit beside it without growing handleReviewing into a giant branch.
function dispatchDefaultVerdict(
  projectName: string,
  projectPath: string,
  baseBranch: string,
  entry: WorkerEntry,
  review: ReviewResult,
): boolean {
  if (review.verdict === "clean" || review.verdict === "fixed") {
    const wtPath = entry.worktreePath ?? projectPath;
    const branchName = entry.branchName ?? entry.name;
    // Stale-verdict guard (CLEAN only). A CLEAN verdict means the reviewer found
    // nothing to change, so it committed and pushed nothing. If origin/<branch>
    // has nonetheless advanced past the SHA the reviewer reviewed (lastSeenSha,
    // captured from the remote ref at launch), the worker itself published new
    // commits during the review — force-pushing now would merge never-reviewed
    // code under a CLEAN stamp. Discard the stale verdict and re-review.
    //
    // Deliberately NOT applied to FIXED: a reviewer that fixes DOES sometimes
    // push its own commit (the west-old-reef incident), which is
    // SHA-indistinguishable from a worker push (both leave origin == local HEAD
    // in the shared worktree). CLEAN carries no such ambiguity — a clean review
    // never pushes — so the remote-advance signal is unambiguous there. A null
    // remoteSha (no remote / transient git failure) fails open to dispatch,
    // matching the review===null worker-push guard above.
    if (review.verdict === "clean") {
      const remoteSha = getRemoteTrackingSha(wtPath, branchName);
      if (remoteSha && entry.lastSeenSha && remoteSha !== entry.lastSeenSha) {
        resetToWorkingOnWorkerPush(projectName, wtPath, baseBranch, entry, "review");
        return true;
      }
    }
    if (!tryForcePushAfterReview(projectName, entry, wtPath, branchName, "review")) {
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
      reviewRetryCount: undefined,
      reviewRetryAt: undefined,
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
    reviewRetryCount: undefined,
    reviewRetryAt: undefined,
  });
  refreshDashboard();
  return true;
}

// Trellis verdict dispatcher. See WORKFLOWS.md "One iteration, in detail" /
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

  // Log a single structured info line per iteration. driftCount and
  // alignedCount are only meaningful on DRIFT verdicts (the body parses
  // a structured drift block); the other verdicts log the same shape with
  // 0 / undefined so the operator can grep iteration history uniformly.
  // See WORKFLOWS.md "Logs".
  const trellisData = entry.trellis;
  const driftPreview = review.verdict === "DRIFT" ? parseDriftList(review.body) : undefined;
  log.info("poller", "trellis iteration", {
    worker: entry.name,
    data: {
      project: projectName,
      trellis: trellisData?.name,
      iteration: trellisData?.iteration,
      verdict: review.verdict,
      driftCount: driftPreview?.items.length ?? 0,
      alignedCount: driftPreview?.alignedCount ?? trellisData?.alignedCount,
    },
  });

  if (review.verdict === "ALIGNED") {
    if (!tryForcePushAfterReview(projectName, entry, wtPath, branchName, "trellis review")) {
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
      reviewWindowName: undefined,
      reviewStartedAt: undefined,
      unparseableReviewAt: undefined,
      reviewRetryCount: undefined,
      reviewRetryAt: undefined,
      trellis: {
        lastVerdict: "ALIGNED",
        // `aligned` distinguishes reviewer-declared success from operator
        // sentinel-set; finalizeMerge preserves it into `done`.
        aligned: true,
        // Clear the drift list — the loop converged.
        lastDrift: undefined,
      },
    });
    refreshDashboard();
    scheduleDelayedPoke(projectName, 0);
    return true;
  }

  if (review.verdict === "DRIFT") {
    const drift = parseDriftList(review.body);
    const driftLines = drift.items.map((it, i) => renderDriftItem(it, i));
    if (!tryForcePushAfterReview(projectName, entry, wtPath, branchName, "trellis DRIFT")) {
      return true;
    }
    transitionState(projectName, entry.name, "merge-pending", {
      mergePendingAt: new Date().toISOString(),
      lastReviewBody: review.body,
      reviewWindowName: undefined,
      reviewStartedAt: undefined,
      unparseableReviewAt: undefined,
      reviewRetryCount: undefined,
      reviewRetryAt: undefined,
      trellis: {
        lastVerdict: "DRIFT",
        lastDrift: driftLines,
        alignedCount: drift.alignedCount,
      },
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
    const trellisName = trellisData?.name ?? "?";
    addAlert({
      level: "error",
      source: "trellis",
      project: projectName,
      worker: entry.name,
      message:
        `Trellis '${trellisName}' flagged for worker ${entry.name}: ${detail}. ` +
        `Run 'garden trellis amend ${projectName} ${trellisName === "?" ? "<name>" : trellisName}' or ` +
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
      reviewWindowName: undefined,
      reviewStartedAt: undefined,
      preReviewSha: undefined,
      unparseableReviewAt: undefined,
      reviewRetryCount: undefined,
      reviewRetryAt: undefined,
      trellis: {
        lastVerdict: "FLAGGED",
        flaggedClauses: clauses.length > 0 ? clauses : undefined,
      },
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
    reviewWindowName: undefined,
    reviewStartedAt: undefined,
    preReviewSha: undefined,
    unparseableReviewAt: undefined,
    reviewRetryCount: undefined,
    reviewRetryAt: undefined,
    trellis: { lastVerdict: "FAILED" },
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
    { worker: entry.name, data: { project: projectName } },
  );
  killReviewWindow(projectName, entry.name);

  const commitSummary = getCommitSummary(wtPath, baseBranch);
  const hasCommits = commitSummary.length > 0;

  transitionState(projectName, entry.name, "working", {
    lastShaChangeAt: new Date().toISOString(),
    reviewWindowName: undefined,
    reviewStartedAt: undefined,
    resolveAttempts: 0,
    preResolveSha: undefined,
    lastResolveBody: undefined,
    mergePendingAt: undefined,
    // Worker pushed mid-review: this is a fresh cycle, reset transient retry
    // state so any prior in-flight backoff doesn't bleed into the new review.
    reviewRetryCount: undefined,
    reviewRetryAt: undefined,
    pendingReviewAt: hasCommits ? Date.now() : entry.pendingReviewAt,
  });
  refreshDashboard();
  // The FIFO poke that woke us dispatched to the prior state's handler, not
  // handleWorking. Schedule an immediate re-poke so the next tick picks up
  // pendingReviewAt via handleWorking.
  scheduleDelayedPoke(projectName, 0);
}

// Pokes the project's FIFO after REVIEW_TIMEOUT_MS so the poller wakes to
// run the `isReviewTimedOut` check below — a hung reviewer produces no events
// on its own, so without this the timeout would never be detected. Spurious
// pokes after normal completion are harmless (handlers no-op).
//
// Delegates to scheduleDelayedPoke for the same reason b6c4c87 was reverted
// for that helper in ef12da0: the in-process `setTimeout(...).unref()`
// shortcut is dropped at the calling _poll Node child's exit, so the FIFO
// never sees the byte. A detached bash subprocess survives the parent's exit.
// The reviewer scheduling site has the same lifecycle as scheduleDelayedPoke's
// — both fire from inside _poll's synchronous lifecycle work — so the fix is
// the same. Symptom of the unref'd version: a hung reviewer wedges the
// worker in `reviewing` forever, blocking the merge → post-merge auto-continue
// path and leaving the worker idle "waiting for continuation that never comes."
export function scheduleReviewTimeoutPoke(projectName: string): void {
  scheduleDelayedPoke(projectName, REVIEW_TIMEOUT_MS);
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
    data: { project: projectName, kind, elapsedMs, timeoutMs: REVIEW_TIMEOUT_MS },
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
    reviewRetryCount: undefined,
    reviewRetryAt: undefined,
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
  const isGrow = entry.workflow === "grow";

  // Trellis workflow: increment iteration counter *before* the budget check
  // and *before* dispatch (WORKFLOWS.md "One iteration, in detail" / step 5).
  // After the increment, the counter reflects the iteration about to be
  // reviewed (1 during the first review, 2 during the second, etc.). When
  // the increment exceeds maxIterations, short-circuit to failing with
  // failingReason="iteration-budget" — the iteration cap is the primary
  // safety net (Invariant 4).
  if (isTrellis) {
    const state = trellisLoopHooks.readIteration(entry);
    const nextIter = (state?.iteration ?? 0) + 1;
    const cap = state?.maxIterations ?? 30;
    if (nextIter > cap) {
      const headSha = getBranchHeadSha(wtPath);
      const lastDriftPreview = (entry.trellis?.lastDrift ?? []).slice(0, 3).join("; ");
      addAlert({
        level: "error",
        source: "trellis",
        project: projectName,
        worker: entry.name,
        message:
          `Trellis '${entry.trellis?.name ?? "?"}' iteration budget exhausted ` +
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
    // Persist the increment before dispatch via the shared loop primitive
    // (writes to disk + updates the in-memory entry) so handleReviewing's
    // verdict logging and any concurrent `garden trellis status` see the
    // right iteration number.
    persistIteration(projectName, entry.name, entry, trellisLoopHooks, nextIter);
  }

  // Grow workflow: increment iteration counter before dispatch. No budget
  // check at preflight — grow's terminal-on-budget is `done`, fired
  // post-merge in maybeAutoContinue. The increment + persist is shared
  // with trellis via persistIteration; the grow-specific bookkeeping is
  // the sub-object field path (entry.grow.iteration vs
  // entry.trellis.iteration), encapsulated in growLoopHooks.
  if (isGrow) {
    const state = growLoopHooks.readIteration(entry);
    const nextIter = (state?.iteration ?? 0) + 1;
    persistIteration(projectName, entry.name, entry, growLoopHooks, nextIter);
  }

  // Fetch latest base branch so the reviewer can rebase onto it
  try {
    execFileSync("git", ["fetch", "origin", baseBranch], {
      cwd: wtPath,
      stdio: "ignore",
    });
  } catch (err) {
    log.debug("poller", "fetch before review failed", { worker: entry.name, data: { project: projectName, error: String(err) } });
  }

  // Build the review prompt with the workflow-appropriate vocabulary.
  const prompt = isTrellis
    ? buildTrellisReviewPrompt(projectName, projectPath, baseBranch, entry)
    : buildReviewPrompt(projectName, projectPath, baseBranch, entry);

  if (prompt === null) {
    log.warn("poller", "failed to build review prompt", { worker: entry.name, data: { project: projectName } });
    return false;
  }

  // GARDEN_REVIEWER=1 marks this Claude as the reviewer so its hooks
  // (sessionstart/prompt/stop fired from the same worktree as the worker)
  // can be distinguished from worker hooks and short-circuited by the
  // hook handler. Without this, the reviewer's Stop hook would be treated
  // as the worker's Stop hook and would (a) write agentStatus="idle" for
  // the worker, and (b) poke the poller to start another review.
  //
  // Reviewer role resolution: harness + model + env, arbitrary-per-role but
  // defaulting to a strong first-party Anthropic reviewer (Opus). That default
  // is the safety net that makes a cheap/experimental worker safe to try —
  // resolveReviewRole's claude-code env prefix also neutralizes any provider
  // env inherited from the tmux server so the reviewer never runs against the
  // worker's backend. Codex-as-reviewer (`garden config <p> role reviewer
  // harness codex`) flows through the same path with its own auth and no
  // Anthropic env. See docs/MULTI-MODEL.md "Phase 4".
  const reviewer = resolveReviewRole(
    tryGetProject(projectName) ?? {}, entry.workflow ?? "default", "reviewer",
  );
  const revWindow = reviewWindowName(projectName, entry.name);
  launchHeadlessAgent({
    cwd: wtPath,
    windowName: revWindow,
    prompt,
    promptFile: reviewPromptPath(projectName, entry.name),
    resultFile: reviewResultPath(projectName, entry.name),
    envPrefix: reviewer.envPrefix,
    envVars: { GARDEN_REVIEWER: "1" },
    signalFifo: signalFifoPath(projectName),
    onLaunched: () => scheduleReviewTimeoutPoke(projectName),
    model: reviewer.model,
    harness: reviewer.harness,
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
    data: isTrellis
      ? { project: projectName, iteration: entry.trellis?.iteration }
      : { project: projectName },
  });
  return true;
}

// Read the reviewer's result file and return its trimmed contents, or null on
// missing/empty/unreadable. Split out from parse so handleReviewing can pass
// the raw string to both the verdict parser and the transient-failure
// detector without re-reading after cleanReviewFiles deletes the file.
function readReviewOutputRaw(
  projectName: string,
  entry: WorkerEntry,
): string | null {
  const resultFile = reviewResultPath(projectName, entry.name);

  try {
    if (!fs.existsSync(resultFile)) {
      log.warn("poller", "review result file missing", { worker: entry.name, data: { project: projectName } });
      return null;
    }

    const output = fs.readFileSync(resultFile, "utf-8").trim();
    if (!output) {
      log.warn("poller", "review result file empty", { worker: entry.name, data: { project: projectName } });
      return null;
    }
    return output;
  } catch (err) {
    log.warn("poller", "failed to read review result", {
      worker: entry.name,
      data: { project: projectName, error: String(err) },
    });
    return null;
  }
}

function parseReviewResult(output: string, workerName: string, projectName: string): ReviewResult | null {
  const parsed = parseLastLineVerdict(output, REVIEW_VERDICT_VOCAB);
  if (!parsed) {
    const lastLine = output.split("\n").reverse().find(l => l.trim()) ?? "";
    log.warn("poller", "could not parse review verdict", {
      worker: workerName,
      data: { project: projectName, lastLine: lastLine.trim() },
    });
    return null;
  }
  const body = parsed.body || "No additional comments.";
  return { verdict: parsed.verdict.toLowerCase() as ReviewResult["verdict"], body };
}

// Trellis variant of parseReviewResult — parses with the trellis vocabulary
// (ALIGNED/DRIFT/FAILED/FLAGGED). Returns null on unparseable output; the
// caller's existing unparseable-verdict retry path handles it.
function parseTrellisReviewResult(
  output: string,
  workerName: string,
  projectName: string,
): TrellisVerdictResult | null {
  const parsed = parseTrellisVerdict(output);
  if (!parsed) {
    const lastLine = output.split("\n").reverse().find(l => l.trim()) ?? "";
    log.warn("poller", "could not parse trellis verdict", {
      worker: workerName,
      data: { project: projectName, lastLine: lastLine.trim() },
    });
    return null;
  }
  return { verdict: parsed.verdict, body: parsed.body || "No additional comments." };
}

export function killReviewWindow(projectName: string, workerName: string): void {
  const revWindow = reviewWindowName(projectName, workerName);
  if (windowExists(revWindow)) {
    killWindowSafe(revWindow);
  }
  cleanReviewFiles(projectName, workerName);
}

export function cleanReviewFiles(projectName: string, workerName: string): void {
  const resultFile = reviewResultPath(projectName, workerName);
  try { fs.unlinkSync(resultFile); } catch { /* ignore */ }
  try { fs.unlinkSync(codexStderrSidecar(resultFile)); } catch { /* ignore */ }
  try { fs.unlinkSync(reviewPromptPath(projectName, workerName)); } catch { /* ignore */ }
}

// The stderr sidecar written by a non-claude headless reviewer (Codex sends
// its verdict to stdout, errors + progress to stderr). Returns "" when absent
// (claude-code merges stderr into the result file, so there is no sidecar).
function readReviewStderrSidecar(projectName: string, entry: WorkerEntry): string {
  const sidecar = codexStderrSidecar(reviewResultPath(projectName, entry.name));
  try {
    return fs.existsSync(sidecar) ? fs.readFileSync(sidecar, "utf-8").trim() : "";
  } catch {
    return "";
  }
}

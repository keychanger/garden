// Review lifecycle: launching reviewers, parsing verdicts, handling the
// reviewing-state events, retries on unparseable output, timeouts.
//
// The reviewer is a separate Claude process running `claude -p` inside the
// worker's worktree, in a hidden tmux window. GARDEN_REVIEWER=1 marks its
// hooks so they don't get treated as worker hooks.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { tryGetProject, getMaxConcurrentReviews } from "../config.js";
import { addAlert } from "./alerts.js";
import { atomicWriteFile } from "./atomic-write.js";
import { resolveReviewRole, SAFE_REVIEW_MODEL } from "./roles.js";
import { reviewerEnvPrefix, reviewerEnvObject } from "./claude-env.js";
import { extractReviewVerdict } from "./verdict-extract.js";
import { codexStderrSidecar } from "./harness/codex-core.js";
import { getHarnessCore } from "./harness/core.js";
import { setDoneSentinel } from "./continue.js";
import {
  forcePushBranch, getBranchHeadSha, getCommitSummary, getRemoteTrackingSha,
  getDiffNumstat, hasCommitsAhead, getChangedFiles, isWorktreeDirty,
} from "./git.js";
import { getWorkflow } from "./workflows/index.js";
import { isPublishablePath } from "./botanist-paths.js";
import { refreshDashboard } from "./header.js";
import { launchHeadlessAgent } from "./headless-agent.js";
import { resolveHeadlessLaunchPlan } from "./launch-plan.js";
import { log } from "./log.js";
import { persistIteration } from "./loop.js";
import { buildReviewPrompt } from "./prompts.js";
import { MAX_REVIEW_PROMPT_BYTES, reviewPromptBytes } from "./prompt-compose.js";
import {
  findWorkerByName, updateWorkerFields,
  type WorkerEntry,
} from "./registry.js";
import { windowExists, killWindowSafe, listAllWindowNames } from "./tmux.js";
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
import { recordReviewVerdict } from "./telemetry.js";
import {
  holisticFindingsPath,
  reviewPromptPath,
  reviewResultPath,
} from "./headless-paths.js";

export { reviewPromptPath, reviewResultPath } from "./headless-paths.js";

// Wall-clock ceiling on a single reviewer or resolver run. If the tmux window
// is still alive past this, the poller kills it and escalates to `failing`.
// Catches hung subprocesses the reviewer can't escape from (e.g. a `npm test`
// that blocks forever because tests have no timeout and the sandbox silently
// denies their network calls).
export const REVIEW_TIMEOUT_MS = 60 * 60 * 1000;

// Cap on the reviewer body stored in the durable lastReview snapshot (registry
// is read/written on the hook hot path, so the blob stays bounded). The tail is
// kept — the verdict rationale and any error trailer land at the end.
const REVIEW_BODY_TAIL_CHARS = 4000;

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

// Session/usage-quota retry schedule (handleQuotaLimitReview). Only a
// claude-code reviewer reaches this ladder: a FOREIGN reviewer (codex) that
// hits its quota falls back to the first-party Opus reviewer immediately
// (handleQuotaFallbackReview) rather than waiting out a multi-day subscription
// window. A claude-code quota IS the operator's own rolling window, which resets
// on an hours scale — so unlike the transient ladder this is a FLAT ~15-min
// cadence over a ~6h ceiling (24 retries), landing a relaunch within 15 min of
// the true reset regardless of when in the window it was hit. Past the budget →
// `failing`/"quota" (kick-recoverable).
export const QUOTA_REVIEW_BACKOFF_MS = 15 * 60_000; // 15m
export const MAX_QUOTA_REVIEW_RETRIES = 24;         // 24 × 15m ≈ 6h

// Unparseable-verdict auto-retry budget (handleUnparseableReview). When the
// reviewer ended its turn with no parseable verdict AND committed nothing —
// e.g. it emitted a filler sentence ("I'll wait for the workflow result...")
// instead of a standalone CLEAN/FIXED/FAILED token — the reviewed diff is
// unchanged and usually fine; the reviewer just failed to verbalize the
// verdict. That is a benign, non-deterministic flake, so re-run the review a
// bounded number of times on a short backoff before escalating. Past the
// budget → `failing` with failingReason="unparseable-verdict" (kick-recoverable).
// A flat (not laddered) backoff: unlike a transient API outage there is nothing
// external to wait out — a fresh reviewer run almost always emits the verdict —
// so the delay just lets the old subprocess die and avoids a tight relaunch loop.
export const MAX_UNPARSEABLE_REVIEW_RETRIES = 2;
export const UNPARSEABLE_REVIEW_BACKOFF_MS = 15_000; // 15s

// Threshold past which `agentStatus="working"` is treated as stale in
// handleWorking — i.e. the worker's Claude is hung (sandbox-killed, network
// died mid-stream, in-flight bug). Hooks fire on every tool use and on Stop,
// so a healthy working Claude emits something well inside this window;
// silence past the threshold means the status is no longer accurate.
//
// Must exceed the longest legitimate hook-silent stretch: a single Bash call
// emits no hook until it completes, and a worker running `garden checks` can
// sit in one such call for the checks-semaphore wait ceiling
// (DEFAULT_MAX_WAIT_MS = 45m, checks-semaphore.ts) plus the suite runtime. At
// the old 15m this fired mid-suite and launched a reviewer into the live
// worktree. Set well above that ceiling; the clean-worktree gate in
// handleWorking is the real protection against clobbering live edits.
export const STALE_AGENT_STATUS_MS = 60 * 60 * 1000;

const REVIEW_VERDICT_VOCAB = ["CLEAN", "FIXED", "FAILED"] as const;

export interface ReviewResult {
  verdict: "clean" | "fixed" | "failed";
  body: string;
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
  const wtPath = entry.worktreePath ?? projectPath;

  if (entry.agentStatus === "working") {
    const stale = entry.lastEventAt !== undefined
      && Date.now() - entry.lastEventAt >= STALE_AGENT_STATUS_MS;
    if (!stale) return false;
    // Stale status does not prove the worker is dead — a long hook-silent
    // `garden checks` call looks identical. launchReview rebases and
    // force-pushes in this same worktree (cwd: wtPath), so never proceed while
    // the worktree has uncommitted changes: that would clobber a live worker's
    // edits. Defer unless the tree is provably clean (an indeterminate git
    // result is treated as dirty).
    if (isWorktreeDirty(wtPath) !== false) {
      log.debug("poller", "stale-working review deferred: worktree not provably clean", {
        worker: entry.name,
        data: { project: projectName },
      });
      return false;
    }
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

  // Skip-review workflows (botanist): the branch carries a design artifact the
  // operator already reviewed at the human gate, not code — so no reviewer runs.
  // Route working -> merge-pending directly, after enforcing that the committed
  // diff touches only publishable docs/ paths.
  if (getWorkflow(entry.workflow ?? "default").skipsReviewMerge) {
    return handleSkipReviewMerge(projectName, entry, wtPath, baseBranch);
  }

  // Fleet-wide review concurrency cap (garden-level limits.maxConcurrentReviews).
  // Reviews are the pipeline's entry point; when the machine is already running
  // the configured number of reviewers, defer this launch rather than
  // oversubscribing. pendingReviewAt stays set, so the re-poke (or any sibling
  // FIFO event, e.g. a review finishing and freeing a slot) re-drives this
  // handler and the launch proceeds once a slot opens. 0 = unlimited (default),
  // in which case the count is not even taken.
  const reviewCap = getMaxConcurrentReviews();
  if (reviewCap > 0 && countActiveReviewWindows() >= reviewCap) {
    log.debug("poller", "review deferred: fleet review cap reached", {
      worker: entry.name,
      data: { project: projectName, cap: reviewCap },
    });
    scheduleDelayedPoke(projectName, REVIEW_CAP_RETRY_MS);
    return false;
  }

  return launchReview(projectName, projectPath, baseBranch, entry);
}

// A skip-review (botanist) worker with commits ahead of base. Enforce the
// writeable-path boundary, then transition straight to merge-pending — no
// reviewer, since the operator already reviewed the artifact at the gate. A
// committed file outside docs/ (a botanist that drifted into building code)
// parks the worker in `failing` with an operator alert; removing the offending
// files and re-pushing auto-retries the publish (see handleFailing).
function handleSkipReviewMerge(
  projectName: string,
  entry: WorkerEntry,
  wtPath: string,
  baseBranch: string,
): boolean {
  const offending = getChangedFiles(wtPath, baseBranch).filter(f => !isPublishablePath(f));
  if (offending.length > 0) {
    const shown = offending.slice(0, 5).join(", ");
    const more = offending.length > 5 ? ` (+${offending.length - 5} more)` : "";
    const headSha = getBranchHeadSha(wtPath) ?? undefined;
    log.warn("poller", "botanist committed files outside docs/; parking in failing", {
      worker: entry.name, data: { project: projectName, offending },
    });
    addAlert({
      level: "error",
      source: "poller",
      project: projectName,
      worker: entry.name,
      message: `Botanist ${entry.name} committed files outside docs/ — refusing to merge: ${shown}${more}. `
        + `A botanist publishes design docs, not code. Remove the non-doc files and re-push to retry.`,
      dedupKey: `botanist-scope:${projectName}:${entry.name}`,
    });
    transitionState(projectName, entry.name, "failing", {
      pendingReviewAt: undefined,
      failingReason: "botanist-scope",
      // Park until a NEW commit (the fix) lands: handleFailing re-arms on a sha
      // change, so setting failingSha stops the debounce-timeout retry loop.
      failingSha: headSha,
      lastSeenSha: headSha,
    });
    refreshDashboard();
    return true;
  }
  log.info("poller", "botanist publish: skipping review, merging directly", {
    worker: entry.name, data: { project: projectName },
  });
  transitionState(projectName, entry.name, "merge-pending", {
    mergePendingAt: new Date().toISOString(),
    pendingReviewAt: undefined,
  });
  refreshDashboard();
  scheduleDelayedPoke(projectName, 0);
  return true;
}

export function handleReviewing(
  projectName: string,
  projectPath: string,
  baseBranch: string,
  entry: WorkerEntry,
): boolean {
  // A mutating tool call landed on the worker while this review was in flight
  // (hooks/default.ts stamps reviewInterruptedAt): the reviewer shares the
  // worker's worktree, so the tree it is certifying is being rewritten under
  // it. Any verdict from this pass is untrustworthy — a CLEAN would hand the
  // live worktree to the merge queue's cleanWorktree — so cancel it, even if
  // the reviewer already finished and wrote a result. Checked before the
  // holistic branch: the interposed whole-task pass shares the worktree and
  // the hazard. The re-review happens at quiescence via the worker's next Stop.
  if (entry.reviewInterruptedAt) {
    return cancelReviewOnWorkerEdit(projectName, projectPath, baseBranch, entry);
  }
  // The interposed whole-task final review (poller-holistic-review.ts) runs in
  // the same reviewing window but is dispatched differently — no per-phase diff,
  // no 2nd review, CLEAN finalizes to done, a fix rides the merge gate. It owns
  // its own timeout + window-wait, so branch before the per-phase machinery.
  if (entry.holisticFinalActive) {
    return handleHolisticFinalReview(projectName, projectPath, baseBranch, entry);
  }
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
    return recordAndDispatchReview(
      projectName, projectPath, baseBranch, entry, review, isTrellis, wtPath,
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
    tryGetProject(projectName) ?? {}, entry.workflow ?? "default", "reviewer", undefined, entry,
  ).harness;
  // If a prior quota fallback is active, THIS review ran on the fallback harness
  // (claude-code/Opus), not the configured one — launchReview overrode it. So
  // classify against the harness the review ACTUALLY used: output-stream
  // assembly (sidecar vs merged stdout), core selection, the further-fallback
  // guard, and the alert naming would all key off the wrong (foreign) harness
  // otherwise. Cleared on the next fresh cycle, so the configured reviewer resumes.
  const effectiveReviewerHarness = entry.reviewFallbackHarness ?? reviewerHarness;
  const transientSource = (effectiveReviewerHarness === "claude-code"
    ? rawOutput
    : [rawOutput, rawStderrSidecar].filter(Boolean).join("\n")
  ) || null;
  const core = getHarnessCore(effectiveReviewerHarness);
  // Whether the reviewer committed work before its output ran out. If so we
  // never relaunch on top of it (a quota or transient retry would) — it falls
  // through to handleUnparseableReview's force-push + re-queue recovery.
  const reviewerAdvanced = didReviewerAdvanceHead(projectPath, entry);
  // Quota BEFORE transient. A session/usage-limit cutoff needs an hours-scale
  // wait for the operator's window to reset, not a seconds retry — and codex's
  // "429 insufficient_quota" would otherwise trip the bare-429 transient rule.
  // (This detector only runs on an already-unparseable review, so a real
  // CLEAN/FIXED verdict — even one whose body mentions a "session limit" — has
  // already dispatched above and can never reach it. That parse-first ordering
  // is load-bearing; do not move this below verdict dispatch.)
  if (transientSource !== null && !reviewerAdvanced) {
    const resetHint = core.quotaLimitResetHint(transientSource);
    if (resetHint !== null) {
      // A FOREIGN reviewer's quota is a multi-day subscription window — waiting
      // it out would wedge the whole project's merge pipeline. Fall back to the
      // first-party Opus safety net immediately (operator decision 2026-07-16).
      // A claude-code reviewer (the configured default, or a fallback that ALSO
      // hit quota) has no stronger fallback: wait out the operator's own rolling
      // window on the flat 15-min ladder.
      if (effectiveReviewerHarness !== "claude-code") {
        return handleQuotaFallbackReview(
          projectName, projectPath, entry, effectiveReviewerHarness, resetHint,
        );
      }
      return handleQuotaLimitReview(
        projectName, projectPath, entry, resetHint, effectiveReviewerHarness,
      );
    }
  }
  if (
    transientSource !== null
    && core.isTransientError(transientSource)
    && !reviewerAdvanced
  ) {
    return handleTransientReviewFailure(projectName, projectPath, entry, transientSource);
  }

  // The reviewer produced a genuine conclusion but no parseable verdict token,
  // and it is not a transient/quota error (those returned above). Rather than
  // re-run the whole review, ask a cheap Haiku to read the reviewer's own output
  // and classify its verdict — the reviewer already decided, it just failed to
  // format the final line. Default workflow only: the trellis DRIFT verdict
  // carries a structured drift list a one-word extraction can't reconstruct, so
  // trellis keeps re-reviewing (falls straight through to handleUnparseableReview).
  if (!isTrellis && rawOutput && rawOutput.trim()) {
    const project = tryGetProject(projectName) ?? {};
    const extracted = extractReviewVerdict(rawOutput, {
      env: { ...process.env, ...reviewerEnvObject(project) },
    });
    if (extracted !== null) {
      log.info("poller", "recovered review verdict via haiku extraction", {
        worker: entry.name,
        data: { project: projectName, verdict: extracted },
      });
      const recovered: ReviewResult = { verdict: extracted.toLowerCase() as ReviewResult["verdict"], body: rawOutput.trim() };
      return recordAndDispatchReview(
        projectName, projectPath, baseBranch, entry, recovered, false, wtPath,
      );
    }
    log.info("poller", "haiku extraction did not recover a verdict; falling through to re-review", {
      worker: entry.name,
      data: { project: projectName },
    });
  }
  return handleUnparseableReview(projectName, projectPath, entry);
}

// Verdict handler for the interposed whole-task final review (holisticFinalActive).
// Reuses the per-phase read/parse/timeout helpers but its own disposition:
//   fix   → FIXED-with-commits rides the CI + merge gate (marker persists so the
//           merge finalizes straight to done); CLEAN / no-commit finalizes done;
//           FAILED parks in failing.
//   shadow → reports findings as an alert, then finalizes done (never merges).
// A best-effort pass: an unparseable/transient outcome with no commit finalizes
// done rather than failing a task whose work already merged and passed per-phase
// review. Only an explicit FAILED verdict fails the worker. Harness-agnostic: a
// codex reviewer writes its verdict to the result file (stdout) like claude does.
function handleHolisticFinalReview(
  projectName: string,
  projectPath: string,
  baseBranch: string,
  entry: WorkerEntry,
): boolean {
  if (isReviewTimedOut(entry)) {
    return handleReviewTimeout(projectName, projectPath, entry, "review");
  }
  const revWindow = entry.reviewWindowName;
  if (revWindow && windowExists(revWindow)) return false; // still in-flight

  const wtPath = entry.worktreePath ?? projectPath;
  const branchName = entry.branchName ?? entry.name;
  const mode = entry.holisticReviewMode ?? "fix";
  const mergeCount = entry.mergeCount ?? 0;

  const rawOutput = readReviewOutputRaw(projectName, entry);
  const review = rawOutput === null ? null : parseReviewResult(rawOutput, entry.name, projectName);
  cleanReviewFiles(projectName, entry.name);

  // Finalize the worker back to `done`, clearing the final-review markers and
  // bumping the high-water guard past this mergeCount so it never re-fires.
  const finalizeDone = (): void => {
    transitionState(projectName, entry.name, "done", {
      holisticReviewedThroughMergeCount: mergeCount,
      holisticFinalActive: undefined,
      holisticReviewMode: undefined,
      reviewWindowName: undefined,
      reviewStartedAt: undefined,
      preReviewSha: undefined,
      lastReviewBody: undefined,
    });
    refreshDashboard();
  };

  if (mode === "shadow") {
    // Analysis-only: surface findings, never merge. A durable copy lands in the
    // trusted reports directory so the operator can read past the alert cap.
    const findings = (review?.body ?? rawOutput ?? "").trim();
    const coherent = review?.verdict === "clean";
    const durable = holisticFindingsPath(projectName, entry.name);
    try { atomicWriteFile(durable, findings || "CLEAN — no cross-phase defects."); } catch { /* best effort */ }
    addAlert({
      level: "warn",
      source: "poller",
      project: projectName,
      worker: entry.name,
      message: coherent
        ? `Holistic review CLEAN (${entry.name}): no cross-phase defects. ${durable}`
        : `Holistic review FINDINGS (${entry.name}): ${findings.slice(0, 160).replace(/\s+/g, " ")} … ${durable}`,
      dedupKey: `holistic-findings:${projectName}:${entry.name}`,
    });
    log.info("poller", "holistic shadow review complete", {
      worker: entry.name, data: { project: projectName, coherent },
    });
    finalizeDone();
    return true;
  }

  const headSha = getBranchHeadSha(wtPath);
  const committed = headSha !== null && entry.preReviewSha !== undefined
    && headSha !== entry.preReviewSha;

  // FAILED — the reviewer found a cross-phase defect it could not fix.
  if (review?.verdict === "failed") {
    addAlert({
      level: "error",
      source: "review",
      project: projectName,
      worker: entry.name,
      message: `Holistic review could not fix a cross-phase defect for ${entry.name}: ${review.body.slice(0, 300)}`,
      dedupKey: `holistic-failed:${projectName}:${entry.name}`,
    });
    transitionState(projectName, entry.name, "failing", {
      failCount: (entry.failCount ?? 0) + 1,
      failingReason: "code",
      failingSha: headSha ?? undefined,
      lastSeenSha: headSha ?? undefined,
      lastShaChangeAt: new Date().toISOString(),
      reviewWindowName: undefined,
      reviewStartedAt: undefined,
      preReviewSha: undefined,
      holisticReviewedThroughMergeCount: mergeCount,
      holisticFinalActive: undefined,
      holisticReviewMode: undefined,
    });
    refreshDashboard();
    return true;
  }

  // A fix was committed (FIXED, or an unparseable verdict that nonetheless left
  // commits): force-push and ride the normal CI + merge gate. holisticFinalActive
  // rides merge-pending so transitionToTerminal finalizes the fix merge to done.
  if (committed && (review === null || review.verdict === "fixed")) {
    try {
      forcePushBranch(wtPath, branchName);
    } catch (err) {
      log.error("poller", "holistic fix force-push failed; finalizing done without the fix", {
        worker: entry.name, data: { project: projectName, error: String(err) },
      });
      addAlert({
        level: "warn",
        source: "poller",
        project: projectName,
        worker: entry.name,
        message: `Holistic review fixed a defect for ${entry.name} but the push failed; the fix was not merged. ${String(err).slice(0, 150)}`,
        dedupKey: `holistic-push-failed:${projectName}:${entry.name}`,
      });
      finalizeDone();
      return true;
    }
    log.info("poller", "holistic review fixed a cross-phase defect; merging", {
      worker: entry.name, data: { project: projectName },
    });
    transitionState(projectName, entry.name, "merge-pending", {
      mergePendingAt: new Date().toISOString(),
      lastReviewBody: review?.body,
      reviewWindowName: undefined,
      reviewStartedAt: undefined,
      // holisticFinalActive + holisticReviewMode persist for the merge finalizer.
    });
    refreshDashboard();
    scheduleDelayedPoke(projectName, 0);
    return true;
  }

  // CLEAN, FIXED-without-commits, or a best-effort skip (unparseable / transient
  // with no commit): nothing to merge — the whole-task review is complete.
  if (review === null) {
    log.warn("poller", "holistic review verdict unparseable; finalizing done (best-effort pass)", {
      worker: entry.name, data: { project: projectName },
    });
  } else {
    log.info("poller", "holistic review complete", {
      worker: entry.name, data: { project: projectName, verdict: review.verdict },
    });
  }
  finalizeDone();
  return true;
}

// Record the durable last-review snapshot + telemetry for a parsed (or
// Haiku-recovered) verdict, then hand off to the workflow's verdict dispatcher.
// Shared by the normal parse path and the Haiku-extraction fallback so both
// record identically. preReviewSha is still on the entry here (the failing/merge
// resets that clear it run inside dispatch); tipSha is the reviewed HEAD. The
// snapshot is recorded even in the uncommon case a downstream guard then
// discards the verdict (the worker pushed mid-review, or the post-review
// force-push failed); the next review overwrites it, so any staleness is
// transient and read-only.
function recordAndDispatchReview(
  projectName: string,
  projectPath: string,
  baseBranch: string,
  entry: WorkerEntry,
  review: ReviewResult | TrellisVerdictResult,
  isTrellis: boolean,
  wtPath: string,
): boolean {
  const tipSha = getBranchHeadSha(wtPath) ?? undefined;
  updateWorkerFields(projectName, entry.name, {
    lastReview: {
      verdict: review.verdict,
      at: Date.now(),
      body: review.body.slice(-REVIEW_BODY_TAIL_CHARS),
      preReviewSha: entry.preReviewSha,
      tipSha,
    },
  });

  // Ledger the verdict with the signal the `state` event can't carry: review
  // duration and the reviewer's fix magnitude (numstat of preReviewSha..tipSha
  // — zero on CLEAN, the edit size on FIXED).
  const fix = entry.preReviewSha && tipSha
    ? getDiffNumstat(wtPath, entry.preReviewSha, tipSha)
    : { files: 0, insertions: 0, deletions: 0 };
  recordReviewVerdict(projectName, entry.name, entry.createdAt, entry.workflow ?? "default", {
    verdict: review.verdict,
    durationMs: entry.reviewStartedAt ? Date.now() - entry.reviewStartedAt : undefined,
    fixFiles: fix.files,
    fixInsertions: fix.insertions,
    fixDeletions: fix.deletions,
    preReviewSha: entry.preReviewSha,
    tipSha,
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
      unparseableRetryCount: undefined,
      quotaRetryCount: undefined,
      reviewFallbackHarness: undefined,
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

// Human label for a reviewer harness in operator-facing alerts. "Claude" reads
// better than the internal "claude-code" id; a foreign harness is title-cased
// (codex -> Codex).
function harnessDisplayName(harness: string): string {
  if (harness === "claude-code") return "Claude";
  return harness.charAt(0).toUpperCase() + harness.slice(1);
}

// The reviewer hit its session/usage QUOTA cutoff with no parseable verdict and
// no committed work. Only a claude-code reviewer reaches here — a foreign
// reviewer (codex) falls back to the first-party Opus reviewer instead of
// waiting out its multi-day window (handleQuotaFallbackReview) — so the wait is
// the operator's own rolling Claude window: unlike a transient API blip it
// resets on an hours scale, so auto-retry on a FLAT ~15-min cadence until it
// clears, up to MAX_QUOTA_REVIEW_RETRIES (~6h), then park in `failing`/"quota"
// (kick-recoverable). A 15-min relaunch lands within 15 min of the reset with no
// operator action. Reuses reviewRetryAt as the cause-agnostic relaunch gate
// (handleWorking) but keeps its own quotaRetryCount budget so a fast transient
// blip and this hours-scale wait can't conflate. reviewerHarness names the
// blocked harness in the alert (and the reset time when known).
function handleQuotaLimitReview(
  projectName: string,
  projectPath: string,
  entry: WorkerEntry,
  resetHint: string,
  reviewerHarness: string,
): boolean {
  const wtPath = entry.worktreePath ?? projectPath;
  const headSha = getBranchHeadSha(wtPath);
  const prior = entry.quotaRetryCount ?? 0;
  const next = prior + 1;
  const resetSuffix = resetHint ? ` (resets ${resetHint})` : "";
  const label = harnessDisplayName(reviewerHarness);

  if (next > MAX_QUOTA_REVIEW_RETRIES) {
    log.warn("poller", "quota review retries exhausted, transitioning to failing", {
      worker: entry.name,
      data: { project: projectName, attempts: prior, harness: reviewerHarness },
    });
    addAlert({
      level: "error",
      source: "review",
      project: projectName,
      worker: entry.name,
      message:
        `Review for worker ${entry.name} is still blocked by the ${label} ` +
        `usage/session limit${resetSuffix} after ${prior} auto-retries. Run ` +
        `\`garden kick ${entry.name}\` once its window has reset.`,
      dedupKey: `quota-review-exhausted:${projectName}:${entry.name}`,
    });
    transitionState(projectName, entry.name, "failing", {
      failCount: (entry.failCount ?? 0) + 1,
      failingReason: "quota",
      failingSha: headSha ?? undefined,
      lastSeenSha: headSha ?? undefined,
      lastShaChangeAt: new Date().toISOString(),
      reviewWindowName: undefined,
      reviewStartedAt: undefined,
      reviewRetryCount: undefined,
      unparseableRetryCount: undefined,
      reviewRetryAt: undefined,
      quotaRetryCount: undefined,
      reviewFallbackHarness: undefined,
    });
    refreshDashboard();
    return true;
  }

  // Alert once, on first detection (prior===0), so the operator isn't spammed
  // across the multi-hour wait; intermediate retries only log.
  if (prior === 0) {
    addAlert({
      level: "warn",
      source: "review",
      project: projectName,
      worker: entry.name,
      message:
        `Review for worker ${entry.name} paused: the ${label} reviewer hit its ` +
        `usage/session limit${resetSuffix}. Auto-retrying every 15 min until the ` +
        `window resets; run \`garden kick ${entry.name}\` to retry now.`,
      dedupKey: `quota-review:${projectName}:${entry.name}`,
    });
  }

  const nextAt = Date.now() + QUOTA_REVIEW_BACKOFF_MS;
  log.info("poller", "quota review cutoff; scheduling long-backoff retry", {
    worker: entry.name,
    data: {
      project: projectName,
      attempt: next,
      maxAttempts: MAX_QUOTA_REVIEW_RETRIES,
      backoffMs: QUOTA_REVIEW_BACKOFF_MS,
      resetHint,
    },
  });
  transitionState(projectName, entry.name, "working", {
    pendingReviewAt: Date.now(),
    quotaRetryCount: next,
    reviewRetryAt: nextAt,
    reviewWindowName: undefined,
    reviewStartedAt: undefined,
    preReviewSha: undefined,
  });
  refreshDashboard();
  scheduleDelayedPoke(projectName, QUOTA_REVIEW_BACKOFF_MS);
  return true;
}

// A project-configured FOREIGN reviewer (e.g. codex) hit its usage/quota cutoff.
// Unlike a claude-code reviewer's rolling window (hours), a foreign subscription
// window resets on a multi-day scale — so retrying it would wedge the whole
// project's merge pipeline for days. Operator decision (2026-07-16): fall back
// to the first-party Opus safety net immediately. Re-queue THIS review at once
// (no backoff) with reviewFallbackHarness set, which (a) makes launchReview pin
// the review to claude-code/Opus regardless of project.roles, and (b) marks the
// relaunch as a retry so the loop iteration counter is not re-incremented. The
// flag persists across the fallback review's own retries and clears on the next
// fresh cycle, so the configured reviewer is retried automatically once its
// window resets. The override is surfaced with a warn alert (deduped per worker/
// hour) so garden stepping in for the operator's explicit reviewer choice is
// visible without spamming across a multi-day window.
function handleQuotaFallbackReview(
  projectName: string,
  projectPath: string,
  entry: WorkerEntry,
  blockedHarness: string,
  resetHint: string,
): boolean {
  const label = harnessDisplayName(blockedHarness);
  const resetSuffix = resetHint ? ` (resets ${resetHint})` : "";
  log.info("poller", "reviewer quota; falling back to first-party Opus", {
    worker: entry.name,
    data: { project: projectName, blockedHarness, resetHint },
  });
  addAlert({
    level: "warn",
    source: "review",
    project: projectName,
    worker: entry.name,
    message:
      `Review for worker ${entry.name}: the ${label} reviewer is quota-blocked` +
      `${resetSuffix} — falling back to the first-party Opus reviewer for this ` +
      `review. ${label} resumes automatically once its window resets.`,
    dedupKey: `quota-fallback:${projectName}:${entry.name}`,
  });
  transitionState(projectName, entry.name, "working", {
    pendingReviewAt: Date.now(),
    reviewFallbackHarness: "claude-code",
    reviewWindowName: undefined,
    reviewStartedAt: undefined,
    preReviewSha: undefined,
  });
  refreshDashboard();
  scheduleDelayedPoke(projectName, 0);
  return true;
}

// The reviewer exited but its output didn't emit a recognizable verdict.
// Three recovery paths, in order:
//
//  1. The reviewer DID commit something (rebase, fixes) — head advanced past
//     entry.preReviewSha — and we haven't already retried. Force-push the
//     reviewer's work and re-queue one more review. The second reviewer
//     usually sees a clean state and emits CLEAN.
//
//  2. The reviewer committed nothing (head unchanged) and the no-commit retry
//     budget (MAX_UNPARSEABLE_REVIEW_RETRIES) remains: re-queue the review on a
//     short backoff. This catches the benign flake where the reviewer ended its
//     turn with prose instead of a verdict token — the diff is fine, the
//     reviewer just failed to verbalize, and a fresh run almost always emits it.
//
//  3. Otherwise (head advanced but already retried once, or the no-commit budget
//     is exhausted): transition to `failing` with reason "unparseable-verdict"
//     and an operator alert. `garden kick` re-queues from there. The bounded
//     budgets keep a reviewer that can't verbalize from looping forever.
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
        unparseableRetryCount: undefined,
        quotaRetryCount: undefined,
        reviewFallbackHarness: undefined,
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
      unparseableRetryCount: undefined,
      quotaRetryCount: undefined,
      reviewFallbackHarness: undefined,
      reviewRetryAt: undefined,
    });
    refreshDashboard();
    scheduleDelayedPoke(projectName, 0);
    return true;
  }

  // No reviewer commits to capture and the diff is unchanged: the reviewer
  // ended its turn with prose instead of a verdict token (e.g. it kicked off
  // async sub-work and stopped before folding the result into a final
  // CLEAN/FIXED/FAILED line). That is a benign, non-deterministic flake — the
  // reviewed code is probably fine — not a code failure. Give it a bounded
  // auto-retry on a short backoff before parking in `failing`, mirroring
  // handleTransientReviewFailure: a fresh reviewer run almost always emits the
  // verdict. Only the no-advance case is eligible — if the reviewer committed
  // work, the head-advanced path above owns recovery (we must never relaunch a
  // review on top of unpushed reviewer commits). reviewRetryAt is the shared
  // cause-agnostic relaunch gate honored by handleWorking; unparseableRetryCount
  // is this path's own budget so it can't conflate with the transient/quota
  // ladders. Both clear on any parseable verdict, worker push, or timeout.
  if (!headAdvanced) {
    const prior = entry.unparseableRetryCount ?? 0;
    const next = prior + 1;
    if (next <= MAX_UNPARSEABLE_REVIEW_RETRIES) {
      const nextAt = Date.now() + UNPARSEABLE_REVIEW_BACKOFF_MS;
      log.info("poller", "unparseable verdict with no reviewer commits; scheduling retry", {
        worker: entry.name,
        data: {
          project: projectName,
          attempt: next,
          maxAttempts: MAX_UNPARSEABLE_REVIEW_RETRIES,
          backoffMs: UNPARSEABLE_REVIEW_BACKOFF_MS,
        },
      });
      transitionState(projectName, entry.name, "working", {
        pendingReviewAt: Date.now(),
        unparseableRetryCount: next,
        reviewRetryAt: nextAt,
        reviewWindowName: undefined,
        reviewStartedAt: undefined,
        preReviewSha: undefined,
      });
      refreshDashboard();
      scheduleDelayedPoke(projectName, UNPARSEABLE_REVIEW_BACKOFF_MS);
      return true;
    }
  }

  // Head advanced and the one-shot re-queue is already spent, OR the no-commit
  // retry budget is exhausted: park in `failing` with reason
  // "unparseable-verdict". Kick-recoverable (kick.ts REVIEW_SIDE_FAILING_REASONS).
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
    unparseableRetryCount: undefined,
    quotaRetryCount: undefined,
    reviewFallbackHarness: undefined,
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
      unparseableRetryCount: undefined,
      quotaRetryCount: undefined,
      reviewFallbackHarness: undefined,
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
    unparseableRetryCount: undefined,
    quotaRetryCount: undefined,
    reviewFallbackHarness: undefined,
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
      unparseableRetryCount: undefined,
      quotaRetryCount: undefined,
      reviewFallbackHarness: undefined,
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
    // DRIFT is mergeable; iterate. When the reviewer named drift but emitted no
    // parseable bullets (parseDriftList null), seed the continue prompt with its
    // raw prose instead of an empty list — an empty list fires the continue
    // builder's "none reported" branch, inviting a false convergence.
    const driftLines = drift
      ? drift.items.map((it, i) => renderDriftItem(it, i))
      : [review.body.trim().split("\n").slice(0, 8).join(" ").slice(0, 400)
          || "reviewer reported drift without structured items"];
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
      unparseableRetryCount: undefined,
      quotaRetryCount: undefined,
      reviewFallbackHarness: undefined,
      reviewRetryAt: undefined,
      trellis: {
        lastVerdict: "DRIFT",
        lastDrift: driftLines,
        alignedCount: drift?.alignedCount,
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
      unparseableRetryCount: undefined,
      quotaRetryCount: undefined,
      reviewFallbackHarness: undefined,
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
    unparseableRetryCount: undefined,
    quotaRetryCount: undefined,
    reviewFallbackHarness: undefined,
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
    unparseableRetryCount: undefined,
    quotaRetryCount: undefined,
    reviewFallbackHarness: undefined,
    reviewRetryAt: undefined,
    pendingReviewAt: hasCommits ? Date.now() : entry.pendingReviewAt,
  });
  refreshDashboard();
  // The FIFO poke that woke us dispatched to the prior state's handler, not
  // handleWorking. Schedule an immediate re-poke so the next tick picks up
  // pendingReviewAt via handleWorking.
  scheduleDelayedPoke(projectName, 0);
}

// The worker ran a mutating tool while its review was in flight (marker
// stamped by hooks/default.ts, checked at the top of handleReviewing). Kill
// the reviewer and reset to working; the verdict — even one already written —
// is discarded, since it certifies a tree that was rewritten under it.
// resetToWorkingOnWorkerPush's sibling for the operator-prompt race rather
// than the worker-push race, so it additionally clears the holistic markers
// (the whole-task pass shares the worktree and is cancelled the same way; the
// holistic gate re-evaluates at the worker's next terminal transition).
export function cancelReviewOnWorkerEdit(
  projectName: string,
  projectPath: string,
  baseBranch: string,
  entry: WorkerEntry,
): boolean {
  log.info("poller", "review cancelled: worker edited worktree mid-review", {
    worker: entry.name,
    data: {
      project: projectName,
      holistic: entry.holisticFinalActive === true,
      interruptedAt: entry.reviewInterruptedAt,
    },
  });
  killReviewWindow(projectName, entry.name);

  const wtPath = entry.worktreePath ?? projectPath;
  const hasCommits = getCommitSummary(wtPath, baseBranch).length > 0;

  transitionState(projectName, entry.name, "working", {
    reviewInterruptedAt: undefined,
    reviewWindowName: undefined,
    reviewStartedAt: undefined,
    reviewRetryCount: undefined,
    unparseableRetryCount: undefined,
    quotaRetryCount: undefined,
    reviewFallbackHarness: undefined,
    reviewRetryAt: undefined,
    holisticFinalActive: undefined,
    holisticReviewMode: undefined,
    // Keep the review armed: the branch still holds unreviewed commits.
    // handleWorking's agentStatus="working" guard defers the relaunch until
    // the worker goes quiet, and its Stop hook independently re-marks + pokes
    // — this is the belt for a worker whose Stop never fires (killed mid-turn).
    pendingReviewAt: hasCommits ? Date.now() : undefined,
  });
  refreshDashboard();
  return true;
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
    unparseableRetryCount: undefined,
    quotaRetryCount: undefined,
    reviewFallbackHarness: undefined,
    reviewRetryAt: undefined,
    // A timed-out holistic final review resolves to `failing` here; clear its
    // in-flight markers so a later re-open (failing -> working -> reviewing) is
    // routed to the per-phase reviewer, not misrouted back to
    // handleHolisticFinalReview. Undefined for a per-phase review, so this is a
    // no-op there (STATUS.md: the markers clear when the pass resolves).
    holisticFinalActive: undefined,
    holisticReviewMode: undefined,
  });
  refreshDashboard();
  return true;
}

// Count live headless-reviewer windows across the whole dashboard session
// (every project's `_<project>-review-<worker>`, including holistic passes).
// Tmux is the source of truth for window existence, so this is derived fresh
// each call — no acquire/release bookkeeping to leak across the fire-and-forget
// reviewer launches. The `-worker-`/`-ci-fix-` exclusions guard the (unlikely)
// case of a project whose name ends in "review". ci-fix agents run in a
// name-distinct `-ci-fix-` window and are excluded here — the cap throttles
// the pipeline's inflow, not its drain. Resolvers reuse the review window name
// (`reviewWindowName` in poller-resolve.ts), so a running resolver DOES count;
// that is benign because resolver launches are never gated by this cap (the
// gate lives only in handleWorking), so a deferred review simply waits for the
// resolver to drain and free the slot — it can never deadlock — and resolvers
// (rebase-conflict only) are rare.
export function countActiveReviewWindows(): number {
  return listAllWindowNames().filter(
    (n) => n.includes("-review-") && !n.includes("-worker-") && !n.includes("-ci-fix-"),
  ).length;
}

// Re-poke cadence when a review launch is deferred by the fleet-wide review
// cap. Short enough that a freed slot is picked up promptly, long enough not to
// spin — the poll is also woken by any sibling FIFO event (a review finishing).
const REVIEW_CAP_RETRY_MS = 20_000;

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

  // A retry relaunch (a transient- or quota-review backoff re-queued the SAME
  // iteration through `working`) re-drives launchReview without any new worker
  // work: the reviewer failed to emit a verdict, the commits are unchanged.
  // The loop iteration counter must track real iterations, not retries, so a
  // retry must NOT re-increment it (nor re-run the trellis budget check). Left
  // unguarded, a quota wait's flat 15-min ladder (budget MAX_QUOTA_REVIEW_RETRIES
  // = 24) would inflate trellis.iteration / grow.iteration by up to 24 while the
  // operator's Claude window is exhausted — tripping the trellis iteration-budget
  // cap prematurely (parking in the non-kick-recoverable failing/"iteration-budget"
  // with amend/raise-budget advice instead of the kick-recoverable failing/"quota"
  // wait it actually is) and ending grow loops several passes early once the
  // window resets and the review merges. reviewRetryCount / quotaRetryCount /
  // unparseableRetryCount are set by handleTransientReviewFailure /
  // handleQuotaLimitReview / handleUnparseableReview and cleared on any
  // parseable verdict or worker push, so their presence uniquely marks a retry
  // relaunch. unparseableRetryCount belongs here too: a no-commit unparseable
  // retry re-reviews the SAME commits (the reviewer emitted no verdict and did
  // no work), so it must not consume a loop iteration either. reviewFallbackHarness
  // likewise marks a relaunch: a quota fallback re-reviews the SAME commits on the
  // Opus safety net, so it must not re-increment the loop counter.
  const isRetryRelaunch =
    (entry.reviewRetryCount ?? 0) > 0
    || (entry.quotaRetryCount ?? 0) > 0
    || (entry.unparseableRetryCount ?? 0) > 0
    || entry.reviewFallbackHarness !== undefined;

  // Trellis workflow: increment iteration counter *before* the budget check
  // and *before* dispatch (WORKFLOWS.md "One iteration, in detail" / step 5).
  // After the increment, the counter reflects the iteration about to be
  // reviewed (1 during the first review, 2 during the second, etc.). When
  // the increment exceeds maxIterations, short-circuit to failing with
  // failingReason="iteration-budget" — the iteration cap is the primary
  // safety net (Invariant 4).
  if (isTrellis && !isRetryRelaunch) {
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
  if (isGrow && !isRetryRelaunch) {
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

  // Backstop. The builder already degrades an oversized branch delta to a file
  // summary the reviewer pages through itself (composeWithinCeiling), so a
  // prompt still over the ceiling here means the NON-diff context — rules, docs,
  // test files — is what does not fit, and no reviewer can be launched at all:
  // the agent CLI rejects the request before the reviewer starts. Park the
  // worker with the real reason rather than burning the retry ladder on three
  // doomed launches. NOT an operator-action reason: shrinking the branch
  // rewrites it, and the new SHA re-enters review through the normal failing
  // debounce — the fix retries itself.
  const promptBytes = reviewPromptBytes(prompt);
  if (promptBytes > MAX_REVIEW_PROMPT_BYTES) {
    const headSha = getBranchHeadSha(wtPath);
    const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)}MB`;
    addAlert({
      level: "error",
      source: "review",
      project: projectName,
      worker: entry.name,
      message:
        `Review prompt for ${entry.name} is ${mb(promptBytes)} (ceiling ${mb(MAX_REVIEW_PROMPT_BYTES)}) even `
        + `with the branch diff reduced to a file summary — the surrounding context (rules, docs, test files) `
        + `is too large for any reviewer's context window. `
        + `Split the work across smaller branches and push a reduced diff; the review retries on the new SHA.`,
      dedupKey: `oversized-diff:${projectName}:${entry.name}:${headSha ?? "?"}`,
    });
    log.warn("poller", "review prompt exceeds context ceiling; not launching", {
      worker: entry.name,
      data: {
        project: projectName,
        promptBytes,
        ceilingBytes: MAX_REVIEW_PROMPT_BYTES,
        baseBranch,
      },
    });
    transitionState(projectName, entry.name, "failing", {
      failCount: (entry.failCount ?? 0) + 1,
      failingReason: "oversized-diff",
      failingSha: headSha ?? undefined,
      lastSeenSha: headSha ?? undefined,
      lastShaChangeAt: new Date().toISOString(),
      pendingReviewAt: undefined,
    });
    refreshDashboard();
    return true;
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
  //
  // Quota fallback override: when the configured (foreign) reviewer is
  // quota-blocked, entry.reviewFallbackHarness pins THIS cycle to the pure
  // first-party Opus safety net — the fallback harness, the Opus model, and the
  // neutralizing reviewer env prefix — regardless of project.roles, so a
  // multi-day foreign-subscription window can't wedge the merge pipeline. The
  // model is SAFE_REVIEW_MODEL for every workflow (trellis's reviewerModel is
  // also "opus"). Cleared on the next fresh cycle, so the configured reviewer
  // resumes automatically (see handleQuotaFallbackReview).
  const projectCfg = tryGetProject(projectName) ?? {};
  const reviewer = entry.reviewFallbackHarness
    ? resolveHeadlessLaunchPlan({
        role: "reviewer",
        harness: entry.reviewFallbackHarness,
        model: SAFE_REVIEW_MODEL,
        envPrefix: reviewerEnvPrefix(projectCfg),
      })
    : resolveReviewRole(projectCfg, entry.workflow ?? "default", "reviewer", undefined, entry);
  const revWindow = reviewWindowName(projectName, entry.name);
  launchHeadlessAgent({
    cwd: wtPath,
    windowName: revWindow,
    prompt,
    promptFile: reviewPromptPath(projectName, entry.name),
    resultFile: reviewResultPath(projectName, entry.name),
    launchPlan: reviewer,
    envVars: { GARDEN_REVIEWER: "1" },
    signalFifo: signalFifoPath(projectName),
    onLaunched: () => scheduleReviewTimeoutPoke(projectName),
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
    // Defensively clear a leaked mid-review-edit marker: one stamped in the
    // instant between a prior pass's verdict dispatch and its poll would
    // otherwise cancel this fresh review on its first handleReviewing tick.
    reviewInterruptedAt: undefined,
    mergePendingAt: entry.mergePendingAt,
    preReviewSha,
    // Defensively clear any leaked holistic final-review markers. A per-phase
    // review launched here is NEVER the interposed whole-task pass (that runs
    // via launchHolisticFinalReview, which sets the markers itself and never
    // routes through launchReview). If a prior holistic FIX reached
    // merge-pending and then failed to merge (resolver/ci-fix budget exhausted,
    // wedged merge), the markers persist into `failing`; without this clear a
    // later failing -> working -> reviewing recovery would misroute this fresh
    // review to handleHolisticFinalReview (which finalizes CLEAN to `done`
    // without merging the recovery commits). STATUS.md: the markers clear when
    // the pass resolves — this is the resolution point for that merge-failed leg.
    holisticFinalActive: undefined,
    holisticReviewMode: undefined,
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

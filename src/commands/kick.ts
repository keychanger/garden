import { findWorkerByName, updateWorkerFields, type FailingReason } from "../dashboard/registry.js";
import { FRESH_REVIEW_CYCLE } from "../dashboard/cycle-resets.js";
import { triggerProjectPoll } from "../dashboard/poller.js";
import { transitionState } from "../dashboard/poller-state.js";
import { getCommitSummary, getWorkerBaseBranch } from "../dashboard/git.js";
import { stripControlSequences } from "../dashboard/tmux.js";
import { recordOperatorAction } from "../dashboard/telemetry.js";
import { tryGetProject } from "../config.js";
import { output } from "../output.js";
import { resolveWorkerArg } from "./resolve-worker.js";

// Failing reasons where the worker's *code* is fine and the failure is on the
// reviewer side — Anthropic API blip, reviewer crashed mid-stream, reviewer
// went off-rails without emitting a verdict, reviewer killed by the wall-clock
// cap before it could emit one. For these, `kick` re-queues the review without
// requiring new commits. A FAILED verdict is re-queued only on the explicit
// --retry-review; everything else (code, ci, oversized-diff) needs new commits
// — kick should refuse.
const REVIEW_SIDE_FAILING_REASONS: ReadonlySet<FailingReason> = new Set<FailingReason>([
  "unparseable-verdict",
  "transient-review",
  "quota",
  "review-timeout",
]);

export async function kick(args: string[]): Promise<void> {
  const arg = args[0];
  const retryReview = args[1] === "--retry-review";
  if (!arg || arg.startsWith("-") || args.length > 2 || (args.length === 2 && !retryReview)) {
    throw new Error("Usage: garden kick <worker> [--retry-review]");
  }

  const { project, worker: workerName, entry } = resolveWorkerArg(arg);
  const state = entry.prState;
  const agentStatus = entry.agentStatus;
  const failingReason = entry.failingReason;

  if (retryReview && !(state === "failing"
    && (failingReason === "code" || failingReason === undefined)
    && (entry.workflow ?? "default") === "default"
    && entry.lastReview?.verdict === "failed"
    && entry.failingSha !== undefined
    && entry.lastReview.tipSha === entry.failingSha)) {
    throw new Error("--retry-review requires a failed default-workflow review matching the failing SHA. Inspect 'garden review <worker>' first.");
  }

  const isReviewSideFailure = state === "failing"
    && failingReason !== undefined
    && REVIEW_SIDE_FAILING_REASONS.has(failingReason);

  if (state && state !== "working" && !isReviewSideFailure && !retryReview) {
    const hint = state === "failing"
      ? ` (failingReason='${failingReason ?? "code"}'). Kick only auto-recovers ` +
        `review-side failures (${[...REVIEW_SIDE_FAILING_REASONS].join(", ")}); ` +
        `for code failures push a new commit (or, after repairing the review environment, ` +
        `inspect garden review and use --retry-review for a fresh full review), for oversized-diff split the work ` +
        `across smaller branches (a retry on the same diff fails identically).`
      : `. Kick only re-arms workers stranded in working or review-side failing — ` +
        `for other states, investigate the poller log or the alerts panel.`;
    throw new Error(
      `Worker ${project}/${workerName} is in state '${state}'${hint}`,
    );
  }
  // A reviewer racing a live worker can force-push over unfinished commits.
  // For failing-state review-side recovery, this guard is operator-overridden:
  // the worker is already in `failing` (so no review cycle is in flight), the
  // operator is explicitly opting in to a retry, and `handleWorking` has its
  // own stale-status detection so a truly hung Claude won't deadlock the
  // launch. We still reject in the normal `working`-state kick path because
  // that's the path where the original race is reachable.
  if (!isReviewSideFailure && (agentStatus === "working" || agentStatus === "asking")) {
    throw new Error(
      `Worker ${project}/${workerName} is currently ${agentStatus} — Claude is ` +
      `still mid-turn. Kick only re-arms workers whose turn has ended ` +
      `(agentStatus=idle). Wait for the Stop hook, or if you believe the ` +
      `status is truly stuck, edit the registry directly.`,
    );
  }

  const projectInfo = tryGetProject(project);
  if (projectInfo) {
    const wtPath = entry.worktreePath ?? projectInfo.path;
    const baseBranch = getWorkerBaseBranch(entry, projectInfo.path);
    const commits = getCommitSummary(wtPath, baseBranch);
    if (!commits) {
      throw new Error(
        `Worker ${project}/${workerName} has no commits ahead of ${baseBranch} — nothing to review.`,
      );
    }
  }

  if (isReviewSideFailure || retryReview) {
    // Clear the failing pin and the retry state so handleWorking launches a
    // fresh review on the next poll. The guards above judged the entry as it
    // was read, so the move is made only while the worker is still in that
    // `failing`: one that left it since (a pushed fix the poller already took
    // back to working, a second kick) is not moved on a stale reading.
    const moved = transitionState(project, entry, "working", {
      pendingReviewAt: Date.now(),
      failingReason: undefined,
      failingSha: undefined,
      ...FRESH_REVIEW_CYCLE,
    });
    if (!moved) {
      const current = findWorkerByName(project, workerName);
      throw new Error(current
        ? `Worker ${project}/${workerName} moved from 'failing' to '${stripControlSequences(current.prState ?? "working")}' `
          + `while the kick ran; nothing was changed.`
        : `Worker ${project}/${workerName} was removed while the kick ran.`);
    }
    recordOperatorAction(project, workerName, entry.createdAt, entry.workflow ?? "default", "kick");
    triggerProjectPoll(project);
    const recoveredFrom = failingReason ?? "code";
    output({ project, worker: workerName, reviewQueued: true, recoveredFrom },
      () => `Kicked ${project}/${workerName} — recovered from failing (${recoveredFrom}), review re-queued.`);
    return;
  }

  updateWorkerFields(project, workerName, { pendingReviewAt: Date.now() });
  recordOperatorAction(project, workerName, entry.createdAt, entry.workflow ?? "default", "kick");
  triggerProjectPoll(project);
  output({ project, worker: workerName, reviewQueued: true },
    () => `Kicked ${project}/${workerName} — review queued.`);
}

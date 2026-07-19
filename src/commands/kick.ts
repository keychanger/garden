import { updateWorkerFields, type FailingReason } from "../dashboard/registry.js";
import { triggerProjectPoll } from "../dashboard/poller.js";
import { getCommitSummary, getWorkerBaseBranch } from "../dashboard/git.js";
import { recordOperatorAction } from "../dashboard/telemetry.js";
import { tryGetProject } from "../config.js";
import { resolveWorkerArg } from "./resolve-worker.js";

// Failing reasons where the worker's *code* is fine and the failure is on the
// reviewer side — Anthropic API blip, reviewer crashed mid-stream, reviewer
// went off-rails without emitting a verdict. For these, `kick` re-queues the
// review without requiring new commits. For everything else (code failure,
// trellis-flagged, iteration-budget, ci), new commits or the specific
// workflow command are the right recovery — kick should refuse.
const REVIEW_SIDE_FAILING_REASONS: ReadonlySet<FailingReason> = new Set<FailingReason>([
  "unparseable-verdict",
  "transient-review",
  "quota",
]);

export async function kick(args: string[]): Promise<void> {
  const arg = args[0];
  if (!arg) throw new Error("Usage: garden kick <worker>");

  const { project, worker: workerName, entry } = resolveWorkerArg(arg);
  const state = entry.prState;
  const agentStatus = entry.agentStatus;
  const failingReason = entry.failingReason;

  // failing → working recovery for review-side failures. The worker's code is
  // fine; the reviewer itself was unavailable or garbled. Clear the failing
  // pin and re-queue review without needing a new commit.
  const isReviewSideFailure = state === "failing"
    && failingReason !== undefined
    && REVIEW_SIDE_FAILING_REASONS.has(failingReason);

  if (state && state !== "working" && !isReviewSideFailure) {
    const hint = state === "failing"
      ? ` (failingReason='${failingReason ?? "code"}'). Kick only auto-recovers ` +
        `review-side failures (${[...REVIEW_SIDE_FAILING_REASONS].join(", ")}); ` +
        `for code failures push a new commit, for trellis-flagged run ` +
        `'garden trellis resume', for an exhausted iteration budget inspect and ` +
        `amend the trellis, then re-spawn the vine with a higher --max-iterations ` +
        `(or kill it).`
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

  // Past every guard — the kick will take effect on one of the two branches
  // below. Ledger the operator intervention once here so both paths are covered.
  recordOperatorAction(project, workerName, entry.createdAt, entry.workflow ?? "default", "kick");

  if (isReviewSideFailure) {
    // Clear the failing pin and the retry state so handleWorking launches a
    // fresh review on the next poll. prState moves failing → working via the
    // workflow's valid-transitions map.
    updateWorkerFields(project, workerName, {
      prState: "working",
      pendingReviewAt: Date.now(),
      failingReason: undefined,
      failingSha: undefined,
      unparseableReviewAt: undefined,
      reviewRetryCount: undefined,
      reviewRetryAt: undefined,
      quotaRetryCount: undefined,
      unparseableRetryCount: undefined,
    });
    triggerProjectPoll(project);
    console.log(`Kicked ${project}/${workerName} — recovered from failing (${failingReason}), review re-queued.`);
    return;
  }

  updateWorkerFields(project, workerName, { pendingReviewAt: Date.now() });
  triggerProjectPoll(project);
  console.log(`Kicked ${project}/${workerName} — review queued.`);
}

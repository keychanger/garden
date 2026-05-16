import { readRegistry, updateWorkerFields, type FailingReason } from "../dashboard/registry.js";
import { triggerProjectPoll } from "../dashboard/poller.js";
import { getCommitSummary, getWorkerBaseBranch } from "../dashboard/git.js";
import { tryGetProject } from "../config.js";

// Failing reasons where the worker's *code* is fine and the failure is on the
// reviewer side — Anthropic API blip, reviewer crashed mid-stream, reviewer
// went off-rails without emitting a verdict. For these, `kick` re-queues the
// review without requiring new commits. For everything else (code failure,
// trellis-flagged, iteration-budget, ci), new commits or the specific
// workflow command are the right recovery — kick should refuse.
const REVIEW_SIDE_FAILING_REASONS: ReadonlySet<FailingReason> = new Set<FailingReason>([
  "unparseable-verdict",
  "transient-review",
]);

export async function kick(args: string[]): Promise<void> {
  const workerName = args[0];
  if (!workerName) throw new Error("Usage: garden kick <worker>");

  const registry = readRegistry();
  const matches: Array<{
    project: string;
    worker: string;
    state?: string;
    claudeStatus?: string;
    failingReason?: FailingReason;
  }> = [];
  for (const [project, entries] of Object.entries(registry.workers)) {
    for (const entry of entries) {
      if (entry.name === workerName) {
        matches.push({
          project,
          worker: entry.name,
          state: entry.prState,
          claudeStatus: entry.claudeStatus,
          failingReason: entry.failingReason,
        });
      }
    }
  }

  if (matches.length === 0) {
    throw new Error(`No worker found with name '${workerName}'`);
  }
  if (matches.length > 1) {
    const list = matches.map(m => `  ${m.project}/${m.worker} (${m.state ?? "working"})`).join("\n");
    throw new Error(`Multiple workers match '${workerName}':\n${list}\nKill or rename one first.`);
  }

  const { project, state, claudeStatus, failingReason } = matches[0];

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
        `'garden trellis resume', for iteration-budget run ` +
        `'garden trellis budget'.`
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
  if (!isReviewSideFailure && (claudeStatus === "working" || claudeStatus === "asking")) {
    throw new Error(
      `Worker ${project}/${workerName} is currently ${claudeStatus} — Claude is ` +
      `still mid-turn. Kick only re-arms workers whose turn has ended ` +
      `(claudeStatus=idle). Wait for the Stop hook, or if you believe the ` +
      `status is truly stuck, edit the registry directly.`,
    );
  }

  const projectInfo = tryGetProject(project);
  if (projectInfo) {
    const entry = registry.workers[project].find(e => e.name === workerName);
    const wtPath = entry?.worktreePath ?? projectInfo.path;
    const baseBranch = getWorkerBaseBranch(entry ?? {}, projectInfo.path);
    const commits = getCommitSummary(wtPath, baseBranch);
    if (!commits) {
      throw new Error(
        `Worker ${project}/${workerName} has no commits ahead of ${baseBranch} — nothing to review.`,
      );
    }
  }

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
    });
    triggerProjectPoll(project);
    console.log(`Kicked ${project}/${workerName} — recovered from failing (${failingReason}), review re-queued.`);
    return;
  }

  updateWorkerFields(project, workerName, { pendingReviewAt: Date.now() });
  triggerProjectPoll(project);
  console.log(`Kicked ${project}/${workerName} — review queued.`);
}

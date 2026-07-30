// Holistic (whole-task) final-review dispatcher.
//
// When a multi-phase DEFAULT worker reaches `done` having merged >=2 times, the
// poller interposes ONE final review of the whole-task cumulative diff — the
// assembled result no single per-phase review ever saw — before the worker
// truly finishes. This is NOT a separate spawned worker: it reuses the headless
// reviewer flow (launchHeadlessAgent + resolveReviewRole) on the ORIGINAL
// worker's own branch, so a Codex reviewer runs it exactly like a per-phase
// review. The reviewer reviews the aggregated diff for cross-phase coherence
// defects and, in `fix` mode, fixes them directly — the fix rides the normal
// CI + merge gate; in `shadow` mode it reports findings only.
//
// The two trigger sites both fire from `done`: transitionToTerminal (the
// sentinel-on-last-phase merge-driven path) and handleDone (the trail-off path).
// The dispatcher re-opens `done` -> `reviewing` for the final pass; when that
// review resolves, the worker settles back to `done` (CLEAN / after a fix
// merges) or `failing` (the reviewer could not fix a defect).
//
// The high-water guard (holisticReviewedThroughMergeCount) is set the moment a
// completion is found eligible — even in mode "off" — so the decision fires
// exactly once per done-arrival on both trigger sites, and re-arms if a
// re-opened worker adds more phases later.
import { tryGetProject, DEFAULT_HOLISTIC_REVIEW } from "../config.js";
import { log } from "./log.js";
import {
  findWorkerByName, updateWorkerFields, type WorkerEntry,
} from "./registry.js";
import {
  getBranchHeadSha, getCommitLogRange, getRemoteTrackingSha, syncWorktreeToBase,
} from "./git.js";
import { refreshDashboard } from "./header.js";
import { resolveReviewRole } from "./roles.js";
import { launchHeadlessAgent } from "./headless-agent.js";
import { buildHolisticFinalReviewPrompt } from "./prompts.js";
import { reviewWindowName } from "./window-names.js";
import { signalFifoPath, isWorkerClaudeWorking } from "./poller-fifo.js";
import { transitionState } from "./poller-state.js";
import { autoContinueGateReason } from "./poller-merge.js";
import {
  reviewPromptPath, reviewResultPath, scheduleReviewTimeoutPoke,
  MAX_REVIEW_PROMPT_BYTES,
} from "./poller-review.js";
import { addAlert } from "./alerts.js";

// Which trigger site invoked the dispatcher. Surfaced in the decision trace so
// validation can confirm both the merge-driven and trail-off paths fire; a
// zero count for one site is otherwise unfalsifiable.
export type HolisticEntryPath = "transitionToTerminal" | "trailoff-handleDone";

export type HolisticSkipReason =
  | "ok"
  | "not-done"
  | "workflow"
  | "mergeCount<2"
  | "already-reviewed";

export interface HolisticGate {
  eligible: boolean;
  reason: HolisticSkipReason;
}

// The structural gate. Pure — no config, no mode, no side effects — so it is
// unit-testable in isolation against synthetic entries.
export function evaluateHolisticGate(entry: WorkerEntry): HolisticGate {
  if (entry.prState !== "done") return { eligible: false, reason: "not-done" };
  // Load-bearing: `=== "default"` excludes grow and trellis in one clause. They
  // legitimately reach mergeCount>=2 via normal merges; only this gate keeps
  // them out of the whole-task review, which is a default-workflow concern.
  if ((entry.workflow ?? "default") !== "default") return { eligible: false, reason: "workflow" };
  const mergeCount = entry.mergeCount ?? 0;
  if (mergeCount < 2) return { eligible: false, reason: "mergeCount<2" };
  if ((entry.holisticReviewedThroughMergeCount ?? 0) >= mergeCount) {
    return { eligible: false, reason: "already-reviewed" };
  }
  return { eligible: true, reason: "ok" };
}

// Evaluate the gate, emit the decision trace, and interpose the final review.
// Idempotent per done-arrival via the high-water guard.
export function maybeDispatchHolisticReview(
  projectName: string,
  projectPath: string,
  baseBranch: string,
  entry: WorkerEntry,
  entryPath: HolisticEntryPath,
): void {
  const { eligible, reason } = evaluateHolisticGate(entry);
  const mode = tryGetProject(projectName)?.holisticReview ?? DEFAULT_HOLISTIC_REVIEW;
  const traceData = {
    project: projectName,
    decision: eligible ? "dispatch" : "skip",
    reason,
    entryPath,
    mergeCount: entry.mergeCount ?? 0,
    reviewedThrough: entry.holisticReviewedThroughMergeCount ?? 0,
    workflow: entry.workflow ?? "default",
    mode,
  };
  // INFO for an actionable dispatch (keeps the info stream to real firings);
  // DEBUG for skips (still queryable without firehosing the log).
  if (eligible) log.info("poller", "holistic-review gate", { worker: entry.name, data: traceData });
  else log.debug("poller", "holistic-review gate", { worker: entry.name, data: traceData });

  if (!eligible) return;

  const setGuard = () => updateWorkerFields(projectName, entry.name, {
    holisticReviewedThroughMergeCount: entry.mergeCount ?? 0,
  });

  if (mode === "off") {
    // Mark evaluated so this completion isn't retroactively reviewed if the
    // operator later enables the feature, and so the trace fires once.
    setGuard();
    return;
  }

  const fromSha = entry.baseBranchSha;
  const files = entry.holisticTouchedFiles ?? [];
  if (!fromSha || files.length === 0) {
    // No reconstructable whole-task diff (a pre-Phase-0 straggler, or a task
    // that touched no files). Mark reviewed so we don't retry a completion we
    // can't review.
    log.warn("poller", "holistic-review skipped: no diff inputs", {
      worker: entry.name,
      data: { project: projectName, hasBaseSha: Boolean(fromSha), fileCount: files.length },
    });
    setGuard();
    return;
  }

  // Defer (do NOT set the guard -> retries on the next sweep poke) when the
  // worker's Claude is still working (the review shares the worktree) or the
  // shared usage gate is closed. Project-scoped gate: the reviewer runs on this
  // project's env, so a usage-exempt project (separate token pool) dispatches
  // through a usage-triggered closure; an explicit `garden auto off` defers.
  if (isWorkerClaudeWorking(projectName, entry.name)) {
    log.debug("poller", "holistic-review deferred: worker Claude still working", {
      worker: entry.name, data: { project: projectName },
    });
    return;
  }
  const gateReason = autoContinueGateReason(projectName, entry.provider);
  if (gateReason) {
    log.debug("poller", "holistic-review deferred: usage gate closed", {
      worker: entry.name, data: { project: projectName, gateReason },
    });
    return;
  }

  setGuard();
  launchHolisticFinalReview(projectName, projectPath, baseBranch, entry, mode);
}

// Launch the interposed whole-task review on the worker's own branch and move
// it `done` -> `reviewing`. Reuses the headless reviewer primitive so the
// verdict is handled by handleHolisticFinalReview (poller-review.ts), harness-
// aware like any review. `mode` is "fix" | "shadow".
function launchHolisticFinalReview(
  projectName: string,
  projectPath: string,
  baseBranch: string,
  entry: WorkerEntry,
  mode: "fix" | "shadow",
): void {
  const wtPath = entry.worktreePath ?? projectPath;
  const fromSha = entry.baseBranchSha!;
  const files = entry.holisticTouchedFiles ?? [];

  // Cross-phase rationale for the deliberate-decision guardrail. Computed from
  // the project checkout, which has both baseBranchSha and the current base tip.
  const toSha = getRemoteTrackingSha(projectPath, baseBranch) ?? `origin/${baseBranch}`;
  const rationale = getCommitLogRange(projectPath, fromSha, toSha, files);

  // Advance the worker's already-merged branch to the base tip so a reviewer fix
  // lands as a single clean delta (no stale ancestor commits to rebase). ff-only:
  // the branch is an ancestor of origin/<base> once merged, so this always
  // fast-forwards. A failure (dirty tree, fetch error) is non-fatal — a shadow
  // pass needs no commit, and a fix pass can still rebase via the resolver.
  const synced = syncWorktreeToBase(wtPath, baseBranch);
  if (!synced.ok) {
    log.warn("poller", "holistic-review could not advance branch to base tip", {
      worker: entry.name, data: { project: projectName, reason: synced.reason },
    });
  }

  // Persist rationale + mode so the prompt builder and verdict handler read them
  // off the entry.
  updateWorkerFields(projectName, entry.name, {
    holisticRationale: rationale,
    holisticReviewMode: mode,
  });
  const staged = findWorkerByName(projectName, entry.name) ?? entry;

  const prompt = buildHolisticFinalReviewPrompt(projectName, projectPath, baseBranch, staged);
  if (prompt === null) {
    log.warn("poller", "holistic-review could not build prompt; leaving worker done", {
      worker: entry.name, data: { project: projectName },
    });
    return; // guard already set — the worker stays `done`
  }

  // Same context ceiling as a per-phase review, and the whole-task range is the
  // more likely one to reach it. Disposition differs: this pass is best-effort
  // over work that already merged and already passed per-phase review, so an
  // unreviewable range leaves the worker `done` rather than failing it — the
  // file's stated posture for every other could-not-complete outcome. Alerted,
  // not silent: the operator loses the cross-phase check and should know.
  if (prompt.length > MAX_REVIEW_PROMPT_BYTES) {
    const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)}MB`;
    addAlert({
      level: "warn",
      source: "review",
      project: projectName,
      worker: entry.name,
      message:
        `Skipped the whole-task review for ${entry.name}: assembled prompt is ${mb(prompt.length)} `
        + `(ceiling ${mb(MAX_REVIEW_PROMPT_BYTES)}), larger than any reviewer's context window. `
        + `The per-phase reviews all passed; only the cross-phase check was skipped.`,
      dedupKey: `oversized-holistic:${projectName}:${entry.name}`,
    });
    log.warn("poller", "holistic-review prompt exceeds context ceiling; leaving worker done", {
      worker: entry.name,
      data: {
        project: projectName,
        promptBytes: prompt.length,
        ceilingBytes: MAX_REVIEW_PROMPT_BYTES,
      },
    });
    return; // guard already set — the worker stays `done`
  }

  // Reviewer role (harness/model/env) — honors project.roles + crew, so a Codex
  // reviewer runs the aggregated pass exactly like a per-phase review. Resolved
  // independently of the worker's own harness (docs/MULTI-MODEL.md "Mixed fleets").
  const reviewer = resolveReviewRole(
    tryGetProject(projectName) ?? {}, staged.workflow ?? "default", "reviewer", undefined, staged,
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
    effort: reviewer.effort,
    harness: reviewer.harness,
  });

  const preReviewSha = getBranchHeadSha(wtPath) ?? undefined;
  transitionState(projectName, entry.name, "reviewing", {
    reviewWindowName: revWindow,
    reviewStartedAt: Date.now(),
    preReviewSha,
    // Same defensive clear as launchReview: a stale mid-review-edit marker
    // would cancel this fresh pass on its first handleReviewing tick.
    reviewInterruptedAt: undefined,
    holisticFinalActive: true,
    holisticReviewMode: mode,
    lastSeenSha: preReviewSha,
    lastShaChangeAt: new Date().toISOString(),
    // Clear the terminal-state fields from the `done` we are re-opening.
    mergedAt: undefined,
    pendingContinueChangedFiles: undefined,
    pendingContinueSyncFailed: undefined,
  });
  refreshDashboard();

  log.info("poller", "holistic final review launched", {
    worker: entry.name,
    data: {
      project: projectName, mode, reviewer: reviewer.harness,
      mergeCount: entry.mergeCount ?? 0,
    },
  });
}

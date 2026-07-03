// Resolver lifecycle: launchResolver, handleResolving, escalateResolveBudget.
// The resolver is launched when handleMergePending hits a rebase conflict
// (the base branch advanced while the worker was reviewing). Verdict from
// the resolver is advisory; the worktree state is the ground truth (see
// STATUS.md invariant 7).
import fs from "node:fs";
import { tryGetProject } from "../config.js";
import { addAlert } from "./alerts.js";
import { resolveReviewRole } from "./roles.js";
import { getHarnessCore } from "./harness/core.js";
import { codexStderrSidecar } from "./harness/codex-core.js";
import {
  abortRebase, forcePushBranch, getBranchHeadSha, getRemoteTrackingSha,
  getUnmergedFiles, hasRebaseInProgress, isAncestor,
} from "./git.js";
import { refreshDashboard } from "./header.js";
import { launchHeadlessAgent } from "./headless-agent.js";
import { log } from "./log.js";
import { buildResolvePrompt } from "./prompts.js";
import {
  updateWorkerFields,
  type WorkerEntry,
} from "./registry.js";
import { windowExists } from "./tmux.js";
import { parseLastLineVerdict } from "./verdict.js";
import { reviewWindowName } from "./window-names.js";
import {
  signalFifoPath, scheduleDelayedPoke, isWorkerClaudeWorking,
} from "./poller-fifo.js";
import { transitionState } from "./poller-state.js";
import {
  cleanReviewFiles, handleReviewTimeout, isReviewTimedOut,
  resetToWorkingOnWorkerPush, reviewPromptPath, reviewResultPath,
  scheduleReviewTimeoutPoke,
} from "./poller-review.js";

export const RESOLVE_BUDGET = 2;

const RESOLVE_VERDICT_VOCAB = ["DONE", "FAILED"] as const;

// Was the resolver's run a transient backend error (5xx / 429 / overloaded /
// rate-limit) rather than a genuine "could not resolve"? An Anthropic (or codex)
// outage during a rebase-conflict resolve should not park the worker in the
// unrecoverable `code` failing reason that `garden kick` refuses. Harness-aware,
// mirroring handleReviewing: claude-code merges stderr into the result via 2>&1;
// codex sends the verdict to stdout and errors to a stderr sidecar. Must be read
// before cleanReviewFiles deletes the result/sidecar.
function resolverOutputWasTransient(projectName: string, entry: WorkerEntry): boolean {
  const harness = resolveReviewRole(
    tryGetProject(projectName) ?? {}, entry.workflow ?? "default", "resolver",
  ).harness;
  const resultFile = reviewResultPath(projectName, entry.name);
  let rawOutput = "";
  try { rawOutput = fs.readFileSync(resultFile, "utf-8"); } catch { /* missing */ }
  let sidecar = "";
  if (harness !== "claude-code") {
    try { sidecar = fs.readFileSync(codexStderrSidecar(resultFile), "utf-8"); } catch { /* missing */ }
  }
  const source = (harness === "claude-code"
    ? rawOutput
    : [rawOutput, sidecar].filter(Boolean).join("\n")) || null;
  return source !== null && getHarnessCore(harness).isTransientError(source);
}

interface ResolveResult {
  verdict: "done" | "failed";
  body: string;
}

// Launch a resolver to fix a merge-queue rebase conflict. Budget is 2 attempts
// per merge; if exhausted, escalate to `failing` with an operator alert. If
// the worker's Claude is currently working we cannot share the worktree, so
// defer — the next event will re-poll.
export function launchResolver(
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
    log.warn("poller", "failed to build resolve prompt", { worker: entry.name, data: { project: projectName } });
    return false;
  }

  // Resolver role resolution (independent of the reviewer's) — defaults to the
  // same strong first-party Anthropic + Opus safety net, overridable via
  // `garden config <p> role resolver ...`. See docs/MULTI-MODEL.md "Phase 4".
  const resolver = resolveReviewRole(
    tryGetProject(projectName) ?? {}, entry.workflow ?? "default", "resolver",
  );
  const revWindow = reviewWindowName(projectName, entry.name);
  launchHeadlessAgent({
    cwd: wtPath,
    windowName: revWindow,
    prompt,
    promptFile: reviewPromptPath(projectName, entry.name),
    resultFile: reviewResultPath(projectName, entry.name),
    envPrefix: resolver.envPrefix,
    envVars: { GARDEN_REVIEWER: "1" },
    signalFifo: signalFifoPath(projectName),
    onLaunched: () => scheduleReviewTimeoutPoke(projectName),
    model: resolver.model,
    harness: resolver.harness,
  });

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
    data: { project: projectName, attempt: attempts + 1, budget: RESOLVE_BUDGET },
  });
  return true;
}

function escalateResolveBudget(
  projectName: string,
  wtPath: string,
  entry: WorkerEntry,
  wasTransient = false,
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
    data: { project: projectName, budget: RESOLVE_BUDGET, conflictFiles, transient: wasTransient },
  });
  // A transient backend outage is not a code failure: escalate with a
  // kick-recoverable reason so `garden kick` re-queues the merge once the
  // outage clears, instead of the `code` reason that tells the operator to push
  // a commit they don't need.
  addAlert({
    level: "error",
    source: "poller",
    project: projectName,
    worker: entry.name,
    message: wasTransient
      ? `Worker ${entry.name}: the resolver could not reach its backend (transient API errors) across ${RESOLVE_BUDGET} attempts, so the merge-queue conflict is unresolved. This is not a code failure — 'garden kick' retries once the outage clears.${bodyTail}`
      : `Worker ${entry.name}: resolver could not fix the merge-queue rebase conflict after ${RESOLVE_BUDGET} attempts. Conflict files: ${fileList}. A new worker push will reset the retry budget.${bodyTail}`,
    // fileList and bodyTail vary across runs; without a stable key, every
    // resolve-budget exhaustion would persist a fresh alert.
    dedupKey: `resolve-budget:${projectName}:${entry.name}`,
  });
  const headSha = getBranchHeadSha(wtPath);
  transitionState(projectName, entry.name, "failing", {
    failCount: (entry.failCount ?? 0) + 1,
    failingReason: wasTransient ? "transient-review" : "code",
    failingSha: headSha ?? undefined,
    lastSeenSha: headSha ?? undefined,
    lastShaChangeAt: new Date().toISOString(),
    reviewWindowName: undefined,
    reviewStartedAt: undefined,
    mergePendingAt: undefined,
    // Clear the exhausted resolve budget on entry to `failing`, mirroring
    // escalateCiFixBudget. A transient-review failing state is kick-recoverable;
    // kick re-queues a review without resetting these, so a stale resolveAttempts
    // at budget would make the next genuine conflict re-escalate via
    // launchResolver without ever launching a resolver (see poller-merge.ts's
    // merge-failure re-arm for the same invariant).
    resolveAttempts: 0,
    preResolveSha: undefined,
  });
  refreshDashboard();
}

// Resolver handler: waits for the resolver window to exit, then verifies the
// rebase actually landed (STATUS.md invariant 7). On pass → force-push and
// merge-pending. On fail → count the attempt, retry or escalate per budget.
export function handleResolving(
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
  // Detect a transient backend outage before cleanReviewFiles removes the
  // result/sidecar, so a budget-exhausting outage escalates recoverably.
  const wasTransient = resolverOutputWasTransient(projectName, entry);
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
        project: projectName,
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
      escalateResolveBudget(projectName, wtPath, entry, wasTransient);
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
    data: { project: projectName, attempts: entry.resolveAttempts ?? 0 },
  });

  try {
    forcePushBranch(wtPath, branchName);
  } catch (err) {
    log.error("poller", "force-push after resolve failed", {
      worker: entry.name,
      data: { project: projectName, error: String(err) },
    });
    // Re-arm rather than strand the worker in an unwatched `working` state (see
    // tryForcePushAfterReview): a transient failure self-heals via a fresh
    // review, a persistent one is surfaced by the deduped alert, and the 30s
    // poke floor keeps it from tight-looping.
    addAlert({
      level: "warn",
      source: "poller",
      project: projectName,
      worker: entry.name,
      message: `Force-push after conflict resolution failed for '${entry.name}'; re-queuing a review to retry. ${String(err).slice(0, 200)}`,
      dedupKey: `push-failed:${projectName}:${entry.name}`,
    });
    transitionState(projectName, entry.name, "working", {
      pendingReviewAt: Date.now(),
      reviewWindowName: undefined,
      reviewStartedAt: undefined,
      mergePendingAt: undefined,
      // Fresh cycle: reset the resolver budget and stale resolve state, matching
      // resetToWorkingOnWorkerPush / finalizeMerge. Without this, the (already at
      // or near budget) resolveAttempts would carry into the re-reviewed cycle
      // and prematurely escalate the next genuine conflict to `failing`.
      resolveAttempts: 0,
      preResolveSha: undefined,
      lastResolveBody: undefined,
    });
    refreshDashboard();
    scheduleDelayedPoke(projectName, 30_000);
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

function readResolveResult(
  projectName: string,
  entry: WorkerEntry,
): ResolveResult | null {
  const resultFile = reviewResultPath(projectName, entry.name);
  try {
    if (!fs.existsSync(resultFile)) {
      log.warn("poller", "resolve result file missing", { worker: entry.name, data: { project: projectName } });
      return null;
    }
    const output = fs.readFileSync(resultFile, "utf-8").trim();
    if (!output) {
      log.warn("poller", "resolve result file empty", { worker: entry.name, data: { project: projectName } });
      return null;
    }
    const parsed = parseLastLineVerdict(output, RESOLVE_VERDICT_VOCAB, { scanLines: 1 });
    if (!parsed) {
      const lastLine = output.split("\n").reverse().find(l => l.trim())?.trim() ?? "";
      log.warn("poller", "could not parse resolve verdict", {
        worker: entry.name,
        data: { project: projectName, lastLine },
      });
      return null;
    }
    return {
      verdict: parsed.verdict.toLowerCase() as ResolveResult["verdict"],
      body: parsed.body || "No additional comments.",
    };
  } catch (err) {
    log.warn("poller", "failed to read resolve result", {
      worker: entry.name,
      data: { project: projectName, error: String(err) },
    });
    return null;
  }
}

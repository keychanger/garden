// CI-fix lifecycle: launchCiFix, handleCiFixing, escalateCiFixBudget.
//
// Mirrors poller-resolve.ts. Dispatched from poller-merge.ts's gateCiStatus
// when GitHub Actions reports failed check-runs on a merge candidate's
// branch HEAD. The agent reads the failing logs, makes the minimum fix to
// turn CI green, and pushes; the poller re-enters merge-pending on the new
// SHA and the gate re-runs. Budget 3 attempts per merge cycle. On exhaustion,
// or on the agent reporting FAILED without progress, the worker is parked in
// `failing` with failingReason="ci" — preserving the pre-self-heal terminal
// behavior so operator muscle memory still works.
//
// See poller-resolve.ts for the analogous merge-conflict resolution flow.
import fs from "node:fs";
import path from "node:path";
import { SESSIONS_DIR, tryGetProject } from "../config.js";
import { addAlert } from "./alerts.js";
import { claudeEnvPrefix } from "./claude-env.js";
import { getBranchHeadSha, getRemoteTrackingSha } from "./git.js";
import { refreshDashboard } from "./header.js";
import { launchHeadlessAgent } from "./headless-agent.js";
import { log } from "./log.js";
import { buildCiFixPrompt } from "./prompts.js";
import {
  updateWorkerFields,
  type WorkerEntry,
} from "./registry.js";
import { killWindowSafe, windowExists } from "./tmux.js";
import { parseLastLineVerdict } from "./verdict.js";
import { ciFixWindowName } from "./window-names.js";
import {
  signalFifoPath, scheduleDelayedPoke, isWorkerClaudeWorking,
} from "./poller-fifo.js";
import { transitionState } from "./poller-state.js";
import {
  REVIEW_TIMEOUT_MS, scheduleReviewTimeoutPoke,
} from "./poller-review.js";

export const CI_FIX_BUDGET = 3;

const CI_FIX_VERDICT_VOCAB = ["FIXED", "FAILED"] as const;

interface CiFixResult {
  verdict: "fixed" | "failed";
  body: string;
}

export function ciFixPromptPath(project: string, worker: string): string {
  return path.join(SESSIONS_DIR, `${project}-${worker}-ci-fix-prompt.txt`);
}

export function ciFixResultPath(project: string, worker: string): string {
  return path.join(SESSIONS_DIR, `${project}-${worker}-ci-fix-result.txt`);
}

export interface FailingCheck {
  name: string;
  conclusion: string;
  htmlUrl?: string;
}

// Format the failed check-run list into a single string the agent reads in
// the prompt. Stamped on `entry.failingCheckSummary` at launch so the prompt
// section can stay agnostic of CiStatus's shape.
export function formatFailingCheckSummary(failed: ReadonlyArray<FailingCheck>): string {
  if (!failed || failed.length === 0) return "No failure detail available.";
  const lines: string[] = [];
  for (const f of failed) {
    const url = f.htmlUrl ? `  url: ${f.htmlUrl}` : "  url: (not reported)";
    lines.push(`- ${f.name} → ${f.conclusion}\n${url}`);
  }
  return lines.join("\n");
}

// Launch a ci-fix agent. Budget 3 per merge. If exhausted, escalate to
// `failing`. If the worker's Claude is currently working, defer — we can't
// share the worktree.
//
// Returns true when the caller (gateCiStatus in poller-merge.ts) should treat
// the merge as deferred (handled). Returns false only when launch was
// genuinely skipped (worker pane busy) so the next event re-polls.
export function launchCiFix(
  projectName: string,
  projectPath: string,
  baseBranch: string,
  entry: WorkerEntry,
  failed: ReadonlyArray<FailingCheck>,
  sha: string,
): boolean {
  const wtPath = entry.worktreePath ?? projectPath;
  const attempts = entry.ciFixAttempts ?? 0;

  if (attempts >= CI_FIX_BUDGET) {
    escalateCiFixBudget(projectName, wtPath, entry, sha);
    return true;
  }

  if (isWorkerClaudeWorking(projectName, entry.name)) return false;

  // Stamp failingCheckSummary BEFORE building the prompt — the section reads
  // it off the entry. Also stamp the SHA so the agent's commit lands a new
  // SHA we can verify against.
  const failingCheckSummary = formatFailingCheckSummary(failed);
  updateWorkerFields(projectName, entry.name, {
    failingCheckSummary,
    failingSha: sha,
  });
  // Re-read so the prompt builder sees the stamped fields.
  const stampedEntry: WorkerEntry = {
    ...entry,
    failingCheckSummary,
    failingSha: sha,
  };

  const prompt = buildCiFixPrompt(projectName, projectPath, baseBranch, stampedEntry);
  if (prompt === null) {
    log.warn("poller", "failed to build ci-fix prompt", { worker: entry.name });
    return false;
  }

  const cfWindow = ciFixWindowName(projectName, entry.name);
  launchHeadlessAgent({
    cwd: wtPath,
    windowName: cfWindow,
    prompt,
    promptFile: ciFixPromptPath(projectName, entry.name),
    resultFile: ciFixResultPath(projectName, entry.name),
    envPrefix: claudeEnvPrefix(tryGetProject(projectName) ?? {}),
    envVars: { GARDEN_REVIEWER: "1" },
    signalFifo: signalFifoPath(projectName),
    onLaunched: () => scheduleReviewTimeoutPoke(projectName),
  });

  const preCiFixSha = getBranchHeadSha(wtPath);
  const launchSha = getRemoteTrackingSha(wtPath, entry.branchName ?? entry.name)
    ?? preCiFixSha ?? entry.lastSeenSha;

  const nextAttempts = attempts + 1;
  transitionState(projectName, entry.name, "ci-fixing", {
    reviewWindowName: cfWindow,
    reviewStartedAt: Date.now(),
    preCiFixSha: preCiFixSha ?? undefined,
    ciFixAttempts: nextAttempts,
    lastSeenSha: launchSha,
    lastShaChangeAt: new Date().toISOString(),
    mergePendingAt: undefined,
  });
  refreshDashboard();

  const detail = failed
    .map(f => `${f.name} (${f.conclusion})`)
    .join(", ");
  addAlert({
    level: "warn",
    source: "poller",
    project: projectName,
    worker: entry.name,
    message:
      `CI fix-agent launched for ${entry.name} (attempt ${nextAttempts}/${CI_FIX_BUDGET}): ` +
      `investigating ${sha.slice(0, 7)} — ${detail}`,
    // Dedup per (worker, SHA). A retry on the same SHA after a non-pushing
    // FAILED verdict is the same logical event; a new SHA from the agent's
    // push (which would trigger a fresh failure) deserves a fresh alert.
    dedupKey: `ci-fix-launch:${projectName}:${entry.name}:${sha}`,
  });

  log.info("poller", "launched ci-fix", {
    worker: entry.name,
    data: { attempt: nextAttempts, budget: CI_FIX_BUDGET, sha: sha.slice(0, 7) },
  });
  return true;
}

function escalateCiFixBudget(
  projectName: string,
  wtPath: string,
  entry: WorkerEntry,
  sha: string,
): void {
  const bodyTail = entry.lastCiFixBody
    ? `\n\nLast ci-fix output:\n${entry.lastCiFixBody.slice(0, 500)}`
    : "";
  log.error("poller", "ci-fix budget exhausted", {
    worker: entry.name,
    data: { budget: CI_FIX_BUDGET, sha: sha.slice(0, 7) },
  });
  addAlert({
    level: "error",
    source: "poller",
    project: projectName,
    worker: entry.name,
    message:
      `CI fix-agent exhausted ${CI_FIX_BUDGET} attempts for ${entry.name} on ${sha.slice(0, 7)}. ` +
      `Parking in failing. Push a fix or set 'requireCiSuccess false' to bypass.${bodyTail}`,
    // Per-SHA so a new commit that fails CI differently deserves a fresh
    // alert. lastCiFixBody varies across runs and would defeat the default
    // 200-char dedup key.
    dedupKey: `ci-fix-exhausted:${projectName}:${entry.name}:${sha}`,
  });
  const headSha = getBranchHeadSha(wtPath);
  transitionState(projectName, entry.name, "failing", {
    failCount: (entry.failCount ?? 0) + 1,
    failingReason: "ci",
    failingSha: sha,
    lastSeenSha: headSha ?? sha,
    lastShaChangeAt: new Date().toISOString(),
    reviewWindowName: undefined,
    reviewStartedAt: undefined,
    mergePendingAt: undefined,
    ciFixAttempts: 0,
    preCiFixSha: undefined,
  });
  refreshDashboard();
}

// CI-fix state handler. Mirrors handleResolving: waits for the agent window
// to exit, verifies the agent actually pushed, transitions back to
// merge-pending on success (so the CI gate re-runs on the new SHA), retries
// or escalates per budget on failure.
export function handleCiFixing(
  projectName: string,
  projectPath: string,
  _baseBranch: string,
  entry: WorkerEntry,
): boolean {
  // Timeout: same wall-clock ceiling as the reviewer/resolver. A hung agent
  // is killed and escalated to `failing` so the state machine doesn't wedge.
  if (isCiFixTimedOut(entry)) {
    return handleCiFixTimeout(projectName, projectPath, entry);
  }

  const cfWindow = entry.reviewWindowName;
  if (cfWindow && windowExists(cfWindow)) {
    return false; // still in-flight
  }

  const wtPath = entry.worktreePath ?? projectPath;
  const branchName = entry.branchName ?? entry.name;

  const result = readCiFixResult(projectName, entry);
  cleanCiFixFiles(projectName, entry.name);

  if (result) {
    updateWorkerFields(projectName, entry.name, {
      lastCiFixBody: result.body,
    });
  }

  const verdictFailed = result === null || result.verdict === "failed";

  // Programmatic verification: the agent's verdict is advisory; only an
  // actual push counts. HEAD must have advanced past preCiFixSha AND the
  // remote tracking ref must match local HEAD (push went through). The
  // agent and the worker share the worktree, so we cannot distinguish an
  // agent push from a worker push by looking at the remote ref alone —
  // verification has to run before any worker-push fallback, otherwise
  // every successful agent push would be misclassified as a worker push.
  const headSha = getBranchHeadSha(wtPath);
  const remoteHeadSha = getRemoteTrackingSha(wtPath, branchName);
  const madeProgress = headSha !== null && entry.preCiFixSha !== undefined &&
    headSha !== entry.preCiFixSha;
  const pushed = headSha !== null && remoteHeadSha === headSha;
  const verificationPassed = !verdictFailed && madeProgress && pushed;

  if (!verificationPassed) {
    log.warn("poller", "ci-fix verification failed", {
      worker: entry.name,
      data: {
        verdict: result?.verdict ?? "missing",
        madeProgress,
        pushed,
      },
    });

    // Verification failed but the remote ref still advanced — that's a
    // worker-authored push during ci-fix (operator nudged the worker pane
    // mid-fix). Abort, reset budget, and let the normal working→reviewing
    // flow re-enter from the new SHA.
    if (remoteHeadSha && entry.lastSeenSha && remoteHeadSha !== entry.lastSeenSha) {
      log.info("poller", "new commits during ci-fix, resetting to working", {
        worker: entry.name,
      });
      transitionState(projectName, entry.name, "working", {
        lastShaChangeAt: new Date().toISOString(),
        reviewWindowName: undefined,
        reviewStartedAt: undefined,
        ciFixAttempts: 0,
        preCiFixSha: undefined,
        lastCiFixBody: undefined,
        failingCheckSummary: undefined,
        mergePendingAt: undefined,
        pendingReviewAt: Date.now(),
      });
      refreshDashboard();
      scheduleDelayedPoke(projectName, 0);
      return true;
    }

    const attempts = entry.ciFixAttempts ?? 0;
    if (attempts >= CI_FIX_BUDGET) {
      escalateCiFixBudget(projectName, wtPath, entry, entry.failingSha ?? entry.lastSeenSha ?? "");
      return true;
    }

    // Re-enter merge-pending: the next poll cycle will re-run the CI gate,
    // which (on the same SHA) will re-fail, which will call launchCiFix
    // again, counting toward the budget.
    transitionState(projectName, entry.name, "merge-pending", {
      mergePendingAt: entry.mergePendingAt ?? new Date().toISOString(),
      reviewWindowName: undefined,
      reviewStartedAt: undefined,
    });
    refreshDashboard();
    scheduleDelayedPoke(projectName, 0);
    return true;
  }

  // Success: agent pushed a fix. Lifecycle alert so the operator can watch
  // the auto-heal land, then re-enter merge-pending. The next CI gate query
  // runs against the new SHA — if the fix works, the merge proceeds; if it
  // doesn't, gateCiStatus will see a new SHA and spawn another ci-fix
  // attempt against the new failure detail.
  log.info("poller", "ci-fix pushed", {
    worker: entry.name,
    data: { attempts: entry.ciFixAttempts ?? 0, newSha: headSha?.slice(0, 7) },
  });
  addAlert({
    level: "warn",
    source: "poller",
    project: projectName,
    worker: entry.name,
    message:
      `CI fix-agent pushed fix for ${entry.name}: ${headSha!.slice(0, 7)}. ` +
      `Re-running CI gate.`,
    // Per-newSha so successive successful pushes (each against a different
    // SHA) each get their own alert. The 1-hour dedup window then handles
    // the case where the same SHA's success event somehow replays.
    dedupKey: `ci-fix-success:${projectName}:${entry.name}:${headSha}`,
  });

  transitionState(projectName, entry.name, "merge-pending", {
    mergePendingAt: entry.mergePendingAt ?? new Date().toISOString(),
    reviewWindowName: undefined,
    reviewStartedAt: undefined,
    lastSeenSha: headSha ?? undefined,
    lastShaChangeAt: new Date().toISOString(),
  });
  refreshDashboard();
  scheduleDelayedPoke(projectName, 0);
  return true;
}

function isCiFixTimedOut(entry: WorkerEntry): boolean {
  if (!entry.reviewStartedAt || !entry.reviewWindowName) return false;
  if (!windowExists(entry.reviewWindowName)) return false;
  return Date.now() - entry.reviewStartedAt > REVIEW_TIMEOUT_MS;
}

function handleCiFixTimeout(
  projectName: string,
  projectPath: string,
  entry: WorkerEntry,
): boolean {
  const elapsedMs = Date.now() - (entry.reviewStartedAt ?? 0);
  log.warn("poller", "ci-fix timed out, killing window", {
    worker: entry.name,
    data: { elapsedMs, timeoutMs: REVIEW_TIMEOUT_MS },
  });
  if (entry.reviewWindowName) killWindowSafe(entry.reviewWindowName);
  cleanCiFixFiles(projectName, entry.name);
  addAlert({
    level: "error",
    source: "review",
    project: projectName,
    worker: entry.name,
    message:
      `CI fix-agent for ${entry.name} exceeded ${Math.floor(REVIEW_TIMEOUT_MS / 60000)}-minute ` +
      `timeout and was killed. Check the worktree for hung subprocesses.`,
  });
  const wtPath = entry.worktreePath ?? projectPath;
  const headSha = getBranchHeadSha(wtPath);
  transitionState(projectName, entry.name, "failing", {
    failCount: (entry.failCount ?? 0) + 1,
    failingReason: "ci",
    failingSha: headSha ?? undefined,
    lastSeenSha: headSha ?? undefined,
    lastShaChangeAt: new Date().toISOString(),
    reviewWindowName: undefined,
    reviewStartedAt: undefined,
    mergePendingAt: undefined,
  });
  refreshDashboard();
  return true;
}

function readCiFixResult(
  projectName: string,
  entry: WorkerEntry,
): CiFixResult | null {
  const resultFile = ciFixResultPath(projectName, entry.name);
  try {
    if (!fs.existsSync(resultFile)) {
      log.warn("poller", "ci-fix result file missing", { worker: entry.name });
      return null;
    }
    const output = fs.readFileSync(resultFile, "utf-8").trim();
    if (!output) {
      log.warn("poller", "ci-fix result file empty", { worker: entry.name });
      return null;
    }
    const parsed = parseLastLineVerdict(output, CI_FIX_VERDICT_VOCAB, { scanLines: 1 });
    if (!parsed) {
      const lastLine = output.split("\n").reverse().find(l => l.trim())?.trim() ?? "";
      log.warn("poller", "could not parse ci-fix verdict", {
        worker: entry.name,
        data: { lastLine },
      });
      return null;
    }
    return {
      verdict: parsed.verdict.toLowerCase() as CiFixResult["verdict"],
      body: parsed.body || "No additional comments.",
    };
  } catch (err) {
    log.warn("poller", "failed to read ci-fix result", {
      worker: entry.name,
      data: { error: String(err) },
    });
    return null;
  }
}

export function cleanCiFixFiles(projectName: string, workerName: string): void {
  try { fs.unlinkSync(ciFixResultPath(projectName, workerName)); } catch { /* ignore */ }
  try { fs.unlinkSync(ciFixPromptPath(projectName, workerName)); } catch { /* ignore */ }
}


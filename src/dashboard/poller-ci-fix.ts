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
import { tryGetProject } from "../config.js";
import { addAlert } from "./alerts.js";
import { resolveReviewRole } from "./roles.js";
import { codexStderrSidecar } from "./harness/codex-core.js";
import { getHarnessCore } from "./harness/core.js";
import { getBranchHeadSha, getRemoteTrackingSha } from "./git.js";
import { refreshDashboard } from "./header.js";
import { launchHeadlessAgent } from "./headless-agent.js";
import { log } from "./log.js";
import { buildCiFixPrompt } from "./prompts.js";
import { MAX_REVIEW_PROMPT_BYTES, reviewPromptBytes } from "./prompt-compose.js";
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
import { recordCiFixOutcome } from "./telemetry.js";
import {
  ciFixPromptPath,
  ciFixResultPath,
} from "./headless-paths.js";
import {
  REVIEW_TIMEOUT_MS, scheduleReviewTimeoutPoke,
} from "./poller-review.js";

export const CI_FIX_BUDGET = 3;

export { ciFixPromptPath, ciFixResultPath } from "./headless-paths.js";

const CI_FIX_VERDICT_VOCAB = ["FIXED", "FAILED"] as const;

interface CiFixResult {
  verdict: "fixed" | "failed";
  body: string;
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
    log.warn("poller", "failed to build ci-fix prompt", { worker: entry.name, data: { project: projectName } });
    return false;
  }

  // Backstop, mirroring launchReview. The builder already degrades an oversized
  // branch delta to a file summary the agent pages itself, so a prompt still
  // over the ceiling means the non-diff context does not fit and the agent CLI
  // rejects the request before the fix agent starts. Every attempt would fail
  // identically, so park now on the same terminal this file already uses for
  // "self-healing cannot help" (`failingReason: "ci"`, red CI the operator must
  // look at) rather than spending the budget on three doomed launches. The
  // attempt counter is deliberately NOT incremented — nothing ran.
  const promptBytes = reviewPromptBytes(prompt);
  if (promptBytes > MAX_REVIEW_PROMPT_BYTES) {
    const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)}MB`;
    addAlert({
      level: "error",
      source: "review",
      project: projectName,
      worker: entry.name,
      message:
        `CI is red for ${entry.name} and the fix agent cannot be launched: its prompt is `
        + `${mb(promptBytes)} (ceiling ${mb(MAX_REVIEW_PROMPT_BYTES)}) even with the branch diff `
        + `reduced to a file summary. Fix the failing checks by hand, or split the work across `
        + `smaller branches.`,
      dedupKey: `oversized-cifix:${projectName}:${entry.name}:${sha}`,
    });
    log.warn("poller", "ci-fix prompt exceeds context ceiling; not launching", {
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
      failingReason: "ci",
      failingSha: sha,
      lastSeenSha: sha,
      lastShaChangeAt: new Date().toISOString(),
      mergePendingAt: undefined,
      // Reset the budget on the park, mirroring escalateCiFixBudget — a worker
      // that recovers must not carry a silently-reduced budget into a later
      // merge cycle.
      ciFixAttempts: 0,
      preCiFixSha: undefined,
    });
    refreshDashboard();
    return true;
  }

  // Ci-fix role resolution (independent of reviewer/resolver) — same strong
  // first-party Anthropic + Opus default, overridable via `garden config <p>
  // role ci-fix ...`. See docs/MULTI-MODEL.md "Phase 4".
  const ciFix = resolveReviewRole(
    tryGetProject(projectName) ?? {}, entry.workflow ?? "default", "ciFix", undefined, entry,
  );
  const cfWindow = ciFixWindowName(projectName, entry.name);
  launchHeadlessAgent({
    cwd: wtPath,
    windowName: cfWindow,
    prompt,
    promptFile: ciFixPromptPath(projectName, entry.name),
    resultFile: ciFixResultPath(projectName, entry.name),
    envPrefix: ciFix.envPrefix,
    envVars: { GARDEN_REVIEWER: "1" },
    signalFifo: signalFifoPath(projectName),
    onLaunched: () => scheduleReviewTimeoutPoke(projectName),
    model: ciFix.model,
    effort: ciFix.effort,
    harness: ciFix.harness,
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
  // Launch is a routine lifecycle beat — log it (streams into `garden logs`)
  // but do not raise an operator alert. The alert badge is reserved for states
  // that need the operator: only ci-fix budget *exhaustion* (below) alerts.
  log.info("poller", "launched ci-fix", {
    worker: entry.name,
    data: {
      project: projectName, attempt: nextAttempts, budget: CI_FIX_BUDGET,
      sha: sha.slice(0, 7), detail,
    },
  });
  return true;
}

// The ci-fix analog of resolverOutputWasTransient: was the ci-fix agent's run a
// transient backend error (5xx / 429 / overloaded) or a usage/quota cutoff —
// rather than a genuine couldn't-fix? An outage OR quota block should escalate
// recoverably instead of parking in the `ci` reason that tells the operator to
// push a fix. A foreign harness's subscription usage-limit surfaces only through
// quotaLimitResetHint, NOT isTransientError (the reviewer's quota fallback keys
// off the same split), so both are checked. Harness-aware; read before
// cleanCiFixFiles removes the result/sidecar.
function ciFixOutputWasTransient(projectName: string, entry: WorkerEntry): boolean {
  const harness = resolveReviewRole(
    tryGetProject(projectName) ?? {}, entry.workflow ?? "default", "ciFix", undefined, entry,
  ).harness;
  const resultFile = ciFixResultPath(projectName, entry.name);
  let rawOutput = "";
  try { rawOutput = fs.readFileSync(resultFile, "utf-8"); } catch { /* missing */ }
  let sidecar = "";
  if (harness !== "claude-code") {
    try { sidecar = fs.readFileSync(codexStderrSidecar(resultFile), "utf-8"); } catch { /* missing */ }
  }
  const source = (harness === "claude-code"
    ? rawOutput
    : [rawOutput, sidecar].filter(Boolean).join("\n")) || null;
  if (source === null) return false;
  const core = getHarnessCore(harness);
  return core.isTransientError(source) || core.quotaLimitResetHint(source) !== null;
}

function escalateCiFixBudget(
  projectName: string,
  wtPath: string,
  entry: WorkerEntry,
  sha: string,
  wasTransient = false,
): void {
  const bodyTail = entry.lastCiFixBody
    ? `\n\nLast ci-fix output:\n${entry.lastCiFixBody.slice(0, 500)}`
    : "";
  log.error("poller", "ci-fix budget exhausted", {
    worker: entry.name,
    data: { project: projectName, budget: CI_FIX_BUDGET, sha: sha.slice(0, 7) },
  });
  addAlert({
    level: "error",
    source: "poller",
    project: projectName,
    worker: entry.name,
    message: wasTransient
      ? `CI fix-agent for ${entry.name} on ${sha.slice(0, 7)} could not reach its backend (transient API errors) across ${CI_FIX_BUDGET} attempts — CI is still red but this is not a code failure. 'garden kick' retries once the outage clears.${bodyTail}`
      : `CI fix-agent exhausted ${CI_FIX_BUDGET} attempts for ${entry.name} on ${sha.slice(0, 7)}. ` +
        `Parking in failing. Push a fix or set 'requireCiSuccess false' to bypass.${bodyTail}`,
    // Per-SHA so a new commit that fails CI differently deserves a fresh
    // alert. lastCiFixBody varies across runs and would defeat the default
    // 200-char dedup key.
    dedupKey: `ci-fix-exhausted:${projectName}:${entry.name}:${sha}`,
  });
  const headSha = getBranchHeadSha(wtPath);
  transitionState(projectName, entry.name, "failing", {
    failCount: (entry.failCount ?? 0) + 1,
    // A transient outage is kick-recoverable; the `ci` reason (push a fix) is
    // for a genuinely red CI the agent couldn't repair.
    failingReason: wasTransient ? "transient-review" : "ci",
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
  // Detect a transient backend outage before cleanCiFixFiles removes the files.
  const wasTransient = ciFixOutputWasTransient(projectName, entry);
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

  // A non-passing verification whose remote ref still advanced past the launch
  // baseline is a worker-authored push during ci-fix (operator nudged the pane),
  // not a genuine ci-fix failure. The resolver never pushes, so poller-resolve.ts
  // detects this with an early return before its ledger write; the ci-fix agent
  // DOES push, so the worker push is only distinguishable after verification.
  // Compute it once so the ledger below and the reset branch below agree.
  const workerPushInterruption = !verificationPassed
    && !!remoteHeadSha && !!entry.lastSeenSha && remoteHeadSha !== entry.lastSeenSha;

  // Ledger the ci-fix outcome at the single point a genuine outcome is known,
  // before the branch into retry / escalate / merge-pending. Skipped on a worker-
  // push interruption so an interruption isn't recorded as a cifix.outcome
  // failure — mirroring resolve.outcome, which the resolver's early return omits
  // in the same case. verificationPassed is the ground truth; attempts is the
  // effort spent; reviewStartedAt is the agent's launch stamp (reused field).
  if (!workerPushInterruption) {
    recordCiFixOutcome(projectName, entry.name, entry.createdAt, entry.workflow ?? "default", {
      verdict: result?.verdict ?? "missing",
      verificationPassed,
      attempts: entry.ciFixAttempts ?? 0,
      durationMs: entry.reviewStartedAt ? Date.now() - entry.reviewStartedAt : undefined,
    });
  }

  if (!verificationPassed) {
    log.warn("poller", "ci-fix verification failed", {
      worker: entry.name,
      data: {
        project: projectName,
        verdict: result?.verdict ?? "missing",
        madeProgress,
        pushed,
      },
    });

    // Worker-authored push during ci-fix (operator nudged the worker pane
    // mid-fix): abort, reset budget, and let the normal working→reviewing
    // flow re-enter from the new SHA.
    if (workerPushInterruption) {
      log.info("poller", "new commits during ci-fix, resetting to working", {
        worker: entry.name,
        data: { project: projectName },
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
      escalateCiFixBudget(projectName, wtPath, entry, entry.failingSha ?? entry.lastSeenSha ?? "", wasTransient);
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

  // Success: agent pushed a fix and re-enters merge-pending; the next CI gate
  // query runs against the new SHA — if the fix works the merge proceeds, if it
  // doesn't gateCiStatus sees the new SHA and spawns another attempt. A routine
  // lifecycle beat: log it (visible in `garden logs`) but raise no operator
  // alert — the badge is reserved for exhaustion.
  log.info("poller", "ci-fix pushed", {
    worker: entry.name,
    data: { project: projectName, attempts: entry.ciFixAttempts ?? 0, newSha: headSha?.slice(0, 7) },
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
    data: { project: projectName, elapsedMs, timeoutMs: REVIEW_TIMEOUT_MS },
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
    // Reset the ci-fix budget on the timeout park, mirroring
    // escalateCiFixBudget — otherwise a worker that recovers from one timeout
    // carries a silently-reduced budget into later merge cycles.
    ciFixAttempts: 0,
    preCiFixSha: undefined,
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
      log.warn("poller", "ci-fix result file missing", { worker: entry.name, data: { project: projectName } });
      return null;
    }
    const output = fs.readFileSync(resultFile, "utf-8").trim();
    if (!output) {
      log.warn("poller", "ci-fix result file empty", { worker: entry.name, data: { project: projectName } });
      return null;
    }
    const parsed = parseLastLineVerdict(output, CI_FIX_VERDICT_VOCAB, { scanLines: 1 });
    if (!parsed) {
      const lastLine = output.split("\n").reverse().find(l => l.trim())?.trim() ?? "";
      log.warn("poller", "could not parse ci-fix verdict", {
        worker: entry.name,
        data: { project: projectName, lastLine },
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
      data: { project: projectName, error: String(err) },
    });
    return null;
  }
}

export function cleanCiFixFiles(projectName: string, workerName: string): void {
  const resultFile = ciFixResultPath(projectName, workerName);
  try { fs.unlinkSync(resultFile); } catch { /* ignore */ }
  // A codex-routed ci-fix agent splits stderr into a sidecar (see cleanReviewFiles).
  try { fs.unlinkSync(codexStderrSidecar(resultFile)); } catch { /* ignore */ }
  try { fs.unlinkSync(ciFixPromptPath(projectName, workerName)); } catch { /* ignore */ }
}

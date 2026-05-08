// Trellis vine model selection. See WORKFLOWS.md "Model selection and budget".
//
// Resolution order for the worker model on each iteration spawn:
//   1. Per-worker override: entry.trellis.workerModel (set via --model at plant time).
//   2. Workflow default: workflow.workerModel (trellis declares "sonnet").
//   3. Account default: undefined → no `--model` flag → claude picks.
//
// On top of that, when the resolved model is "sonnet" and Sonnet usage is
// at or above the project's threshold:
//
//   - trellisOpusFallback !== false (default): bump this iteration's model
//     to "opus" so the loop keeps moving. Fire one alert per Sonnet reset
//     window (deduped via `entry.trellis.modelFallbackAt`).
//   - trellisOpusFallback === false: signal the caller to pause via the
//     existing usage-pause mechanism (alert source `usage`, gate flipped).
//
// The reviewer model is *never* affected by this — Invariant 10 keeps the
// reviewer pinned to workflow.reviewerModel ("opus"). Reviewer launches
// thread `model: workflow.reviewerModel` directly in poller-review.ts.
//
// Pure function: takes the inputs, returns the decision. The caller
// interprets the result, fires the alert, updates `trellis.modelFallbackAt`.
// Keeping it pure makes it easy to unit-test with synthetic snapshots.
import {
  getAutoContinueConfig, setAutoContinueConfig, tryGetProject,
  type AutoContinueConfig, type ProjectConfig,
} from "../config.js";
import { addAlert } from "./alerts.js";
import { log } from "./log.js";
import { updateWorkerFields, type WorkerEntry } from "./registry.js";
import { readUsageSnapshot, type UsageSnapshot } from "./usage.js";
import type { WorkflowDefinition } from "./workflows/types.js";

export type ResolvedModel = "opus" | "sonnet";

export interface ResolveVineModelResult {
  /** Model to spawn this iteration with. `null` means: do not spawn —
   *  the caller should pause the loop via the global usage-pause path
   *  (mirrors the operator's `garden auto off`). */
  model: ResolvedModel | null;
  /** True when the resolved model differs from the requested one due to
   *  Sonnet exhaustion. Caller fires the fallback alert and updates
   *  `entry.trellis.modelFallbackAt` to dedupe. */
  fellBack: boolean;
  /** When `model === null` (Sonnet exhausted, fallback disabled), the
   *  ISO timestamp at which the Sonnet meter resets. The caller sets
   *  this as the `pausedUntil` on the global auto-continue gate. */
  pausedUntil?: string;
  /** Short human-readable reason for logs/alerts. */
  reason?: string;
}

export function resolveVineModel(
  entry: WorkerEntry,
  project: ProjectConfig,
  workflow: WorkflowDefinition,
  snapshot: UsageSnapshot | null,
  autoContinue: AutoContinueConfig,
): ResolveVineModelResult {
  // 1. Resolve the requested model from the chain.
  const requested: ResolvedModel | undefined =
    entry.trellis?.workerModel ?? workflow.workerModel;

  // No requested model means the worker takes the account default. Trellis
  // workflow always sets workflow.workerModel, so this branch only fires
  // if a future workflow leaves both unset. Treat it as "account default,
  // no fallback applies."
  if (!requested) {
    return { model: null, fellBack: false, reason: "no model requested (account default)" };
  }

  // 2. If the requested model is opus, no fallback applies — Sonnet
  // exhaustion doesn't affect Opus iterations.
  if (requested === "opus") {
    return { model: "opus", fellBack: false };
  }

  // 3. Sonnet path. Check the snapshot.
  const exhaustion = sonnetExhaustion(snapshot, autoContinue.usageThreshold);
  if (!exhaustion) {
    return { model: "sonnet", fellBack: false };
  }

  // 4. Sonnet at or above threshold. Choose between fallback-to-Opus and
  // pause-the-loop based on the project config (default: fallback enabled).
  const fallbackEnabled = project.trellisOpusFallback !== false;
  if (fallbackEnabled) {
    return {
      model: "opus",
      fellBack: true,
      reason: `Sonnet ${exhaustion.label} at ${exhaustion.pct}% — falling back to Opus for this iteration`,
    };
  }

  return {
    model: null,
    fellBack: false,
    pausedUntil: exhaustion.resetsAt,
    reason: `Sonnet ${exhaustion.label} at ${exhaustion.pct}% — trellisOpusFallback=false, pausing loop until reset`,
  };
}

interface SonnetExhaustion {
  label: string;        // "7d" — WORKFLOWS.md spec's notation is loose; the
                        // actual snapshot tracks one Sonnet meter, the
                        // seven-day bucket. See TRELLIS-PLAN.md Q1.
  pct: number;          // rounded percentage for the alert text
  resetsAt: string;     // ISO 8601
}

function sonnetExhaustion(
  snapshot: UsageSnapshot | null,
  threshold: number,
): SonnetExhaustion | null {
  if (!snapshot?.data?.sonnet) return null;
  const meter = snapshot.data.sonnet;
  if (meter.pct < threshold) return null;
  return {
    label: "7d",
    pct: Math.round(meter.pct),
    resetsAt: meter.resetsAt,
  };
}

// Helper for the alert-deduplication window. Returns true when the entry's
// last fallback was recorded before the latest Sonnet reset (i.e. a new
// fallback cycle has started and a fresh alert is appropriate). Returns
// false when the existing fallback is still within the same Sonnet
// window — alert already fired.
export function shouldFireFallbackAlert(
  entry: WorkerEntry,
  snapshot: UsageSnapshot | null,
): boolean {
  const fallbackAt = entry.trellis?.modelFallbackAt;
  if (!fallbackAt) return true;
  const resetsAt = snapshot?.data?.sonnet?.resetsAt;
  if (!resetsAt) return true; // no anchor — fire conservatively
  const resetMs = Date.parse(resetsAt);
  if (!Number.isFinite(resetMs)) return true;
  // We've fired before. Fire again only if the *previous* Sonnet window
  // has reset since then (i.e. the fallback is now in a new window).
  // The simplest approximation: refire if more than ~7 days have passed
  // since the last fallback.
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  return Date.now() - fallbackAt > SEVEN_DAYS_MS;
}

// Side-effecting wrapper around resolveVineModel. Reads the usage snapshot
// + autoContinue config from disk, calls the pure resolver, and applies
// the alert + state updates the result calls for. Returns the resolved
// model (or null when the loop should pause).
//
// Callers (newWorker on initial plant, trellisAutoContinueAfterMerge on
// per-iteration respawn) pass the result to the spawn primitives. When
// the result is null, callers should NOT spawn — the global usage gate
// has been flipped and the operator's `garden auto on` (or Sonnet reset)
// is required to resume.
export function resolveAndApplyVineModel(
  projectName: string,
  entry: WorkerEntry,
  workflow: WorkflowDefinition,
): ResolvedModel | null {
  const project = tryGetProject(projectName);
  if (!project) {
    log.warn("trellis-model", "project not registered, skipping vine model resolution", {
      worker: entry.name, data: { project: projectName },
    });
    return null;
  }
  const snapshot = readUsageSnapshot();
  const autoContinue = getAutoContinueConfig();
  const result = resolveVineModel(entry, project, workflow, snapshot, autoContinue);

  if (result.fellBack) {
    if (shouldFireFallbackAlert(entry, snapshot)) {
      addAlert({
        level: "warn",
        source: "trellis-budget",
        project: projectName,
        worker: entry.name,
        message:
          `Trellis vine ${entry.name} fell back from Sonnet to Opus this iteration: ` +
          `${result.reason ?? "Sonnet exhausted"}. ` +
          `Set 'garden config ${projectName} trellisOpusFallback false' to pause instead.`,
        // Stable key — Sonnet pct varies across the window; one alert per
        // worker per fallback occurrence (deduped within a Sonnet window).
        dedupKey: `trellis-fallback:${projectName}:${entry.name}`,
      });
      updateWorkerFields(projectName, entry.name, {
        trellis: { modelFallbackAt: Date.now() },
      });
    }
    log.info("trellis-model", "fell back to Opus for this iteration", {
      worker: entry.name, data: { project: projectName, reason: result.reason },
    });
    return result.model;
  }

  if (result.model === null && result.pausedUntil) {
    // trellisOpusFallback === false + Sonnet exhausted. Flip the global
    // auto-continue gate so the loop pauses until reset.
    setAutoContinueConfig({
      enabled: false,
      pausedUntil: result.pausedUntil,
      pausedReason: result.reason,
    });
    addAlert({
      level: "warn",
      source: "usage",
      project: projectName,
      worker: entry.name,
      message:
        `Trellis vine ${entry.name} paused: ${result.reason ?? "Sonnet exhausted"}. ` +
        `Loop resumes when Sonnet meter resets, or run 'garden auto on'.`,
    });
    log.warn("trellis-model", "paused vine due to Sonnet exhaustion (fallback disabled)", {
      worker: entry.name, data: { project: projectName, pausedUntil: result.pausedUntil },
    });
    return null;
  }

  return result.model;
}

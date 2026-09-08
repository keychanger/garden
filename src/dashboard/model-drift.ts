// Reconciles the model a worker is PINNED to against the model its harness is
// actually running.
//
// Garden passes the pin on the launch command line and has always treated it as
// settled fact — `entry.model` is what the status pane renders and what a bounce
// relaunches with. A harness can overrule it after launch. On 2026-09-08 codex
// 0.153.4, on the first session after a Homebrew upgrade, showed its new-model
// notice seven seconds into a worker's boot, moved that live session from the
// pinned `gpt-5.6-sol` to `gpt-6-astra`, and wrote the new model into
// `$CODEX_HOME/config.toml`. The worker's own pane said `gpt-6-astra` in its
// status line for the next 13 minutes of work; garden's row said `gpt-5.6-sol`,
// and nothing anywhere said they disagreed.
//
// The observation is stored beside the pin, never over it: overwriting
// `entry.model` would silence the row by adopting the accident, and the next
// bounce would then relaunch on the drifted model deliberately. So the row
// renders the observation and colors it when the two disagree (status.ts), and
// `⌥i` -> model still restores the intent.
import { addAlert } from "./alerts.js";
import { resolveWorkerRunningModel } from "./harness/core.js";
import { log } from "./log.js";
import { updateWorkerFieldsIf, type WorkerEntry, type WorkerRegistry } from "./registry.js";

// The pin this worker was launched with, in the same vocabulary readRunningModel
// answers in. Trellis vines carry theirs under the workflow sub-object, matching
// how the status pane resolves the model badge.
export function pinnedModel(entry: WorkerEntry): string | undefined {
  return entry.model ?? entry.trellis?.workerModel;
}

// True when the worker's most recent turn ran a model other than the one garden
// pinned. A worker with no pin cannot drift — it was launched on whatever the
// harness defaults to, which is what it is running.
export function hasModelDrift(entry: WorkerEntry): boolean {
  const pin = pinnedModel(entry);
  return pin !== undefined && entry.runningModel !== undefined && entry.runningModel !== pin;
}

// Read each worker's running model back from its harness and record it.
// Returns the number of entries whose reading MOVED, so the caller repaints
// only when the pane would change — the steady state is a bounded tail read per
// worker with no registry write at all.
//
// Harness-gated rather than status-gated: resolveWorkerRunningModel answers null
// for any harness that cannot read its model back (every harness but Codex
// today), so a fleet with no such worker pays one map lookup each. Workers whose
// pane is gone are skipped — their reading can no longer move, and a dead
// worker's rollout is history the operator cannot act on.
export function sweepWorkerModels(registry: WorkerRegistry): number {
  let moved = 0;
  for (const [project, entries] of Object.entries(registry.workers)) {
    for (const entry of entries) {
      if (entry.agentStatus === "exited") continue;
      const observed = resolveWorkerRunningModel(entry);
      if (!observed || observed === entry.runningModel) continue;
      // Guarded on the value this sweep read, so a concurrent writer's newer
      // observation is never rolled back to ours. Return the locked snapshot
      // with the observation applied: the operator may have changed the pin
      // since this sweep began, and alerting against the stale outer snapshot
      // would report drift that no longer exists.
      const updated = updateWorkerFieldsIf(project, entry.name, current =>
        current.agentStatus !== "exited" && current.runningModel === entry.runningModel
          ? { fields: { runningModel: observed }, result: { ...current, runningModel: observed } }
          : { fields: null, result: null });
      if (!updated) continue;
      moved++;
      reportReading(project, updated);
    }
  }
  return moved;
}

// Announce a reading that moved. Drift is an alert because it is silent
// otherwise and expensive to discover late — the motivating worker spent 13
// minutes on the wrong model; agreement is a log line, since it is the answer
// the operator already expects.
function reportReading(project: string, entry: WorkerEntry): void {
  const pin = pinnedModel(entry);
  const data = { project, model: entry.runningModel, pinned: pin };
  if (!hasModelDrift(entry)) {
    log.info("model-drift", "observed running model", { worker: entry.name, data });
    return;
  }
  log.warn("model-drift", "running model differs from the pin", { worker: entry.name, data });
  addAlert({
    level: "warn",
    source: "model-drift",
    project,
    worker: entry.name,
    // States what was observed and nothing about why. Several distinct causes
    // produce this reading — the harness moved a live session off the pin, a
    // resume did not adopt a newly-set pin, or the pin changed and the worker
    // has not taken a turn since — and the alert cannot tell them apart.
    message: `${entry.name} ran ${entry.runningModel} on its most recent turn; its pinned model is ${pin}.`,
    // Both models in the key: a worker that drifts, is bounced back, then drifts
    // again to a different model is a new fact worth a new alert, while the same
    // standing drift re-observed is not.
    dedupKey: `model-drift:${project}:${entry.name}:${pin}:${entry.runningModel}`,
  });
}

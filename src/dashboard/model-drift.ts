// Reconciles the model a worker is PINNED to against the model its harness is
// actually running.
//
// Garden passes the pin on the launch command line and has always treated it as
// settled fact. Usually it is `entry.model`; Codex also has a Garden-owned
// fallback when that field is absent. A harness can overrule it after launch.
// On 2026-09-08 codex
// 0.153.4, on the first session after a Homebrew upgrade, showed its new-model
// notice seven seconds into a worker's boot, moved that live session from the
// pinned `gpt-5.6-sol` to `gpt-6-astra`, and wrote the new model into
// `$CODEX_HOME/config.toml`. The worker's own pane said `gpt-6-astra` in its
// status line for the next 13 minutes of work; garden's row said `gpt-5.6-sol`,
// and nothing anywhere said they disagreed.
//
// The observation is stored beside the pin, never over it: replacing launch
// intent would silence the row by adopting the accident, and the next bounce
// would then relaunch on the drifted model deliberately. So the row renders the
// observation in the pin's place — one model, shown only when it is not the
// model the project runs (status.ts) — while `⌥i` -> model still restores the
// intent.
import { resolveWorkerRunningModel } from "./harness/core.js";
import { DEFAULT_CODEX_MODEL } from "./launch-plan.js";
import { log } from "./log.js";
import { updateWorkerFieldsIf, type WorkerEntry, type WorkerRegistry } from "./registry.js";

// The pin this worker was launched with, in the same vocabulary readRunningModel
// answers in. Trellis vines carry theirs under the workflow sub-object. An
// otherwise-unpinned Codex worker still has Garden's explicit harness tuning
// default on its command line, so that is intent too even though the optional
// per-worker field is absent.
export function pinnedModel(entry: WorkerEntry): string | undefined {
  return entry.model
    ?? entry.trellis?.workerModel
    ?? (entry.harness === "codex" ? DEFAULT_CODEX_MODEL : undefined);
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
// for any harness that cannot read its model back, so a fleet with no such
// worker pays one map lookup each. Both registered harnesses read theirs today,
// each from a bounded tail of its own transcript. Workers whose pane is gone are
// skipped — their reading can no longer move, and a dead worker's rollout is
// history the operator cannot act on.
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
      // since this sweep began, and reporting against the stale outer snapshot
      // would name a drift that no longer exists.
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

// Log a reading that moved — one line per change, since the sweep only reports
// what it actually wrote. Deliberately NOT an alert: the operator changes a
// worker's model routinely (`⌥i` -> model, or `/model` typed into the pane),
// which produces exactly the reading a harness switching a session on its own
// does, and there is no signal in the transcript that separates the two. An
// alert on every model change would be noise on the surface reserved for things
// that need attention now. The row is the surface for this instead: it names the
// running model where it used to assert the pin, so a divergence is visible at
// the moment the operator looks at the fleet — which is what was actually broken
// when a worker ran 13 minutes on a model nobody had chosen. Drift stays `warn`
// so `garden logs -l warn` reconstructs what a branch was built on.
function reportReading(project: string, entry: WorkerEntry): void {
  const data = { project, model: entry.runningModel, pinned: pinnedModel(entry) };
  if (hasModelDrift(entry)) {
    log.warn("model-drift", "running model differs from the pin", { worker: entry.name, data });
  } else {
    log.info("model-drift", "observed running model", { worker: entry.name, data });
  }
}

import fs from "node:fs";
import path from "node:path";
import { readRegistry, updateWorkerFieldsIf, type WorkerEntry } from "./registry.js";
import { codexHome, readCodexInputRequestState, readCodexTurnState } from "./harness/codex-core.js";
import { log } from "./log.js";
import { triggerProjectPoll } from "./poller-fifo.js";

const WATCH_DEBOUNCE_MS = 250;

export function reconcileCodexInputRequests(changedTranscriptPath?: string): boolean {
  const registry = readRegistry();
  const updates: Array<{
    project: string;
    workerName: string;
    from: WorkerEntry["agentStatus"];
    to: WorkerEntry["agentStatus"];
    guardField?: "lastEventAt" | "lastStateChangeAt";
    guardValue?: number;
  }> = [];
  const now = Date.now();

  for (const [project, entries] of Object.entries(registry.workers)) {
    for (const entry of entries) {
      if (entry.harness !== "codex"
          || (entry.agentStatus !== "working" && entry.agentStatus !== "asking")
          || !entry.transcriptPath
          || (changedTranscriptPath
            && entry.transcriptPath !== changedTranscriptPath
            && path.basename(entry.transcriptPath) !== path.basename(changedTranscriptPath))) {
        continue;
      }
      const input = readCodexInputRequestState(entry.transcriptPath);

      let agentStatus: WorkerEntry["agentStatus"] | undefined;
      if (input?.waiting && entry.agentStatus === "working") {
        agentStatus = "asking";
      } else if (input && !input.waiting && entry.agentStatus === "asking"
          && input.changedAt >= (entry.lastStateChangeAt ?? 0)) {
        agentStatus = "working";
      } else if (!input?.waiting && entry.agentStatus === "working") {
        // Stand in for the Stop hook Codex did not fire. `working` outlives the
        // turn whenever the last tool call lands after the turn's final Stop
        // (see readCodexTurnState), and nothing else ever clears it: the worker
        // is parked at its prompt, so no further hook fires unprompted, and the
        // merge gate refuses to touch a worktree it believes an agent is
        // editing — a silent stall until the operator notices.
        //
        // The freshness guard is what keeps this from racing a turn that just
        // started: a new prompt writes `working` with lastEventAt now, while
        // the rollout still ends at the PREVIOUS turn's task_complete, so an
        // unguarded heal would idle a worker that is genuinely running.
        //
        // It compares lastEventAt, NOT lastStateChangeAt: the latter is stamped
        // by prState transitions too, so a worker that goes on to `reviewing`
        // and `merge-pending` carries a lastStateChangeAt minutes NEWER than the
        // turn end it is waiting to have recognized — which is precisely the
        // stalled shape, and would leave the heal permanently out of reach.
        const turn = readCodexTurnState(entry.transcriptPath);
        if (turn?.complete && turn.changedAt >= (entry.lastEventAt ?? 0)) {
          agentStatus = "idle";
        }
      }
      if (!agentStatus) continue;

      const guardField = agentStatus === "idle"
        ? "lastEventAt"
        : entry.agentStatus === "asking" ? "lastStateChangeAt" : undefined;
      updates.push({
        project,
        workerName: entry.name,
        from: entry.agentStatus,
        to: agentStatus,
        guardField,
        guardValue: guardField ? entry[guardField] : undefined,
      });
    }
  }

  if (updates.length === 0) return false;
  // The scan above reads the registry unlocked, so a hook can land between it
  // and the write — the Stop hook that idles a turn ending in the same instant
  // the rollout records its last line is the realistic one, and stomping it
  // back to `working` leaves the row spinning until the operator's next prompt.
  // Re-check the status and whichever freshness field informed the decision
  // from inside the lock, and drop the update if another writer moved either.
  let changed = false;
  for (const update of updates) {
    const applied = updateWorkerFieldsIf(update.project, update.workerName, entry => {
      const guardMatches = !update.guardField
        || entry[update.guardField] === update.guardValue;
      return entry.agentStatus === update.from && guardMatches
        ? {
          fields: { agentStatus: update.to, lastEventAt: now, lastStateChangeAt: now },
          result: true,
        }
        : { fields: null, result: false };
    });
    if (!applied) continue;
    changed = true;
    if (update.to === "idle") triggerProjectPoll(update.project);
    log.info("codex-input", update.to === "idle"
      ? "reconciled turn end missed by the Stop hook"
      : "reconciled request_user_input state", {
      worker: update.workerName,
      data: { project: update.project, agentStatus: update.to },
    });
  }
  return changed;
}

export function startCodexInputWatcher(onStateChange: () => void): void {
  const sessionsDir = path.join(codexHome(), "sessions");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let changedTranscriptPath: string | undefined;
  let scanAll = false;

  const reconcile = (): void => {
    timer = undefined;
    try {
      if (reconcileCodexInputRequests(scanAll ? undefined : changedTranscriptPath)) onStateChange();
    } catch (err) {
      log.warn("codex-input", "request_user_input reconciliation failed", {
        data: { error: String(err) },
      });
    } finally {
      changedTranscriptPath = undefined;
      scanAll = false;
    }
  };

  reconcile();
  try {
    // Codex creates this lazily on its first run, so on a workstation where it
    // has never run the directory is absent and fs.watch throws ENOENT. There is
    // no retry below — the watcher would stay dead for the whole life of the
    // watchdog process that started it, costing every Codex worker its `asking`
    // status and its missed-turn-end healing. Creating the directory is exactly
    // what Codex itself does on first run, and is a no-op on every later boot.
    fs.mkdirSync(sessionsDir, { recursive: true });
    const watcher = fs.watch(sessionsDir, { recursive: true }, (_event, filename) => {
      if (filename && !String(filename).endsWith(".jsonl")) return;
      const nextPath = filename ? path.resolve(sessionsDir, String(filename)) : undefined;
      if (!nextPath || (changedTranscriptPath && changedTranscriptPath !== nextPath)) {
        changedTranscriptPath = undefined;
        scanAll = true;
      } else if (!scanAll) {
        changedTranscriptPath = nextPath;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(reconcile, WATCH_DEBOUNCE_MS);
    });
    watcher.on("error", (err) => {
      log.warn("codex-input", "request_user_input watcher failed", {
        data: { error: String(err) },
      });
    });
  } catch (err) {
    log.warn("codex-input", "request_user_input watcher unavailable", {
      data: { sessionsDir, error: String(err) },
    });
  }
}

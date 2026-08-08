import fs from "node:fs";
import path from "node:path";
import { batchUpdateWorkerFields, readRegistry, type WorkerEntry } from "./registry.js";
import { codexHome, readCodexInputRequestState } from "./harness/codex-core.js";
import { log } from "./log.js";

const WATCH_DEBOUNCE_MS = 250;

export function reconcileCodexInputRequests(changedTranscriptPath?: string): boolean {
  const registry = readRegistry();
  const updates: Array<{
    project: string;
    workerName: string;
    fields: Partial<WorkerEntry>;
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
      if (!input) continue;

      let agentStatus: WorkerEntry["agentStatus"] | undefined;
      if (input.waiting && entry.agentStatus === "working") {
        agentStatus = "asking";
      } else if (!input.waiting && entry.agentStatus === "asking"
          && input.changedAt >= (entry.lastStateChangeAt ?? 0)) {
        agentStatus = "working";
      }
      if (!agentStatus) continue;

      updates.push({
        project,
        workerName: entry.name,
        fields: { agentStatus, lastEventAt: now, lastStateChangeAt: now },
      });
    }
  }

  if (updates.length === 0) return false;
  batchUpdateWorkerFields(updates);
  for (const update of updates) {
    log.info("codex-input", "reconciled request_user_input state", {
      worker: update.workerName,
      data: { project: update.project, agentStatus: update.fields.agentStatus },
    });
  }
  return true;
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

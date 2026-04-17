// Worker registry: persistent record of living workers across dashboard restarts.
//
// Concurrency model: the registry file is read/modified/written as a unit.
// Multiple processes (poller, hooks, dashboard commands) can write at the
// same instant. To prevent lost updates, every read-modify-write cycle holds
// an exclusive file lock for the duration. The lock is a sibling .lock file
// created with O_CREAT|O_EXCL. Stale locks (holder PID dead) are reclaimed.
// See STATUS.md "Detection machinery" — the registry is the single source of
// truth, so it must be race-free.
import fs from "node:fs";
import path from "node:path";
import { SESSIONS_DIR } from "../config.js";
import { log } from "./log.js";

// claudeStatus is written by Claude Code hooks and the tmux pane-died handler.
// prState is written by the poller. There are no other writers. See STATUS.md.
export type ClaudeStatus = "loading" | "ready" | "working" | "asking" | "idle" | "exited";
export type PrState = "working" | "reviewing" | "merge-pending" | "resolving" | "merged" | "failing";

export interface WorkerEntry {
  name: string;       // adjective-noun name, e.g. "swift-oak"
  sessionId: string;  // claude session UUID for direct resume
  task: string;       // last known task summary from pane title
  worktreePath?: string;
  branchName?: string;
  // Base branch pinned at worker creation. Set by newWorker() after verifying
  // origin/<baseBranch> exists. All consumers (poller, Stop hook, kick, resume)
  // must prefer this over re-resolving from projectConfig/main-checkout —
  // otherwise the worker silently breaks when the main checkout is switched
  // to a local-only branch. Optional only for backward compat with workers
  // created before this field existed; new workers always set it.
  baseBranch?: string;
  prState?: PrState;
  lastSeenSha?: string;
  lastShaChangeAt?: string;
  mergedAt?: string;
  failCount?: number;
  failingSha?: string;
  claudeStatus?: ClaudeStatus;
  lastHookAt?: number;    // epoch ms when a Claude hook last fired for this worker
  // Set by the worker's Stop hook when it sees commits ahead of base. The
  // poller's handleWorking gates launchReview on this — without it, an idle
  // worker with stale commits would be reviewed on every FIFO poke. Cleared
  // when launchReview runs. Per STATUS.md invariant 2: "working is the only
  // entry point to the review cycle" — pendingReviewAt makes that explicit.
  pendingReviewAt?: number;
  reviewWindowName?: string;
  mergePendingAt?: string;
  lastReviewBody?: string;
  // Resolver state (see STATUS.md invariants 7 and 8). preResolveSha is the
  // HEAD SHA captured the moment before the resolver launches — the poller
  // compares post-resolver HEAD against it to confirm the resolver actually
  // committed something. resolveAttempts counts resolver launches for the
  // current merge; budget is 2, resets on worker push or successful merge.
  // lastResolveBody carries the resolver's last output body for alert text.
  preResolveSha?: string;
  resolveAttempts?: number;
  lastResolveBody?: string;
  role?: string;
  parentWorker?: string;
}

export interface WorkerRegistry {
  workers: Record<string, WorkerEntry[]>;
}

export const REGISTRY_FILE = path.join(SESSIONS_DIR, "dashboard.registry.json");
const LOCK_FILE = REGISTRY_FILE + ".lock";

// Acquire an exclusive lock by creating a file with O_CREAT|O_EXCL. If the
// lockfile already exists and the holder PID is dead, reclaim it. Retries
// briefly under contention. Throws if it can't acquire within the deadline —
// callers treat that as best-effort and proceed without the lock (a missed
// hook write is preferable to hanging the dashboard).
function withRegistryLock<T>(fn: () => T): T {
  const deadline = Date.now() + 500; // 500ms total
  const myPid = process.pid;
  let acquired = false;

  while (!acquired && Date.now() < deadline) {
    try {
      fs.mkdirSync(SESSIONS_DIR, { recursive: true });
      const fd = fs.openSync(LOCK_FILE, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o644);
      fs.writeSync(fd, String(myPid));
      fs.closeSync(fd);
      acquired = true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        // Check if holder is alive; if not, reclaim
        let holderPid = -1;
        try { holderPid = parseInt(fs.readFileSync(LOCK_FILE, "utf-8"), 10); } catch { /* ignore */ }
        let holderAlive = false;
        if (Number.isFinite(holderPid) && holderPid > 0) {
          try { process.kill(holderPid, 0); holderAlive = true; } catch { /* dead */ }
        }
        if (!holderAlive) {
          try { fs.unlinkSync(LOCK_FILE); } catch { /* ignore */ }
          continue; // retry immediately
        }
        // Spin briefly
        const wait = new Int32Array(new SharedArrayBuffer(4));
        Atomics.wait(wait, 0, 0, 5);
        continue;
      }
      throw err;
    }
  }

  if (!acquired) {
    throw new Error("Could not acquire registry lock after 500ms");
  }

  try {
    return fn();
  } finally {
    try { fs.unlinkSync(LOCK_FILE); } catch { /* ignore */ }
  }
}

export function readRegistry(): WorkerRegistry {
  try {
    if (fs.existsSync(REGISTRY_FILE)) {
      return JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf-8"));
    }
  } catch (err) {
    log.warn("registry", "failed to read registry, using empty", {
      data: { error: String(err) },
    });
  }
  return { workers: {} };
}

export function writeRegistry(registry: WorkerRegistry): void {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const tmpFile = `${REGISTRY_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(registry, null, 2));
  fs.renameSync(tmpFile, REGISTRY_FILE);
}

export function addWorker(project: string, entry: WorkerEntry): void {
  withRegistryLock(() => {
    const registry = readRegistry();
    if (!registry.workers[project]) registry.workers[project] = [];
    registry.workers[project].push(entry);
    writeRegistry(registry);
  });
}

export function removeWorker(project: string, workerName: string): void {
  withRegistryLock(() => {
    const registry = readRegistry();
    const entries = registry.workers[project];
    if (!entries) return;
    registry.workers[project] = entries.filter(e => e.name !== workerName);
    if (registry.workers[project].length === 0) delete registry.workers[project];
    writeRegistry(registry);
  });
}

export function updateWorkerTask(project: string, workerName: string, task: string): void {
  withRegistryLock(() => {
    const registry = readRegistry();
    const entries = registry.workers[project];
    if (!entries) return;
    const entry = entries.find(e => e.name === workerName);
    if (!entry) return;
    entry.task = task;
    writeRegistry(registry);
  });
}

export function updateWorkerFields(
  project: string,
  workerName: string,
  fields: Partial<Omit<WorkerEntry, "name">>,
): void {
  withRegistryLock(() => {
    const registry = readRegistry();
    const entries = registry.workers[project];
    if (!entries) return;
    const entry = entries.find(e => e.name === workerName);
    if (!entry) return;

    // Log state transitions when prState changes
    if (fields.prState && fields.prState !== entry.prState) {
      log.info("poller", `${entry.prState ?? "new"} -> ${fields.prState}`, {
        worker: workerName,
      });
    }

    Object.assign(entry, fields);
    writeRegistry(registry);
  });
}

export function batchUpdateWorkerFields(
  updates: Array<{ project: string; workerName: string; fields: Partial<Omit<WorkerEntry, "name">> }>,
): void {
  if (updates.length === 0) return;
  withRegistryLock(() => {
    const registry = readRegistry();
    for (const { project, workerName, fields } of updates) {
      const entries = registry.workers[project];
      if (!entries) continue;
      const entry = entries.find(e => e.name === workerName);
      if (!entry) continue;
      if (fields.prState && fields.prState !== entry.prState) {
        log.info("poller", `${entry.prState ?? "new"} -> ${fields.prState}`, {
          worker: workerName,
        });
      }
      Object.assign(entry, fields);
    }
    writeRegistry(registry);
  });
}

export function findWorkerByName(
  project: string,
  workerName: string,
): WorkerEntry | undefined {
  return getWorkers(project).find(e => e.name === workerName);
}

export function getWorkers(project: string): WorkerEntry[] {
  return readRegistry().workers[project] ?? [];
}

export function getAllWorkerNames(): string[] {
  const registry = readRegistry();
  const names: string[] = [];
  for (const entries of Object.values(registry.workers)) {
    for (const entry of entries) {
      names.push(entry.name);
    }
  }
  return names;
}

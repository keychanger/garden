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
import { atomicWriteFile } from "./atomic-write.js";
import { withFileLock } from "./file-lock.js";
import { log } from "./log.js";

// claudeStatus is written by Claude Code hooks and the tmux pane-died handler.
// prState is written by the poller. There are no other writers. See STATUS.md.
export type ClaudeStatus = "loading" | "ready" | "working" | "asking" | "idle" | "exited";
export type PrState = "working" | "reviewing" | "merge-pending" | "resolving" | "merged" | "done" | "failing";

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
  // Epoch ms when the current reviewer/resolver window was launched. Set by
  // launchReview/launchResolver, cleared whenever reviewWindowName is cleared.
  // The poller uses this to enforce REVIEW_TIMEOUT_MS — a reviewer stuck on a
  // hung subprocess (e.g. tests with no timeout blocked by the sandbox) is
  // killed and escalated to `failing` rather than wedging the state machine.
  reviewStartedAt?: number;
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
  // Local HEAD SHA captured when a review is launched. Used by handleReviewing
  // to detect whether the reviewer actually committed anything (rebase + fixes)
  // so that an unparseable verdict with real work attached can be recovered
  // instead of silently discarded.
  preReviewSha?: string;
  // Set when handleReviewing receives an unparseable verdict but the reviewer
  // advanced HEAD; the poller force-pushes and re-queues one more review. A
  // second unparseable verdict falls through to the normal failing path.
  // Cleared on any parseable verdict (clean/fixed/failed).
  unparseableReviewAt?: number;
  // Set by handlePaneDied when claudeStatus was "working" at the moment the
  // pane died (dashboard kill, tmux server gone). Read by ensureDashboard's
  // resume loop to decide whether to auto-send a "continue" prompt after the
  // worker is brought back via `claude --resume`. Cleared by _continue-worker
  // once the prompt is dispatched.
  interruptedWhileWorking?: boolean;
  // Set by finalizeMerge after dispatching the post-merge auto-continue prompt.
  // Idempotency guard: if a merge event somehow replays within a short window,
  // we don't double-fire the continue. See dashboard/continue.ts and STATUS.md.
  lastAutoContinueAt?: number;
  // Transient payload for the post-merge auto-continue prompt. finalizeMerge
  // diffs preReviewSha against the merged tip and stores the changed-file list
  // here; continueWorkerAfterMerge reads it to enrich the prompt and clears it
  // after sending. pendingContinueSyncFailed signals that the post-merge
  // worktree sync was skipped (dirty or git failure) so the prompt can tell
  // the worker to sync manually. Both fields live only across the brief
  // finalizeMerge → detached-subprocess → send-keys window.
  pendingContinueChangedFiles?: string[];
  pendingContinueSyncFailed?: boolean;
  role?: string;
  parentWorker?: string;
}

export interface WorkerRegistry {
  workers: Record<string, WorkerEntry[]>;
}

export const REGISTRY_FILE = path.join(SESSIONS_DIR, "dashboard.registry.json");
const LOCK_FILE = REGISTRY_FILE + ".lock";

// Serialize read-modify-write cycles via withFileLock. Throws on timeout —
// callers treat that as best-effort and proceed without the lock (a missed
// hook write is preferable to hanging the dashboard, but the helper logs
// at warn so the operator sees real contention).
function withRegistryLock<T>(fn: () => T): T {
  return withFileLock(LOCK_FILE, fn, { name: "registry" });
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
  atomicWriteFile(REGISTRY_FILE, JSON.stringify(registry, null, 2));
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

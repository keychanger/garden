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

// Trellis reviewer verdict vocabulary. See WORKFLOWS.md "Reviewer prompt and
// verdict". Persisted on WorkerEntry.trellis.lastVerdict for trellis vines.
export type TrellisVerdict = "ALIGNED" | "DRIFT" | "FAILED" | "FLAGGED";

// Reason a worker is in `failing`. Allowed values per WORKFLOWS.md
// "Worker entry additions" + "Equilibrium and termination". Default
// workflow uses "code" and "unparseable-verdict"; trellis adds the rest.
// Optional: legacy entries lack this field; consumers default to "code"
// when absent on a `failing` worker.
export type FailingReason =
  | "code"
  | "trellis-flagged"
  | "iteration-budget"
  | "stagnation"
  | "unparseable-verdict";

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
  // Workflow definition that drives this worker's lifecycle (state machine,
  // state handlers, hook routing). Set to "default" by newWorker. Absent on
  // legacy entries from before the workflow registry shipped — consumers
  // (poller, transitionState, hook dispatcher) read with `entry.workflow ?? "default"`.
  // See WORKFLOWS.md and src/dashboard/workflows/.
  workflow?: string;
  // Reason the worker is in `failing`. See FailingReason above and
  // WORKFLOWS.md "Equilibrium and termination". Default workflow sets "code"
  // (Q8 retrofit) or "unparseable-verdict" (Q9 retrofit, phase 2).
  failingReason?: FailingReason;
  // Trellis-vine-only data. Populated only when workflow === "trellis";
  // absent on default workers. Migration of legacy flat trellis* fields
  // happens in readRegistry. updateWorkerFields deep-merges this sub-object
  // (passing `{ trellis: { lastVerdict: "ALIGNED" } }` updates only that
  // one key without clobbering the rest). See WORKFLOWS.md "Worker entry
  // additions" for field contracts.
  trellis?: TrellisData;
  // Grow-loop-only data. Populated only when workflow === "grow"; absent
  // on default and trellis workers. updateWorkerFields deep-merges this
  // sub-object (same pattern as `trellis`).
  grow?: GrowData;
}

/** Trellis-workflow per-worker data. All fields except `name` and `path`
 *  are runtime mutations the poller writes during the review loop. */
export interface TrellisData {
  /** Logical trellis identifier — e.g. "auth-rewrite". */
  name: string;
  /** Resolved absolute path to the trellis file at plant time. Stable
   *  lookup even if the project's trellisDir changes later. */
  path: string;
  /** Iteration counter. Incremented on each working → reviewing
   *  transition before the budget check and dispatch. Reads as 1 during
   *  the first review, 2 during the second, etc. Starts at 0. */
  iteration?: number;
  maxIterations?: number;
  lastVerdict?: TrellisVerdict;
  lastDrift?: string[];
  alignedCount?: number;
  /** Bounded (length 5) history of drift lists for stagnation detection (v1.5). */
  driftHistory?: string[][];
  /** Bounded (length 5) history of HEAD SHAs at iteration boundaries (v1.5). */
  shaHistory?: string[];
  /** Epoch ms when stagnation was detected; cleared on next push (v1.5). */
  stagnationConfirmedAt?: number;
  /** Cited clauses from a FLAGGED verdict — used in the alert and the
   *  resume command's diagnostic output. */
  flaggedClauses?: string[];
  /** True when the terminal `done` was reached via reviewer ALIGNED
   *  rather than operator-set `.garden-done`. Drives the `✓ aligned,
   *  N iters` status row decoration. Set by finalizeMerge on the
   *  ALIGNED path. */
  aligned?: boolean;
  /** Epoch ms of the most recent Sonnet → Opus fallback. Used to
   *  dedupe alerts within a single Sonnet 5h reset window (phase 3). */
  modelFallbackAt?: number;
  /** Per-worker model override, set via `--model` at plant time. Read
   *  each iteration; falls back to WorkflowDefinition.workerModel,
   *  then project default. Trellis-only — default workers don't carry
   *  this. */
  workerModel?: "opus" | "sonnet";
}

/** Grow-workflow per-worker data. The seed prompt is captured at plant
 *  time and inlined verbatim into every iter ≥ 2 continue prompt — that's
 *  why it lives on the entry rather than only on disk in a one-shot file.
 *  iteration is incremented on each working → reviewing transition (same
 *  pattern as TrellisData.iteration); maxIterations bounds the loop and
 *  is enforced at the post-merge auto-continue dispatch site (not at
 *  preflight, unlike trellis). */
export interface GrowData {
  /** Operator-supplied task description from `--seed` / `--seed-file` /
   *  picker prompt. Inlined verbatim into iter ≥ 2 continue prompts so
   *  the goal anchors across context resets. */
  seed: string;
  /** Iteration counter. Incremented on each working → reviewing transition
   *  before dispatch. Reads as 1 during the first review, 2 during the
   *  second, etc. Starts at 0. */
  iteration?: number;
  maxIterations?: number;
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

// Shape guard for parsed registry. Top-level must be an object with a
// `workers` field that maps project names to arrays. Per-entry validation
// only checks `name` is a string — every other WorkerEntry field is
// optional and tolerates absence (legacy entries from earlier garden
// versions don't carry baseBranch, workflow, etc.). A failed check signals
// hand-edit corruption or a half-write that escaped atomic-rename; fall
// back to empty rather than feed junk into the poller.
function isWorkerRegistry(x: unknown): x is WorkerRegistry {
  if (!x || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  if (!r.workers || typeof r.workers !== "object" || Array.isArray(r.workers)) return false;
  for (const entries of Object.values(r.workers as Record<string, unknown>)) {
    if (!Array.isArray(entries)) return false;
    for (const e of entries) {
      if (!e || typeof e !== "object") return false;
      const entry = e as Record<string, unknown>;
      if (typeof entry.name !== "string") return false;
    }
  }
  return true;
}

export function readRegistry(): WorkerRegistry {
  try {
    if (fs.existsSync(REGISTRY_FILE)) {
      const raw = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf-8"));
      if (!isWorkerRegistry(raw)) {
        log.warn("registry", "registry file failed shape check, using empty", {
          data: { topLevelKeys: Object.keys(raw ?? {}) },
        });
        return { workers: {} };
      }
      // Lazily migrate legacy flat trellis* fields to the nested
      // entry.trellis sub-object. Idempotent: entries already in the new
      // shape pass through unchanged. The next writeRegistry persists the
      // new shape; readers below this layer never see the old flat keys.
      for (const entries of Object.values(raw.workers)) {
        for (const e of entries as WorkerEntry[]) {
          migrateLegacyTrellisFields(e);
        }
      }
      return raw;
    }
  } catch (err) {
    log.warn("registry", "failed to read registry, using empty", {
      data: { error: String(err) },
    });
  }
  return { workers: {} };
}

const LEGACY_TRELLIS_KEYS = [
  "trellisName", "trellisPath", "trellisIteration", "trellisMaxIterations",
  "trellisLastVerdict", "trellisLastDrift", "trellisAlignedCount",
  "trellisDriftHistory", "trellisShaHistory", "trellisStagnationConfirmedAt",
  "trellisFlaggedClauses", "trellisAligned", "trellisModelFallbackAt",
  "workerModel",
] as const;

function migrateLegacyTrellisFields(entry: WorkerEntry): void {
  const e = entry as unknown as Record<string, unknown>;
  // Only migrate when the entry has at least the load-bearing trellisName
  // legacy field and no nested `trellis` sub-object yet. workerModel was
  // shared by trellis-only call sites so it migrates with the rest.
  if (typeof e.trellisName !== "string") return;
  if (entry.trellis !== undefined) {
    // Both shapes present — strip the legacy fields. The nested form wins.
    for (const k of LEGACY_TRELLIS_KEYS) delete e[k];
    return;
  }
  entry.trellis = {
    name: e.trellisName as string,
    path: typeof e.trellisPath === "string" ? e.trellisPath : "",
    iteration: e.trellisIteration as number | undefined,
    maxIterations: e.trellisMaxIterations as number | undefined,
    lastVerdict: e.trellisLastVerdict as TrellisVerdict | undefined,
    lastDrift: e.trellisLastDrift as string[] | undefined,
    alignedCount: e.trellisAlignedCount as number | undefined,
    driftHistory: e.trellisDriftHistory as string[][] | undefined,
    shaHistory: e.trellisShaHistory as string[] | undefined,
    stagnationConfirmedAt: e.trellisStagnationConfirmedAt as number | undefined,
    flaggedClauses: e.trellisFlaggedClauses as string[] | undefined,
    aligned: e.trellisAligned as boolean | undefined,
    modelFallbackAt: e.trellisModelFallbackAt as number | undefined,
    workerModel: e.workerModel as "opus" | "sonnet" | undefined,
  };
  for (const k of LEGACY_TRELLIS_KEYS) delete e[k];
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

/** Field-update payload accepted by updateWorkerFields. Top-level fields
 *  are shallow-merged onto the entry. The nested `trellis` and `grow` fields
 *  are deep-merged into the existing sub-object — passing
 *  `{ trellis: { lastVerdict: "ALIGNED" } }` or `{ grow: { iteration: 3 } }`
 *  updates only that one field without clobbering the rest of the sub-object. */
export interface WorkerFieldsUpdate
  extends Partial<Omit<WorkerEntry, "name" | "trellis" | "grow">> {
  trellis?: Partial<TrellisData>;
  grow?: Partial<GrowData>;
}

export function updateWorkerFields(
  project: string,
  workerName: string,
  fields: WorkerFieldsUpdate,
): void {
  withRegistryLock(() => {
    const registry = readRegistry();
    const entries = registry.workers[project];
    if (!entries) return;
    const entry = entries.find(e => e.name === workerName);
    if (!entry) return;

    if (fields.prState && fields.prState !== entry.prState) {
      log.info("poller", `${entry.prState ?? "new"} -> ${fields.prState}`, {
        worker: workerName,
      });
    }

    const { trellis: trellisUpdate, grow: growUpdate, ...rest } = fields;
    Object.assign(entry, rest);
    if (trellisUpdate !== undefined) {
      // Merge into existing trellis. If entry.trellis is unset (a default
      // worker received a stray trellis update — caller bug), the spread
      // still produces a TrellisData-shaped object from whatever was passed.
      entry.trellis = { ...(entry.trellis ?? {}), ...trellisUpdate } as TrellisData;
    }
    if (growUpdate !== undefined) {
      // Same deep-merge pattern as trellis. Caller bug if entry.grow is
      // unset and the update lacks `seed`; the resulting object would have
      // no anchoring seed for iter ≥ 2 prompts. The cast lets the broken
      // shape persist (rather than throw) so the loop can surface it
      // visibly via a missing-seed iteration prompt.
      entry.grow = { ...(entry.grow ?? {}), ...growUpdate } as GrowData;
    }
    writeRegistry(registry);
  });
}

export function batchUpdateWorkerFields(
  updates: Array<{ project: string; workerName: string; fields: WorkerFieldsUpdate }>,
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
      const { trellis: trellisUpdate, grow: growUpdate, ...rest } = fields;
      Object.assign(entry, rest);
      if (trellisUpdate !== undefined) {
        entry.trellis = { ...(entry.trellis ?? {}), ...trellisUpdate } as TrellisData;
      }
      if (growUpdate !== undefined) {
        entry.grow = { ...(entry.grow ?? {}), ...growUpdate } as GrowData;
      }
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

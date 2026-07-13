// Telemetry: an append-only JSONL event ledger for analyzing garden's work
// across models, providers, harnesses, workflows, and prompt versions.
//
// This is the durable flight recorder garden never had. The registry hard-
// deletes a worker's entry on cleanup (removeWorker) and dashboard.log tail-
// trims at 10MB, so no lasting record of a worker's lifecycle survives today.
// The ledger records one line per lifecycle FACT (not an aggregate), sharded
// monthly and NEVER truncated — aggregation happens at read time, which
// preserves the ability to ask questions we haven't thought of yet.
//
// Design constraints:
//   - Best-effort: a telemetry failure must never break the poller or a worker
//     launch. Every write is wrapped and swallows, exactly like log.ts.
//   - THIN: registry.ts (which reaches the dist/hook.js bundle) may import this,
//     so the module's import closure stays fs/path/crypto/config only. Callers
//     construct the already-primitive payloads (harness/model/crew/rulesHash are
//     resolved caller-side, in CLI-only modules); this module only serializes.
//   - Denormalized config: worker.created freezes the full configuration onto
//     the event, because config is mutable and "what was configured when this
//     ran" cannot be reconstructed by joining against the live config later.
//     The lean lifecycle events (state/merge) carry only workerId + workflow;
//     they join back to worker.created on workerId for the rest.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { GARDEN_DIR } from "../config.js";

// Resolved lazily (not a module-top const) so importing this module is pure —
// it touches no filesystem path and reads GARDEN_DIR only when actually
// recording, inside the best-effort try below. This keeps the module safe to
// pull into any import graph without an import-time dependency on config.
export function telemetryDir(): string {
  return path.join(GARDEN_DIR, "telemetry");
}

// Bump when an event's shape changes incompatibly. Readers migrate on `v`,
// exactly like readRegistry's legacy-shape migrations.
const SCHEMA_VERSION = 1;

// One review role's resolved selection, frozen onto worker.created.
export interface RoleSnapshot {
  harness: string;
  model?: string;
}

// The full experiment context frozen at worker creation. Everything here is a
// grouping axis for analysis: "clean-review rate by harness", "cost per merge
// by provider", "did outcomes shift when rulesHash changed". Resolved by the
// caller (workers.ts) from live config; this module never reads config itself.
export interface WorkerCreatedSnapshot {
  workflow: string;
  harness: string;
  provider: string | null;
  model: string | null;
  ultracode: boolean;
  crew: string | null;
  roles: { reviewer: RoleSnapshot; resolver: RoleSnapshot; ciFix: RoleSnapshot };
  baseBranch?: string;
  // Hash of the composed global + project rules the worker launches with — the
  // prompt-version axis. A prompt edit is an experiment too, so outcomes must
  // be sliceable by it. See shortHash.
  rulesHash?: string;
  // Build version (esbuild --define), the "what code shipped" axis.
  gardenVersion: string;
}

// A parsed ledger line. Every event shares this spine; event-specific fields
// (verdict, tokens, kind, …) ride the index signature and readers narrow by
// `event`. `readTelemetryEvents` is the sole read path — `garden stats` (the
// analysis surface) aggregates over it.
export interface LedgerEvent {
  v: number;
  ts: string;
  event: string;
  project: string;
  worker: string;
  workerId: string;
  workflow?: string;
  [key: string]: unknown;
}

// Read every event across all monthly shards, oldest first, tolerant of torn
// lines (a crash mid-append loses at most the last line, not the file). The
// `project` filter is applied here; time filtering is deliberately left to the
// caller so it can build the workerId→config join from the full worker.created
// history before windowing the metric events (a worker created before the
// window still resolves its config). Best-effort: unreadable dir/shard → skip.
export function readTelemetryEvents(opts: { project?: string } = {}): LedgerEvent[] {
  const dir = telemetryDir();
  let files: string[];
  try {
    files = fs.readdirSync(dir)
      .filter(f => f.startsWith("events-") && f.endsWith(".jsonl"))
      .sort();
  } catch {
    return [];
  }
  const events: LedgerEvent[] = [];
  for (const f of files) {
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(dir, f), "utf-8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (!line) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (!obj || typeof obj !== "object") continue;
      const e = obj as LedgerEvent;
      if (typeof e.event !== "string" || typeof e.workerId !== "string") continue;
      if (opts.project && e.project !== opts.project) continue;
      events.push(e);
    }
  }
  return events;
}

// Durable identity for a worker across name reuse: worker names are randomly
// generated slugs that collide over months, so the stable key is
// project/name/createdAt. Every event carries it as the join key.
export function telemetryWorkerId(
  project: string,
  worker: string,
  createdAt?: number,
): string {
  return `${project}/${worker}/${createdAt ?? 0}`;
}

// Short, stable content hash for the rules-version axis. sha256 (node builtin,
// no dependency) truncated to 12 hex chars — collision-irrelevant for a
// human-scale set of prompt versions.
export function shortHash(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 12);
}

// Current month's shard basename, e.g. events-2026-07.jsonl. Sharding keeps any
// single file bounded without ever discarding history (each shard is closed
// forever once the month rolls over) and makes a date-ranged read a filename
// filter rather than a full scan.
export function shardName(date: Date = new Date()): string {
  return `events-${date.toISOString().slice(0, 7)}.jsonl`; // events-YYYY-MM.jsonl
}

function write(line: Record<string, unknown>): void {
  try {
    const dir = telemetryDir();
    fs.mkdirSync(dir, { recursive: true });
    const entry = { v: SCHEMA_VERSION, ts: new Date().toISOString(), ...line };
    fs.appendFileSync(path.join(dir, shardName()), JSON.stringify(entry) + "\n");
  } catch {
    /* telemetry must never crash the app */
  }
}

// worker.created — the experiment context. Emitted once per worker launch.
export function recordWorkerCreated(
  project: string,
  worker: string,
  createdAt: number,
  snapshot: WorkerCreatedSnapshot,
): void {
  write({
    event: "worker.created",
    project,
    worker,
    workerId: telemetryWorkerId(project, worker, createdAt),
    ...snapshot,
  });
}

// state — one genuine prState move (from !== to). The lifecycle backbone: every
// review/resolve/ci-fix/merge state change funnels through transitionState, and
// time-in-state (review duration, resolve duration, cycle time) falls out of
// consecutive events' timestamps at read time.
export function recordStateTransition(
  project: string,
  worker: string,
  createdAt: number | undefined,
  workflow: string,
  from: string,
  to: string,
): void {
  write({
    event: "state",
    project,
    worker,
    workerId: telemetryWorkerId(project, worker, createdAt),
    workflow,
    from,
    to,
  });
}

// review.verdict — a reviewer produced a parseable verdict. Emitted at the
// single point where the verdict is known for both default and trellis
// (poller-review.ts), so it captures every clean/fixed/failed (and trellis
// ALIGNED/DRIFT/FLAGGED) outcome. The signal the `state` event can't carry:
// the verdict vocabulary, the review duration, and the reviewer's FIX MAGNITUDE
// — the numstat of preReviewSha..tipSha, which is 0 on a CLEAN review and the
// reviewer's edit size on a FIXED one (with the caveat that a mid-review rebase
// onto a sibling merge also lands in that range). This is the headline quality
// metric: a "cheaper" worker that a reviewer must rewrite 40 lines per merge to
// land is not actually cheaper.
export interface ReviewVerdictFields {
  verdict: string;
  durationMs?: number;
  fixFiles: number;
  fixInsertions: number;
  fixDeletions: number;
  preReviewSha?: string;
  tipSha?: string;
}

export function recordReviewVerdict(
  project: string,
  worker: string,
  createdAt: number | undefined,
  workflow: string,
  fields: ReviewVerdictFields,
): void {
  write({
    event: "review.verdict",
    project,
    worker,
    workerId: telemetryWorkerId(project, worker, createdAt),
    workflow,
    ...fields,
  });
}

// resolve.outcome / cifix.outcome — a rebase-conflict resolver or a CI-fix agent
// finished. The state stream already encodes success/failure via the following
// transition (→ merge-pending vs → failing); these events add what it can't:
// the ground-truth `verificationPassed` (the agent's verdict text is advisory —
// only an actual verified push counts), the effort spent (`attempts` against the
// per-cycle budget), and the duration. A config that needs three resolve
// attempts per conflict is meaningfully worse than one that needs one.
export interface AgentOutcomeFields {
  verdict: string; // done|failed|fixed|missing (agent's advisory verdict)
  verificationPassed: boolean;
  attempts: number;
  durationMs?: number;
}

export function recordResolveOutcome(
  project: string,
  worker: string,
  createdAt: number | undefined,
  workflow: string,
  fields: AgentOutcomeFields,
): void {
  write({
    event: "resolve.outcome",
    project,
    worker,
    workerId: telemetryWorkerId(project, worker, createdAt),
    workflow,
    ...fields,
  });
}

export function recordCiFixOutcome(
  project: string,
  worker: string,
  createdAt: number | undefined,
  workflow: string,
  fields: AgentOutcomeFields,
): void {
  write({
    event: "cifix.outcome",
    project,
    worker,
    workerId: telemetryWorkerId(project, worker, createdAt),
    workflow,
    ...fields,
  });
}

// worker.tokens — the worker's CUMULATIVE token usage, sampled at each merge
// (from transitionToTerminal, summed over its Claude transcript). The core cost
// signal: the worker's model/provider is the variable a cost comparison turns on
// (the review family is always strong Opus), so tokens-per-merged-line by config
// answers "is this cheap worker actually cheap." Cumulative-at-merge because the
// transcript is one growing session across a default worker's phases, so per-
// cycle cost is a read-time diff of consecutive samples for the same workerId;
// `mergeCount` aligns each sample to its cycle. `model` is the transcript's
// ground-truth model. Best-effort: absent entirely when the transcript can't be
// read, so it never blocks the merge event.
export interface WorkerTokensFields {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  model?: string;
  mergeCount: number;
}

export function recordWorkerTokens(
  project: string,
  worker: string,
  createdAt: number | undefined,
  workflow: string,
  fields: WorkerTokensFields,
): void {
  write({
    event: "worker.tokens",
    project,
    worker,
    workerId: telemetryWorkerId(project, worker, createdAt),
    workflow,
    ...fields,
  });
}

// continue.dispatched — garden pasted a prompt into a worker's pane (NOT the
// operator). Emitted at the single paste-success point in continueWorker, so it
// covers every garden-initiated prompt: post-merge auto-continue, interrupt
// recovery, a handoff callback, and a seed. This is the subtrahend for the
// autonomy metric: operator-initiated prompts = all prompts − garden's own, so
// telling them apart requires marking garden's here. `kind` names which.
export function recordContinueDispatched(
  project: string,
  worker: string,
  createdAt: number | undefined,
  workflow: string,
  kind: string,
): void {
  write({
    event: "continue.dispatched",
    project,
    worker,
    workerId: telemetryWorkerId(project, worker, createdAt),
    workflow,
    kind,
  });
}

// operator.action — the operator manually intervened on a worker (hold / kick /
// bounce). The direct "this config needed hand-holding" signal: a config whose
// workers the operator must bounce or kick to keep moving is less autonomous
// than one that runs clean, independent of how its reviews score.
export function recordOperatorAction(
  project: string,
  worker: string,
  createdAt: number | undefined,
  workflow: string,
  action: string,
): void {
  write({
    event: "operator.action",
    project,
    worker,
    workerId: telemetryWorkerId(project, worker, createdAt),
    workflow,
    action,
  });
}

// merge — a completed merge, with the counts the pure state event can't carry:
// the cumulative merge ordinal (the multi-phase cycle number) and how many
// files this cycle touched. terminalState is "done" (worker self-declared
// finished via .garden-done) or "merged" (an intermediate phase).
export function recordMerge(
  project: string,
  worker: string,
  createdAt: number | undefined,
  workflow: string,
  terminalState: string,
  mergeCount: number,
  changedFiles: number,
): void {
  write({
    event: "merge",
    project,
    worker,
    workerId: telemetryWorkerId(project, worker, createdAt),
    workflow,
    terminalState,
    mergeCount,
    changedFiles,
  });
}

// bd (beads) shell-out client for the bead-intake loop. Wraps the installed
// bd binary (verified against bd 1.0.3) with cwd pinned to the project
// checkout so every call hits the project's canonical .beads store — never a
// worktree copy (worktrees carry the tracked .beads files but not the
// gitignored Dolt database, so bd there would bootstrap a divergent local DB).
//
// Verified 1.0.3 behavior this module encodes:
// - `bd update --claim` sets assignee+in_progress on an UNASSIGNED bead, is a
//   success no-op when the bead is already assigned to the same actor, and
//   ERRORS when assigned to anyone else. It never overwrites a foreign claim.
// - `bd swarm status <epic> --json` groups children via dependency edges
//   (the `--parent` family is empty for dependency-edge epics — never use it).
//   Assigned-but-open beads stay in `ready[]` and carry an `assignee` field.
// - `bd show --json` returns a LIST, even for one id; `description`/`design`
//   keys are present only when set.
// - `bd reopen` works from in_progress, `bd assign <id> ""` unassigns.
// - stderr may carry advisory noise (a beads.role warning) on success; only
//   the exit status decides ok, and JSON is parsed from stdout alone.
import { spawnSync } from "node:child_process";
import { log } from "./log.js";

const BD_TIMEOUT_MS = 20_000;
// The embedded Dolt store takes an exclusive lock per invocation; a concurrent
// writer (a worker's bd close, board's export tick) surfaces as a transient
// lock error. One short retry absorbs the common collision without hiding a
// real failure.
const LOCK_RETRIES = 2;
const LOCK_RETRY_DELAY_MS = 250;

export interface BdResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface BeadRef {
  id: string;
  title: string;
  assignee?: string;
}

export interface SwarmStatus {
  ready: BeadRef[];
  active: BeadRef[];
  blocked: BeadRef[];
  completed: BeadRef[];
}

export interface BeadDetail {
  id: string;
  title: string;
  status: string;
  priority: number;
  labels: string[];
  description?: string;
  design?: string;
  assignee?: string;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function runBd(
  projectPath: string,
  args: string[],
  opts?: { actor?: string },
): BdResult {
  for (let attempt = 0; ; attempt++) {
    const res = spawnSync("bd", args, {
      cwd: projectPath,
      encoding: "utf8",
      timeout: BD_TIMEOUT_MS,
      env: {
        ...process.env,
        ...(opts?.actor ? { BEADS_ACTOR: opts.actor } : {}),
      },
    });
    if (res.error) {
      return { ok: false, stdout: "", stderr: String(res.error) };
    }
    const out = { ok: res.status === 0, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
    if (!out.ok && attempt < LOCK_RETRIES && /lock/i.test(out.stderr + out.stdout)) {
      sleepSync(LOCK_RETRY_DELAY_MS);
      continue;
    }
    return out;
  }
}

function bdJson(projectPath: string, args: string[]): unknown {
  const res = runBd(projectPath, [...args, "--json"]);
  if (!res.ok) {
    const detail = res.stderr.trim().slice(0, 500) || "unknown error";
    log.warn("beads", "bd command failed", {
      data: { args, stderr: detail },
    });
    throw new Error(`bd ${args.join(" ")} failed: ${detail}`);
  }
  try {
    return JSON.parse(res.stdout);
  } catch {
    log.warn("beads", "bd returned unparseable JSON", {
      data: { args, stdout: res.stdout.slice(0, 200) },
    });
    throw new Error(`bd ${args.join(" ")} returned unparseable JSON`);
  }
}

function asBeadDetail(x: unknown): BeadDetail | null {
  if (typeof x !== "object" || x === null) return null;
  const r = x as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.title !== "string") return null;
  return {
    id: r.id,
    title: r.title,
    status: typeof r.status === "string" ? r.status : "open",
    priority: typeof r.priority === "number" ? r.priority : 2,
    labels: Array.isArray(r.labels) ? r.labels.filter((l): l is string => typeof l === "string") : [],
    ...(typeof r.description === "string" ? { description: r.description } : {}),
    ...(typeof r.design === "string" ? { design: r.design } : {}),
    ...(typeof r.assignee === "string" && r.assignee !== "" ? { assignee: r.assignee } : {}),
  };
}

function asBeadRefs(x: unknown): BeadRef[] {
  if (!Array.isArray(x)) return [];
  const refs: BeadRef[] = [];
  for (const item of x) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r.id !== "string") continue;
    refs.push({
      id: r.id,
      title: typeof r.title === "string" ? r.title : "",
      ...(typeof r.assignee === "string" && r.assignee !== "" ? { assignee: r.assignee } : {}),
    });
  }
  return refs;
}

// Open (non-closed) epics. Dispatch labels are filtered by the caller — the
// query stays broad so one call serves both the dispatch gate and the reaper.
export function listOpenEpics(projectPath: string): BeadDetail[] {
  const parsed = bdJson(projectPath, ["query", "type=epic AND NOT status=closed"]);
  if (!Array.isArray(parsed)) throw new Error("bd query returned an unexpected shape");
  return parsed.map(asBeadDetail).filter((d): d is BeadDetail => d !== null);
}

// The live wavefront, computed by bd from the dependency DAG.
export function swarmStatus(projectPath: string, epicId: string): SwarmStatus | null {
  const parsed = bdJson(projectPath, ["swarm", "status", epicId]);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`bd swarm status ${epicId} returned an unexpected shape`);
  }
  const r = parsed as Record<string, unknown>;
  return {
    ready: asBeadRefs(r.ready),
    active: asBeadRefs(r.active),
    blocked: asBeadRefs(r.blocked),
    completed: asBeadRefs(r.completed),
  };
}

export function showBeads(projectPath: string, ids: string[]): BeadDetail[] {
  if (ids.length === 0) return [];
  const parsed = bdJson(projectPath, ["show", ...ids]);
  if (!Array.isArray(parsed)) throw new Error("bd show returned an unexpected shape");
  return parsed.map(asBeadDetail).filter((d): d is BeadDetail => d !== null);
}

// Atomic claim as the given actor: assignee + in_progress in one bd write.
// Succeeds (no-op) if already claimed by the same actor; fails on a foreign
// claim — which is the idempotency guarantee the intake loop builds on.
export function claimBead(projectPath: string, id: string, actor: string): boolean {
  const res = runBd(projectPath, ["update", id, "--claim"], { actor });
  if (!res.ok) {
    log.warn("beads", "claim failed", {
      data: { id, actor, stderr: res.stderr.trim().slice(0, 300) },
    });
  }
  return res.ok;
}

export function reopenBead(projectPath: string, id: string, reason: string): boolean {
  return runBd(projectPath, ["reopen", id, "-r", reason]).ok;
}

export function unassignBead(projectPath: string, id: string): boolean {
  return runBd(projectPath, ["assign", id, ""]).ok;
}

export function addLabel(projectPath: string, id: string, label: string): boolean {
  return runBd(projectPath, ["label", "add", id, label]).ok;
}

export function removeLabel(projectPath: string, id: string, label: string): boolean {
  return runBd(projectPath, ["label", "remove", id, label]).ok;
}

// Max-wins parse of `<prefix>N` counter labels across duplicates (both sides
// of the board↔garden border parse this way — board's DELEGATION.md Decision
// 10): a crashed rewrite can leave two counter labels, and the higher one is
// the one that fails closed. Garden's rewrite sites remove every matching
// straggler.
export function parseLabelCount(labels: string[], prefix: string): number | null {
  let max: number | null = null;
  for (const l of labels) {
    if (!l.startsWith(prefix)) continue;
    const n = Number(l.slice(prefix.length));
    if (!Number.isInteger(n) || n < 0) continue;
    if (max === null || n > max) max = n;
  }
  return max;
}

export interface BeadLabelOps {
  addLabel(id: string, label: string): boolean;
  removeLabel(id: string, label: string): boolean;
}

// The circuit-breaker writer (DELEGATION.md Decision 8): bump a bead's
// dispatch:failed:N quality-failure counter. Shared by the two places garden
// observes quality failure — the intake reaper recovering a worker that died
// `failing` (poller-intake.ts) and a review rejection of a bead-carrying
// worker (poller-review.ts). Lives here rather than in poller-intake because
// poller-review cannot import poller-intake without closing the
// poller-review → poller-intake → workers → poller → poller-review cycle.
//
// The incremented label is added BEFORE the stragglers are removed (the
// spent counter's partial-write order): a failed GC leaves duplicates that
// max-wins parsing resolves to the new count, so a partial write can only
// preserve or raise the count, never lose it. `ok` is false when the add
// itself failed — the count did not land. Best-effort by contract: the
// breaker is advisory and may fail open, unlike the budget — callers log or
// alert, never abort their pass.
export function incrementFailedLabel(
  ops: BeadLabelOps,
  beadId: string,
  labels: string[],
): { ok: boolean; count: number } {
  const count = (parseLabelCount(labels, "dispatch:failed:") ?? 0) + 1;
  if (!ops.addLabel(beadId, `dispatch:failed:${count}`)) return { ok: false, count };
  for (const l of labels) {
    if (l.startsWith("dispatch:failed:")) ops.removeLabel(beadId, l);
  }
  return { ok: true, count };
}

export function bdAvailable(): boolean {
  const res = spawnSync("bd", ["--version"], { encoding: "utf8", timeout: 5000 });
  return !res.error && res.status === 0;
}

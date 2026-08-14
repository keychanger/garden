// Bead-intake step: converts ready, dispatch-labeled beads into garden
// workers. Runs inside the per-project poller cycle (poll() in poller.ts) for
// projects opted in via `beadIntake: true`. Design: board's docs/DELEGATION.md
// ("The intake loop (garden)") — bd owns the work graph and computes the ready
// frontier; garden subscribes to it; board steers it via labels on the epic.
//
// Label contract (the whole interface between board and this loop):
//   dispatch:manual            operator-armed authorization for ONE WAVE
//                              (DELEGATION.md Decision 9): intake keeps
//                              dispatching under the arm across passes until
//                              the observed frontier is empty, then consumes
//                              by rewriting to dispatch:dispatched (board's
//                              `g` re-arms by restoring dispatch:manual).
//                              Beads that become ready mid-wave dispatch
//                              under the same arm — accepted.
//   dispatch:dispatching       garden-written durable mid-wave marker: the
//                              armed wave has started but the frontier was
//                              not yet empty (cap/budget throttled). Lets a
//                              later empty-frontier pass tell "wave done"
//                              from "armed, nothing ready yet" (which stays
//                              armed — the operator's g press is never
//                              silently eaten). GC'd whenever the epic's
//                              mode is not manual.
//   dispatch:auto              wavefront marches unattended
//   dispatch:off               gate closed (wins over manual/auto)
//   dispatch:dispatched        garden-written: manual authorization consumed
//   dispatch:budget-exhausted  garden-written at the budget cap; halts intake
//                              until the operator clears it / raises budget:N
//   budget:N                   operator-written cap on total dispatched
//                              sessions for the epic (retries count)
//   dispatch:spent:N           garden-written session counter backing budget:N
//                              (bd labels are the sanctioned durable channel;
//                              the registry hard-deletes on worker removal).
//                              Written fail-closed (Decision 10): charged
//                              BEFORE each spawn with both label writes
//                              checked; a write failure aborts the epic's
//                              pass, and a spawn failure refunds best-effort
//                              (a failed refund overcounts, which fails
//                              closed). Never spawn an uncounted session.
//   dispatch:retry:N           garden-written on a bead each time the reaper
//                              recovers it
//   dispatch:failed:N          quality-failure counter on a bead (read-only
//                              here; its writer is future work). At
//                              BREAKER_THRESHOLD the frontier excludes the
//                              bead — the circuit breaker's read side.
//
// All counter labels parse max-wins across duplicates (both sides of the
// border do), and garden's own increment/rewrite sites remove every matching
// straggler.
//
// Idempotency (bd 1.0.3 route-around): the design doc's `garden-pending`
// pre-assign + claim-overwrite stack is unimplementable on 1.0.3 — `bd update
// --claim` never overwrites a foreign assignee, and a same-actor claim on a
// pre-assigned open bead is a no-op that does NOT set in_progress. Instead
// intake claims the bead AS the worker (BEADS_ACTOR=<worker-name>) right
// after the spawn returns the name: one atomic write sets assignee +
// in_progress, removes the bead from the ready frontier, and establishes the
// bd-assignee == registry-name join immediately. The worker's own seeded
// `bd update --claim` then hits the verified same-actor no-op path. A spawn
// that dies after the claim leaves in_progress + a dead registry entry —
// exactly the reaper's predicate, so missed spawns and crashed workers share
// one recovery.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SESSIONS_DIR, type ProjectConfig } from "../config.js";
import {
  intakeStampPath, intakePokePath, writeIntakeError, clearIntakeError,
} from "./intake-paths.js";
import { getWorkers, updateWorkerTask, type WorkerEntry } from "./registry.js";
import { newWorker } from "./workers.js";
import { addAlert } from "./alerts.js";
import { atomicWriteFile } from "./atomic-write.js";
import { log } from "./log.js";
import {
  listOpenEpics, swarmStatus, showBeads, claimBead, reopenBead, unassignBead,
  addLabel, removeLabel, type BeadDetail, type SwarmStatus,
} from "./beads.js";

export const DEFAULT_BEAD_INTAKE_CAP = 3;
// Background throttle: the poller wakes on every lifecycle event, and each
// intake pass costs bd shell-outs. An explicit poke (garden poke / board's
// gate keys) bypasses this via the marker file below.
export const INTAKE_MIN_INTERVAL_MS = 60_000;
// Grace before the reaper treats an exited worker's bead as abandoned — spans
// a bounce's kill→relaunch gap and pane-died flapping.
export const REAPER_GRACE_MS = 10 * 60_000;

// The stamp paths live in intake-paths.ts (a hook-bundle-safe leaf, because
// `garden status` reads them); re-exported here for the existing importers.
export { intakeStampPath, intakePokePath } from "./intake-paths.js";

// The circuit breaker's read side (DELEGATION.md Decision 8): a bead whose
// dispatch:failed:N reaches this count is excluded from the frontier — its
// blocked descendants wait, and board renders the epic chip red. Nothing in
// garden writes dispatch:failed:N yet.
export const BREAKER_THRESHOLD = 2;

export interface DispatchState {
  mode: "manual" | "auto" | "off" | null;
  dispatched: boolean;
  dispatching: boolean;
  budget: number | null;
  spent: number;
  budgetExhausted: boolean;
}

export function parseDispatchState(labels: string[]): DispatchState {
  const has = (l: string) => labels.includes(l);
  let mode: DispatchState["mode"] = null;
  if (has("dispatch:off")) mode = "off";
  else if (has("dispatch:manual")) mode = "manual";
  else if (has("dispatch:auto")) mode = "auto";
  return {
    mode,
    dispatched: has("dispatch:dispatched"),
    dispatching: has("dispatch:dispatching"),
    budget: parseLabelCount(labels, "budget:"),
    spent: parseLabelCount(labels, "dispatch:spent:") ?? 0,
    budgetExhausted: has("dispatch:budget-exhausted"),
  };
}

// Max-wins across duplicates (Decision 10): a crashed rewrite can leave two
// counter labels, and the higher one is the one that fails closed. Rewrite
// sites remove every matching straggler (see removeCountLabels).
function parseLabelCount(labels: string[], prefix: string): number | null {
  let max: number | null = null;
  for (const l of labels) {
    if (!l.startsWith(prefix)) continue;
    const n = Number(l.slice(prefix.length));
    if (!Number.isInteger(n) || n < 0) continue;
    if (max === null || n > max) max = n;
  }
  return max;
}

export function retryCount(labels: string[]): number {
  return parseLabelCount(labels, "dispatch:retry:") ?? 0;
}

export function failedCount(labels: string[]): number {
  return parseLabelCount(labels, "dispatch:failed:") ?? 0;
}

// A worker occupying an intake slot: registered, not exited, and not parked in
// a terminal state. `failing`/`done` need operator or board attention but no
// longer consume a build slot.
export function isIntakeLive(entry: WorkerEntry): boolean {
  if (entry.agentStatus === "exited") return false;
  const state = entry.prState ?? "working";
  return state !== "done" && state !== "failing";
}

// The reaper's dead-worker predicate. Deliberately narrow: only beads whose
// assignee provably maps to a garden worker that died mid-build are recovered.
// - no registry entry at all -> NOT ours to touch (an operator or foreign
//   actor holding a bead under a gated epic is legitimate; reopening their
//   work would be destructive). "garden-pending" is the one exception — the
//   design doc's marker for a spawn that never happened.
// - entry in a pipeline or terminal state -> leave it: reviewing/merging
//   continues headless without the pane, and a done-but-open bead is board's
//   amber "missed bd close" divergence, not a crash.
export function shouldReap(
  assignee: string,
  entry: WorkerEntry | undefined,
  nowMs: number,
): boolean {
  if (assignee === "garden-pending") return true;
  if (!entry) return false;
  if (entry.agentStatus !== "exited") return false;
  if ((entry.prState ?? "working") !== "working") return false;
  const freshness = entry.lastEventAt ?? entry.lastStateChangeAt ?? entry.createdAt ?? 0;
  if (freshness === 0) return false;
  return nowMs - freshness > REAPER_GRACE_MS;
}

// Seed contract from DELEGATION.md: bd show content + the epic's design doc +
// the fixed protocol footer. The stuck path deviates from the doc's sketch
// because `bd human <id>` on 1.0.3 only prints a help menu — the real flag is
// the `human` label plus a comment (surfaced by `bd human list`).
export function buildBeadSeed(opts: {
  projectName: string;
  epic: { id: string; title: string; design?: string };
  bead: BeadDetail;
  mergedSiblings: string[];
}): string {
  const { epic, bead } = opts;
  const siblings = opts.mergedSiblings.length > 0
    ? `${opts.mergedSiblings.join(", ")} — read their commits on your base branch before starting.`
    : "none yet.";
  return [
    `[bead dispatch — ${opts.projectName} epic ${epic.id}: ${epic.title}]`,
    ``,
    `You are assigned bead ${bead.id}: ${bead.title}`,
    ``,
    `## Bead description`,
    ``,
    bead.description?.trim() || "(no description on the bead — the epic's design doc below is the authority)",
    ``,
    `## Epic design doc`,
    ``,
    epic.design?.trim() || "(no design doc pinned on the epic)",
    ``,
    `## Bead protocol`,
    ``,
    `Your bead is ${bead.id}. First action: \`bd update ${bead.id} --claim\`. ` +
    `After your merge lands: \`bd close ${bead.id}\`. ` +
    `If stuck: \`bd update ${bead.id} -s blocked\`, then \`bd label add ${bead.id} human\` ` +
    `and \`bd comment ${bead.id} "<why>"\`. ` +
    `If your \`bd update ${bead.id} --claim\` fails because another actor holds the bead, ` +
    `stop and mark yourself done. ` +
    `Sibling beads already merged: ${siblings}`,
  ].join("\n");
}

// The spawn seam is an options object so later intake extensions widen it
// without reshaping every fake: `bead` is stamped onto the worker's registry
// entry (the registry→bd half of the bead↔worker join — recall/reconcile and
// the removal-time unclaim read it); `workflow` is declared for the planner
// workflow but not consumed yet — every spawn today uses the default
// workflow.
export interface IntakeSpawnRequest {
  seed: string;
  task: string;
  bead?: string;
  workflow?: string;
}

// bd operations + spawn machinery, injectable for tests. The real deps shell
// out to bd (cwd = the project checkout) and go through newWorker.
export interface IntakeDeps {
  projectName: string;
  cap: number;
  listOpenEpics(): BeadDetail[];
  swarmStatus(epicId: string): SwarmStatus | null;
  showBeads(ids: string[]): BeadDetail[];
  claim(id: string, actor: string): boolean;
  reopen(id: string, reason: string): boolean;
  unassign(id: string): boolean;
  addLabel(id: string, label: string): boolean;
  removeLabel(id: string, label: string): boolean;
  spawn(req: IntakeSpawnRequest): string | null;
  workers(): WorkerEntry[];
  alert(input: Parameters<typeof addAlert>[0]): void;
  nowMs(): number;
}

// One intake pass over every dispatch-labeled epic: reap dead workers'
// beads, then dispatch the unassigned ready frontier up to
// min(cap slack, budget remaining, wave size). Returns true when anything
// changed (a spawn, a reap, or a label write).
export function runIntakeOnce(deps: IntakeDeps): boolean {
  const epics = deps.listOpenEpics()
    .filter(e => e.labels.some(l => l.startsWith("dispatch:")));
  if (epics.length === 0) return false;

  const workers = deps.workers();
  const byName = new Map(workers.map(w => [w.name, w]));
  const statuses = new Map<string, SwarmStatus>();
  for (const epic of epics) {
    const st = deps.swarmStatus(epic.id);
    if (!st) throw new Error(`bd swarm status returned no data for epic ${epic.id}`);
    statuses.set(epic.id, st);
  }

  let changed = false;

  // Reaper first, across ALL gated epics (including off/dispatched/exhausted
  // — recovery is not dispatch), so a reopened bead re-enters the frontier
  // computed below on the next pass.
  for (const epic of epics) {
    const st = statuses.get(epic.id);
    if (!st) continue;
    for (const bead of st.active) {
      if (!bead.assignee) continue;
      if (!shouldReap(bead.assignee, byName.get(bead.assignee), deps.nowMs())) continue;
      const detail = deps.showBeads([bead.id])[0];
      if (!detail) throw new Error(`bd show returned no data for bead ${bead.id}`);
      const retryLabels = detail.labels;
      const retries = retryCount(retryLabels);
      if (!deps.reopen(bead.id, `garden intake reaper: worker ${bead.assignee} died`)) continue;
      deps.unassign(bead.id);
      removeCountLabels(deps, bead.id, retryLabels, "dispatch:retry:");
      deps.addLabel(bead.id, `dispatch:retry:${retries + 1}`);
      changed = true;
      log.warn("intake", "reaped abandoned bead", {
        data: { project: deps.projectName, bead: bead.id, assignee: bead.assignee, retries: retries + 1 },
      });
      deps.alert({
        level: "warn",
        source: "intake",
        project: deps.projectName,
        worker: bead.assignee,
        message: `Bead ${bead.id} reopened: worker '${bead.assignee}' died mid-build (retry ${retries + 1}).`,
        dedupKey: `intake-reap:${deps.projectName}:${bead.id}:${retries + 1}`,
      });
    }
  }

  // Concurrency governor: live intake workers are registry workers whose
  // names appear as assignees on the gated epics' beads (the bd-assignee ==
  // registry-name join; no invented registry state). Spawns this pass count
  // immediately so a multi-epic pass can't overshoot the cap.
  let live = 0;
  const counted = new Set<string>();
  for (const st of statuses.values()) {
    for (const bead of [...st.active, ...st.ready]) {
      const assignee = bead.assignee;
      if (!assignee || counted.has(assignee)) continue;
      counted.add(assignee);
      const entry = byName.get(assignee);
      if (entry && isIntakeLive(entry)) live++;
    }
  }

  for (const epic of epics) {
    const st = statuses.get(epic.id);
    if (!st) continue;
    const ds = parseDispatchState(epic.labels);
    // GC the mid-wave marker whenever the epic is not an armed manual gate —
    // the mode changed (auto/off/cleared) so no wave is in flight to track.
    if (ds.dispatching && ds.mode !== "manual") {
      deps.removeLabel(epic.id, "dispatch:dispatching");
      changed = true;
    }
    if (ds.mode !== "manual" && ds.mode !== "auto") continue;
    if (ds.mode === "manual" && ds.dispatched) continue;
    if (ds.budgetExhausted) continue;

    if (ds.budget !== null && ds.spent >= ds.budget) {
      exhaustBudget(deps, epic, ds);
      changed = true;
      continue;
    }

    // The frontier — ONE definition shared by dispatch and the manual-wave
    // consume rule below: unassigned ready beads not tripped by the circuit
    // breaker. Exclusion happens before slots are computed and before the
    // priority sort, so an excluded bead can neither hold a slot open nor
    // outrank an eligible sibling.
    const unassigned = st.ready.filter(b => !b.assignee);
    const unassignedIds = unassigned.map(b => b.id);
    const frontierDetails = unassignedIds.length > 0 ? deps.showBeads(unassignedIds) : [];
    if (!sameIds(unassignedIds, frontierDetails)) {
      throw new Error(`bd show returned incomplete frontier data for epic ${epic.id}`);
    }
    const frontier = frontierDetails
      .filter(d => {
        if (failedCount(d.labels) < BREAKER_THRESHOLD) return true;
        log.info("intake", "bead excluded by circuit breaker", {
          data: { project: deps.projectName, epic: epic.id, bead: d.id, failed: failedCount(d.labels) },
        });
        return false;
      });
    // Shrinks as beads leave the frontier this pass (spawned, or found
    // claimed by the pre-spawn re-check); 0 at the end means the wave the
    // operator armed is fully dispatched.
    let frontierLeft = frontier.length;

    let slots = deps.cap - live;
    if (ds.budget !== null) slots = Math.min(slots, ds.budget - ds.spent);
    slots = Math.min(slots, frontier.length);

    // Priority order (0 = highest) so board's reordering steers which beads
    // win the slots; the ready refs carry no priority, so the details do.
    const details = [...frontier]
      .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));

    let spent = ds.spent;
    let spawned = 0;
    // The dispatch:spent:N labels currently on the epic (may be several — a
    // crashed rewrite leaves stragglers); every rewrite removes them all.
    let spentLabels = epic.labels.filter(l => l.startsWith("dispatch:spent:"));
    for (const bead of details) {
      if (spawned >= slots) break;
      // Spawn-race guard: the frontier snapshot is stale by the time we get
      // here (another intake pass, an operator claim, a recall). Re-read the
      // single bead and skip without charging if a claim appeared.
      const fresh = deps.showBeads([bead.id])[0];
      if (!fresh) throw new Error(`bd show returned no data for bead ${bead.id}`);
      if (fresh.assignee) {
        frontierLeft--;
        log.info("intake", "bead claimed since frontier snapshot; skipping", {
          data: { project: deps.projectName, epic: epic.id, bead: bead.id, assignee: fresh.assignee },
        });
        continue;
      }
      // Fail-closed pre-charge (Decision 10): count the session BEFORE the
      // spawn, both writes checked. A failure here means the durable budget
      // channel is broken — abort this epic's pass (others continue) rather
      // than spawn a session the counter never sees.
      const prevSpent = spent;
      const nextLabel = `dispatch:spent:${spent + 1}`;
      // Add the higher count first. If adding fails, the old count remains;
      // if cleanup fails, max-wins parsing sees the new count. Either partial
      // write therefore overcounts or preserves spend, never undercounts it.
      let chargeOk = deps.addLabel(epic.id, nextLabel);
      if (chargeOk) {
        chargeOk = removeCountLabels(deps, epic.id, spentLabels, "dispatch:spent:");
      }
      if (!chargeOk) {
        log.error("intake", "budget label write failed; aborting epic dispatch pass", {
          data: { project: deps.projectName, epic: epic.id, bead: bead.id },
        });
        deps.alert({
          level: "error",
          source: "intake",
          project: deps.projectName,
          message:
            `Epic ${epic.id} (${epic.title}): dispatch:spent label write failed — ` +
            `dispatch aborted for this epic (budget writes fail closed).`,
          dedupKey: `intake-budget-write:${deps.projectName}:${epic.id}`,
        });
        changed = true;
        break;
      }
      spent++;
      spentLabels = [nextLabel];
      changed = true;

      const seed = buildBeadSeed({
        projectName: deps.projectName,
        epic: { id: epic.id, title: epic.title, ...(epic.design ? { design: epic.design } : {}) },
        bead,
        mergedSiblings: st.completed.map(c => c.id),
      });
      const name = deps.spawn({ seed, task: `bead ${bead.id}: ${bead.title}`, bead: bead.id });
      if (!name) {
        // Spawn machinery is broken (not bead-specific) — stop the pass
        // rather than burn the budget against a dead newWorker. Refund the
        // pre-charge best-effort; a failed refund leaves an overcount, which
        // fails closed (fewer future sessions, never an uncounted one).
        // Restore a non-zero prior count before removing the charge. A failed
        // restore leaves nextLabel in place (an overcount); a failed removal
        // leaves both labels and max-wins also keeps the overcount.
        const refunded = prevSpent === 0
          ? deps.removeLabel(epic.id, nextLabel)
          : deps.addLabel(epic.id, `dispatch:spent:${prevSpent}`)
            && deps.removeLabel(epic.id, nextLabel);
        log.error("intake", "spawn failed; halting dispatch pass", {
          data: { project: deps.projectName, epic: epic.id, bead: bead.id, refunded },
        });
        break;
      }
      // Claim AS the worker: the join keystone (see module header). One
      // retry absorbs a transient store-lock loss; a second failure is
      // non-fatal — the worker's own seeded claim completes the join.
      if (!deps.claim(bead.id, name) && !deps.claim(bead.id, name)) {
        log.warn("intake", "post-spawn claim failed twice; worker's own claim will retry", {
          data: { project: deps.projectName, bead: bead.id, worker: name },
        });
      }
      spawned++;
      frontierLeft--;
      live++;
      log.info("intake", "dispatched bead to new worker", {
        worker: name,
        data: { project: deps.projectName, epic: epic.id, bead: bead.id, spent },
      });
    }

    // True-wave manual consume (Decision 9): the arm covers the WAVE, not one
    // pass. Consume only when the observed frontier is empty — either this
    // pass finished it, or an earlier pass's durable dispatch:dispatching
    // marker says the wave was started and nothing remains. An armed epic
    // with an untouched non-empty frontier (throttled, aborted, or nothing
    // ready yet) stays armed; the operator's g press is never silently eaten.
    if (ds.mode === "manual") {
      if (frontierLeft === 0 && (spawned > 0 || ds.dispatching)) {
        deps.removeLabel(epic.id, "dispatch:manual");
        if (ds.dispatching) deps.removeLabel(epic.id, "dispatch:dispatching");
        deps.addLabel(epic.id, "dispatch:dispatched");
        changed = true;
      } else if (spawned > 0 && !ds.dispatching) {
        deps.addLabel(epic.id, "dispatch:dispatching");
        changed = true;
      }
    }
    if (spawned > 0 && ds.budget !== null && spent >= ds.budget) {
      exhaustBudget(deps, epic, { ...ds, spent });
      changed = true;
    }
  }

  return changed;
}

function sameIds(expected: string[], actual: BeadDetail[]): boolean {
  if (expected.length !== actual.length) return false;
  const actualIds = new Set(actual.map(bead => bead.id));
  return actualIds.size === expected.length && expected.every(id => actualIds.has(id));
}

// Remove every label matching a counter prefix (straggler GC for max-wins
// parsing). Returns false if any removal failed — the caller decides whether
// that fails the write chain (budget) or is best-effort (retry).
function removeCountLabels(
  deps: IntakeDeps,
  id: string,
  labels: string[],
  prefix: string,
): boolean {
  let ok = true;
  for (const l of labels) {
    if (!l.startsWith(prefix)) continue;
    if (!deps.removeLabel(id, l)) ok = false;
  }
  return ok;
}

function exhaustBudget(deps: IntakeDeps, epic: BeadDetail, ds: DispatchState): void {
  if (!epic.labels.includes("dispatch:budget-exhausted")) {
    deps.addLabel(epic.id, "dispatch:budget-exhausted");
  }
  // Operator decision (DELEGATION.md): halt intake and alert; never kill
  // in-flight workers.
  deps.alert({
    level: "error",
    source: "intake",
    project: deps.projectName,
    message:
      `Epic ${epic.id} (${epic.title}) hit its session budget ` +
      `(${ds.spent}/${ds.budget} dispatched) — intake halted. Clear ` +
      `dispatch:budget-exhausted and raise budget:N to resume.`,
    dedupKey: `intake-budget:${deps.projectName}:${epic.id}`,
  });
  log.warn("intake", "budget exhausted; intake halted for epic", {
    data: { project: deps.projectName, epic: epic.id, spent: ds.spent, budget: ds.budget },
  });
}

// Throttle gate: run on an explicit poke marker (consuming it) or when the
// last run is older than the background interval. On-disk, not in-memory —
// the poller execs a fresh process per wake.
export function intakeDue(project: string, nowMs: number): boolean {
  const pokeFile = intakePokePath(project);
  if (fs.existsSync(pokeFile)) {
    try { fs.unlinkSync(pokeFile); } catch { /* concurrent consumer */ }
    return true;
  }
  try {
    const stat = fs.statSync(intakeStampPath(project));
    return nowMs - stat.mtimeMs >= INTAKE_MIN_INTERVAL_MS;
  } catch {
    return true;
  }
}

function stampIntakeRun(project: string): void {
  try {
    atomicWriteFile(intakeStampPath(project), String(Date.now()));
  } catch { /* best-effort */ }
}

// Poller entry point: throttle, then one pass with the real bd/spawn deps.
// A pass that throws stamps intake-error-<project> (JSON {at, message}) so
// `garden status --json` can report lastIntakeError to board's dispatcher-
// liveness chip (DELEGATION.md Decision 11); a successful pass clears it.
// The poller's own catch around this call stays as the backstop for throws
// outside the pass itself.
export function runBeadIntake(projectName: string, project: ProjectConfig): boolean {
  if (project.beadIntake !== true) return false;
  if (!intakeDue(projectName, Date.now())) return false;
  stampIntakeRun(projectName);

  try {
    const changed = runIntakeOnceReal(projectName, project);
    clearIntakeError(projectName);
    return changed;
  } catch (err) {
    writeIntakeError(projectName, String(err));
    log.error("intake", "intake pass failed", {
      data: { project: projectName, error: String(err) },
    });
    return false;
  }
}

function runIntakeOnceReal(projectName: string, project: ProjectConfig): boolean {
  const projectPath = project.path;
  return runIntakeOnce({
    projectName,
    cap: project.beadIntakeCap ?? DEFAULT_BEAD_INTAKE_CAP,
    listOpenEpics: () => listOpenEpics(projectPath),
    swarmStatus: (epicId) => swarmStatus(projectPath, epicId),
    showBeads: (ids) => showBeads(projectPath, ids),
    claim: (id, actor) => claimBead(projectPath, id, actor),
    reopen: (id, reason) => reopenBead(projectPath, id, reason),
    unassign: (id) => unassignBead(projectPath, id),
    addLabel: (id, label) => addLabel(projectPath, id, label),
    removeLabel: (id, label) => removeLabel(projectPath, id, label),
    spawn: (req) => spawnBeadWorker(projectName, req),
    workers: () => getWorkers(projectName),
    alert: addAlert,
    nowMs: () => Date.now(),
  });
}

function spawnBeadWorker(projectName: string, req: IntakeSpawnRequest): string | null {
  const seedsDir = path.join(SESSIONS_DIR, "seeds");
  fs.mkdirSync(seedsDir, { recursive: true });
  const seedFile = path.join(seedsDir, `bead-${crypto.randomUUID()}.md`);
  atomicWriteFile(seedFile, req.seed);
  const name = newWorker({
    projectName,
    seedMessageFile: seedFile,
    background: true,
    // Registry→bd join: recall/reconcile and the removal-time unclaim read
    // entry.bead. (req.workflow is declared on the seam but not consumed —
    // intake spawns default-workflow workers only.)
    ...(req.bead ? { bead: req.bead } : {}),
  });
  if (!name) {
    try { fs.unlinkSync(seedFile); } catch { /* ignore */ }
    return null;
  }
  updateWorkerTask(projectName, name, req.task);
  return name;
}

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
//                              recovers a crash (worker died mid-build)
//   dispatch:failed:N          garden-written quality-failure counter on a
//                              bead (Decision 8), from the two places garden
//                              observes quality failure: the reaper branch
//                              recovering a worker that died `failing`
//                              (below), and a review rejection of a bead-
//                              carrying worker (poller-review.ts). At
//                              BREAKER_THRESHOLD the frontier excludes the
//                              bead — the circuit breaker. Distinct from
//                              retry:N because failed should stop dispatch
//                              and retry should not.
//
// The plan:* lifecycle (DELEGATION.md Decision 16, phase 4d) shares the epic
// as its label surface but is a SEPARATE loop from dispatch — a planner
// decomposes the epic into children; dispatch executes them:
//   plan:pending               board-armed (the S key): decompose this epic.
//                              The ONLY spawnable plan state — consumed to
//                              plan:planning BEFORE the planner spawns, so
//                              repeated poller wakes are idempotent by
//                              construction.
//   plan:planning              garden-written pre-spawn: a planner owns this
//                              epic. The planner worker itself rewrites it to
//                              plan:ready / plan:failed on completion; intake
//                              rewrites it to plan:failed when the spawn dies.
//   plan:ready                 planner-written: draft wisps await board's S
//                              promotion. Never touched by garden.
//   plan:failed                terminal failure; board's ;plan:none re-arms.
// Unknown plan:* values are ignored on both sides (fail closed) — never
// invent new ones. The planner spawn carries no bead assignee and is
// deliberately EXEMPT from the intake cap/governor and the budget counter:
// the governor joins on bd assignees, budget counts dispatched build
// sessions, and a planner is neither.
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
import {
  SESSIONS_DIR, resolveBeadsDir, beadsStoreError, type ProjectConfig,
} from "../config.js";
import {
  intakeStampPath, intakePokePath, writeIntakeError, clearIntakeError,
} from "./intake-paths.js";
import { getWorkers, updateWorkerTask, type WorkerEntry } from "./registry.js";
import { newWorker, stopWorkerByName } from "./workers.js";
import { addAlert } from "./alerts.js";
import { atomicWriteFile } from "./atomic-write.js";
import { log } from "./log.js";
import {
  listOpenEpics, swarmStatus, showBeads, claimBead, reopenBead, unassignBead,
  addLabel, removeLabel, parseLabelCount, incrementFailedLabel,
  type BeadDetail, type SwarmStatus,
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

// The circuit breaker's threshold (DELEGATION.md Decision 8): a bead whose
// dispatch:failed:N reaches this count is excluded from the frontier — its
// blocked descendants wait, and board renders the epic chip red. The label's
// writers are the reaper's failing branch below and the review pipeline's
// rejection path (dispatchDefaultVerdict in poller-review.ts), both through
// incrementFailedLabel in beads.ts.
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

// parseLabelCount (max-wins across duplicates, Decision 10) lives in beads.ts
// so poller-review.ts can share the dispatch:failed:N writer without importing
// this module (poller-review → poller-intake → workers → poller closes a
// cycle). Rewrite sites here remove every matching straggler (see
// removeCountLabels).

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

// The reaper's second branch (DELEGATION.md Decision 8): a worker that died
// while parked in `failing` is a QUALITY failure, not a crash — its recovery
// bumps dispatch:failed:N (feeding the circuit breaker) and explicitly NOT
// dispatch:retry:N. A separate predicate beside shouldReap because that one's
// narrowness (prState `working` only) is deliberate and documented; widening
// it would silently change the crash-recovery contract. A LIVE failing worker
// keeps its bead — the operator may still redirect it; only provably-dead
// ones (agent exited, past the same grace) are recovered.
export function shouldReapFailing(
  entry: WorkerEntry | undefined,
  nowMs: number,
): boolean {
  if (!entry) return false;
  if (entry.agentStatus !== "exited") return false;
  if (entry.prState !== "failing") return false;
  const freshness = entry.lastEventAt ?? entry.lastStateChangeAt ?? entry.createdAt ?? 0;
  if (freshness === 0) return false;
  return nowMs - freshness > REAPER_GRACE_MS;
}

// Seed contract from DELEGATION.md: bd show content + the epic's design doc +
// the fixed protocol footer. The stuck path deviates from the doc's sketch
// because `bd human <id>` on 1.0.3 only prints a help menu — the real flag is
// the `human` label plus a comment (surfaced by `bd human list`).
//
// A bead carrying the `integration` label (Decision 13, planner-emitted) gets
// the verify-the-assembly contract in place of the leaf build contract: its
// worker is the epic's exit gate, dispatched only once every sibling has
// merged (it blocks-depends on all of them), and its job is to verify the
// assembled feature — not to build a unit. The claim/close/blocked protocol
// lines stay identical.
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
  const integration = bead.labels.includes("integration");
  const contract = integration
    ? `Your bead is the epic's integration gate: verify the ASSEMBLED feature ` +
      `against the epic's design doc above, on your base branch — every sibling ` +
      `bead is already merged there. Run the project's full gates (checks suite, ` +
      `and anything the design doc names as acceptance). Close ${bead.id} only ` +
      `when the assembly actually works end to end. File new beads under epic ` +
      `${epic.id} for defects you find instead of fixing sibling scope yourself ` +
      `— your deliverable is the verdict and the defect list, plus only the glue ` +
      `fixes integration itself requires. `
    : "";
  const completion = integration
    ? `If verification passes and no glue commit is needed, ` +
      `\`bd close ${bead.id}\` directly before marking yourself done. If you ` +
      `make glue changes, close ${bead.id} only after that merge lands. `
    : `After your merge lands: \`bd close ${bead.id}\`. `;
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
    contract +
    `Your bead is ${bead.id}. First action: \`bd update ${bead.id} --claim\`. ` +
    completion +
    `If stuck: \`bd update ${bead.id} -s blocked\`, then \`bd label add ${bead.id} human\` ` +
    `and \`bd comment ${bead.id} "<why>"\`. ` +
    `If your \`bd update ${bead.id} --claim\` fails because another actor holds the bead, ` +
    `stop and mark yourself done. ` +
    `Sibling beads already merged: ${siblings}`,
  ].join("\n");
}

// Planner seed (DELEGATION.md phase 4d + Decisions 13/16): the epic, its full
// pinned design doc, and the exact bd 1.0.3 contract — verbatim enough that a
// fresh worker cannot get it wrong. The command spellings were re-verified
// empirically against the installed bd 1.0.3 (2026-08-14) and deviate from
// the delegation doc's `bd create --graph` sketch deliberately: --graph
// silently ignores --ephemeral in every spelling (CLI flag, node fields, plan
// top level), and non-ephemeral children would bypass board's draft-review
// gate (dimmed wisps, S promotion, ;plan:none discard) — ephemerality is the
// load-bearing half of the contract, so the seed pins the per-child
// `bd create --ephemeral --parent` + `bd dep --blocks` spelling that actually
// produces reviewable wisps. The integration test suite pins these spellings
// (and the --graph misbehavior) against the real binary.
export function buildPlannerSeed(opts: {
  projectName: string;
  epic: { id: string; title: string; design?: string };
}): string {
  const { epic } = opts;
  const id = epic.id;
  return [
    `[plan dispatch — ${opts.projectName} epic ${id}: ${epic.title}]`,
    ``,
    `You are the planner for epic ${id}. Decompose its design doc into a`,
    `dependency-gated bead DAG of EPHEMERAL draft children (wisps) in the`,
    `project's bd store, then hand the draft back to the operator by rewriting`,
    `the epic's plan label. You write ONLY to the bd store: no commits, no`,
    `pushes, no checks, no repo edits. The \`planner\` skill`,
    `(.claude/skills/planner/) carries the method; this contract is the`,
    `authority on the exact commands.`,
    ``,
    `## Epic design doc`,
    ``,
    epic.design?.trim() || "(no design doc pinned on the epic — decompose from the epic's title and description; do not invent scope)",
    ``,
    `## The contract (verified bd 1.0.3 spellings — follow verbatim)`,
    ``,
    `1. Read the design doc above and draft the child DAG: each child one`,
    `   worker-session with a crisp deliverable; blocker edges for real ordering`,
    `   constraints only; include ONE extra child titled and labeled`,
    `   \`integration\` that every leaf blocks — its worker verifies the`,
    `   assembled feature once all siblings merge (Decision 13). bd rejects`,
    `   epic↔task blocks edges in both directions, so the integration bead is a`,
    `   task like its siblings, never an edge to the epic.`,
    `2. Create each child as an ephemeral wisp parented to the epic:`,
    `   \`bd create "<title>" --ephemeral --parent ${id} -d "<description>"\``,
    `   (add \`-l integration\` on the integration child). Do NOT use`,
    `   \`bd create --graph\`: on bd 1.0.3 it silently ignores --ephemeral —`,
    `   you get PERMANENT children that skip the operator's draft-review gate —`,
    `   and it silently ignores node-level "deps" arrays (an edgeless graph,`,
    `   no error). NEVER use \`--dry-run\` anywhere: it writes anyway.`,
    `3. Wire every dependency edge explicitly, one call per edge:`,
    `   \`bd dep <blocker-id> --blocks <blocked-id>\`, including`,
    `   \`bd dep <leaf-id> --blocks <integration-id>\` for EVERY leaf.`,
    `4. Run \`bd dep cycles\` as belt-and-suspenders (must report no cycles),`,
    `   then sanity-check \`bd swarm status ${id} --json\`: the first wave`,
    `   ready, the integration child blocked.`,
    `5. On success: \`bd label remove ${id} plan:planning\` then`,
    `   \`bd label add ${id} plan:ready\`.`,
    `   On ANY failure: \`bd label remove ${id} plan:planning\` then`,
    `   \`bd label add ${id} plan:failed\`. Never leave the epic at`,
    `   plan:planning.`,
    `6. Never \`bd promote\` (the operator's S in board owns promotion), never`,
    `   claim or close beads, never touch beads outside epic ${id}, never`,
    `   commit code. Then stop — end your turn; no review or merge follows.`,
  ].join("\n");
}

// `bead` is stamped onto the worker's registry entry (the registry→bd half of
// the bead↔worker join — recall/reconcile and removal-time unclaim read it).
// `workflow` selects the spawned worker's workflow ("planner" for the
// plan-consume loop; absent = default). A planner spawn carries no bead:
// planners hold no assignee, so they are invisible to the governor join and
// to reconcile — cleanup is `garden workers stop` or the dashboard kill.
export interface IntakeSpawnRequest {
  seed: string;
  task: string;
  bead?: string;
  workflow?: string;
}

// bd operations + spawn machinery, injectable for tests. The real deps shell
// out to bd (cwd = the project checkout, store resolved via resolveBeadsDir)
// and go through newWorker.
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
  // Remove a worker end-to-end (the `garden workers stop` back end); false
  // when the stop failed. The reconcile step is the only caller.
  stopWorker(name: string): boolean;
  workers(): WorkerEntry[];
  alert(input: Parameters<typeof addAlert>[0]): void;
  nowMs(): number;
}

// One intake pass: consume plan:pending epics into planner workers, then —
// over every dispatch-labeled epic — reap dead workers' beads, reconcile
// workers whose bead was closed or recalled, and dispatch the unassigned
// ready frontier up to min(cap slack, budget remaining, wave size). Returns
// true when anything changed (a spawn, a reap, a stop, or a label write).
export function runIntakeOnce(deps: IntakeDeps): boolean {
  // Project scoping (DELEGATION.md Decision 15): with a shared store, every
  // project's pass sees every project's epics, so the whole pass — plan
  // consume, reaper, governor, dispatch — is scoped client-side to epics
  // carrying this project's `project:<name>` label (the bd query stays broad:
  // one call still serves everything). Harmless for a project on its own
  // store too — board's own epics carry project:board — and an epic with no
  // matching label simply never drives this project's intake.
  const projectLabel = `project:${deps.projectName}`;
  const allEpics = deps.listOpenEpics().filter(e => e.labels.includes(projectLabel));
  // The two label families select independent loops: an epic is planned via
  // plan:* and dispatched via dispatch:*, and one carrying both runs both
  // (planning a fresh epic while dispatching its already-promoted children is
  // a legitimate, if unusual, state).
  const planEpics = allEpics.filter(e => e.labels.some(l => l.startsWith("plan:")));
  const epics = allEpics.filter(e => e.labels.some(l => l.startsWith("dispatch:")));
  // No early return on empty epic sets: the reconcile step below walks
  // registry workers carrying entry.bead independent of any gated epic
  // (handoff --bead workers reconcile too).

  let planChanged = false;
  // Plan-consume loop (DELEGATION.md Decision 16), BEFORE dispatch. Only
  // plan:pending is spawnable, and it is consumed to plan:planning BEFORE the
  // spawn — so repeated poller wakes are idempotent by construction (a
  // planning/ready/failed epic never spawns). The planner is deliberately
  // exempt from the cap/governor (it holds no bead assignee, so the join
  // cannot count it) and from the budget counter (budget:N caps dispatched
  // BUILD sessions).
  for (const epic of planEpics) {
    if (!epic.labels.includes("plan:pending")) continue;
    // Consume FIRST. A failed remove aborts this epic: proceeding would leave
    // plan:pending in place and risk a duplicate planner on the next wake.
    if (!deps.removeLabel(epic.id, "plan:pending")) {
      log.error("intake", "plan:pending consume failed; skipping epic", {
        data: { project: deps.projectName, epic: epic.id },
      });
      deps.alert({
        level: "error",
        source: "intake",
        project: deps.projectName,
        message:
          `Epic ${epic.id} (${epic.title}): failed to consume plan:pending — ` +
          `planner not spawned (proceeding would risk duplicate planners).`,
        dedupKey: `intake-plan:${deps.projectName}:${epic.id}`,
      });
      continue;
    }
    planChanged = true;
    if (!deps.addLabel(epic.id, "plan:planning")) {
      // pending is gone but planning didn't land — the epic would look
      // label-less to board. Land plan:failed best-effort so the operator
      // sees a red chip and can re-arm with ;plan:none.
      deps.addLabel(epic.id, "plan:failed");
      log.error("intake", "plan:planning write failed; landed plan:failed", {
        data: { project: deps.projectName, epic: epic.id },
      });
      deps.alert({
        level: "error",
        source: "intake",
        project: deps.projectName,
        message:
          `Epic ${epic.id} (${epic.title}): consumed plan:pending but failed to ` +
          `write plan:planning — landed plan:failed; re-arm from board.`,
        dedupKey: `intake-plan-arm:${deps.projectName}:${epic.id}`,
      });
      continue;
    }
    const seed = buildPlannerSeed({
      projectName: deps.projectName,
      epic: { id: epic.id, title: epic.title, ...(epic.design ? { design: epic.design } : {}) },
    });
    let name: string | null = null;
    let spawnError: unknown;
    try {
      name = deps.spawn({
        seed,
        task: `plan epic ${epic.id}: ${epic.title}`,
        workflow: "planner",
      });
    } catch (err) {
      spawnError = err;
    }
    if (!name) {
      // The epic is durably at plan:planning with no planner alive — rewrite
      // to plan:failed so board renders the failure instead of an eternal
      // ambient "planning".
      deps.removeLabel(epic.id, "plan:planning");
      deps.addLabel(epic.id, "plan:failed");
      log.error("intake", "planner spawn failed; landed plan:failed", {
        data: {
          project: deps.projectName,
          epic: epic.id,
          ...(spawnError ? { error: String(spawnError) } : {}),
        },
      });
      deps.alert({
        level: "error",
        source: "intake",
        project: deps.projectName,
        message:
          `Epic ${epic.id} (${epic.title}): planner spawn failed — landed ` +
          `plan:failed; re-arm from board (;plan:none, then S).`,
        dedupKey: `intake-plan-spawn:${deps.projectName}:${epic.id}`,
      });
      continue;
    }
    log.info("intake", "spawned planner for epic", {
      worker: name,
      data: { project: deps.projectName, epic: epic.id },
    });
  }

  const workers = deps.workers();
  const byName = new Map(workers.map(w => [w.name, w]));
  const statuses = new Map<string, SwarmStatus>();
  for (const epic of epics) {
    const st = deps.swarmStatus(epic.id);
    if (!st) throw new Error(`bd swarm status returned no data for epic ${epic.id}`);
    statuses.set(epic.id, st);
  }

  let changed = planChanged;

  // Reaper first, across ALL gated epics (including off/dispatched/exhausted
  // — recovery is not dispatch), so a reopened bead re-enters the frontier
  // computed below on the next pass. Two recovery branches (DELEGATION.md
  // Decision 8): a worker that died mid-build takes the retry counter (a
  // crash — the bead re-dispatches freely); a worker that died parked in
  // `failing` takes the failed counter (a quality failure — at
  // BREAKER_THRESHOLD the frontier excludes the bead) and explicitly NO
  // retry bump.
  for (const epic of epics) {
    const st = statuses.get(epic.id);
    if (!st) continue;
    for (const bead of st.active) {
      if (!bead.assignee) continue;
      const worker = byName.get(bead.assignee);
      const reapCrashed = shouldReap(bead.assignee, worker, deps.nowMs());
      const reapFailing = !reapCrashed && shouldReapFailing(worker, deps.nowMs());
      if (!reapCrashed && !reapFailing) continue;
      const detail = deps.showBeads([bead.id])[0];
      if (!detail) throw new Error(`bd show returned no data for bead ${bead.id}`);
      const died = reapFailing ? "died in failing state" : "died mid-build";
      if (!deps.reopen(bead.id, `garden intake reaper: worker ${bead.assignee} ${died}`)) continue;
      deps.unassign(bead.id);
      changed = true;
      if (reapFailing) {
        const { ok, count } = incrementFailedLabel(deps, bead.id, detail.labels);
        if (!ok) {
          log.warn("intake", "dispatch:failed label write failed on failing reap", {
            data: { project: deps.projectName, bead: bead.id },
          });
        }
        log.warn("intake", "reaped bead of worker that died failing", {
          data: { project: deps.projectName, bead: bead.id, assignee: bead.assignee, failed: count },
        });
        deps.alert({
          level: "warn",
          source: "intake",
          project: deps.projectName,
          worker: bead.assignee,
          message: `Bead ${bead.id} reopened: worker '${bead.assignee}' died in failing state (dispatch:failed:${count}).`,
          dedupKey: `intake-failed:${deps.projectName}:${bead.id}:${count}`,
        });
      } else {
        const retries = retryCount(detail.labels);
        removeCountLabels(deps, bead.id, detail.labels, "dispatch:retry:");
        deps.addLabel(bead.id, `dispatch:retry:${retries + 1}`);
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
  }

  // Reconcile (DELEGATION.md Decision 7): stop registry workers whose bead no
  // longer backs them. Closed bead: the intended lifecycle GC for
  // background-spawned bead workers — this deliberately sweeps COMPLETED
  // intake workers too (worker merges, closes its bead, goes done → the next
  // pass retires it); the Decision-12 guard in the removal tail leaves a
  // closed bead untouched, so retirement never disturbs the graph.
  // Foreign-assigned bead: the operator's board-side recall — their claim is
  // the durable cancel marker, and the same guard preserves it. Keyed on
  // entry.bead (the registry→bd join), independent of the gated-epic set, so
  // handoff --bead workers reconcile too; and it runs BEFORE the governor
  // count so a freed slot is usable in this same pass. Two guards: an
  // UNASSIGNED bead is skipped (the worker's own claim may still be in flight
  // after a failed post-spawn claim — not a recall), and workers in pipeline
  // states are deferred, never yanked mid-headless-pipeline — the next pass
  // catches them once they exit it.
  const beadWorkers = workers.filter(w => w.bead);
  if (beadWorkers.length > 0) {
    const beadDetails = new Map(
      deps.showBeads(beadWorkers.map(w => w.bead as string)).map(d => [d.id, d]),
    );
    for (const worker of beadWorkers) {
      const beadId = worker.bead as string;
      const detail = beadDetails.get(beadId);
      if (!detail) {
        // Never stop a worker on missing data (stopping is destructive), and
        // never abort the whole pass over one stale registry field.
        log.warn("intake", "bead reconcile: bd show returned no data for bead", {
          worker: worker.name,
          data: { project: deps.projectName, bead: beadId },
        });
        continue;
      }
      const closed = detail.status === "closed";
      const recalled = !closed && !!detail.assignee && detail.assignee !== worker.name;
      if (!closed && !recalled) continue;
      const reason = closed ? "closed" : "recalled";
      const prState = worker.prState ?? "working";
      if (prState === "reviewing" || prState === "resolving"
          || prState === "ci-fixing" || prState === "merge-pending") {
        log.info("intake", "bead reconcile deferred: worker is mid-pipeline", {
          worker: worker.name,
          data: { project: deps.projectName, bead: beadId, reason, prState },
        });
        continue;
      }
      if (!deps.stopWorker(worker.name)) {
        log.warn("intake", "bead reconcile: failed to stop worker", {
          worker: worker.name,
          data: { project: deps.projectName, bead: beadId, reason },
        });
        continue;
      }
      byName.delete(worker.name);
      changed = true;
      log.info("intake", "stopped worker on bead reconcile", {
        worker: worker.name,
        data: { project: deps.projectName, bead: beadId, reason },
      });
      if (recalled) {
        // Only the recall alerts: a closed-bead sweep of a finished worker is
        // routine lifecycle (logged above, like ci-fix launches), and the
        // alert surface has no info level.
        deps.alert({
          level: "warn",
          source: "intake",
          project: deps.projectName,
          worker: worker.name,
          message:
            `Worker '${worker.name}' stopped: bead ${beadId} was recalled `
            + `(now assigned to '${detail.assignee}').`,
          dedupKey: `intake-reconcile:${deps.projectName}:${worker.name}`,
        });
      }
    }
  }

  if (epics.length === 0) return changed;

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

  // Fail-closed store check (Decision 15's loud dangling-store rule): a
  // configured beadsDir that is missing is never run against — bd would
  // bootstrap a fresh divergent DB there, the split-brain the shared
  // resolver exists to prevent. Stamped as the intake error (board's
  // dispatcher-liveness chip reads it) AND alerted, throttled like any pass.
  const storeError = beadsStoreError(project);
  if (storeError) {
    writeIntakeError(projectName, storeError);
    log.warn("intake", "beads store unavailable; intake pass skipped", {
      data: { project: projectName, error: storeError },
    });
    addAlert({
      level: "error",
      source: "intake",
      project: projectName,
      message: `Bead intake halted: ${storeError}. Fix or clear 'garden config ${projectName} beadsDir'.`,
      dedupKey: `intake-store:${projectName}`,
    });
    return false;
  }
  // Which store this pass resolved — the split-brain diagnostic DELEGATION.md
  // wants loud. Info when a shared store is pinned (the interesting case);
  // the default own-checkout store logs at debug.
  const store = resolveBeadsDir(project);
  if (project.beadsDir) {
    log.info("intake", "intake pass resolved shared beads store", {
      data: { project: projectName, store },
    });
  } else {
    log.debug("intake", "intake pass resolved beads store", {
      data: { project: projectName, store },
    });
  }

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
  return runIntakeOnce({
    projectName,
    cap: project.beadIntakeCap ?? DEFAULT_BEAD_INTAKE_CAP,
    listOpenEpics: () => listOpenEpics(project),
    swarmStatus: (epicId) => swarmStatus(project, epicId),
    showBeads: (ids) => showBeads(project, ids),
    claim: (id, actor) => claimBead(project, id, actor),
    reopen: (id, reason) => reopenBead(project, id, reason),
    unassign: (id) => unassignBead(project, id),
    addLabel: (id, label) => addLabel(project, id, label),
    removeLabel: (id, label) => removeLabel(project, id, label),
    spawn: (req) => spawnBeadWorker(projectName, req),
    stopWorker: (name) => {
      try {
        stopWorkerByName(projectName, name);
        return true;
      } catch (err) {
        log.warn("intake", "workers stop failed during bead reconcile", {
          worker: name,
          data: { project: projectName, error: String(err) },
        });
        return false;
      }
    },
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
  let name: string | null;
  try {
    name = newWorker({
      projectName,
      seedMessageFile: seedFile,
      background: true,
      // Registry→bd join: recall/reconcile and the removal-time unclaim read
      // entry.bead.
      ...(req.bead ? { bead: req.bead } : {}),
      // "planner" for the plan-consume loop; absent = default build worker.
      ...(req.workflow ? { workflow: req.workflow } : {}),
    });
  } catch (err) {
    try { fs.unlinkSync(seedFile); } catch { /* ignore */ }
    throw err;
  }
  if (!name) {
    try { fs.unlinkSync(seedFile); } catch { /* ignore */ }
    return null;
  }
  updateWorkerTask(projectName, name, req.task);
  return name;
}

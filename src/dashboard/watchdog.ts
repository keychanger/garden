// Liveness watchdog: a slow recurring tick with four duties, plus one
// event-driven Codex rollout listener.
//
// 1. Re-poke projects holding workers stranded in active states. The state
// machine is event-driven (docs/STATUS.md invariant 6) and a dropped one-shot
// event — a poke lost in the poller kill→spawn gap, a detached-bash delayed
// poke killed by reboot, a review-launch poke that never landed — would
// otherwise strand a worker until the operator diagnosed it. The watchdog
// bounds that blast radius: it delivers only the ordinary FIFO poke the lost
// event would have sent.
//
// 2. Keep each project's poller window healthy: respawn it if it died and
// collapse duplicates to one if a spawn race left several (see
// healProjectPollers). A poke is useless if no poller is reading the FIFO: a
// poller window can vanish uncleanly and, once gone, is otherwise only revived
// by a dashboard re-attach (validate) or a worker-create (ensureProjectPoller).
// If the session stays attached and no new worker is created, the project's
// whole review/merge pipeline stalls silently. The watchdog closes that gap so
// a dead — or accidentally duplicated — poller self-heals within one tick.
//
// 3. Alert on orphans — a resource whose registry entry is gone while the
// resource lives, in either of the two places one can survive. A live tmux
// worker window (see alertOrphanedWindows) means a running but invisible pane
// that no poller reviews; a worktree directory (see alertOrphanedWorktrees, on
// the hourly housekeeping throttle) means disk nothing owns. Detection only in
// both cases — the watchdog never reconstructs an entry and never deletes a
// tree; it makes the casualty visible so the operator can decide.
//
// 4. Re-file worker windows whose names disagree with the registered worktree
// their panes occupy. This repairs the status-visibility casualty of a failed
// post-swap rename without guessing when two panes claim the same worker.
//
// The rollout listener translates Codex's hookless request_user_input call and
// result records into the shared asking/working worker states. It is driven by
// fs.watch writes, not by the recurring tick.
//
// Runs in a single hidden tmux window (_garden-watchdog), mirroring the usage
// poller's lifecycle: the window being killed (reset or exit) is the
// termination signal — no signal file, no FIFO. Unlike the usage poller it
// starts unconditionally; provider-only fleets still need liveness.
import fs from "node:fs";
import path from "node:path";
import { SESSIONS_DIR } from "../config.js";
import { newDashboardWindow, windowExists, killWindowSafe, listAllWindowNames } from "./tmux.js";
import { watchdogWindowName, parseWorkerWindow } from "./window-names.js";
import { readRegistry, mutateRegistry, PR_STATE_KIND, OPERATOR_ACTION_FAILING_REASONS, type WorkerEntry, type WorkerRegistry } from "./registry.js";
import { triggerProjectPoll } from "./poller-fifo.js";
import { addAlert } from "./alerts.js";
import { log, truncateLog } from "./log.js";
import { sweepSpawnDrafts } from "./spawn-draft.js";
import { dueCleanupRequests, dispatchWorkerCleanup } from "./worker-cleanup.js";
import {
  captureCodexUsageLatest, probeCodexUsageIfStale, CODEX_PROBE_INTERVAL_MS,
} from "./codex-usage.js";
import { startCodexInputWatcher } from "./codex-input.js";
import { healWorkerWindows } from "./window-heal.js";
import {
  commitsBehindOrigin, gardenInstallRepo, listWorktreeDirs, workerCleanupMarkerPath,
} from "./git.js";
import { readDashState, writeDashState, withStateLock } from "./state.js";
import { getBuildBranch, loadConfig } from "../config.js";
import { GARDEN_VERSION } from "../version.js";

export const WATCHDOG_TICK_MS = 60_000;
export const WATCHDOG_THRESHOLD_MS = 5 * 60_000;
// A watchdog loop iteration that overran its intended cadence by more than this
// means the process was suspended (machine sleep / clock jump) — a real suspend
// is minutes-to-hours, an over-long tick body is seconds. One full extra tick of
// slack keeps a slow body (poller respawns under a large fleet) well clear.
export const SLEEP_SLACK_MS = WATCHDOG_TICK_MS;

// States the watchdog watches: those where the poller owes the worker a future
// action (PR_STATE_KIND.pollerOwed), plus two stranding classes that live in
// otherwise-quiescent states — a `working` worker with commits ahead awaiting a
// lost review-launch poke, and a `failing` worker mid-debounce awaiting a lost
// failing->working poke. The pollerOwed classification is the single source of
// truth in registry.ts; the genuinely quiescent states (an idle `working` with
// no pending review, a parked `failing` with no pushed fix, `done`) park
// legitimately on an event of their own, so they are never watched.
export function isWatchedState(entry: WorkerEntry): boolean {
  const state = entry.prState ?? "working";
  if (PR_STATE_KIND[state].pollerOwed) return true;
  // A Stop hook saw commits ahead of base but the review-launch poke never
  // arrived — the one stranding class that lives in the working state.
  if (state === "working" && entry.pendingReviewAt !== undefined) return true;
  // A `failing` worker that observed new commits (lastSeenSha has advanced past
  // the pinned failingSha) owes a debounced failing->working transition, which
  // handleFailing schedules as a one-shot delayed poke. `failing` is
  // pollerOwed:false, so if that poke is lost (poller killed in the gap, a
  // reboot) nothing re-pokes it and the operator's pushed fix is never picked
  // up — the worker sits in `failing` forever. Watch that pending-debounce case
  // so the watchdog re-pokes it. Operator-action dispositions (trellis-flagged /
  // iteration-budget / stagnation) are deliberately parked and excluded.
  return state === "failing"
    && !OPERATOR_ACTION_FAILING_REASONS.has(entry.failingReason ?? "code")
    && entry.lastSeenSha !== undefined
    && entry.lastSeenSha !== entry.failingSha;
}

// A worker in a `windowed` state (reviewing/resolving/ci-fixing) whose hidden
// tmux window is still alive is actively in flight, not stranded — the work is
// progressing and bounded by its own timeout (REVIEW_TIMEOUT_MS). The watchdog
// exists to recover *dropped* events; a live window is proof the event was not
// dropped. Without this, any review/resolve/ci-fix running past the staleness
// threshold (routine for a substantial review) draws a spurious poke every
// threshold window — harmless (handleReviewing no-ops while the window lives)
// but it logs a misleading "poked stale project" each time. The genuine
// stranding class — the window exited but its completion poke was lost — has a
// dead window and still trips, so recovery is preserved.
export function hasLiveWork(entry: WorkerEntry): boolean {
  const state = entry.prState ?? "working";
  return PR_STATE_KIND[state].windowed
    && entry.reviewWindowName !== undefined
    && windowExists(entry.reviewWindowName);
}

// Most recent relevant activity as epoch ms, 0 when no timestamp is set.
// Epoch-ms fields are read directly; ISO-string fields go through Date.parse.
export function latestActivityMs(entry: WorkerEntry): number {
  const epochs = [
    entry.lastEventAt, entry.pendingReviewAt, entry.reviewStartedAt,
    entry.lastAutoContinueAt,
  ];
  for (const iso of [entry.mergePendingAt, entry.mergedAt, entry.lastShaChangeAt]) {
    if (iso !== undefined) epochs.push(Date.parse(iso));
  }
  return Math.max(0, ...epochs.filter((t): t is number =>
    typeof t === "number" && Number.isFinite(t)));
}

export function isWorkerStale(
  entry: WorkerEntry, nowMs: number, thresholdMs = WATCHDOG_THRESHOLD_MS,
): boolean {
  if (!isWatchedState(entry)) return false;
  // A live windowed worker is in flight, not stranded — never stale.
  if (hasLiveWork(entry)) return false;
  const lastActivity = latestActivityMs(entry);
  // No timestamp means no clock to age against — age would be unbounded.
  if (lastActivity === 0) return false;
  return nowMs - lastActivity > thresholdMs;
}

// One watchdog cycle: poke each project holding a stale watched worker,
// damped to one poke per project per threshold via the caller-owned map
// (project → epoch ms of last poke). Exported for tests.
export function tick(lastPokeAt: Map<string, number>, nowMs: number): void {
  const registry = readRegistry();
  for (const [project, entries] of Object.entries(registry.workers)) {
    const stale = entries.filter(e => isWorkerStale(e, nowMs));
    if (stale.length === 0) continue;
    if (nowMs - (lastPokeAt.get(project) ?? 0) < WATCHDOG_THRESHOLD_MS) continue;
    lastPokeAt.set(project, nowMs);
    triggerProjectPoll(project);
    log.info("watchdog", "poked stale project", {
      data: {
        project,
        workers: stale.map(e => ({
          name: e.name,
          state: e.prState ?? "working",
          ageMs: nowMs - latestActivityMs(e),
        })),
      },
    });
  }
}

// Ensure every project that holds workers or has bead intake enabled has
// exactly one live poller window.
// Delegates to the injected `ensurePoller` (startProjectPoller), which is
// convergent: it spawns when no window exists, collapses duplicates to one,
// and no-ops when exactly one is live. Calling it for every project each tick
// therefore both revives a poller that died uncleanly (collateral from a
// worker-kill/worktree-cleanup, a lost tmux pane, an OS signal — none of which
// log "stopped") and heals the duplicate-window leak a spawn race can produce.
// Self-damping: once each project has its single poller, later calls no-op
// silently. `ensurePoller` is injected so this module never statically imports
// poller.ts (which imports this one for start/stopWatchdog) — that would close
// a cycle. Per-project failures are isolated so one can't abort the cycle and
// skip the staleness sweep. Returns the projects acted on this cycle.
export function healProjectPollers(
  ensurePoller: (project: string) => void,
): string[] {
  const registry = readRegistry();
  const config = loadConfig();
  const projects = new Set(
    Object.entries(registry.workers)
      .filter(([, entries]) => entries.length > 0)
      .map(([project]) => project),
  );
  for (const [project, projectConfig] of Object.entries(config.projects)) {
    if (projectConfig.beadIntake === true) projects.add(project);
  }
  const ensured: string[] = [];
  for (const project of projects) {
    try {
      ensurePoller(project);
      ensured.push(project);
    } catch (err) {
      log.warn("watchdog", "failed to ensure project poller", {
        data: { project, error: String(err) },
      });
    }
  }
  return ensured;
}

// Surface orphaned worker windows: a live tmux worker window with no registry
// entry. This is the inverse of validate's "window missing → mark exited" pass
// — here the *entry* is missing while the window lives. The create/sweep race
// (now fixed in dropGhostEntries) could delete a freshly-created worker's entry
// mid-bootstrap, leaving the pane running but detached: its hooks no-op
// (updateWorkerFields finds no entry) and the poller, which only iterates the
// registry, never reviews or merges its work. The grace fix should prevent new
// orphans; this alert is the backstop that makes any that still slip through
// (or predate the fix) visible so the operator can recover them. Detection
// only — reconstructing a usable entry from a window is unsafe (workflow,
// sessionId, and base branch can't be recovered reliably), so the watchdog
// never re-adds; addAlert's stable dedupKey caps this at one alert per orphan
// per hour despite the 60s tick.
export function alertOrphanedWindows(registry: WorkerRegistry): void {
  let windows: string[];
  try {
    windows = listAllWindowNames();
  } catch {
    return;
  }
  for (const name of windows) {
    const parsed = parseWorkerWindow(name);
    if (!parsed) continue;
    const { project, worker } = parsed;
    if ((registry.workers[project] ?? []).some(e => e.name === worker)) continue;
    addAlert({
      level: "warn",
      source: "watchdog",
      project,
      worker,
      message:
        `Worker '${worker}' has a live tmux window but no registry entry — it is ` +
        `orphaned from the review/merge pipeline (its hooks no-op and the poller ` +
        `can't see it). The worktree and branch are intact on disk; recreate the ` +
        `worker or recover its branch manually to land its work. [orphan]`,
      dedupKey: `watchdog-orphan:${project}:${worker}`,
    });
    log.warn("watchdog", "orphaned worker window (no registry entry)", {
      worker,
      data: { project, window: name },
    });
  }
}

// Discount machine-sleep / clock-jump time from live review/resolve/ci-fix
// timeouts. isReviewTimedOut / isCiFixTimedOut kill a reviewer whose window has
// lived past REVIEW_TIMEOUT_MS (Date.now() - reviewStartedAt), transitioning a
// HEALTHY review into `failing` — but a laptop that sleeps mid-review makes that
// wall-clock difference include the suspend and spuriously trips the timeout on
// wake. The watchdog is the fleet's one fixed-cadence process, so the wall-clock
// it overran its intended loop interval by (gapMs) directly measures suspend
// time. When that overrun exceeds a full tick of slack, shift reviewStartedAt
// forward by the slippage for every live-windowed worker, so the naive
// downstream checks exclude the sleep. All three role timeouts read
// entry.reviewStartedAt behind a live entry.reviewWindowName, so one durable
// shift corrects reviewing, resolving, and ci-fixing alike.
//
// Only reviewStartedAt is shifted: backoff gates (reviewRetryAt), the failing
// debounce (lastShaChangeAt), and owed-action anchors (mergePendingAt /
// pendingReviewAt) SHOULD come due on wake — the API recovered, the quota
// window reset, the fix aged — so they are deliberately left alone. The shift
// re-reads under the registry lock and re-checks the window fields, so a
// concurrent verdict-dispatch (which clears reviewStartedAt + reviewWindowName)
// can't resurrect a stale anchor onto a merged worker. Returns the slippage
// applied (0 when no suspend), for logging and tests. This transitions no state
// — it is delivery-time bookkeeping, consistent with the watchdog contract.
//
// Residual (documented): if the OS suspends while a poll process is already
// mid-worker-loop, that poll resumes on wake and can reach isReviewTimedOut
// before this shift lands (a scheduler coin-flip). Rare (the machine is idle
// between short, event-driven polls) and operator-recoverable (`garden kick`);
// closing it deterministically would need a sleep-aware check on every timeout,
// which is not worth the added failure surface.
export function absorbSleep(gapMs: number): number {
  const slippage = gapMs - WATCHDOG_TICK_MS;
  if (slippage <= SLEEP_SLACK_MS) return 0;
  const registry = readRegistry();
  const eligible = new Set<string>();
  for (const [project, entries] of Object.entries(registry.workers)) {
    for (const e of entries) {
      if (e.reviewStartedAt !== undefined && hasLiveWork(e)) {
        eligible.add(`${project} ${e.name}`);
      }
    }
  }
  if (eligible.size === 0) return 0;
  mutateRegistry((reg) => {
    let changed = false;
    for (const [project, entries] of Object.entries(reg.workers)) {
      for (const e of entries) {
        // Re-check the window fields under the lock — not windowExists again
        // (a rare op shouldn't hold the lock across tmux calls); a dispatch that
        // cleared reviewStartedAt/reviewWindowName drops the entry from the shift.
        if (eligible.has(`${project} ${e.name}`)
            && e.reviewStartedAt !== undefined && e.reviewWindowName !== undefined) {
          e.reviewStartedAt += slippage;
          changed = true;
        }
      }
    }
    return changed;
  });
  log.info("watchdog", "discounted machine-sleep from live review timeouts", {
    data: { slippageMs: slippage, workers: eligible.size },
  });
  return slippage;
}

// How often the housekeeping sweep runs. Neither artifact it bounds grows fast
// enough to need the 60s liveness cadence, and the bootstrap sweep stats a whole
// directory — so it is throttled to hourly via the caller-owned timestamp.
export const HOUSEKEEP_INTERVAL_MS = 60 * 60_000;

// How often the running build's staleness is recounted. The answer only moves
// when something merges, and the point is spotting drift measured in days — so
// this is deliberately slow. It is a local `rev-list --count` with no fetch,
// kept off the render path because formatRightBar runs on the hook firehose.
export const BUILD_STALENESS_INTERVAL_MS = 5 * 60_000;

// Bead-intake heartbeat: the slow self-arm timer DELEGATION.md's intake loop
// calls for. The poller is event-driven, and a fully idle project fires no
// events — so an epic gated open while nothing else moves would wait forever.
// The watchdog (the fleet's one recurring tick) pokes each opted-in project's
// FIFO on this cadence; the poller-side 60s throttle keeps the resulting pass
// cheap, and explicit `garden poke` wakes remain the fast path.
export const INTAKE_BEAT_MS = 5 * 60_000;

// Poke every beadIntake-enabled project's poller so its intake step runs even
// on a quiet fleet. Config is re-read each beat so an operator toggling
// `beadIntake` mid-session is picked up without a watchdog restart.
export function pokeBeadIntakeProjects(): string[] {
  const poked: string[] = [];
  for (const [name, project] of Object.entries(loadConfig().projects)) {
    if (project.beadIntake !== true) continue;
    triggerProjectPoll(name);
    poked.push(name);
  }
  return poked;
}

// Recount how far the running build trails its configured branch and cache it
// in dashboard state for the status bar. Returns true when the number changed,
// so the caller repaints only on a real move. No-ops on a dev build or an
// install not running out of a git checkout — nothing to measure there, and the
// bar stays normal rather than nagging about something unknowable.
export function refreshBuildStaleness(): boolean {
  if (GARDEN_VERSION === "dev") return false;
  const repo = gardenInstallRepo();
  if (!repo) return false;
  const behind = commitsBehindOrigin(repo, GARDEN_VERSION, getBuildBranch());
  let changed = false;
  withStateLock(() => {
    const state = readDashState();
    if (state.buildBehind === behind) return;
    state.buildBehind = behind;
    writeDashState(state);
    changed = true;
  });
  return changed;
}

// A spent bootstrap script older than this is safe to delete. The worker pane
// runs `sh bootstrap-<project>-<branch>.sh` once, seconds after it is written,
// and never touches it again (bounce/resume relaunch via `claude --resume`,
// not the script); on Unix an already-open sh keeps its fd alive across the
// unlink regardless. Hours of slack puts the cut far past any real bootstrap
// (fetch + install + launch) while still sweeping the per-worker orphans that
// accrue over months.
export const BOOTSTRAP_MAX_AGE_MS = 6 * 60 * 60_000;

// Delete spent worker bootstrap scripts from SESSIONS_DIR. buildWorktreeBootstrapScript
// (create.ts) writes one `bootstrap-<project>-<branch>.sh` per worker launch and
// nothing ever removed it, so one orphan accrued per worker ever created (1000+
// over months). Match the naming contract from create.ts directly rather than
// importing it — create.ts transitively imports this module (via poller.ts), so
// a back-edge would close an init cycle. Returns the count removed (for tests).
export function sweepBootstrapScripts(nowMs: number): number {
  let names: string[];
  try {
    names = fs.readdirSync(SESSIONS_DIR);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith("bootstrap-") || !name.endsWith(".sh")) continue;
    const file = path.join(SESSIONS_DIR, name);
    try {
      if (nowMs - fs.statSync(file).mtimeMs <= BOOTSTRAP_MAX_AGE_MS) continue;
      fs.unlinkSync(file);
      removed++;
    } catch { /* raced with another sweep, or already gone */ }
  }
  if (removed > 0) {
    log.info("watchdog", "swept spent bootstrap scripts", { data: { removed } });
  }
  return removed;
}

// A worktree directory younger than this is never called an orphan. Two races
// make a young unclaimed directory normal rather than leaked: a spawn in flight
// (the worktree exists while `npm install` runs, before the registry entry is
// durable) and a kill's detached git cleanup, which removes the directory
// moments after removeWorker deleted the entry. An hour is far past both, and
// costs nothing to wait — these live for months, so reporting one late is
// strictly better than reporting a healthy spawn as garbage.
export const ORPHAN_WORKTREE_GRACE_MS = 60 * 60_000;

// Cap on directory entries visited while sizing one orphan. A worktree can hold
// a full node_modules (100k+ files), and this runs on the watchdog's own thread
// — an unbounded walk over several orphans would stall the liveness tick that
// re-pokes stranded workers. At the cap the size is reported as a floor rather
// than pretending to be exact.
export const ORPHAN_WORKTREE_WALK_CAP = 50_000;

// Recursive size of a directory, abandoning the walk at `cap` entries. Symlinks
// are counted by their own size and never followed — a worktree's node_modules
// is full of them (.bin/*) and following them would double-count or escape the
// tree entirely.
export function directoryBytes(
  dir: string,
  cap: number = ORPHAN_WORKTREE_WALK_CAP,
): { bytes: number; truncated: boolean } {
  let bytes = 0;
  let visited = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue; // vanished mid-walk, or unreadable
    }
    for (const entry of entries) {
      if (++visited > cap) return { bytes, truncated: true };
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      try {
        bytes += fs.lstatSync(full).size;
      } catch { /* raced with a removal */ }
    }
  }
  return { bytes, truncated: false };
}

export interface OrphanedWorktree {
  project: string;
  name: string;
  path: string;
  /** Time since anything last modified the directory (see the mtime rationale). */
  idleMs: number;
  bytes: number;
  truncated: boolean;
}

// Worktree directories on disk that no registry entry claims. This is the
// worktree analogue of alertOrphanedWindows: there the *entry* is missing while
// a window lives, here it is missing while a directory lives. Nothing else in
// garden can see these — validate.ts reconciles registry → disk (it clears a
// dangling entry.worktreePath and drops ghost `loading` entries) but never walks
// the directories asking which are unclaimed, so an orphan is invisible by
// omission rather than by policy. 12 had accumulated over ~4 months (6.3GB, half
// of them carrying a node_modules) before anyone looked.
//
// Matched on the (project, name) pair the directory layout encodes, NOT on
// entry.worktreePath: validate.ts sets that field to undefined when the path is
// missing, and a resurrect can rebuild an entry whose path is not yet written —
// either would make a live worker's tree read as unclaimed.
export function findOrphanedWorktrees(
  registry: WorkerRegistry,
  nowMs: number,
): OrphanedWorktree[] {
  const claimed = new Set<string>();
  for (const [project, entries] of Object.entries(registry.workers)) {
    for (const entry of entries) claimed.add(`${project}\0${entry.name}`);
  }
  const orphans: OrphanedWorktree[] = [];
  for (const dir of listWorktreeDirs()) {
    if (claimed.has(`${dir.project}\0${dir.name}`)) continue;
    // A kill's detached cleanup is still running against this tree — it will
    // remove the directory itself. Same marker resurrect refuses on.
    if (fs.existsSync(workerCleanupMarkerPath(dir.project, dir.name))) continue;
    let idleMs: number;
    try {
      // mtime, not birthtime: the question is "has anything touched this
      // recently", since that is what distinguishes an in-flight spawn or a
      // running cleanup from an abandoned tree. Creation time would also
      // mis-describe the age — a worker created months ago but orphaned
      // yesterday would report as months stale.
      idleMs = nowMs - fs.statSync(dir.path).mtimeMs;
    } catch {
      continue; // vanished between listing and stat
    }
    if (idleMs < ORPHAN_WORKTREE_GRACE_MS) continue;
    const { bytes, truncated } = directoryBytes(dir.path);
    orphans.push({ ...dir, idleMs, bytes, truncated });
  }
  return orphans;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

// How many orphans to name individually in the alert before summarizing.
const ORPHAN_WORKTREE_NAME_LIMIT = 5;

// Surface unclaimed worktrees to the operator. DETECTION ONLY — the watchdog
// never deletes one, for the same reason it never reconstructs an orphaned
// window: an unclaimed tree can still hold the only copy of uncommitted work
// (one of the 12 found in the first sweep held 978 uncommitted lines), and
// deciding that is the operator's call, not a background sweep's. Committed work
// is never at stake — a worktree's branch lives in the repo and survives its
// removal — so the alert says so, since that is what makes the cleanup safe.
//
// Fires on CHANGE only, against the signature persisted in dashboard state: the
// set is a standing condition that can persist for months while the hourly sweep
// re-derives it, so keying addAlert's dedup on it alone (a 1-hour window) would
// nag ~24 times a day forever. Returns the number of orphans found, whether or
// not this call alerted.
export function alertOrphanedWorktrees(nowMs: number): number {
  const orphans = findOrphanedWorktrees(readRegistry(), nowMs);
  const signature = orphans.map(o => `${o.project}/${o.name}`).sort().join(",") || null;
  let changed = false;
  withStateLock(() => {
    const state = readDashState();
    if (state.orphanWorktreeSignature === signature) return;
    state.orphanWorktreeSignature = signature;
    writeDashState(state);
    changed = true;
  });
  if (!changed || orphans.length === 0) return orphans.length;

  // One alert per project rather than one fleet-wide: the alert store is keyed by
  // project and the status pane renders a per-project unread count, so a
  // single cross-project alert would have to be filed under some arbitrary
  // project's badge. The change signature is still global — one sweep, one
  // decision — so all affected projects alert together.
  const byProject = new Map<string, OrphanedWorktree[]>();
  for (const orphan of orphans) {
    const list = byProject.get(orphan.project) ?? [];
    list.push(orphan);
    byProject.set(orphan.project, list);
  }
  for (const [project, list] of byProject) {
    const totalBytes = list.reduce((sum, o) => sum + o.bytes, 0);
    const atLeast = list.some(o => o.truncated) ? "at least " : "";
    const named = list
      .slice(0, ORPHAN_WORKTREE_NAME_LIMIT)
      .map(o => `${o.name} (${formatBytes(o.bytes)}, idle ${Math.floor(o.idleMs / 86_400_000)}d)`)
      .join(", ");
    const rest = list.length - Math.min(list.length, ORPHAN_WORKTREE_NAME_LIMIT);
    addAlert({
      level: "warn",
      source: "watchdog",
      project,
      message:
        `${list.length} worktree${list.length === 1 ? "" : "s"} on disk with no ` +
        `registry entry, holding ${atLeast}${formatBytes(totalBytes)}: ${named}` +
        `${rest > 0 ? `, and ${rest} more` : ""}. Nothing owns ` +
        `${list.length === 1 ? "it" : "them"} — no dashboard row, no poller, no ` +
        `reviewer. Committed work is safe either way (a branch outlives its ` +
        `worktree), so only uncommitted changes need saving first: ` +
        `\`git -C <repo> worktree remove --force <path>\`, then ` +
        `\`git -C <repo> worktree prune\`. [orphan-worktree]`,
      dedupKey: `watchdog-orphan-worktrees:${project}:${signature}`,
    });
    log.warn("watchdog", "orphaned worktrees (no registry entry)", {
      data: {
        project,
        count: list.length,
        bytes: totalBytes,
        worktrees: list.map(o => o.name),
      },
    });
  }
  return orphans.length;
}

// Bound two on-disk artifacts the fleet accumulates unbounded. Called on the
// hourly throttle (see the loop): (1) dashboard.log — truncateLog tail-trims it
// past its 10MB cap, but was only ever invoked on fresh dashboard creation, so a
// long-lived session's log grew unbounded between restarts; enforce the cap on a
// recurring cadence instead. (2) spent bootstrap scripts (see above). Transitions
// no state — pure disk housekeeping, consistent with the watchdog contract.
//
// Also carries the orphaned-worktree sweep, which is detection rather than
// bounding: it belongs on this throttle rather than the 60s tick because it walks
// directories to size what it finds, and an unclaimed worktree that has sat for
// months is not news that needs reporting within a minute.
// Re-dispatch worker-cleanup requests that are still on disk. The removing
// process already fired one attempt; a request that outlived
// CLEANUP_RETRY_AFTER_MS means that attempt did not finish the job — most often
// because it ran inside an agent sandbox that denies writes to the project
// checkout, and so failed every git step. The watchdog is never sandboxed, so
// its re-dispatch is the one that succeeds.
//
// Dispatched detached rather than run inline: removing a worktree holding a
// full node_modules and deleting an origin branch are seconds-to-minutes of
// work, and an overrunning iteration is read by absorbSleep as machine-suspend
// time — doing this on the tick's own thread would shift live review timers.
export function sweepWorkerCleanups(nowMs: number, gardenRunner: string): number {
  const due = dueCleanupRequests(nowMs);
  for (const req of due) {
    dispatchWorkerCleanup(gardenRunner, req.project, req.worker);
  }
  if (due.length > 0) {
    log.info("watchdog", "re-dispatched stalled worker cleanups", {
      data: { count: due.length, workers: due.map(r => `${r.project}/${r.worker}`) },
    });
  }
  return due.length;
}

export function housekeeping(nowMs: number): void {
  truncateLog();
  sweepBootstrapScripts(nowMs);
  sweepSpawnDrafts(nowMs);
  alertOrphanedWorktrees(nowMs);
}

export async function runWatchdogLoop(): Promise<void> {
  log.info("watchdog", "started");
  // Imported dynamically to avoid a static cycle (poller.ts statically imports
  // this module for start/stopWatchdog). Resolved once; stable for the loop's
  // lifetime. The runner is read from this process's own argv via
  // resolveGardenRunner, so respawned pollers bake the same canonical garden
  // path the watchdog window itself was spawned with.
  const { resolveGardenRunner } = await import("./runner.js");
  const { startProjectPoller } = await import("./poller.js");
  // Dynamic-imported (like the poller above) to keep watchdog.ts's static import
  // surface minimal; header.ts is heavy and this module is start/stop-imported by
  // poller.ts. Re-bakes the status pane each tick so time-in-state suffixes tick.
  const { refreshStatusElapsed, refreshDashboard } = await import("./header.js");
  startCodexInputWatcher(refreshDashboard);
  const gardenRunner = resolveGardenRunner();
  // Damping state lives in the loop closure: it persists across ticks and
  // resets on window respawn, which is fine — a respawn is itself a restart
  // event and one extra poke is harmless.
  const lastPokeAt = new Map<string, number>();
  // Hourly disk-housekeeping throttle (see HOUSEKEEP_INTERVAL_MS). 0 forces a
  // sweep on the first tick after (re)spawn, which clears any orphans that
  // accrued while the watchdog was down.
  let lastHousekeepAt = 0;
  // Codex-probe throttle. Seeded to now (unlike lastHousekeepAt, which is 0 to
  // force a first-tick sweep): the probe costs quota, so a watchdog respawn must
  // not be a way to trigger one — the snapshot-age gate decides when it is due.
  let lastCodexProbeAt = Date.now();
  // 0, unlike the codex probe: a dashboard restart is exactly when a rebuild
  // may have just landed, and recounting costs one local git call.
  let lastStalenessAt = 0;
  // 0 so the first tick after (re)spawn pokes intake projects — a restart may
  // have eaten a poke, and the poller-side throttle bounds the cost.
  let lastIntakeBeatAt = 0;
  // Timestamp the START of each iteration; the gap to the next start spans the
  // whole loop (tick body + the fixed sleep), so a suspend during EITHER is
  // measured — capturing only around the sleep would miss a suspend mid-body.
  let iterStart = Date.now();
  while (true) {
    const gap = Date.now() - iterStart;
    iterStart = Date.now();
    try {
      // First thing on (re)entry: reconcile any machine-sleep that spanned the
      // previous iteration, before the timeout-bearing tick runs.
      absorbSleep(gap);
      // Heal pollers before poking so a just-revived poller receives this
      // cycle's staleness poke (and resumes work) without waiting another tick.
      healProjectPollers(
        (project) => startProjectPoller(project, gardenRunner),
      );
      tick(lastPokeAt, Date.now());
      // Re-file worker windows whose name disagrees with the worker their pane
      // holds (a misfiled rename makes a live worker invisible in the status
      // pane), BEFORE orphan detection so it judges the healed names. Under the
      // state lock so the heal cannot observe a navigation swap mid-flight.
      try {
        withStateLock(() => healWorkerWindows());
      } catch (err) {
        log.warn("watchdog", "window heal failed", { data: { error: String(err) } });
      }
      alertOrphanedWindows(readRegistry());
      // Retry any worker cleanup whose own dispatch failed. On the fast 60s
      // tick rather than hourly housekeeping: this is a recovery path for a
      // leak that is actively occupying disk, and the sweep is a readdir that
      // matches nothing in the steady state.
      try {
        sweepWorkerCleanups(Date.now(), gardenRunner);
      } catch (err) {
        log.warn("watchdog", "worker cleanup sweep failed", { data: { error: String(err) } });
      }
      // Advance the status pane's time-in-state suffixes ("reviewing 12m" ->
      // "13m"). Content-deduped inside, so this is a no-op when nothing is in
      // flight. Wrapped separately (it runs after tick/alerts, which are already
      // done) so a repaint failure logs its own specific reason instead of the
      // generic "tick failed".
      try {
        refreshStatusElapsed();
      } catch (err) {
        log.warn("watchdog", "status elapsed refresh failed", { data: { error: String(err) } });
      }
      // Codex usage meter: pick up whatever rate_limits any Codex process wrote
      // since the last tick. The watchdog owns this because it is the fleet's
      // one unconditional recurring tick — the Anthropic usage poller is gated
      // on anyAnthropicMeteredProject(), so hanging the capture there would
      // leave an all-Codex fleet with no meter at all. Repaints only when the
      // reading moved (writes are rare; the steady state is a bounded dir walk).
      try {
        if (captureCodexUsageLatest()) refreshDashboard();
      } catch (err) {
        log.warn("watchdog", "codex usage capture failed", { data: { error: String(err) } });
      }
      // Recount how stale the running build is, on its own slow throttle, and
      // repaint only when the number moves — so a current build never touches
      // tmux for this.
      if (Date.now() - lastStalenessAt >= BUILD_STALENESS_INTERVAL_MS) {
        lastStalenessAt = Date.now();
        try {
          if (refreshBuildStaleness()) refreshDashboard();
        } catch (err) {
          log.warn("watchdog", "build staleness refresh failed", { data: { error: String(err) } });
        }
      }
      // The passive capture above only re-reports the last time Codex ran, so a
      // fleet that runs Codex occasionally would sit on a reading captured days
      // ago — and a plan change in between makes that reading a percentage of a
      // quota that no longer exists. Probe on a slow throttle to bound it. This
      // spends real Codex quota, hence both gates: only when Codex is in the
      // fleet at all, and only when the snapshot is already older than the
      // interval (a fleet actively running Codex is fed for free by the capture
      // and never probes).
      const probeNow = Date.now();
      if (probeNow - lastCodexProbeAt >= CODEX_PROBE_INTERVAL_MS) {
        // Advance unconditionally, before the attempt: the decision is re-made
        // at most once per interval whatever its outcome. A probe that fired but
        // captured nothing (codex offline, out of quota) must not be retried on
        // the next 60s tick — that would spend quota per minute, not per plan
        // change — and a decision that declined to probe need not be re-derived
        // (two file reads) every tick until the next one does.
        lastCodexProbeAt = probeNow;
        try {
          // probeCodexUsageIfStale carries the snapshot-age + codexInFleet gates.
          if (probeCodexUsageIfStale(probeNow)) refreshDashboard();
        } catch (err) {
          log.warn("watchdog", "codex usage probe failed", { data: { error: String(err) } });
        }
      }
      // Bead-intake heartbeat (see INTAKE_BEAT_MS): a plain FIFO poke per
      // opted-in project, so gated epics dispatch even when no lifecycle
      // event is arriving.
      if (Date.now() - lastIntakeBeatAt >= INTAKE_BEAT_MS) {
        lastIntakeBeatAt = Date.now();
        try {
          pokeBeadIntakeProjects();
        } catch (err) {
          log.warn("watchdog", "bead intake beat failed", { data: { error: String(err) } });
        }
      }
      // Disk housekeeping on the hourly throttle — bounds dashboard.log and the
      // spent-bootstrap-script pile. Wrapped separately so a sweep failure logs
      // its own reason instead of aborting the liveness tick above.
      const now = Date.now();
      if (now - lastHousekeepAt >= HOUSEKEEP_INTERVAL_MS) {
        lastHousekeepAt = now;
        try {
          housekeeping(now);
        } catch (err) {
          log.warn("watchdog", "housekeeping failed", { data: { error: String(err) } });
        }
      }
    } catch (err) {
      log.warn("watchdog", "tick failed", { data: { error: String(err) } });
    }
    await sleep(WATCHDOG_TICK_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// -----------------------------------------------------------------------------
// tmux window lifecycle
// -----------------------------------------------------------------------------

export function startWatchdog(gardenRunner: string): void {
  const window = watchdogWindowName();
  if (windowExists(window)) return;
  newDashboardWindow(window, "bash", "-c", `${gardenRunner} dashboard _watchdog-loop 2>/dev/null`);
  log.info("watchdog", "spawned window", { data: { window } });
}

export function stopWatchdog(): void {
  killWindowSafe(watchdogWindowName());
}

// Liveness watchdog: a slow recurring tick with two duties, neither of which
// transitions worker state itself.
//
// 1. Re-poke projects holding workers stranded in active states. The state
// machine is event-driven (docs/STATUS.md invariant 6) and a dropped one-shot
// event — a poke lost in the poller kill→spawn gap, a detached-bash delayed
// poke killed by reboot, a review-launch poke that never landed — would
// otherwise strand a worker until the operator diagnosed it. The watchdog
// bounds that blast radius: it delivers only the ordinary FIFO poke the lost
// event would have sent.
//
// 2. Respawn project pollers whose tmux window has died. A poke is useless if
// no poller is reading the FIFO: a poller window can vanish uncleanly (see
// respawnDeadPollers) and, once gone, is only revived by a dashboard
// re-attach (validate) or a worker-create (ensureProjectPoller). If the
// session stays attached and no new worker is created, the project's whole
// review/merge pipeline stalls silently. The watchdog closes that gap so a
// dead poller self-heals within one tick.
//
// Runs in a single hidden tmux window (_garden-watchdog), mirroring the usage
// poller's lifecycle: the window being killed (reset or exit) is the
// termination signal — no signal file, no FIFO. Unlike the usage poller it
// starts unconditionally; provider-only fleets still need liveness.
import { tmux, windowExists, killWindowSafe } from "./tmux.js";
import { DASHBOARD_SESSION } from "../session.js";
import { watchdogWindowName } from "./window-names.js";
import { readRegistry, type WorkerEntry, type PrState } from "./registry.js";
import { triggerProjectPoll } from "./poller-fifo.js";
import { log } from "./log.js";

export const WATCHDOG_TICK_MS = 60_000;
export const WATCHDOG_THRESHOLD_MS = 5 * 60_000;

// States where the poller owes the worker a future action. Quiescent states
// (idle working, failing, done) park legitimately waiting on operator or
// worker action that carries its own event, so they are never watched.
const WATCHED_PR_STATES = new Set<PrState>([
  "reviewing", "resolving", "ci-fixing", "merge-pending", "merged",
]);

export function isWatchedState(entry: WorkerEntry): boolean {
  const state = entry.prState ?? "working";
  if (WATCHED_PR_STATES.has(state)) return true;
  // A Stop hook saw commits ahead of base but the review-launch poke never
  // arrived — the one stranding class that lives in the working state.
  return state === "working" && entry.pendingReviewAt !== undefined;
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

// Respawn pollers for projects that hold workers but whose poller window is
// gone. A poller window dies cleanly only through stopProjectPoller, which
// logs "stopped" and fires only when a project's last worker is removed. Any
// other disappearance — collateral from a worker-kill/worktree-cleanup, a tmux
// pane lost, an OS signal — leaves no log and no recovery: the watchdog's poke
// (duty 1) writes to a FIFO with no reader. Respawning is self-damping: once
// the window is back, isPollerRunning returns true and later ticks no-op. The
// poller/runner callbacks are injected so this module never statically imports
// poller.ts, which would close the cycle poller.ts -> watchdog.ts ->
// poller.ts. Returns the names of the projects respawned this cycle.
export function respawnDeadPollers(
  isPollerRunning: (project: string) => boolean,
  startPoller: (project: string) => void,
): string[] {
  const registry = readRegistry();
  const respawned: string[] = [];
  for (const [project, entries] of Object.entries(registry.workers)) {
    if (entries.length === 0 || isPollerRunning(project)) continue;
    try {
      startPoller(project);
    } catch (err) {
      // Isolate per project: one project's spawn failure must not abort the
      // cycle and skip the staleness sweep (tick) for every other project.
      log.warn("watchdog", "failed to respawn dead poller", {
        data: { project, error: String(err) },
      });
      continue;
    }
    respawned.push(project);
    log.warn("watchdog", "respawned dead poller", {
      data: { project, workers: entries.length },
    });
  }
  return respawned;
}

export async function runWatchdogLoop(): Promise<void> {
  log.info("watchdog", "started");
  // Imported dynamically to avoid a static cycle (poller.ts statically imports
  // this module for start/stopWatchdog). Resolved once; stable for the loop's
  // lifetime. The runner is read from this process's own argv via
  // resolveGardenRunner, so respawned pollers bake the same canonical garden
  // path the watchdog window itself was spawned with.
  const { resolveGardenRunner } = await import("./runner.js");
  const { projectPollerRunning, startProjectPoller } = await import("./poller.js");
  const gardenRunner = resolveGardenRunner();
  // Damping state lives in the loop closure: it persists across ticks and
  // resets on window respawn, which is fine — a respawn is itself a restart
  // event and one extra poke is harmless.
  const lastPokeAt = new Map<string, number>();
  while (true) {
    try {
      // Respawn before poking so a just-revived poller receives this cycle's
      // staleness poke (and resumes work) without waiting another tick.
      respawnDeadPollers(
        projectPollerRunning,
        (project) => startProjectPoller(project, gardenRunner),
      );
      tick(lastPokeAt, Date.now());
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
  tmux("new-window", "-d", "-t", DASHBOARD_SESSION, "-n", window,
    "bash", "-c", `${gardenRunner} dashboard _watchdog-loop 2>/dev/null`);
  log.info("watchdog", "spawned window", { data: { window } });
}

export function stopWatchdog(): void {
  killWindowSafe(watchdogWindowName());
}

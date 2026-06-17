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
// 2. Keep each project's poller window healthy: respawn it if it died and
// collapse duplicates to one if a spawn race left several (see
// healProjectPollers). A poke is useless if no poller is reading the FIFO: a
// poller window can vanish uncleanly and, once gone, is otherwise only revived
// by a dashboard re-attach (validate) or a worker-create (ensureProjectPoller).
// If the session stays attached and no new worker is created, the project's
// whole review/merge pipeline stalls silently. The watchdog closes that gap so
// a dead — or accidentally duplicated — poller self-heals within one tick.
//
// Runs in a single hidden tmux window (_garden-watchdog), mirroring the usage
// poller's lifecycle: the window being killed (reset or exit) is the
// termination signal — no signal file, no FIFO. Unlike the usage poller it
// starts unconditionally; provider-only fleets still need liveness.
import { tmux, windowExists, killWindowSafe } from "./tmux.js";
import { DASHBOARD_SESSION } from "../session.js";
import { watchdogWindowName } from "./window-names.js";
import { readRegistry, PR_STATE_KIND, type WorkerEntry } from "./registry.js";
import { triggerProjectPoll } from "./poller-fifo.js";
import { log } from "./log.js";

export const WATCHDOG_TICK_MS = 60_000;
export const WATCHDOG_THRESHOLD_MS = 5 * 60_000;

// States the watchdog watches: those where the poller owes the worker a future
// action (PR_STATE_KIND.pollerOwed), plus the one stranding class that lives in
// the working state. The pollerOwed classification is the single source of
// truth in registry.ts; quiescent states (idle working, failing, done) park
// legitimately on an event of their own, so they are never watched.
export function isWatchedState(entry: WorkerEntry): boolean {
  const state = entry.prState ?? "working";
  if (PR_STATE_KIND[state].pollerOwed) return true;
  // A Stop hook saw commits ahead of base but the review-launch poke never
  // arrived — the one stranding class that lives in the working state.
  return state === "working" && entry.pendingReviewAt !== undefined;
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

// Ensure every project that holds workers has exactly one live poller window.
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
  const ensured: string[] = [];
  for (const [project, entries] of Object.entries(registry.workers)) {
    if (entries.length === 0) continue;
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

export async function runWatchdogLoop(): Promise<void> {
  log.info("watchdog", "started");
  // Imported dynamically to avoid a static cycle (poller.ts statically imports
  // this module for start/stopWatchdog). Resolved once; stable for the loop's
  // lifetime. The runner is read from this process's own argv via
  // resolveGardenRunner, so respawned pollers bake the same canonical garden
  // path the watchdog window itself was spawned with.
  const { resolveGardenRunner } = await import("./runner.js");
  const { startProjectPoller } = await import("./poller.js");
  const gardenRunner = resolveGardenRunner();
  // Damping state lives in the loop closure: it persists across ticks and
  // resets on window respawn, which is fine — a respawn is itself a restart
  // event and one extra poke is harmless.
  const lastPokeAt = new Map<string, number>();
  while (true) {
    try {
      // Heal pollers before poking so a just-revived poller receives this
      // cycle's staleness poke (and resumes work) without waiting another tick.
      healProjectPollers(
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

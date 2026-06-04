// Liveness watchdog: a slow recurring tick that re-pokes projects holding
// workers stranded in active states. The state machine is event-driven
// (docs/STATUS.md invariant 6) and a dropped one-shot event — a poke lost in
// the poller kill→spawn gap, a detached-bash delayed poke killed by reboot, a
// review-launch poke that never landed — would otherwise strand a worker
// until the operator diagnosed it. The watchdog bounds that blast radius: it
// delivers only the ordinary FIFO poke the lost event would have sent, never
// transitions state itself, and goes quiescent when no worker is mid-pipeline.
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

export async function runWatchdogLoop(): Promise<void> {
  log.info("watchdog", "started");
  // Damping state lives in the loop closure: it persists across ticks and
  // resets on window respawn, which is fine — a respawn is itself a restart
  // event and one extra poke is harmless.
  const lastPokeAt = new Map<string, number>();
  while (true) {
    try {
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

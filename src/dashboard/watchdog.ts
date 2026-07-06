// Liveness watchdog: a slow recurring tick with three duties, none of which
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
// 3. Alert on orphaned worker windows: a live tmux worker window with no
// registry entry (see alertOrphanedWindows). The create/sweep race could
// delete a worker's entry mid-bootstrap, leaving a running but invisible pane
// that no poller reviews. Detection only — the watchdog never reconstructs an
// entry; it makes the casualty visible so the operator can recover it.
//
// Runs in a single hidden tmux window (_garden-watchdog), mirroring the usage
// poller's lifecycle: the window being killed (reset or exit) is the
// termination signal — no signal file, no FIFO. Unlike the usage poller it
// starts unconditionally; provider-only fleets still need liveness.
import { newDashboardWindow, windowExists, killWindowSafe, listAllWindowNames } from "./tmux.js";
import { watchdogWindowName, parseWorkerWindow } from "./window-names.js";
import { readRegistry, mutateRegistry, PR_STATE_KIND, OPERATOR_ACTION_FAILING_REASONS, type WorkerEntry, type WorkerRegistry } from "./registry.js";
import { triggerProjectPoll } from "./poller-fifo.js";
import { addAlert } from "./alerts.js";
import { log } from "./log.js";

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
  const { refreshStatusElapsed } = await import("./header.js");
  const gardenRunner = resolveGardenRunner();
  // Damping state lives in the loop closure: it persists across ticks and
  // resets on window respawn, which is fine — a respawn is itself a restart
  // event and one extra poke is harmless.
  const lastPokeAt = new Map<string, number>();
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
      alertOrphanedWindows(readRegistry());
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

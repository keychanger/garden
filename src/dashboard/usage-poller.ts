// Background process that refreshes the Claude usage snapshot on a cadence.
// Runs in a single hidden tmux window (_garden-usage-poller). The /api/oauth/usage
// endpoint is strictly rate-limited so the poll cadence stays deliberately slow
// (5 min on success) and honors server Retry-After on 429s.
import { tmux, windowExists, killWindowSafe } from "./tmux.js";
import { DASHBOARD_SESSION } from "../session.js";
import { usagePollerWindowName } from "./window-names.js";
import { refreshUsage } from "./usage.js";
import { refreshDashboard } from "./header.js";
import { log } from "./log.js";

const POLL_OK_MS = 5 * 60 * 1000;    // 5 min on success
const POLL_ERR_MS = 10 * 60 * 1000;  // 10 min on non-429 errors
const POLL_MIN_MS = 60 * 1000;       // floor for any computed interval

export async function runUsagePollerLoop(): Promise<void> {
  log.info("usage-poller", "started");
  while (true) {
    const snap = await refreshUsage();
    // refreshDashboard() rewrites the pre-baked status file (so the SIGUSR1
    // trap path picks up new usage bars) and then signals the pane. A plain
    // refreshStatusPane() would only re-display the stale pre-baked content.
    try { refreshDashboard(); } catch { /* status pane gone or tmux unavailable */ }
    const nextMs = decideNextIntervalMs(snap);
    log.debug("usage-poller", "sleep", { data: { ms: nextMs } });
    await sleep(nextMs);
  }
}

function decideNextIntervalMs(snap: { error?: string; retryAfterMs?: number }): number {
  if (!snap.error) return POLL_OK_MS;
  if (snap.retryAfterMs && snap.retryAfterMs > 0) {
    return Math.max(POLL_MIN_MS, snap.retryAfterMs + 1000);
  }
  return POLL_ERR_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// -----------------------------------------------------------------------------
// tmux window lifecycle
// -----------------------------------------------------------------------------

export function startUsagePoller(gardenRunner: string): void {
  const window = usagePollerWindowName();
  if (windowExists(window)) return;
  // Single long-running process. The tmux window being killed (reset or exit)
  // is the termination signal — no signal file, no FIFO.
  tmux("new-window", "-d", "-t", DASHBOARD_SESSION, "-n", window,
    "bash", "-c", `${gardenRunner} dashboard _usage-poll-loop 2>/dev/null`);
  log.info("usage-poller", "spawned window", { data: { window } });
}

export function stopUsagePoller(): void {
  killWindowSafe(usagePollerWindowName());
}


// Background process that refreshes the Claude usage snapshot on a cadence.
// Runs in a single hidden tmux window (_garden-usage-poller). The /api/oauth/usage
// endpoint is strictly rate-limited so the poll cadence stays deliberately slow
// (5 min on success) and honors server Retry-After on 429s. Cadence comes from
// usage.ts:decideRefresh — same rule the Stop-hook opportunistic refresh uses,
// so neither path can outpace the other.
import { tmux, windowExists, killWindowSafe } from "./tmux.js";
import { DASHBOARD_SESSION } from "../session.js";
import { usagePollerWindowName } from "./window-names.js";
import { decideRefresh, readUsageSnapshot, refreshUsage } from "./usage.js";
import { refreshDashboard } from "./header.js";
import { anyAnthropicMeteredProject } from "../config.js";
import { log } from "./log.js";

export async function runUsagePollerLoop(): Promise<void> {
  log.info("usage-poller", "started");
  while (true) {
    await refreshUsage();
    // refreshDashboard() rewrites the pre-baked status file (so the SIGUSR1
    // trap path picks up new usage bars) and then signals the pane. A plain
    // refreshStatusPane() would only re-display the stale pre-baked content.
    try { refreshDashboard(); } catch { /* status pane gone or tmux unavailable */ }
    // Re-read so the sleep is computed against the snapshot we (or a sibling)
    // actually wrote, not the pre-fetch state. decideRefresh's nextAttemptInMs
    // already floors at POLL_MIN_MS.
    const decision = decideRefresh(readUsageSnapshot(), Date.now(), "poller");
    log.debug("usage-poller", "sleep", { data: { ms: decision.nextAttemptInMs } });
    await sleep(decision.nextAttemptInMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// -----------------------------------------------------------------------------
// tmux window lifecycle
// -----------------------------------------------------------------------------

export function startUsagePoller(gardenRunner: string): void {
  // A provider-only fleet has nothing for the OAuth usage meter to measure;
  // spawning the poller would just 401 against api.anthropic.com every
  // backoff window. The pane renders an explicit "off" line instead
  // (renderUsagePane), so the absence is visible rather than mysterious.
  // Same defensive try/catch as the render/hook gate sites: a config read
  // failure keeps the meter on rather than killing the caller.
  try {
    if (!anyAnthropicMeteredProject()) {
      log.info("usage-poller", "skipped: every project uses a provider; no Anthropic meter to poll");
      return;
    }
  } catch { /* config unavailable: keep the poller */ }
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

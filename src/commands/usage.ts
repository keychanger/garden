// Manual usage-meter inspection and force-refresh.
import {
  formatDuration,
  formatExtraUsageCredits,
  readUsageSnapshot,
  refreshUsage,
  type UsageSnapshot,
} from "../dashboard/usage.js";
import { refreshDashboard } from "../dashboard/header.js";
import { anyAnthropicMeteredProject } from "../config.js";
import { output } from "../output.js";

export async function usage(args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || sub === "show") return showUsage();
  if (sub === "refresh") return refreshAndShow();
  throw new Error(`Unknown subcommand: ${sub}. Usage: garden usage [refresh]`);
}

// Same gate as the dashboard pane and the background poller: a
// provider-only fleet has no Anthropic meter, so showing a stale snapshot
// or fetching with the personal OAuth credential would mislead.
function meteredOrExplain(): boolean {
  let metered = true;
  try { metered = anyAnthropicMeteredProject(); } catch { /* config unavailable: keep meter */ }
  if (!metered) {
    output({ metered: false }, () => "usage meter off — every project uses a provider");
  }
  return metered;
}

function showUsage(): void {
  if (!meteredOrExplain()) return;
  const snap = readUsageSnapshot();
  output(snap, renderPretty);
}

async function refreshAndShow(): Promise<void> {
  // Codex first, and OUTSIDE meteredOrExplain: the Codex meter is a separate
  // quota pool, so a provider-only fleet (no Anthropic meter) still has one to
  // refresh. Ungated by staleness — unlike the ambient watchdog/hook callers,
  // this is the operator explicitly asking, which is worth one probe. Without
  // it `garden usage refresh` left the Codex column showing whatever the last
  // Codex run happened to report, with no way to move it.
  try {
    const { codexInFleet, probeCodexUsage } = await import("../dashboard/codex-usage.js");
    if (codexInFleet()) probeCodexUsage();
  } catch { /* best effort — never block the Claude half */ }
  if (!meteredOrExplain()) {
    try { refreshDashboard(); } catch { /* no dashboard running or pane gone */ }
    return;
  }
  // Explicit operator command: force past the auth/error backoff so a refresh
  // right after `garden login` re-hits the API instead of echoing a stale error.
  const snap = await refreshUsage(true);
  try { refreshDashboard(); } catch { /* no dashboard running or pane gone */ }
  output(snap, renderPretty);
}

function renderPretty(data: unknown): string {
  const snap = data as UsageSnapshot | null;
  if (!snap) return "No usage snapshot yet. Run 'garden usage refresh'.";
  const ageMs = Date.now() - Date.parse(snap.fetchedAt);
  const ageText = Number.isFinite(ageMs)
    ? `fetched ${formatAge(ageMs)}`
    : `fetched ${snap.fetchedAt}`;

  if (snap.error) {
    const lines = [`⚠ ${snap.error} (${ageText})`];
    if (snap.retryAfterMs) {
      lines.push(`  poller will retry ${formatDuration(snap.retryAfterMs - ageMs)}`);
    }
    if (snap.error === "login expired") {
      lines.push(`  run 'garden login' then 'garden usage refresh'`);
    }
    return lines.join("\n");
  }

  const d = snap.data ?? {};
  const rows = [
    `5h      ${meterRow(d.fiveHour)}`,
    `week    ${meterRow(d.weekly)}`,
  ];
  for (const s of d.scoped ?? []) {
    rows.push(`${s.label.toLowerCase().slice(0, 6).padEnd(6)}  ${meterRow(s)}`);
  }
  if (d.extraUsage) rows.push(`extra   ${formatExtraUsageCredits(d.extraUsage)}`);
  // A scoped (Fable) fetch failure doesn't freeze the primary bars — note it so
  // a held-value scoped bar is explained rather than looking silently stuck.
  if (snap.scopedError) {
    const label = d.scoped?.[0]?.label ?? "scoped";
    rows.push(`  ⚠ ${label} meter ${snap.scopedError} — bar holds last value`);
  }
  rows.push(``, ageText);
  return rows.join("\n");
}

function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return "just now";
  const totalMin = Math.floor(ms / 60000);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days}d ${hours}h ago`;
  if (hours > 0) return `${hours}h ${mins}m ago`;
  return `${mins}m ago`;
}

function meterRow(m: { pct: number; resetsAt?: string } | undefined): string {
  if (!m) return "—";
  const pct = `${String(Math.round(m.pct)).padStart(3)}%`;
  // A scoped window that hasn't opened yet has no reset to count down to.
  if (!m.resetsAt) return pct;
  const ms = Date.parse(m.resetsAt) - Date.now();
  return `${pct}   resets ${formatDuration(ms)}`;
}

// Manual usage-meter inspection and force-refresh.
import {
  formatDuration,
  readUsageSnapshot,
  refreshUsage,
  type UsageSnapshot,
} from "../dashboard/usage.js";
import { refreshDashboard } from "../dashboard/header.js";
import { output } from "../output.js";

export async function usage(args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || sub === "show") return showUsage();
  if (sub === "refresh") return refreshAndShow();
  throw new Error(`Unknown subcommand: ${sub}. Usage: garden usage [refresh]`);
}

function showUsage(): void {
  const snap = readUsageSnapshot();
  output(snap, renderPretty);
}

async function refreshAndShow(): Promise<void> {
  const snap = await refreshUsage();
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
    `sonnet  ${meterRow(d.sonnet)}`,
    ``,
    ageText,
  ];
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

function meterRow(m: { pct: number; resetsAt: string } | undefined): string {
  if (!m) return "—";
  const ms = Date.parse(m.resetsAt) - Date.now();
  return `${String(Math.round(m.pct)).padStart(3)}%   resets ${formatDuration(ms)}`;
}

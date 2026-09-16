// Manual usage-meter inspection and force-refresh, for both quota pools: the
// Claude account and, when Codex has ever reported usage, the Codex account.
import {
  codexWindowLabel,
  formatDuration,
  formatExtraUsageCredits,
  readUsageSnapshot,
  refreshUsage,
  type UsageSnapshot,
} from "../dashboard/usage.js";
import { refreshDashboard } from "../dashboard/header.js";
import {
  codexInFleet,
  probeCodexUsage,
  readCodexUsage,
  type CodexUsageSnapshot,
} from "../dashboard/codex-usage.js";
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
function anthropicMetered(): boolean {
  try { return anyAnthropicMeteredProject(); } catch { return true; /* config unavailable: keep meter */ }
}

// The Codex pool rides as an additive `codex` key beside the Claude snapshot's
// own fields, so a piped consumer of those fields sees the shape it always did.
function emit(claude: UsageSnapshot | null | "unmetered", codex: CodexUsageSnapshot | null): void {
  const claudeJson = claude === "unmetered" ? { metered: false } : claude;
  const json = codex ? { ...(claudeJson ?? {}), codex } : claudeJson;
  const claudeText = claude === "unmetered"
    ? "usage meter off — every project uses a provider"
    : renderPretty(claude);
  output(json, () => codex
    ? [`claude`, claudeText, ``, `codex`, renderCodex(codex)].join("\n")
    : claudeText);
}

function showUsage(): void {
  emit(anthropicMetered() ? readUsageSnapshot() : "unmetered", readCodexUsage());
}

async function refreshAndShow(): Promise<void> {
  // Codex first, and outside the Anthropic gate: the Codex meter is a separate
  // quota pool, so a provider-only fleet still has one to refresh. Ungated by
  // staleness — unlike the ambient watchdog/hook callers, this is the operator
  // explicitly asking, which is worth one probe.
  try {
    if (codexInFleet()) probeCodexUsage();
  } catch { /* best effort — never block the Claude half */ }
  // Explicit operator command: force past the auth/error backoff so a refresh
  // right after `garden login` re-hits the API instead of echoing a stale error.
  const claude = anthropicMetered() ? await refreshUsage(true) : "unmetered";
  try { refreshDashboard(); } catch { /* no dashboard running or pane gone */ }
  emit(claude, readCodexUsage());
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

// Mirrors the dashboard's Codex column: one row per window, "—" once a window
// has rolled over since capture (the percentage describes the previous one),
// and a credits row only when there is a balance worth watching.
function renderCodex(snap: CodexUsageSnapshot): string {
  const rows: string[] = [];
  for (const w of snap.data.windows) {
    const label = codexWindowLabel(w.windowMinutes).padEnd(6);
    const resetsAtMs = w.resetsAt * 1000;
    if (resetsAtMs <= Date.now()) {
      rows.push(`${label}  —`);
      continue;
    }
    const pct = `${String(Math.round(w.usedPercent)).padStart(3)}%`;
    rows.push(`${label}  ${pct}   resets ${formatDuration(resetsAtMs - Date.now())}`);
  }
  if (typeof snap.data.creditBalance === "number" && snap.data.creditBalance > 0) {
    rows.push(`credits $${snap.data.creditBalance.toFixed(2)}`);
  } else if (snap.data.creditsUnlimited) {
    rows.push(`credits unlimited`);
  }
  rows.push(``, `fetched ${formatAge(Date.now() - snap.capturedAt)}`);
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

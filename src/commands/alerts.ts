// Command: garden alerts — view and manage dashboard alerts. Splits alerts into
// unread (added since the last ⌥l acknowledgement) and read, with honest
// level glyphs and relative timestamps.
import { readAlerts, clearAlerts, type Alert } from "../dashboard/alerts.js";
import { output, isTTY } from "../output.js";

export async function alerts(args: string[]): Promise<void> {
  if (args[0] === "clear") {
    clearAlerts();
    console.log("Alerts cleared.");
    return;
  }

  const store = readAlerts();

  if (!isTTY) {
    output({ alerts: store.alerts, lastSeenAt: store.lastSeenAt });
    return;
  }

  if (store.alerts.length === 0) {
    console.log("No alerts.");
    return;
  }

  const seen = store.lastSeenAt ? Date.parse(store.lastSeenAt) : 0;
  const now = Date.now();
  const unread = store.alerts.filter(a => Date.parse(a.ts) > seen);
  const read = store.alerts.filter(a => Date.parse(a.ts) <= seen);

  console.log("");
  if (unread.length > 0) {
    console.log(`  \x1b[1munread (${unread.length})\x1b[0m`);
    for (const a of unread) console.log(formatAlertRow(a, now, false));
    console.log("");
  }
  if (read.length > 0) {
    console.log(`  \x1b[2mread (${read.length})\x1b[0m`);
    for (const a of read) console.log(formatAlertRow(a, now, true));
    console.log("");
  }
  console.log("  \x1b[2m⌥l in the dashboard marks alerts read; 'garden alerts clear' removes them\x1b[0m");
  console.log("");
}

function formatAlertRow(a: Alert, now: number, read: boolean): string {
  const ago = formatAgo(now - Date.parse(a.ts)).padStart(4);
  const loc = a.worker ? `${a.project}/${a.worker}` : a.project;
  if (read) {
    // Fully dimmed — the level is still legible from the glyph, but read alerts
    // recede so the unread block draws the eye.
    const glyph = a.level === "error" ? "✖" : "⚠";
    return `    \x1b[90m${glyph} ${ago}  ${loc}  ${a.message}\x1b[0m`;
  }
  // Unread: colored glyph by level (heavy-x for error, warning sign for warn),
  // dim relative age, bold location.
  const glyph = a.level === "error" ? "\x1b[1;31m✖\x1b[0m" : "\x1b[1;33m⚠\x1b[0m";
  return `    ${glyph} \x1b[2m${ago}\x1b[0m  \x1b[1m${loc}\x1b[0m  ${a.message}`;
}

// Compact relative age: seconds under a minute, then minutes/hours/days. Bounded
// so the column stays narrow (the alert list is a scan, not a precise clock).
function formatAgo(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

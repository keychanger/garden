// Command: garden alerts — view and manage dashboard alerts. Splits alerts into
// unread (added since the last ⌥a acknowledgement) and read, with honest
// level glyphs and relative timestamps. renderAlertsPane serves the dashboard's
// ⌥a view from the same data and formatter (the status-pane precedent:
// renderQuickStatus in status.ts).
import { readAlerts, clearAlerts, type Alert } from "../dashboard/alerts.js";
import { output, isTTY } from "../output.js";
import { wrapDetail } from "./logs.js";

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

  const now = Date.now();
  const { unread, read } = splitBySeen(store.alerts, store.lastSeenAt ?? null);

  console.log("");
  // Oldest first, read before unread: time runs down the screen, so the newest
  // alert is the last thing printed and stays on screen when the list overflows.
  if (read.length > 0) {
    console.log(`  \x1b[2mread (${read.length})\x1b[0m`);
    for (const a of read) console.log(formatAlertRow(a, now, true));
    console.log("");
  }
  if (unread.length > 0) {
    console.log(`  \x1b[1munread (${unread.length})\x1b[0m`);
    for (const a of unread) console.log(formatAlertRow(a, now, false));
    console.log("");
  }
  console.log("  \x1b[2m⌥a in the dashboard marks alerts read; 'garden alerts clear' removes them\x1b[0m");
  console.log("");
}

// An alert is unread when it landed after the seen-mark. Shared so the CLI and
// the ⌥a pane can't drift on where the line falls.
function splitBySeen(all: Alert[], seenAt: string | null): { unread: Alert[]; read: Alert[] } {
  const seen = seenAt ? Date.parse(seenAt) : 0;
  return {
    unread: all.filter(a => Date.parse(a.ts) > seen),
    read: all.filter(a => Date.parse(a.ts) <= seen),
  };
}

// The ⌥a view. Same split and glyph vocabulary as the CLI, but laid out for the
// narrow lower-left pane: each alert is a location header line plus its message
// wrapped underneath (condensed to prose first — see condenseMessage), rather
// than the CLI's wide single-line row. The pane prints every alert and lets tmux
// hold the overflow in scrollback — the render
// prints from the top, so an overflowing list scrolls the oldest alerts off the
// top and leaves the newest on screen. That only reads correctly in
// chronological order, so sections run read-then-unread and each section runs
// oldest-first: the newest alert is the last line printed.
export function renderAlertsPane(width: number, seenAt: string | null, now: number): string {
  const store = readAlerts();
  if (store.alerts.length === 0) return " \x1b[2mno alerts\x1b[0m";

  const { unread, read } = splitBySeen(store.alerts, seenAt);
  const lines: string[] = [];
  const section = (label: string, group: Alert[], dim: boolean) => {
    if (group.length === 0) return;
    if (lines.length > 0) lines.push("");
    const style = dim ? "\x1b[2m" : "\x1b[1m";
    lines.push(` ${style}${label} (${group.length})\x1b[0m`);
    for (const a of group) lines.push(...formatPaneRows(a, now, dim, width));
  };
  section("read", read, true);
  section("unread", unread, false);
  return lines.join("\n");
}

// Message column starts under the glyph+age gutter (" ✖ 12m  " = 8 cols).
const PANE_GUTTER = 8;
const PANE_MAX_MESSAGE_LINES = 3;

// Alert messages are not authored for display: they embed raw git stderr
// (multi-line, "Aborting\nUpdating …") and raw agent markdown (the reviewer
// alert splices in 300 chars of a model's reply, headings and bold markers
// intact). wrapDetail measures columns but does not touch newlines, so those
// embedded breaks escaped the gutter and rendered at column 0, and the markdown
// syntax read as litter. Flatten to a single prose line here, at the display
// layer — the store and `garden logs` keep the message verbatim.
export function condenseMessage(message: string): string {
  return message
    .replace(/```[\s\S]*?```/g, " ")     // fenced code blocks carry no gist
    .replace(/^\s*#{1,6}\s+/gm, "")      // markdown headings
    .replace(/\*\*|__|`/g, "")           // bold/code emphasis markers
    .replace(/^\s*[-*]\s+/gm, "· ")      // list bullets survive as a mid-line marker
    .replace(/\s+/g, " ")                // every remaining break becomes a space
    .trim();
}

function formatPaneRows(a: Alert, now: number, read: boolean, width: number): string[] {
  const ago = formatAgo(now - Date.parse(a.ts)).padStart(3);
  const loc = a.worker ? `${a.project}/${a.worker}` : a.project;
  const glyph = a.level === "error" ? "✖" : "⚠";
  // Read alerts recede in the gutter only. The message is the whole reason the
  // operator opened the view — greying it out made an already-noisy pane harder
  // to skim, and the section header plus the dim gutter already say "seen".
  const head = read
    ? ` \x1b[2m${glyph} ${ago}  ${loc}\x1b[0m`
    : ` ${a.level === "error" ? "\x1b[1;31m" : "\x1b[1;33m"}${glyph}\x1b[0m \x1b[2m${ago}\x1b[0m  \x1b[1m${loc}\x1b[0m`;

  const textWidth = Math.max(10, width - PANE_GUTTER - 1);
  const body = wrapDetail(condenseMessage(a.message), textWidth, textWidth, PANE_MAX_MESSAGE_LINES)
    .map(line => `${" ".repeat(PANE_GUTTER)}${line}`);
  return [head, ...body];
}

function formatAlertRow(a: Alert, now: number, read: boolean): string {
  const ago = formatAgo(now - Date.parse(a.ts)).padStart(4);
  const loc = a.worker ? `${a.project}/${a.worker}` : a.project;
  // Single-line row, so an un-condensed message would break the row apart at
  // its own newlines — same reason as the pane.
  const message = condenseMessage(a.message);
  if (read) {
    const glyph = a.level === "error" ? "✖" : "⚠";
    return `    \x1b[2m${glyph} ${ago}  ${loc}\x1b[0m  ${message}`;
  }
  // Unread: colored glyph by level (heavy-x for error, warning sign for warn),
  // dim relative age, bold location.
  const glyph = a.level === "error" ? "\x1b[1;31m✖\x1b[0m" : "\x1b[1;33m⚠\x1b[0m";
  return `    ${glyph} \x1b[2m${ago}\x1b[0m  \x1b[1m${loc}\x1b[0m  ${message}`;
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

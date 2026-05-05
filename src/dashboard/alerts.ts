// Dashboard alerts: persistent alerts for operator-visible events.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SESSIONS_DIR } from "../config.js";
import { DASHBOARD_SESSION } from "../session.js";
import { tmux } from "./tmux.js";
import { atomicWriteFile } from "./atomic-write.js";
import { log } from "./log.js";
import { GARDEN_VERSION } from "../version.js";

export interface Alert {
  id: string;
  ts: string;
  level: "warn" | "error";
  source: string;
  project: string;
  worker?: string;
  message: string;
  /** Key used when this alert was added; future addAlert calls with the
   *  same dedup key within ALERT_DEDUP_WINDOW_MS are silently suppressed.
   *  Optional only for backward compatibility with alerts persisted by
   *  pre-dedup builds — readers must tolerate undefined. */
  dedupKey?: string;
}

interface AlertStore {
  alerts: Alert[];
  lastSeenAt?: string;
}

const MAX_ALERTS = 100;

// Dedup window for repeating alerts. A merge that fails the same way every
// poll cycle (e.g., postMerge command broken) would otherwise spam the
// right-bar badge faster than the operator can read. Within this window an
// alert with the same dedup key is silently suppressed; past the window the
// next firing persists. One hour balances "operator gets reminded if a
// problem genuinely persists" against "stuck poller doesn't scroll twelve
// alerts off the screen per minute."
const ALERT_DEDUP_WINDOW_MS = 60 * 60 * 1000;

// Truncation length for the default dedup key. Many of garden's alert
// messages embed time-varying detail (commit SHA, error string, file list)
// past the first ~150 chars; truncating absorbs that variation when the
// caller hasn't supplied an explicit dedupKey. Callers with predictably
// stable prefixes can rely on this; callers with volatile content right at
// the start (rare) should pass an explicit dedupKey instead.
const DEDUP_MESSAGE_PREFIX_LEN = 200;

export const ALERTS_FILE = path.join(SESSIONS_DIR, "dashboard.alerts.json");

export function readAlerts(): AlertStore {
  try {
    if (fs.existsSync(ALERTS_FILE)) {
      return JSON.parse(fs.readFileSync(ALERTS_FILE, "utf-8"));
    }
  } catch {
    // corrupt or missing — start fresh
  }
  return { alerts: [] };
}

function writeAlerts(store: AlertStore): void {
  atomicWriteFile(ALERTS_FILE, JSON.stringify(store, null, 2));
}

export interface AddAlertInput extends Omit<Alert, "id" | "ts"> {
  /** Stable identifier for dedup. If omitted, falls back to a default key
   *  built from {level, source, project, worker, message[:200]}. Use an
   *  explicit key when the message contains volatile detail (commit SHA,
   *  error text, file list) that would defeat the default truncation. */
  dedupKey?: string;
}

function defaultDedupKey(fields: Omit<Alert, "id" | "ts">): string {
  return [
    fields.level,
    fields.source,
    fields.project,
    fields.worker ?? "",
    fields.message.slice(0, DEDUP_MESSAGE_PREFIX_LEN),
  ].join("\x00");
}

function findRecentByDedupKey(store: AlertStore, key: string, now: number): Alert | undefined {
  const cutoff = now - ALERT_DEDUP_WINDOW_MS;
  // Walk newest-first: we only care about whether ANY recent alert matches,
  // and the array is append-ordered so the tail is the most recent.
  for (let i = store.alerts.length - 1; i >= 0; i--) {
    const a = store.alerts[i];
    if (Date.parse(a.ts) < cutoff) break;
    // Pre-dedup alerts (or alerts written without an explicit dedupKey) have
    // an undefined `dedupKey`, in which case the equivalence is the default
    // key form. This keeps suppression working across the upgrade boundary
    // and across calls that mix explicit/default keys for the same logical
    // alert source.
    const stored = a.dedupKey ?? defaultDedupKey(a);
    if (stored === key) return a;
  }
  return undefined;
}

export function addAlert(fields: AddAlertInput): void {
  const store = readAlerts();
  const now = Date.now();
  const key = fields.dedupKey ?? defaultDedupKey(fields);
  const recent = findRecentByDedupKey(store, key, now);
  if (recent) {
    // Suppress: refresh the badge so the existing alert's visibility is
    // reaffirmed (operator sees N stays steady rather than ticking up), but
    // don't write a new entry or emit a duplicate log line.
    refreshAlertBadge();
    return;
  }

  const alert: Alert = {
    level: fields.level,
    source: fields.source,
    project: fields.project,
    worker: fields.worker,
    message: fields.message,
    dedupKey: key,
    id: crypto.randomUUID(),
    ts: new Date(now).toISOString(),
  };
  store.alerts.push(alert);
  // Cap at MAX_ALERTS, drop oldest
  if (store.alerts.length > MAX_ALERTS) {
    store.alerts = store.alerts.slice(-MAX_ALERTS);
  }
  writeAlerts(store);

  // Emit to dashboard.log so the line streams live into `garden logs --follow`
  // (the _garden-logs pane). Route by the alert's own level so warn alerts
  // are not miscategorized as errors.
  log[fields.level]("alert", fields.message, {
    worker: fields.worker,
    data: { project: fields.project, source: fields.source, level: fields.level },
  });

  refreshAlertBadge();
}

export function clearAlerts(): void {
  writeAlerts({ alerts: [], lastSeenAt: new Date().toISOString() });
  refreshAlertBadge();
}

export function alertCount(): number {
  return readAlerts().alerts.length;
}

export function unreadAlertCount(): number {
  const store = readAlerts();
  if (!store.lastSeenAt) return store.alerts.length;
  return store.alerts.filter(a => a.ts > store.lastSeenAt!).length;
}

// Marks all current alerts as seen. Called exclusively from focusLogs (⌥l).
// Intentionally not auto-triggered by "logs already focused when alert fires" —
// garden often runs autonomously while the user is away, and a silent ack
// would defeat the whole point of the bar badge.
export function acknowledgeAlerts(): void {
  const store = readAlerts();
  store.lastSeenAt = new Date().toISOString();
  writeAlerts(store);
  refreshAlertBadge();
}

// Compose the right-side status bar string. Shared between formatRight() in
// header.ts (called on every dashboard refresh) and refreshAlertBadge() here
// (called on alert write/ack). Keeping the logic in one place keeps the two
// paths in sync.
export function formatRightBar(unread: number): string {
  const version = `garden ${GARDEN_VERSION} `;
  if (unread <= 0) return version;
  const word = unread === 1 ? "alert" : "alerts";
  return `#[bg=red,fg=white,bold] ⚠ ${unread} ${word} — ⌥l to clear #[default] ${version}`;
}

// Set @garden_right and kick the status client so the badge appears/clears
// immediately. Safe to call when tmux isn't running — errors are swallowed.
export function refreshAlertBadge(): void {
  try {
    const right = formatRightBar(unreadAlertCount());
    tmux("set-option", "-t", DASHBOARD_SESSION, "@garden_right", right);
    tmux("refresh-client", "-S");
  } catch {
    // dashboard session not running, or tmux unavailable
  }
}

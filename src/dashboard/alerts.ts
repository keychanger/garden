// Dashboard alerts: persistent alerts for operator-visible events.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SESSIONS_DIR } from "../config.js";
import { DASHBOARD_SESSION } from "../session.js";
import { tmux } from "./tmux.js";
import { atomicWriteFile } from "./atomic-write.js";
import { withFileLock } from "./file-lock.js";
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
const ALERTS_LOCK_FILE = ALERTS_FILE + ".lock";

// Shape guard for parsed alerts. Top-level needs `alerts` as an array;
// each entry must carry the load-bearing string fields (level, source,
// project, message). worker/dedupKey are optional. The unread-count and
// dedup paths read these fields on every addAlert/refresh — silently
// returning an empty store on shape drift is safer than letting an
// undefined field crash the badge code.
function isAlertStore(x: unknown): x is AlertStore {
  if (!x || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  if (!Array.isArray(r.alerts)) return false;
  for (const a of r.alerts) {
    if (!a || typeof a !== "object") return false;
    const entry = a as Record<string, unknown>;
    if (typeof entry.level !== "string") return false;
    if (typeof entry.source !== "string") return false;
    if (typeof entry.project !== "string") return false;
    if (typeof entry.message !== "string") return false;
  }
  return true;
}

export function readAlerts(): AlertStore {
  try {
    if (fs.existsSync(ALERTS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(ALERTS_FILE, "utf-8"));
      if (!isAlertStore(raw)) {
        log.warn("alerts", "alerts file failed shape check, using empty", {
          data: { topLevelKeys: Object.keys(raw ?? {}) },
        });
        return { alerts: [] };
      }
      return raw;
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
  const now = Date.now();
  const key = fields.dedupKey ?? defaultDedupKey(fields);
  // Serialize the read-dedup-append-write cycle: concurrent writers (many
  // pollers and hooks alerting at the same instant — exactly the systemic
  // failure this store exists to record) would otherwise drop each other's
  // alerts through a lost update. Best-effort: on lock-acquisition timeout,
  // drop this one alert rather than throw from a best-effort caller (poller /
  // validate paths that never expect addAlert to throw).
  let created: Alert | null = null;
  try {
    created = withFileLock(ALERTS_LOCK_FILE, () => {
      const store = readAlerts();
      if (findRecentByDedupKey(store, key, now)) {
        return null; // duplicate within the dedup window — suppress
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
      if (store.alerts.length > MAX_ALERTS) {
        store.alerts = store.alerts.slice(-MAX_ALERTS);
      }
      writeAlerts(store);
      return alert;
    }, { name: "alerts" });
  } catch {
    return; // could not acquire the alerts lock — drop rather than throw
  }

  // Side effects outside the lock: refresh the badge (reaffirms visibility even
  // when suppressed, so N stays steady rather than ticking up) and, for a newly
  // written alert, emit to dashboard.log so the line streams live into
  // `garden logs --follow` at the alert's own level.
  refreshAlertBadge();
  if (created) {
    log[created.level]("alert", created.message, {
      worker: created.worker,
      data: { project: created.project, source: created.source, level: created.level },
    });
  }
}

export function clearAlerts(): void {
  withFileLock(ALERTS_LOCK_FILE, () => {
    writeAlerts({ alerts: [], lastSeenAt: new Date().toISOString() });
  }, { name: "alerts" });
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

// Per-project counts of unread alerts (added since the last ⌥l ack), so the
// status pane can badge "⚠n" on each project header. The store is read once;
// the ack (lastSeenAt) is global, so ⌥l clears every project's badge at once
// (a documented limitation — there is no per-project seen-state).
export function unreadAlertCountsByProject(): Map<string, number> {
  const store = readAlerts();
  const since = store.lastSeenAt;
  const counts = new Map<string, number>();
  for (const a of store.alerts) {
    if (since && a.ts <= since) continue;
    counts.set(a.project, (counts.get(a.project) ?? 0) + 1);
  }
  return counts;
}

// Marks all current alerts as seen. Called exclusively from focusLogs (⌥l).
// Intentionally not auto-triggered by "logs already focused when alert fires" —
// garden often runs autonomously while the user is away, and a silent ack
// would defeat the whole point of the bar badge.
export function acknowledgeAlerts(): void {
  withFileLock(ALERTS_LOCK_FILE, () => {
    const store = readAlerts();
    store.lastSeenAt = new Date().toISOString();
    writeAlerts(store);
  }, { name: "alerts" });
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

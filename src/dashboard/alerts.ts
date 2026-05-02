// Dashboard alerts: persistent alerts for operator-visible events.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SESSIONS_DIR } from "../config.js";
import { DASHBOARD_SESSION } from "../session.js";
import { tmux } from "./tmux.js";
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
}

interface AlertStore {
  alerts: Alert[];
  lastSeenAt?: string;
}

const MAX_ALERTS = 100;

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
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const tmpFile = `${ALERTS_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(store, null, 2));
  fs.renameSync(tmpFile, ALERTS_FILE);
}

export function addAlert(
  fields: Omit<Alert, "id" | "ts">,
): void {
  const store = readAlerts();
  const alert: Alert = {
    ...fields,
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
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

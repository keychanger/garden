// Dashboard alerts: persistent alerts for operator-visible events.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SESSIONS_DIR } from "../config.js";

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
  const tmpFile = ALERTS_FILE + ".tmp";
  fs.writeFileSync(tmpFile, JSON.stringify(store, null, 2));
  fs.renameSync(tmpFile, ALERTS_FILE);
}

export function addAlert(
  fields: Omit<Alert, "id" | "ts">,
): void {
  const store = readAlerts();
  store.alerts.push({
    ...fields,
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
  });
  // Cap at MAX_ALERTS, drop oldest
  if (store.alerts.length > MAX_ALERTS) {
    store.alerts = store.alerts.slice(-MAX_ALERTS);
  }
  writeAlerts(store);
}

export function clearAlerts(): void {
  writeAlerts({ alerts: [] });
}

export function alertCount(): number {
  return readAlerts().alerts.length;
}

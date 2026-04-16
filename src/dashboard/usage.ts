// Claude usage meter: fetches the authenticated user's 5-hour, weekly, and
// Sonnet-weekly quota from api.anthropic.com using the OAuth token that
// Claude Code writes to the macOS Keychain. Persists a snapshot to
// SESSIONS_DIR and renders a 3-bar header for the dashboard status pane.
//
// The endpoint (/api/oauth/usage) is undocumented and strictly rate-limited
// (observed Retry-After of ~50 minutes after 3 rapid probes). Callers must
// honor retry-after and must never poll faster than every few minutes.
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { SESSIONS_DIR } from "../config.js";
import { log } from "./log.js";

export const USAGE_FILE = path.join(SESSIONS_DIR, "claude-usage.json");

export interface UsageMeter {
  pct: number;
  resetsAt: string; // ISO 8601
}

export interface UsageData {
  fiveHour?: UsageMeter;
  weekly?: UsageMeter;
  sonnet?: UsageMeter;
}

export interface UsageSnapshot {
  fetchedAt: string;       // ISO 8601
  data?: UsageData;        // present on success
  error?: string;          // present on failure; short human-readable
  retryAfterMs?: number;   // set when server returned Retry-After
}

// -----------------------------------------------------------------------------
// Credential discovery
// -----------------------------------------------------------------------------

interface Credential {
  token: string;
  source: "env" | "keychain" | "file";
}

export function loadCredential(): Credential | null {
  const envToken = process.env.GARDEN_CLAUDE_SESSION_KEY;
  if (envToken && envToken.startsWith("sk-ant-")) {
    return { token: envToken, source: "env" };
  }

  if (process.platform === "darwin") {
    try {
      const raw = execFileSync(
        "security",
        ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
      const token = extractAccessToken(raw);
      if (token) return { token, source: "keychain" };
    } catch { /* not present or sandboxed */ }
  }

  const credFile = path.join(os.homedir(), ".claude", ".credentials.json");
  if (fs.existsSync(credFile)) {
    try {
      const token = extractAccessToken(fs.readFileSync(credFile, "utf8"));
      if (token) return { token, source: "file" };
    } catch { /* unreadable or malformed */ }
  }

  return null;
}

function extractAccessToken(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw);
    const t = parsed?.claudeAiOauth?.accessToken;
    return typeof t === "string" && t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// Fetch
// -----------------------------------------------------------------------------

export interface FetchResult {
  status: number;
  body: string;
  retryAfterMs?: number;
}

export function fetchUsageRaw(token: string): Promise<FetchResult> {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: "api.anthropic.com",
      path: "/api/oauth/usage",
      method: "GET",
      headers: {
        "Authorization": `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "garden-dashboard/1.0",
        "Accept": "application/json",
      },
      timeout: 15000,
    }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        const retryHeader = res.headers["retry-after"];
        let retryAfterMs: number | undefined;
        if (typeof retryHeader === "string") {
          const secs = parseInt(retryHeader, 10);
          if (Number.isFinite(secs)) retryAfterMs = secs * 1000;
        }
        resolve({ status: res.statusCode ?? 0, body, retryAfterMs });
      });
    });
    req.on("timeout", () => { req.destroy(new Error("timeout")); });
    req.on("error", reject);
    req.end();
  });
}

// -----------------------------------------------------------------------------
// Normalize
// -----------------------------------------------------------------------------

// Shape of /api/oauth/usage (observed against a Claude Max account):
//   { five_hour:        { utilization, resets_at } | null,
//     seven_day:        { utilization, resets_at } | null,
//     seven_day_sonnet: { utilization, resets_at } | null,
//     seven_day_opus:   { utilization, resets_at } | null,
//     ... other buckets ...
//     extra_usage:      { is_enabled, monthly_limit, used_credits, utilization } | null }
// On Max plans seven_day_opus is typically null (Opus usage is rolled into
// seven_day); seven_day_sonnet is the populated model-specific bucket, so
// that's what the third bar shows. Fields are parsed defensively so any
// shape shift or null bucket degrades to "—" rather than throwing.
export function normalizeUsage(raw: unknown): UsageData {
  const out: UsageData = {};
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  const m = pickMeter(r["five_hour"]);
  if (m) out.fiveHour = m;
  const w = pickMeter(r["seven_day"]);
  if (w) out.weekly = w;
  const s = pickMeter(r["seven_day_sonnet"]);
  if (s) out.sonnet = s;
  return out;
}

function pickMeter(bucket: unknown): UsageMeter | undefined {
  if (!bucket || typeof bucket !== "object") return undefined;
  const b = bucket as Record<string, unknown>;
  const pct = b["utilization"];
  const reset = b["resets_at"];
  if (typeof pct !== "number" || typeof reset !== "string") return undefined;
  return { pct, resetsAt: reset };
}

// -----------------------------------------------------------------------------
// Snapshot persistence
// -----------------------------------------------------------------------------

export function readUsageSnapshot(): UsageSnapshot | null {
  try {
    if (!fs.existsSync(USAGE_FILE)) return null;
    return JSON.parse(fs.readFileSync(USAGE_FILE, "utf8"));
  } catch {
    return null;
  }
}

export function writeUsageSnapshot(snap: UsageSnapshot): void {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const tmp = `${USAGE_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(snap, null, 2));
  fs.renameSync(tmp, USAGE_FILE);
}

// -----------------------------------------------------------------------------
// Fetch-and-store (used by the poller)
// -----------------------------------------------------------------------------

export async function refreshUsage(): Promise<UsageSnapshot> {
  const cred = loadCredential();
  if (!cred) {
    const snap: UsageSnapshot = {
      fetchedAt: new Date().toISOString(),
      error: "no Claude Code credentials found",
    };
    writeUsageSnapshot(snap);
    return snap;
  }

  try {
    const res = await fetchUsageRaw(cred.token);
    const fetchedAt = new Date().toISOString();

    if (res.status === 200) {
      const parsed = JSON.parse(res.body);
      const data = normalizeUsage(parsed);
      const snap: UsageSnapshot = { fetchedAt, data };
      writeUsageSnapshot(snap);
      log.info("usage", "fetched", {
        data: {
          source: cred.source,
          fiveHour: data.fiveHour?.pct,
          weekly: data.weekly?.pct,
          sonnet: data.sonnet?.pct,
        },
      });
      return snap;
    }

    if (res.status === 429) {
      const snap: UsageSnapshot = {
        fetchedAt,
        error: "rate-limited",
        retryAfterMs: res.retryAfterMs,
      };
      writeUsageSnapshot(snap);
      log.warn("usage", "rate-limited", { data: { retryAfterMs: res.retryAfterMs } });
      return snap;
    }

    if (res.status === 401 || res.status === 403) {
      const snap: UsageSnapshot = { fetchedAt, error: "login expired" };
      writeUsageSnapshot(snap);
      log.warn("usage", "auth failed", { data: { status: res.status } });
      return snap;
    }

    const snap: UsageSnapshot = { fetchedAt, error: `http ${res.status}` };
    writeUsageSnapshot(snap);
    log.warn("usage", "unexpected status", { data: { status: res.status, body: res.body.slice(0, 200) } });
    return snap;
  } catch (err) {
    const snap: UsageSnapshot = {
      fetchedAt: new Date().toISOString(),
      error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
    };
    writeUsageSnapshot(snap);
    log.warn("usage", "fetch error", { data: { error: snap.error } });
    return snap;
  }
}

// -----------------------------------------------------------------------------
// Rendering
// -----------------------------------------------------------------------------

const BAR_WIDTH = 24;
const LABEL_WIDTH = 6; // "sonnet" is the longest label
const INDENT = "    ";  // 4-space indent mirrors worker rows in the status pane
const STALE_AFTER_MS = 30 * 60 * 1000; // 30 min — long enough to survive the endpoint's long rate-limit windows

// Leading blank for breathing room under the pane-border label, then three meter rows.
export function renderUsagePane(nowMs: number = Date.now()): string {
  const snap = readUsageSnapshot();
  const lines: string[] = [""];

  if (!snap) {
    lines.push(`${INDENT}${dim("claude usage  loading\u2026")}`);
    return lines.map(l => l + "\x1b[K").join("\n");
  }

  if (snap.error) {
    lines.push(`${INDENT}${dim(`claude usage  ${snap.error}`)}`);
    return lines.map(l => l + "\x1b[K").join("\n");
  }

  const stale = (nowMs - Date.parse(snap.fetchedAt)) > STALE_AFTER_MS;
  const staleTag = stale ? dim(" (stale)") : "";
  const d = snap.data ?? {};

  lines.push(renderMeterLine("5h",     d.fiveHour, nowMs, staleTag, FIVE_HOUR_MS));
  lines.push(renderMeterLine("week",   d.weekly,   nowMs, staleTag, SEVEN_DAY_MS));
  lines.push(renderMeterLine("sonnet", d.sonnet,   nowMs, staleTag, SEVEN_DAY_MS));

  return lines.map(l => l + "\x1b[K").join("\n");
}

const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;

function renderMeterLine(label: string, meter: UsageMeter | undefined, nowMs: number, suffix: string, windowMs?: number): string {
  const paddedLabel = label.padEnd(LABEL_WIDTH);
  if (!meter) return `${INDENT}${paddedLabel}  ${dim("\u2014")}${suffix}`;
  const pct = Math.max(0, Math.min(100, meter.pct));
  const resetsAt = Date.parse(meter.resetsAt);
  let timePct: number | undefined;
  if (windowMs && Number.isFinite(resetsAt)) {
    const elapsed = windowMs - (resetsAt - nowMs);
    timePct = Math.max(0, Math.min(100, (elapsed / windowMs) * 100));
  }
  const bar = renderBar(pct, timePct);
  const pctText = `${pct.toFixed(0).padStart(3)}%`;
  const resetText = Number.isFinite(resetsAt)
    ? `resets ${formatDuration(resetsAt - nowMs)}`
    : "";
  return `${INDENT}${paddedLabel}  ${bar}  ${pctText}  ${dim(resetText)}${suffix}`;
}

function renderBar(pct: number, markerPct?: number): string {
  const filled = Math.round((pct / 100) * BAR_WIDTH);
  const clamped = Math.max(0, Math.min(BAR_WIDTH, filled));
  const color = colorForPct(pct);
  const fg = "\x1b[" + color + "m";
  const rst = "\x1b[0m";

  if (markerPct == null || !Number.isFinite(markerPct)) {
    return `${fg}${"\u2588".repeat(clamped)}${rst}${dim("\u2591".repeat(BAR_WIDTH - clamped))}`;
  }

  const markerIdx = Math.max(0, Math.min(BAR_WIDTH - 1,
    Math.round((markerPct / 100) * (BAR_WIDTH - 1))));
  const bright = "\x1b[97m";

  // Three segments: before marker, marker, after marker
  const beforeFilled = Math.min(clamped, markerIdx);
  const beforeEmpty = markerIdx - beforeFilled;
  const afterStart = markerIdx + 1;
  const afterFilled = Math.max(0, clamped - afterStart);
  const afterEmpty = BAR_WIDTH - afterStart - afterFilled;

  let result = "";
  if (beforeFilled > 0) result += `${fg}${"\u2588".repeat(beforeFilled)}${rst}`;
  if (beforeEmpty > 0) result += dim("\u2591".repeat(beforeEmpty));
  result += `${bright}\u2502${rst}`;
  if (afterFilled > 0) result += `${fg}${"\u2588".repeat(afterFilled)}${rst}`;
  if (afterEmpty > 0) result += dim("\u2591".repeat(afterEmpty));

  return result;
}

function colorForPct(pct: number): string {
  if (pct < 60) return "32";  // green
  if (pct < 85) return "33";  // yellow
  return "31";                 // red
}

function dim(s: string): string {
  return `\x1b[2m${s}\x1b[0m`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "now";
  const totalMin = Math.floor(ms / 60000);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `in ${days}d ${hours}h`;
  if (hours > 0) return `in ${hours}h ${mins}m`;
  return `in ${mins}m`;
}

// -----------------------------------------------------------------------------
// Event-driven refresh (called from Claude Code hooks)
// -----------------------------------------------------------------------------

// Conservative floor against the endpoint's burst rate-limit.
export const HOOK_REFRESH_COOLDOWN_MS = 60 * 1000;

export function shouldRefreshOnHookWith(
  snap: UsageSnapshot | null,
  nowMs: number,
): boolean {
  if (!snap) return true;
  const age = nowMs - Date.parse(snap.fetchedAt);
  if (!Number.isFinite(age)) return true;
  if (snap.retryAfterMs && age < snap.retryAfterMs) return false;
  return age >= HOOK_REFRESH_COOLDOWN_MS;
}

export function shouldRefreshOnHook(nowMs: number = Date.now()): boolean {
  return shouldRefreshOnHookWith(readUsageSnapshot(), nowMs);
}

// Detached so the 5s hook budget isn't spent waiting on the fetch.
export function maybeRefreshUsage(gardenRunner: string): void {
  if (!shouldRefreshOnHook()) return;
  try {
    spawn("sh", ["-c", `${gardenRunner} dashboard _usage-refresh 2>/dev/null`], {
      detached: true,
      stdio: "ignore",
    }).unref();
  } catch { /* background poller will catch up within 5 minutes */ }
}

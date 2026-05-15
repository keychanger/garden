// Claude usage meter: fetches the authenticated user's 5-hour, weekly, and
// Sonnet-weekly quota from api.anthropic.com using the OAuth token that
// Claude Code writes to the macOS Keychain. Persists a snapshot to
// SESSIONS_DIR and renders a 3-bar header for the dashboard status pane.
//
// The endpoint (/api/oauth/usage) is undocumented and strictly rate-limited
// (observed Retry-After of ~50 minutes after 3 rapid probes; sometimes the
// server returns Retry-After: 0 which is meaningless when the request itself
// was a 429 — we self-floor in that case so we never trust the server to
// pace us safely). Callers must honor retry-after and never poll faster
// than every few minutes.
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { spawn } from "node:child_process";
import { SESSIONS_DIR } from "../config.js";
import { atomicWriteFile } from "./atomic-write.js";
import {
  isAccessTokenExpired,
  persistCredential,
  readPersonalCredential,
  refreshOAuthToken,
  type RefreshError,
} from "./credentials.js";
import { withFileLock } from "./file-lock.js";
import { log } from "./log.js";

export const USAGE_FILE = path.join(SESSIONS_DIR, "claude-usage.json");
const USAGE_LOCK = path.join(SESSIONS_DIR, "claude-usage.lock");

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
  fetchedAt: string;       // last fetch attempt (success or failure)
  data?: UsageData;        // last successfully fetched data; preserved across transient errors
  dataAt?: string;         // when `data` was actually fetched (defaults to fetchedAt for legacy snapshots)
  error?: string;          // present iff the last attempt failed
  retryAfterMs?: number;   // server hint when known (only used as a lower bound for the snapshot's own next-attempt timing)
}

// -----------------------------------------------------------------------------
// Credential discovery
// -----------------------------------------------------------------------------

// Returns an access token usable against api.anthropic.com, refreshing the
// underlying OAuth credential first when it has expired and a refresh token
// is available. On successful refresh, the new tokens are persisted back to
// the credential source (Keychain on macOS, ~/.claude/.credentials.json
// elsewhere) so claude CLI's next read sees the rotated values — otherwise
// our refresh would silently revoke claude CLI's cached refresh token and
// force the operator to re-login.
//
// The `expired_login` return tag distinguishes a revoked refresh token
// (`invalid_grant` from the OAuth server) from a stale-but-fixable cached
// access token — the caller surfaces them differently.
export interface ResolvedCredential {
  token: string;
  source: "env" | "keychain" | "file";
  refreshed: boolean;
}

export async function resolveCredential(): Promise<
  | { ok: true; cred: ResolvedCredential }
  | { ok: false; error: "no_credentials" | "login_expired" | "refresh_failed"; detail?: string }
> {
  const envToken = process.env.GARDEN_CLAUDE_SESSION_KEY;
  if (envToken && envToken.startsWith("sk-ant-")) {
    return { ok: true, cred: { token: envToken, source: "env", refreshed: false } };
  }
  const slot = readPersonalCredential();
  if (!slot) return { ok: false, error: "no_credentials" };
  if (!isAccessTokenExpired(slot.oauth)) {
    return { ok: true, cred: { token: slot.oauth.accessToken, source: slot.source, refreshed: false } };
  }
  if (!slot.oauth.refreshToken) {
    // Expired AT with no refresh token — only `garden login` (or claude /login) can heal.
    return { ok: false, error: "login_expired", detail: "no refresh token on credential" };
  }
  try {
    const fresh = await refreshOAuthToken(slot.oauth.refreshToken);
    persistCredential(slot.source, fresh);
    log.info("usage", "refreshed oauth token", { data: { source: slot.source } });
    return { ok: true, cred: { token: fresh.accessToken, source: slot.source, refreshed: true } };
  } catch (err) {
    const refreshErr = err as RefreshError;
    if (refreshErr.code === "invalid_grant") {
      return { ok: false, error: "login_expired", detail: "refresh token revoked" };
    }
    return { ok: false, error: "refresh_failed", detail: `${refreshErr.code}: ${refreshErr.message}`.slice(0, 200) };
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
        const retryAfterMs = parseRetryAfter(retryHeader);
        resolve({ status: res.statusCode ?? 0, body, retryAfterMs });
      });
    });
    req.on("timeout", () => { req.destroy(new Error("timeout")); });
    req.on("error", reject);
    req.end();
  });
}

// RFC 9110 allows Retry-After in two forms: a delta-seconds integer or an
// HTTP-date. We accept both. Returns undefined for missing/unparseable values
// (which the decision layer treats as "server provided no hint" — falls back
// to our own backoff floor rather than retrying immediately).
export function parseRetryAfter(header: unknown, nowMs: number = Date.now()): number | undefined {
  if (typeof header !== "string") return undefined;
  const trimmed = header.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) {
    const secs = parseInt(trimmed, 10);
    if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
    return undefined;
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - nowMs);
  return undefined;
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
  atomicWriteFile(USAGE_FILE, JSON.stringify(snap, null, 2));
}

// -----------------------------------------------------------------------------
// Refresh decision (single source of truth, used by both poller and hooks)
// -----------------------------------------------------------------------------

// Conservative floor against the endpoint's burst rate-limit. The poller's
// "happy path" cadence — also the minimum spacing between any two fetches.
export const POLL_OK_MS = 5 * 60 * 1000;

// Generic non-429 error backoff (network blip, 5xx, unparseable body).
export const POLL_ERR_MS = 10 * 60 * 1000;

// Floor for any computed interval — defends against Retry-After: 0 / negative
// values, and keeps every code path well above the burst rate-limit.
export const POLL_MIN_MS = 60 * 1000;

// Minimum effective backoff after a 429, regardless of what the server said.
// `Retry-After: 0` after a 429 is meaningless (the request itself was a 429),
// so we self-protect by waiting at least POLL_OK_MS. Honors a longer server
// hint when given.
export const RATE_LIMIT_FLOOR_MS = POLL_OK_MS;

// Poller backoff applied to 401/403. Not transient — waits for a login.
export const AUTH_BACKOFF_MS = 30 * 60 * 1000;

// Hook semantics: minimum age before a Stop hook may opportunistically refresh
// a healthy snapshot. The poller refreshes every POLL_OK_MS; the hook lets
// the meter update sooner when a turn ends near the cooldown boundary.
export const HOOK_REFRESH_COOLDOWN_MS = 60 * 1000;

export interface RefreshDecision {
  // Hook semantics: should this caller fire a refresh now?
  shouldRefresh: boolean;
  // Poller semantics: how long to sleep before the next attempt.
  // Always >= POLL_MIN_MS.
  nextAttemptInMs: number;
}

export function decideRefresh(
  snap: UsageSnapshot | null,
  nowMs: number,
  reason: "hook" | "poller",
): RefreshDecision {
  // No snapshot or unparseable timestamp — fetch now, sleep one OK interval.
  if (!snap) return { shouldRefresh: true, nextAttemptInMs: POLL_OK_MS };
  const fetchedAt = Date.parse(snap.fetchedAt);
  if (!Number.isFinite(fetchedAt)) {
    return { shouldRefresh: true, nextAttemptInMs: POLL_OK_MS };
  }

  const age = nowMs - fetchedAt;
  // Effective backoff between attempts depends on the most recent outcome.
  // We unify the rule for both consumers so a `Retry-After: 0` cascade can't
  // exploit the difference between poller cadence (10 min on err) and hook
  // cadence (60s) to slam the API.
  let requiredAge: number;
  if (snap.error === "rate-limited") {
    requiredAge = Math.max(snap.retryAfterMs ?? 0, RATE_LIMIT_FLOOR_MS);
  } else if (snap.error === "login expired") {
    requiredAge = AUTH_BACKOFF_MS;
  } else if (snap.error) {
    requiredAge = POLL_ERR_MS;
  } else if (reason === "hook") {
    requiredAge = HOOK_REFRESH_COOLDOWN_MS;
  } else {
    requiredAge = POLL_OK_MS;
  }

  const shouldRefresh = age >= requiredAge;
  const remaining = Math.max(0, requiredAge - age);
  // Poller sleeps until the snapshot would be stale, plus a small buffer so it
  // wakes *after* the threshold rather than just before. Floor protects against
  // any zero/negative computation.
  const nextAttemptInMs = Math.max(POLL_MIN_MS, remaining + 1000);
  return { shouldRefresh, nextAttemptInMs };
}

// Back-compat thin wrapper. Existing callers / tests use this name.
export function shouldRefreshOnHookWith(
  snap: UsageSnapshot | null,
  nowMs: number,
): boolean {
  return decideRefresh(snap, nowMs, "hook").shouldRefresh;
}

export function shouldRefreshOnHook(nowMs: number = Date.now()): boolean {
  return decideRefresh(readUsageSnapshot(), nowMs, "hook").shouldRefresh;
}

// -----------------------------------------------------------------------------
// Fetch-and-store (used by the poller and by hook-driven opportunistic refresh)
// -----------------------------------------------------------------------------

// All snapshot mutation goes through here. Two-phase locking pattern:
//
//   1. Acquire the file lock, re-read the snapshot, decide whether to fetch.
//      If a sibling process just refreshed (snapshot is fresh enough), bail
//      with the existing snapshot — no fetch, no thundering herd. Otherwise
//      "claim" the slot by bumping `fetchedAt` to now (preserving prior data
//      and dataAt) so concurrent callers see a fresh-looking snapshot and
//      skip. Release the lock so other state writers aren't blocked on our
//      ~15s network call.
//   2. Fetch (async, no lock held).
//   3. Re-acquire the lock to write the final snapshot. Brief, sync, atomic.
//
// On crash mid-fetch the bumped `fetchedAt` naturally expires after the
// applicable backoff window (60s for hooks, 5min for poller), so a stuck
// claim self-heals rather than wedging the meter.
export async function refreshUsage(): Promise<UsageSnapshot> {
  const claim = withFileLock(USAGE_LOCK, () => {
    const prior = readUsageSnapshot();
    const decision = decideRefresh(prior, Date.now(), "hook");
    if (!decision.shouldRefresh && prior) {
      return { fetched: false as const, snap: prior };
    }
    const claimSnap: UsageSnapshot = {
      fetchedAt: new Date().toISOString(),
      ...(prior?.data ? { data: prior.data } : {}),
      ...(prior?.dataAt ? { dataAt: prior.dataAt } : (prior?.fetchedAt && prior.data ? { dataAt: prior.fetchedAt } : {})),
    };
    writeUsageSnapshot(claimSnap);
    return { fetched: true as const, prior };
  }, { name: "claude-usage", deadlineMs: 5000 });

  if (!claim.fetched) return claim.snap;

  const prior = claim.prior;
  const resolved = await resolveCredential();
  if (!resolved.ok) {
    if (resolved.error === "no_credentials") {
      return finalizeSnapshot({
        fetchedAt: new Date().toISOString(),
        error: "no Claude Code credentials found",
      }, prior);
    }
    if (resolved.error === "login_expired") {
      log.warn("usage", "login expired", { data: { detail: resolved.detail } });
      return finalizeSnapshot({
        fetchedAt: new Date().toISOString(),
        error: "login expired",
        retryAfterMs: AUTH_BACKOFF_MS,
      }, prior);
    }
    // refresh_failed: transient (network/5xx during token refresh). Generic backoff, retry sooner.
    log.warn("usage", "token refresh failed", { data: { detail: resolved.detail } });
    return finalizeSnapshot({
      fetchedAt: new Date().toISOString(),
      error: `refresh failed: ${resolved.detail ?? "unknown"}`.slice(0, 200),
    }, prior);
  }
  const cred = resolved.cred;

  try {
    const res = await fetchUsageRaw(cred.token);
    const fetchedAt = new Date().toISOString();

    if (res.status === 200) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(res.body);
      } catch (err) {
        // 200 with an unparseable body — proxy interference, partial response,
        // or a server-side shape change. Keep last-good data so the bars don't
        // vanish; surface the error inline via the (stale) tag.
        log.warn("usage", "200 with unparseable body", {
          data: { bodyPrefix: res.body.slice(0, 200) },
        });
        return finalizeSnapshot({
          fetchedAt,
          error: `200 with unparseable body: ${String(err).slice(0, 100)}`,
        }, prior);
      }
      const data = normalizeUsage(parsed);
      const snap: UsageSnapshot = { fetchedAt, dataAt: fetchedAt, data };
      writeUsageSnapshotLocked(snap);
      log.debug("usage", "fetched", {
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
      log.warn("usage", "rate-limited", { data: { retryAfterMs: res.retryAfterMs } });
      return finalizeSnapshot({
        fetchedAt,
        error: "rate-limited",
        retryAfterMs: res.retryAfterMs,
      }, prior);
    }

    if (res.status === 401 || res.status === 403) {
      log.warn("usage", "auth failed", { data: { status: res.status } });
      // 401/403 isn't transient; back off AUTH_BACKOFF_MS so a dead token doesn't trigger the endpoint's 429 cascade (garden login overwrites the snapshot to heal early).
      return finalizeSnapshot({
        fetchedAt,
        error: "login expired",
        retryAfterMs: AUTH_BACKOFF_MS,
      }, prior);
    }

    log.warn("usage", "unexpected status", { data: { status: res.status, body: res.body.slice(0, 200) } });
    return finalizeSnapshot({ fetchedAt, error: `http ${res.status}` }, prior);
  } catch (err) {
    const error = (err instanceof Error ? err.message : String(err)).slice(0, 120);
    log.warn("usage", "fetch error", { data: { error } });
    return finalizeSnapshot({
      fetchedAt: new Date().toISOString(),
      error,
    }, prior);
  }
}

// Merges last-good data into the new snapshot and writes under the lock.
// Centralizes the "preserve data through transient errors" rule so every
// failure path benefits.
function finalizeSnapshot(
  next: UsageSnapshot,
  prior: UsageSnapshot | null | undefined,
): UsageSnapshot {
  const merged: UsageSnapshot = { ...next };
  if (prior?.data && !merged.data) {
    merged.data = prior.data;
    merged.dataAt = prior.dataAt ?? prior.fetchedAt;
  }
  writeUsageSnapshotLocked(merged);
  return merged;
}

function writeUsageSnapshotLocked(snap: UsageSnapshot): void {
  withFileLock(USAGE_LOCK, () => writeUsageSnapshot(snap), {
    name: "claude-usage",
    deadlineMs: 5000,
  });
}

// -----------------------------------------------------------------------------
// Rendering
// -----------------------------------------------------------------------------

const BAR_WIDTH = 24;
const MIN_BAR_WIDTH = 6;
const LABEL_WIDTH = 6; // "sonnet" is the longest label
const INDENT = "    ";  // 4-space indent mirrors worker rows in the status pane
const STALE_AFTER_MS = 30 * 60 * 1000; // 30 min — long enough to survive the endpoint's long rate-limit windows

// Fixed parts of a meter line (no bar, no reset): INDENT + LABEL + 2gap + 2gap + pct.
const FIXED_LINE_WIDTH = INDENT.length + LABEL_WIDTH + 2 + 2 + 4;
// "resets in 10d 23h" is the longest reset phrase (2-space gap precedes it).
const RESET_TEXT_WIDTH = 17;

// Narrow zooms shrink the bar first, then drop the reset phrase when even MIN_BAR_WIDTH + reset won't fit.
function computeMeterFit(paneWidth: number | undefined): { barWidth: number; showReset: boolean } {
  if (paneWidth === undefined) return { barWidth: BAR_WIDTH, showReset: true };
  const withReset = paneWidth - FIXED_LINE_WIDTH - 2 - RESET_TEXT_WIDTH;
  if (withReset >= BAR_WIDTH) return { barWidth: BAR_WIDTH, showReset: true };
  if (withReset >= MIN_BAR_WIDTH) return { barWidth: withReset, showReset: true };
  const withoutReset = paneWidth - FIXED_LINE_WIDTH;
  return {
    barWidth: Math.max(MIN_BAR_WIDTH, Math.min(BAR_WIDTH, withoutReset)),
    showReset: false,
  };
}

// Leading blank for breathing room under the pane-border label, then three meter rows.
export function renderUsagePane(nowMs: number = Date.now(), paneWidth?: number): string {
  const snap = readUsageSnapshot();
  const lines: string[] = [""];

  if (!snap) {
    lines.push(`${INDENT}${dim("claude usage  loading…")}`);
    return lines.map(l => l + "\x1b[K").join("\n");
  }

  // No data ever fetched — show the error (or loading) instead of empty bars.
  if (!snap.data) {
    const msg = snap.error ?? "loading…";
    lines.push(`${INDENT}${dim(`claude usage  ${msg}`)}`);
    return lines.map(l => l + "\x1b[K").join("\n");
  }

  // Data present (possibly old). Stale check uses dataAt — the timestamp of
  // the last *successful* fetch, not the last attempt. Snapshots written by
  // older versions lack dataAt and fall back to fetchedAt (which equals dataAt
  // on success in those snapshots, so the behavior matches).
  const staleTag = formatHealthTag(snap, nowMs);
  const d = snap.data;
  const fit = computeMeterFit(paneWidth);

  lines.push(renderMeterLine("5h",     d.fiveHour, nowMs, staleTag, FIVE_HOUR_MS, fit));
  lines.push(renderMeterLine("week",   d.weekly,   nowMs, staleTag, SEVEN_DAY_MS, fit));
  // A null seven_day_sonnet bucket renders "—" rather than a flat-zero bar — a 0% sliver
  // next to the weekly bar reads as broken, and "no data" is the truer signal.
  lines.push(renderMeterLine("sonnet", d.sonnet,   nowMs, staleTag, SEVEN_DAY_MS, fit));

  return lines.map(l => l + "\x1b[K").join("\n");
}

const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;

// Trust signal for the operator: when bars are real-time we say nothing
// (uncluttered). When data is unexpectedly old or the last fetch errored,
// we annotate every meter row with how-old + why so the source of trouble is
// obvious without digging through `garden logs`. Examples:
//   no problems        → ""
//   data 2h old        → " (stale 2h)"
//   error after fresh  → " (rate-limited)"
//   error + data old   → " (stale 2h, rate-limited)"
function formatHealthTag(snap: UsageSnapshot, nowMs: number): string {
  const dataAt = Date.parse(snap.dataAt ?? snap.fetchedAt);
  const ageMs = Number.isFinite(dataAt) ? nowMs - dataAt : Infinity;
  const stale = ageMs > STALE_AFTER_MS;
  if (!snap.error && !stale) return "";
  const parts: string[] = [];
  if (stale) parts.push(`stale ${formatBriefAge(ageMs)}`);
  if (snap.error) parts.push(snap.error);
  return dim(` (${parts.join(", ")})`);
}

// Compact age form for inline annotations: "5m", "3h", "2d". Differs from
// formatDuration() which prepends "in" and is sized for resets-text context.
export function formatBriefAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

function renderMeterLine(
  label: string,
  meter: UsageMeter | undefined,
  nowMs: number,
  suffix: string,
  windowMs: number | undefined,
  fit: { barWidth: number; showReset: boolean },
): string {
  const paddedLabel = label.padEnd(LABEL_WIDTH);
  if (!meter) return `${INDENT}${paddedLabel}  ${dim("—")}${suffix}`;
  const resetsAt = Date.parse(meter.resetsAt);
  // The server-side window has rolled over since our cached pct was fetched —
  // the bucket is in a new window and our pct describes the previous one.
  // Rendering the stale value as if it were current would lie until the next
  // successful poll; em-dash is the truthful "no current value" signal.
  if (Number.isFinite(resetsAt) && resetsAt <= nowMs) {
    return `${INDENT}${paddedLabel}  ${dim("—")}${suffix}`;
  }
  const pct = Math.max(0, Math.min(100, meter.pct));
  let timePct: number | undefined;
  if (windowMs && Number.isFinite(resetsAt)) {
    const elapsed = windowMs - (resetsAt - nowMs);
    timePct = Math.max(0, Math.min(100, (elapsed / windowMs) * 100));
  }
  const bar = renderBar(pct, fit.barWidth, timePct);
  const pctText = `${pct.toFixed(0).padStart(3)}%`;
  const resetText = fit.showReset && Number.isFinite(resetsAt)
    ? `resets ${formatDuration(resetsAt - nowMs)}`
    : "";
  const resetPart = resetText ? `  ${dim(resetText)}` : "";
  return `${INDENT}${paddedLabel}  ${bar}  ${pctText}${resetPart}${suffix}`;
}

function renderBar(pct: number, barWidth: number, markerPct?: number): string {
  const raw = (pct / 100) * barWidth;
  const filled = Math.max(0, Math.min(barWidth, pct > 0 ? Math.max(1, Math.round(raw)) : 0));

  const colorCode = colorForPct(pct);
  const fg = `\x1b[${colorCode}m`;
  const bg = `\x1b[${parseInt(colorCode, 10) + 10}m`;
  const rst = "\x1b[0m";
  const brightFg = "\x1b[97m";

  // Floor at cell 1 so a leading dim cell always precedes the marker.
  const markerIdx = (markerPct != null && Number.isFinite(markerPct))
    ? Math.max(1, Math.min(barWidth - 1, Math.round((markerPct / 100) * (barWidth - 1))))
    : -1;

  let result = "";
  for (let i = 0; i < barWidth; i++) {
    const isFilled = i < filled;
    const isMarker = i === markerIdx;
    if (isMarker && isFilled) {
      // Marker overlays green: green bg keeps the cell from looking "eaten".
      result += `${bg}${brightFg}│${rst}`;
    } else if (isMarker) {
      result += `${brightFg}│${rst}`;
    } else if (isFilled) {
      result += `${fg}█${rst}`;
    } else {
      result += dim("░");
    }
  }
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

// Detached so the 5s hook budget isn't spent waiting on the fetch. The
// thundering-herd guard lives inside refreshUsage's file lock, not here —
// the spawn is cheap and the spawned process bails fast if a sibling already
// won the claim.
export function maybeRefreshUsage(gardenRunner: string): void {
  if (!shouldRefreshOnHook()) return;
  try {
    spawn("sh", ["-c", `${gardenRunner} dashboard _usage-refresh 2>/dev/null`], {
      detached: true,
      stdio: "ignore",
    }).unref();
  } catch { /* background poller will catch up within 5 minutes */ }
}

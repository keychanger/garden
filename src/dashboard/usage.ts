// Claude usage meter: fetches the authenticated user's 5-hour, weekly, and
// model-scoped weekly quota using the OAuth token that Claude Code writes to
// the macOS Keychain. Persists a snapshot to SESSIONS_DIR and renders the
// header meters for the dashboard status pane.
//
// Two sources, split by cadence (this is what Claude Code itself does):
//
//   Primary (every poll) — the `anthropic-ratelimit-unified-{5h,7d}-*` response
//   headers that ride *every* /v1/messages response. We read them off a
//   1-token throwaway completion ("quota"). These carry the 5-hour and weekly
//   bars, are documented/supported, and are governed by the generous messages
//   limiter — not the usage endpoint's stingy one — so they essentially never
//   throttle at our cadence.
//
//   Secondary (hourly) — GET /api/oauth/usage, the undocumented endpoint that
//   is the *only* source of the model-scoped weekly bar (Fable). Its limiter
//   tightened server-side around 2026-07-10 to a fixed Retry-After: 3600 with a
//   budget near 10-12 requests/hour; hitting it once an hour (for the slow-
//   moving 7-day scoped figure alone) sits far under that. A scoped 429 is
//   silent — the primary bars are already live from headers, so the scoped bar
//   just keeps its last value until the next hourly refresh.
//
// The migration off the endpoint's hot path is deliberate: the old design
// polled it every 5-10 min for all three bars and chained hour-long freezes
// whenever the fleet's activity pushed request volume past the budget.
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { spawn } from "node:child_process";
import { SESSIONS_DIR, anyAnthropicMeteredProject } from "../config.js";
import { atomicWriteFile } from "./atomic-write.js";
import { readCodexUsage, type CodexUsageData } from "./codex-usage.js";
import {
  isAccessTokenExpired,
  persistCredential,
  readPersonalCredential,
  refreshOAuthToken,
  type RefreshError,
} from "./credentials.js";
import { withFileLock } from "./file-lock.js";
import { log } from "./log.js";
import { readRegistry, type WorkerEntry } from "./registry.js";

export const USAGE_FILE = path.join(SESSIONS_DIR, "claude-usage.json");
const USAGE_LOCK = path.join(SESSIONS_DIR, "claude-usage.lock");

export interface UsageMeter {
  pct: number;
  resetsAt: string; // ISO 8601
}

// A model-scoped weekly meter (e.g. Fable). The endpoint moved these out of
// the flat `seven_day_<model>` keys into the `limits[]` array, each tagged
// with the model's display name — so the label is data, and the bar
// auto-tracks whatever model Anthropic scopes next without a code change.
// Zero or more per response.
export interface ScopedMeter extends UsageMeter {
  label: string;
}

// Pay-as-you-go overflow credits beyond the plan quota. Surfaced only when the
// account has extra usage turned on (is_enabled); a disabled bucket is dropped
// so the pane adds no extra-usage footer row. The numeric fields are optional
// because the endpoint returns null limits for an uncapped account.
export interface ExtraUsage {
  enabled: boolean;
  monthlyLimit?: number;
  usedCredits?: number;
  utilization?: number; // percent, server-computed
}

export interface UsageData {
  fiveHour?: UsageMeter;
  weekly?: UsageMeter;
  scoped?: ScopedMeter[];
  extraUsage?: ExtraUsage;
}

export interface UsageSnapshot {
  fetchedAt: string;       // last fetch attempt (success or failure)
  data?: UsageData;        // last successfully fetched data; preserved across transient errors
  dataAt?: string;         // when the PRIMARY (5h/weekly header) bars were fetched; drives the stale tag. Defaults to fetchedAt for legacy snapshots.
  error?: string;          // present iff the last PRIMARY (header) attempt failed
  retryAfterMs?: number;   // effective backoff before the next attempt (server hint plus our margin/escalation on 429s)
  rateLimitStreak?: number; // consecutive 429s ending at this snapshot; drives the escalating backoff
  // The model-scoped bar comes from the throttled oauth endpoint on a slower
  // (hourly) cadence than the primary bars, so its freshness is tracked
  // separately. `scopedAt` is the last *successful* scoped fetch (bar
  // freshness); `scopedAttemptedAt` is the last scoped *attempt* — success or
  // failure — and is what spaces the hourly retries so a 429 doesn't re-fire
  // every poll. Absent on all-header cycles and legacy snapshots.
  scopedAt?: string;
  scopedAttemptedAt?: string;
  // Error from the most recent *surfaced* scoped (oauth-endpoint) fetch attempt,
  // or absent when it succeeded / was not surfaced. Only set when a scoped-model
  // (Fable) worker was actively running at fetch time — a scoped miss during the
  // idle keepalive is left silent, since that bar isn't consequential then. Never
  // freezes the primary bars (that is `error`'s job); it renders as a dim note on
  // the model-scoped row's health tag so a Fable-meter rate-limit is explicit.
  scopedError?: string;
}

// Neutral read seam over the snapshot's named buckets: consumers (the
// auto-continue gate, future meter sources) iterate a list instead of
// reaching into Anthropic's bucket names. `key` is the meter class — policy
// that cares about the model-scoped meters (the gate's `scoped` exclusion,
// trellis's Sonnet fallback via findScopedMeter) filters by it at the policy
// site. See docs/MULTI-MODEL.md "Layer 2".
export interface Meter {
  key: "fiveHour" | "weekly" | "scoped";
  label: string;
  pct: number;
  resetsAt: string;
}

export function snapshotMeters(snap: UsageSnapshot | null): Meter[] {
  const d = snap?.data;
  if (!d) return [];
  const out: Meter[] = [];
  if (d.fiveHour) out.push({ key: "fiveHour", label: "5h", ...d.fiveHour });
  if (d.weekly) out.push({ key: "weekly", label: "week", ...d.weekly });
  for (const s of d.scoped ?? []) {
    out.push({ key: "scoped", label: s.label, pct: s.pct, resetsAt: s.resetsAt });
  }
  return out;
}

// Look up a model-scoped weekly meter by model name (case-insensitive), for
// policy that cares about one specific model's quota — e.g. trellis's
// Sonnet-exhaustion fallback. Returns undefined when the endpoint isn't
// exposing that model's meter, which since 2026-07 is the case for Sonnet:
// the account's model-scoped weekly meter is now Fable.
export function findScopedMeter(data: UsageData | undefined, model: string): ScopedMeter | undefined {
  if (!data?.scoped) return undefined;
  const target = model.toLowerCase();
  return data.scoped.find((m) => m.label.toLowerCase() === target);
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
    log.info("usage", "refreshed usage-meter oauth token", { data: { source: slot.source } });
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

// Pulls the diagnostically useful fields off a thrown fetch error and builds
// a concise human summary. Node's network errors carry `code`/`syscall`/
// `hostname` (often more informative than `.message`, which is sometimes
// empty — e.g. on a bare `req.destroy()` or some TLS aborts), so we surface
// those structured fields to the log and prefer "<syscall> <code>" over a
// blank message in the snapshot's error string.
export interface FetchErrorDetail {
  summary: string;
  data: Record<string, string | number>;
}

export function describeFetchError(err: unknown): FetchErrorDetail {
  const data: Record<string, string | number> = {};
  let messageField: string | undefined;
  let nameField: string | undefined;

  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    const stringFields = ["name", "code", "syscall", "hostname", "address"] as const;
    for (const k of stringFields) {
      const v = e[k];
      if (typeof v === "string" && v.length > 0) data[k] = v;
    }
    const numberFields = ["errno", "port"] as const;
    for (const k of numberFields) {
      const v = e[k];
      if (typeof v === "number" && Number.isFinite(v)) data[k] = v;
    }
    if (typeof e.message === "string" && e.message.length > 0) {
      messageField = e.message.slice(0, 200);
      data.message = messageField;
    }
    if (typeof e.name === "string" && e.name.length > 0) nameField = e.name;
    if (e.cause && typeof e.cause === "object") {
      const cause = e.cause as Record<string, unknown>;
      if (typeof cause.code === "string" && cause.code.length > 0) data.causeCode = cause.code;
      if (typeof cause.message === "string" && cause.message.length > 0) {
        data.causeMessage = cause.message.slice(0, 120);
      }
    }
  }

  const code = typeof data.code === "string" ? data.code : undefined;
  const syscall = typeof data.syscall === "string" ? data.syscall : undefined;
  let summary: string;
  if (code && syscall) summary = `${syscall} ${code}`;
  else if (code) summary = code;
  else if (messageField) summary = messageField;
  else if (nameField && nameField !== "Error") summary = nameField;
  else {
    const ctor = err && typeof err === "object" ? (err as { constructor?: { name?: string } }).constructor?.name : undefined;
    if (ctor && ctor !== "Error" && ctor !== "Object") summary = ctor;
    else {
      const s = typeof err === "string" ? err : err == null ? "" : String(err);
      summary = s && s !== "[object Object]" && s !== "Error" ? s : "unknown error (no message or code)";
    }
  }

  return { summary: summary.slice(0, 120), data };
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

// Cheapest tier for the throwaway quota completion. The unified rate-limit
// headers describe the *account*, not the model, so any valid model returns
// them — Haiku just minimizes the (already trivial) cost. If Anthropic retires
// this id the call 404s: the header fetch reports `http 404`, the pane shows
// the preserved bars plus that error, and this constant gets bumped.
const QUOTA_PROBE_MODEL = "claude-haiku-4-5-20251001";

export interface HeaderFetchResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  retryAfterMs?: number;
}

// The primary source: a 1-token /v1/messages completion whose response carries
// the `anthropic-ratelimit-unified-*` headers. Mirrors Claude Code's own
// `source: "quota_check"` call. The body is drained but discarded — only the
// headers matter. Governed by the messages limiter (generous), not the usage
// endpoint's, so it does not participate in the 429 cascade fetchUsageRaw does.
export function fetchUsageHeaders(token: string): Promise<HeaderFetchResult> {
  const body = JSON.stringify({
    model: QUOTA_PROBE_MODEL,
    max_tokens: 1,
    messages: [{ role: "user", content: "quota" }],
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
        "User-Agent": "garden-dashboard/1.0",
        "Accept": "application/json",
        "Content-Length": Buffer.byteLength(body).toString(),
      },
      timeout: 15000,
    }, (res) => {
      res.on("data", () => { /* drain: we only want the headers */ });
      res.on("end", () => {
        const retryAfterMs = parseRetryAfter(res.headers["retry-after"]);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, retryAfterMs });
      });
    });
    req.on("timeout", () => { req.destroy(new Error("timeout")); });
    req.on("error", reject);
    req.write(body);
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
//     seven_day_sonnet: null,   // flat model buckets are all null since 2026-07
//     seven_day_opus:   null,
//     limits: [ { kind: "session",       group, percent, resets_at },
//               { kind: "weekly_all",    group, percent, resets_at },
//               { kind: "weekly_scoped", group, percent, resets_at,
//                 scope: { model: { id, display_name } } }, ... ],
//     extra_usage:      { is_enabled, monthly_limit, used_credits, utilization } | null }
// As of 2026-05 some responses arrive wrapped in an envelope:
//   { schema_version: 2, quota: { five_hour: ..., seven_day: ..., ... } }
// — same bucket shape inside, just versioned. We unwrap when the flat parse
// finds nothing so both shapes Just Work without coordinating with the
// server's rollout. The first two bars still read the flat five_hour/seven_day
// keys (mirrors of the session/weekly_all limits). The model-scoped weekly
// bar(s) moved out of the flat seven_day_<model> keys (now null) into the
// `limits` array as `weekly_scoped` entries, each labeled by
// scope.model.display_name — parsed by pickScopedMeters, one bar per entry.
// The extra_usage bucket is surfaced as `extraUsage` only when is_enabled,
// rendered as a dim credit footer under the bars rather than a resetting
// meter. Fields are parsed defensively so any shape shift or null bucket
// degrades to "—" (or a dropped bar) rather than throwing.
export function normalizeUsage(raw: unknown): UsageData {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const top = pickBuckets(r);
  if (top.fiveHour || top.weekly || top.scoped) return top;
  // Envelope fallback: unwrap `quota` and re-parse. Same field names inside.
  const quota = r["quota"];
  const hasQuotaObject = quota !== null && typeof quota === "object" && !Array.isArray(quota);
  if (hasQuotaObject) {
    const inner = pickBuckets(quota as Record<string, unknown>);
    if (inner.fiveHour || inner.weekly || inner.scoped) return inner;
  }
  // Shape-shift detector: a non-empty response that yields zero recognized
  // meters is either an empty-bucket account (all keys present but null —
  // expected) or a renamed/restructured payload we no longer parse. The
  // second case used to land as silent em-dashes until someone noticed the
  // dashboard; warn with a one-level shape preview so the next surprise
  // tells us *what* changed, not just that something did. When the envelope
  // is recognized but its contents aren't, look for expected keys inside
  // `quota` (so a wrapped all-null account stays quiet) and point the
  // preview at the inner object so the rename inside `quota` is what gets
  // logged.
  const expected = ["five_hour", "seven_day", "limits"];
  const expectedSource = hasQuotaObject ? (quota as Record<string, unknown>) : r;
  const anyExpectedKey = expected.some((k) => k in expectedSource);
  const isAllNullKnown = anyExpectedKey; // legit empty-bucket account — quiet
  if (Object.keys(r).length > 0 && !isAllNullKnown) {
    const previewSource = hasQuotaObject ? quota : r;
    log.warn("usage", "no recognized buckets in response — possible schema change", {
      data: { shape: shapePreview(previewSource) },
    });
  }
  return top;
}

// The primary path: the account's 5-hour and 7-day (weekly) utilization off
// the `anthropic-ratelimit-unified-{5h,7d}-*` response headers. Utilization is
// a 0..1 fraction (scaled to percent); the reset is unix epoch *seconds* (→
// ISO). This mirrors Claude Code's own header reader. The headers carry NO
// per-model bucket — the model-scoped weekly bar (Fable) still comes only from
// the oauth endpoint's `limits[]` array (pickScopedMeters), so this returns
// just fiveHour/weekly and the merge layers the scoped bar on top.
export function parseUnifiedHeaders(
  headers: Record<string, string | string[] | undefined>,
): UsageData {
  const out: UsageData = {};
  const fiveHour = headerMeter(headers, "5h");
  if (fiveHour) out.fiveHour = fiveHour;
  const weekly = headerMeter(headers, "7d");
  if (weekly) out.weekly = weekly;
  return out;
}

function headerMeter(
  headers: Record<string, string | string[] | undefined>,
  window: string,
): UsageMeter | undefined {
  const util = headerValue(headers, `anthropic-ratelimit-unified-${window}-utilization`);
  const reset = headerValue(headers, `anthropic-ratelimit-unified-${window}-reset`);
  if (util === undefined || reset === undefined) return undefined;
  const pct = Number(util);
  const resetSec = Number(reset);
  if (!Number.isFinite(pct) || !Number.isFinite(resetSec)) return undefined;
  return { pct: pct * 100, resetsAt: new Date(resetSec * 1000).toISOString() };
}

// Node lowercases response header names and collapses duplicates to the first;
// this normalizes the union type Node's headers bag exposes to a plain string.
function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const v = headers[name];
  if (Array.isArray(v)) return v[0];
  return typeof v === "string" ? v : undefined;
}

function pickBuckets(r: Record<string, unknown>): UsageData {
  const out: UsageData = {};
  const m = pickMeter(r["five_hour"]);
  if (m) out.fiveHour = m;
  const w = pickMeter(r["seven_day"]);
  if (w) out.weekly = w;
  const scoped = pickScopedMeters(r["limits"]);
  if (scoped.length) out.scoped = scoped;
  const x = pickExtraUsage(r["extra_usage"]);
  if (x) out.extraUsage = x;
  return out;
}

// Model-scoped weekly meters live in the `limits` array as `weekly_scoped`
// entries, each tagged with `scope.model.display_name`. Multiple scoped
// models yield multiple bars. Parsed defensively: an entry missing a numeric
// percent, a reset timestamp, or a usable label is skipped rather than
// rendered as a mislabeled or empty bar.
function pickScopedMeters(limits: unknown): ScopedMeter[] {
  if (!Array.isArray(limits)) return [];
  const out: ScopedMeter[] = [];
  for (const entry of limits) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (e["kind"] !== "weekly_scoped") continue;
    const pct = e["percent"];
    const reset = e["resets_at"];
    const scope = e["scope"];
    const model = scope && typeof scope === "object"
      ? (scope as Record<string, unknown>)["model"]
      : undefined;
    const label = model && typeof model === "object"
      ? (model as Record<string, unknown>)["display_name"]
      : undefined;
    if (typeof pct !== "number" || typeof reset !== "string" || typeof label !== "string" || !label) {
      continue;
    }
    out.push({ pct, resetsAt: reset, label });
  }
  return out;
}

// The extra_usage bucket → ExtraUsage, but only when the account has it
// enabled: a disabled or absent bucket returns undefined so the pane omits the
// extra-usage footer row. Numeric fields are parsed defensively (the endpoint returns null
// for an uncapped monthly_limit / utilization), so a partial bucket degrades
// to the fields it does carry rather than throwing. Note: the "found any
// buckets?" check in normalizeUsage keys on the three time buckets, not this
// one, so an extra-usage-only response still falls through to the
// envelope/shape-shift handling rather than short-circuiting on credits alone.
function pickExtraUsage(bucket: unknown): ExtraUsage | undefined {
  if (!bucket || typeof bucket !== "object") return undefined;
  const b = bucket as Record<string, unknown>;
  if (b["is_enabled"] !== true) return undefined;
  const out: ExtraUsage = { enabled: true };
  if (typeof b["monthly_limit"] === "number") out.monthlyLimit = b["monthly_limit"];
  if (typeof b["used_credits"] === "number") out.usedCredits = b["used_credits"];
  if (typeof b["utilization"] === "number") out.utilization = b["utilization"];
  return out;
}

// The credit tally shared by the dashboard footer and `garden usage`:
// "1234 / 5000 credits (25%)", degrading to whatever fields the endpoint
// returned for an uncapped or partial bucket ("1234 credits used", "enabled").
export function formatExtraUsageCredits(extra: ExtraUsage): string {
  const { usedCredits: used, monthlyLimit: limit, utilization: util } = extra;
  let text: string;
  if (used != null && limit != null) text = `${used} / ${limit} credits`;
  else if (used != null) text = `${used} credits used`;
  else if (limit != null) text = `${limit} credits limit`;
  else text = "enabled";
  if (util != null) text += ` (${Math.round(util)}%)`;
  return text;
}

// One-level structural sketch: for each top-level key, emit either the
// child's own keys (objects), its length (arrays), the literal "null", or
// the primitive type. No values — keys and types are enough to diagnose a
// schema rename without logging account-level numbers.
export function shapePreview(obj: unknown, maxKeys = 20): Record<string, unknown> | string {
  if (obj === null) return "null";
  if (Array.isArray(obj)) return `array[${obj.length}]`;
  if (typeof obj !== "object") return typeof obj;
  const out: Record<string, unknown> = {};
  const entries = Object.entries(obj as Record<string, unknown>);
  for (const [k, v] of entries.slice(0, maxKeys)) {
    if (v === null) out[k] = "null";
    else if (Array.isArray(v)) out[k] = `array[${v.length}]`;
    else if (typeof v === "object") out[k] = Object.keys(v as object).slice(0, 10);
    else out[k] = typeof v;
  }
  if (entries.length > maxKeys) out["…"] = `+${entries.length - maxKeys}`;
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

// The poller's "happy path" cadence — also the minimum spacing between any
// two fetches. Half the endpoint's observed post-2026-07 budget (~10-12
// requests/hour), so the steady state has headroom instead of sitting at the
// limit.
export const POLL_OK_MS = 10 * 60 * 1000;

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

// Margin added on top of the server's Retry-After before the next attempt.
// Retrying at the exact boundary was observed to land while the limiter's
// accounting window was still saturated (2026-07-12: one request, sent
// Retry-After + 1s after a 429, got 429 again), chaining hour-long freezes.
export const RATE_LIMIT_MARGIN_MS = 15 * 60 * 1000;

// Ceiling on the escalating consecutive-429 backoff (rateLimitBackoff).
export const RATE_LIMIT_MAX_BACKOFF_MS = 4 * 60 * 60 * 1000;

// Poller backoff applied to 401/403. Not transient — waits for a login.
export const AUTH_BACKOFF_MS = 30 * 60 * 1000;

// The hook path is a poller-liveness backstop, not a faster lane: it sits
// above POLL_OK_MS so a live poller always fetches first, and a turn-end
// only triggers a refresh when the poller has missed its window (window
// killed, machine slept). Every fetch the hook path doesn't make is budget
// left for the poller's own cadence.
export const HOOK_REFRESH_COOLDOWN_MS = POLL_OK_MS + 2 * 60 * 1000;

// Cadence for the secondary (oauth-endpoint) fetch that supplies the model-
// scoped weekly bar. The primary 5h/weekly bars refresh every poll from cheap
// response headers; the scoped bar is a slow-moving 7-day figure the endpoint
// alone carries, so we hit that throttled endpoint at most once an hour —
// roughly one request/hour, far under its ~10-12/hour budget. Gates on the last
// scoped *attempt* (see scopedFetchDue), not the poll cadence.
export const SCOPED_POLL_MS = 60 * 60 * 1000;

// Cadence when NO worker is actively running a scoped model (e.g. no Fable
// worker is going). The scoped weekly quota only moves while a scoped-model
// worker runs, so when none is live the bar is a near-static 7-day figure —
// polling it hourly just spends the throttled endpoint's tiny budget on a value
// that isn't changing. We drop to a slow keepalive (twice a day) that keeps the
// bar from rotting and refreshes the scoped labels. This is the "only fetch
// Fable when a Fable worker is going" gate: it removes ~22 of every 24 daily
// oauth calls on an idle fleet, cutting the shared per-token budget pressure
// that can collaterally rate-limit the primary /v1/messages probe.
export const SCOPED_IDLE_POLL_MS = 12 * 60 * 60 * 1000;

// A worker counts as "actively using" a scoped model when it fired a Claude
// hook within this window — its session is live and consuming quota now (the
// 10s heartbeat keeps lastEventAt fresh while a worker runs; it goes stale
// within minutes once the session ends). Sized to the hourly scoped cadence so
// exactly one extra fetch fires just after a Fable worker goes quiet, capturing
// its final quota consumption before the bar drops to the idle keepalive.
export const SCOPED_ACTIVE_MS = SCOPED_POLL_MS;

export type RefreshReason = "hook" | "poller";

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
  reason: RefreshReason,
): RefreshDecision {
  // No snapshot or unparseable timestamp — fetch now, sleep one OK interval.
  if (!snap) return { shouldRefresh: true, nextAttemptInMs: POLL_OK_MS };
  const fetchedAt = Date.parse(snap.fetchedAt);
  if (!Number.isFinite(fetchedAt)) {
    return { shouldRefresh: true, nextAttemptInMs: POLL_OK_MS };
  }

  const age = nowMs - fetchedAt;
  // Effective backoff between attempts depends on the most recent outcome.
  // Error backoffs apply to both consumers identically so neither path can
  // outpace the other past a failure — a `Retry-After: 0` cascade once
  // exploited the gap between the poller and hook cadences to slam the API.
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

// Effective backoff to store after a 429. The server's Retry-After is a
// lower bound, not a safe wait: add RATE_LIMIT_MARGIN_MS so the next attempt
// lands after the limiter's window has actually drained, and double on
// consecutive 429s (capped) so a saturated stretch costs one escalating wait
// instead of an all-afternoon chain of hourly re-trips. Any non-429 outcome
// in between resets the streak.
export function rateLimitBackoff(
  prior: UsageSnapshot | null | undefined,
  serverRetryAfterMs: number | undefined,
): { backoffMs: number; streak: number } {
  const streak = (prior?.error === "rate-limited" ? (prior.rateLimitStreak ?? 1) : 0) + 1;
  const base = Math.max(serverRetryAfterMs ?? 0, RATE_LIMIT_FLOOR_MS) + RATE_LIMIT_MARGIN_MS;
  const backoffMs = Math.min(RATE_LIMIT_MAX_BACKOFF_MS, base * 2 ** (streak - 1));
  return { backoffMs, streak };
}

// Whether the secondary (oauth-endpoint) scoped fetch is due. Keys on the last
// scoped *attempt* (success or failure), so a 429'd attempt still waits a full
// interval before the next try instead of re-firing every poll. The interval
// depends on whether a scoped-model worker is actively running: hourly while
// one is (`active`), the slow idle keepalive otherwise. A snapshot that never
// attempted it (fresh install, legacy shape) is always due — the first fetch
// also bootstraps the scoped labels the `active` check relies on.
export function scopedFetchDue(
  snap: UsageSnapshot | null | undefined,
  nowMs: number,
  active: boolean,
): boolean {
  const attempted = snap?.scopedAttemptedAt ? Date.parse(snap.scopedAttemptedAt) : NaN;
  if (!Number.isFinite(attempted)) return true;
  return nowMs - attempted >= (active ? SCOPED_POLL_MS : SCOPED_IDLE_POLL_MS);
}

// Whether any worker in the fleet is actively running a model whose weekly
// quota is the scoped bar (Fable today). "Actively" = the worker's effective
// model — its pinned `model`, or a trellis vine's `workerModel` — matches a
// scoped label case-insensitively AND it fired a hook within SCOPED_ACTIVE_MS
// (a live, quota-consuming session). Labels come from the last snapshot's scoped
// meters, so the gate auto-tracks whatever model Anthropic scopes next; before
// the first successful scoped fetch there are none, so we fall back to "fable"
// (the current scoped model, and the substring in its "claude-fable-5" ids).
// Pure over an explicit worker list for testability.
export function scopedModelInUse(
  scopedLabels: string[],
  nowMs: number,
  workers: WorkerEntry[],
): boolean {
  const labels = (scopedLabels.length ? scopedLabels : ["fable"]).map((l) => l.toLowerCase());
  for (const w of workers) {
    const model = (w.model ?? w.trellis?.workerModel ?? "").toLowerCase();
    if (!model || !labels.some((l) => model.includes(l))) continue;
    if (nowMs - (w.lastEventAt ?? 0) <= SCOPED_ACTIVE_MS) return true;
  }
  return false;
}

// IO wrapper over scopedModelInUse: reads every project's workers from the
// registry. A read failure degrades to "not in use" (the idle keepalive
// cadence) — the safe direction for the throttled endpoint's tiny budget.
function anyScopedModelWorkerActive(
  prior: UsageSnapshot | null | undefined,
  nowMs: number,
): boolean {
  try {
    const labels = (prior?.data?.scoped ?? []).map((s) => s.label);
    const workers = Object.values(readRegistry().workers).flat();
    return scopedModelInUse(labels, nowMs, workers);
  } catch {
    return false;
  }
}

// Assemble the snapshot's data from its two independent sources, each falling
// back to the prior snapshot when it wasn't fetched this cycle (scoped between
// hourly refreshes) or its fetch failed (a network blip), so a partial refresh
// never blanks a live bar. A `scoped` source object that was fetched but
// carries no meters is authoritative — it drops a since-removed bar; `undefined`
// means "not fetched this cycle — keep prior".
export function mergeUsageData(
  primary: UsageData | undefined,
  scoped: { scoped?: ScopedMeter[]; extraUsage?: ExtraUsage } | undefined,
  prior: UsageData | undefined,
): UsageData {
  const out: UsageData = {};
  const fiveHour = primary?.fiveHour ?? prior?.fiveHour;
  if (fiveHour) out.fiveHour = fiveHour;
  const weekly = primary?.weekly ?? prior?.weekly;
  if (weekly) out.weekly = weekly;
  const scopedMeters = scoped ? scoped.scoped : prior?.scoped;
  if (scopedMeters && scopedMeters.length) out.scoped = scopedMeters;
  const extra = scoped ? scoped.extraUsage : prior?.extraUsage;
  if (extra) out.extraUsage = extra;
  return out;
}

// Outcome of the primary (header) fetch. `data` present ⇒ the call returned
// (possibly empty headers); `error` present ⇒ the primary bars stay preserved
// and the health tag surfaces the reason. Both can be set: a 200 that carried
// no unified headers yields empty data plus a soft error.
export interface PrimaryOutcome {
  data?: UsageData;
  error?: { error: string; retryAfterMs?: number; rateLimitStreak?: number };
}

// Outcome of the secondary (scoped/oauth) fetch. `fetched` ⇒ we attempted the
// endpoint this cycle (advances scopedAttemptedAt, spacing retries); `data`
// present ⇒ a 200 parsed (advances scopedAt, the bar's freshness).
export interface ScopedOutcome {
  fetched: boolean;
  data?: { scoped?: ScopedMeter[]; extraUsage?: ExtraUsage };
  // Set when the scoped attempt failed AND was worth surfacing (a scoped-model
  // worker was active, or the operator forced the refresh). Rendered on the
  // scoped row's health tag; never freezes the primary bars.
  error?: string;
}

// The pure core of a refresh: fold the two fetch outcomes and the prior
// snapshot into the next snapshot. Kept separate from the IO in refreshUsage so
// the merge, freshness-timestamp, and scoped-cadence bookkeeping are unit-
// testable without a network. dataAt tracks only the PRIMARY bars — the scoped
// bar is intentionally up to an hour old and must not trip the stale tag — so
// it advances only when a header bar actually arrived.
export function assembleSnapshot(
  fetchedAt: string,
  primary: PrimaryOutcome,
  scoped: ScopedOutcome,
  prior: UsageSnapshot | null | undefined,
): UsageSnapshot {
  const data = mergeUsageData(primary.data, scoped.data, prior?.data);
  const gotPrimaryBar = !!(primary.data && (primary.data.fiveHour || primary.data.weekly));
  const snap: UsageSnapshot = { fetchedAt, data };
  const dataAt = gotPrimaryBar ? fetchedAt : (prior?.dataAt ?? prior?.fetchedAt);
  if (dataAt !== undefined) snap.dataAt = dataAt;
  if (primary.error) {
    snap.error = primary.error.error;
    if (primary.error.retryAfterMs !== undefined) snap.retryAfterMs = primary.error.retryAfterMs;
    if (primary.error.rateLimitStreak !== undefined) snap.rateLimitStreak = primary.error.rateLimitStreak;
  }
  const scopedAt = scoped.data ? fetchedAt : prior?.scopedAt;
  if (scopedAt !== undefined) snap.scopedAt = scopedAt;
  const scopedAttemptedAt = scoped.fetched ? fetchedAt : prior?.scopedAttemptedAt;
  if (scopedAttemptedAt !== undefined) snap.scopedAttemptedAt = scopedAttemptedAt;
  // Attempted this cycle → this attempt's error is authoritative (undefined on
  // success clears a prior note). Not attempted → carry the prior note forward.
  const scopedError = scoped.fetched ? scoped.error : prior?.scopedError;
  if (scopedError !== undefined) snap.scopedError = scopedError;
  return snap;
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
// Log-severity grading (transition-based)
// -----------------------------------------------------------------------------

// Coarse class of a fetch outcome. The exact errno/message varies (ENOTFOUND vs
// ETIMEDOUT vs ECONNRESET are all "the machine is offline"); grading keys on the
// class so roaming between them doesn't re-log. `ok` is a successful fetch.
export type UsageOutcomeKind = "ok" | "transient" | "rate-limited" | "auth" | "server";

// Map a persisted snapshot.error string back to its outcome kind, so the
// current attempt can tell whether it is a *new* episode or a repeat of the
// prior one. Unknown strings default to "transient" — the self-healing,
// non-actionable bucket — so an unrecognized error surfaces once (on the
// transition) and then stays quiet rather than warning every cycle.
export function classifyUsageErrorKind(error: string | undefined): UsageOutcomeKind {
  if (!error) return "ok";
  if (error === "rate-limited") return "rate-limited";
  if (error === "login expired" || error === "no Claude Code credentials found") return "auth";
  // A token-refresh failure is a network reach to the OAuth host — transient
  // and self-healing, not an actionable auth problem. Only a revoked/absent
  // refresh token lands as "login expired" (auth) above.
  if (error.startsWith("refresh failed")) return "transient";
  if (error.startsWith("http ") || error.startsWith("200 with unparseable body")) return "server";
  return "transient";
}

// The severity contract in log.ts, applied to usage fetch outcomes:
//   warn  — operator must act (auth expired/absent): actionable
//   info  — a lifecycle transition: the first cycle of a new error episode, or
//           recovery back to a good fetch
//   debug — "poll cycles with no transition": a repeat of the same error kind
//           (an offline laptop's 40th identical ENOTFOUND), suppressed from the
//           default info-level log but still present under GARDEN_LOG_LEVEL=debug
// This collapses an overnight-offline stretch from dozens of identical warnings
// to one episode-start line and one recovery line.
export function usageLogLevel(
  priorError: string | undefined,
  kind: UsageOutcomeKind,
): "debug" | "info" | "warn" {
  const priorKind = classifyUsageErrorKind(priorError);
  if (kind === "ok") return priorKind === "ok" ? "debug" : "info"; // recovery vs steady heartbeat
  if (kind === priorKind) return "debug"; // repeat of the same episode
  return kind === "auth" ? "warn" : "info"; // episode start
}

// Emit a fetch-outcome line at the transition-graded level. `data` is omitted
// from the entry when empty so a bare episode marker stays clean.
function logUsageOutcome(
  prior: UsageSnapshot | null | undefined,
  kind: Exclude<UsageOutcomeKind, "ok">,
  msg: string,
  data?: Record<string, unknown>,
): void {
  log[usageLogLevel(prior?.error, kind)]("usage", msg, data ? { data } : undefined);
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
// applicable backoff window (POLL_OK_MS for the poller, slightly longer for
// hooks), so a stuck claim self-heals rather than wedging the meter.
//
// `reason` is the caller's own cadence class and gates the healthy-snapshot
// age check. The poller claims with "poller" so a freshly respawned poller
// (dashboard restart) skips when the snapshot is inside POLL_OK_MS instead
// of firing an immediate fetch under the hook cooldown.
export async function refreshUsage(force = false, reason: RefreshReason = "hook"): Promise<UsageSnapshot> {
  const claim = withFileLock(USAGE_LOCK, () => {
    const prior = readUsageSnapshot();
    const decision = decideRefresh(prior, Date.now(), reason);
    // A forced refresh (manual `garden usage refresh`, post-login heal) bypasses
    // the auth and generic-error backoffs so a fresh login clears a stale "login
    // expired" snapshot immediately instead of echoing it for the next 30 min.
    // It deliberately does NOT bypass a 429 `rate-limited` backoff — the usage
    // endpoint is strictly rate-limited, so its retry-after is the one wait a
    // human-initiated refresh must still honor.
    const rateLimited = prior?.error === "rate-limited";
    const shouldRefresh = decision.shouldRefresh || (force && !rateLimited);
    if (!shouldRefresh && prior) {
      return { fetched: false as const, snap: prior };
    }
    const claimSnap: UsageSnapshot = {
      fetchedAt: new Date().toISOString(),
      ...(prior?.data ? { data: prior.data } : {}),
      ...(prior?.dataAt ? { dataAt: prior.dataAt } : (prior?.fetchedAt && prior.data ? { dataAt: prior.fetchedAt } : {})),
      ...(prior?.scopedAt ? { scopedAt: prior.scopedAt } : {}),
      ...(prior?.scopedAttemptedAt ? { scopedAttemptedAt: prior.scopedAttemptedAt } : {}),
    };
    writeUsageSnapshot(claimSnap);
    return { fetched: true as const, prior };
  }, { name: "claude-usage", deadlineMs: 5000 });

  if (!claim.fetched) return claim.snap;

  const prior = claim.prior;
  const resolved = await resolveCredential();
  if (!resolved.ok) {
    if (resolved.error === "no_credentials") {
      logUsageOutcome(prior, "auth", "no credentials");
      return finalizeSnapshot({
        fetchedAt: new Date().toISOString(),
        error: "no Claude Code credentials found",
      }, prior);
    }
    if (resolved.error === "login_expired") {
      logUsageOutcome(prior, "auth", "login expired", { detail: resolved.detail });
      return finalizeSnapshot({
        fetchedAt: new Date().toISOString(),
        error: "login expired",
        retryAfterMs: AUTH_BACKOFF_MS,
      }, prior);
    }
    // refresh_failed: transient (network/5xx during token refresh). Generic backoff, retry sooner.
    logUsageOutcome(prior, "transient", "token refresh failed", { detail: resolved.detail });
    return finalizeSnapshot({
      fetchedAt: new Date().toISOString(),
      error: `refresh failed: ${resolved.detail ?? "unknown"}`.slice(0, 200),
    }, prior);
  }
  const cred = resolved.cred;

  // Primary bars from response headers (every cycle); scoped bar from the
  // throttled oauth endpoint only when due (hourly) and only if the primary
  // token actually worked. assembleSnapshot folds both into the snapshot.
  const primary = await fetchPrimary(cred.token, prior);
  const scoped = await fetchScopedIfDue(cred.token, prior, force, primary);
  const fetchedAt = new Date().toISOString();
  const snap = assembleSnapshot(fetchedAt, primary, scoped, prior);
  writeUsageSnapshotLocked(snap);

  // Recovery from a prior error episode is a lifecycle transition (info); a
  // steady-state success is a heartbeat (debug, suppressed at the default
  // level). usageLogLevel(..., "ok") encodes exactly that split, so the log
  // gains a positive counterpart that closes out each error cluster.
  if (!primary.error && usageLogLevel(prior?.error, "ok") === "info") {
    log.info("usage", "fetch recovered", { data: { from: classifyUsageErrorKind(prior?.error) } });
  }
  if (!primary.error) {
    log.debug("usage", "fetched", {
      data: {
        source: cred.source,
        fiveHour: snap.data?.fiveHour?.pct,
        weekly: snap.data?.weekly?.pct,
        scoped: snap.data?.scoped?.map((s) => `${s.label} ${s.pct}%`),
        scopedFetched: scoped.fetched,
      },
    });
  }
  return snap;
}

// The primary fetch: unified rate-limit headers off a 1-token /v1/messages
// call. Governed by the generous messages limiter, so a 429 here means the
// account itself is at its cap (rare at our cadence) — we still honor it with
// the escalating backoff so we don't hammer. A 200 that somehow carries no
// unified headers is a soft failure: preserve the prior bars, surface a short
// error, and let the stale tag accrue rather than advancing dataAt onto empty
// data (which would silently freeze the meter). All outcomes preserve prior
// bars via assembleSnapshot; this only classifies + logs.
async function fetchPrimary(
  token: string,
  prior: UsageSnapshot | null | undefined,
): Promise<PrimaryOutcome> {
  try {
    const res = await fetchUsageHeaders(token);
    if (res.status === 200) {
      const data = parseUnifiedHeaders(res.headers);
      if (!data.fiveHour && !data.weekly) {
        logUsageOutcome(prior, "transient", "200 without unified rate-limit headers");
        return { data, error: { error: "no rate-limit headers" } };
      }
      return { data };
    }
    if (res.status === 429) {
      const { backoffMs, streak } = rateLimitBackoff(prior, res.retryAfterMs);
      // Attribute to the primary /v1/messages probe (the account 5h/weekly
      // meter) so the log distinguishes this — which freezes the bars — from a
      // scoped (Fable) endpoint 429, which does not. Both authenticate with the
      // same OAuth token, so the throttled scoped endpoint can burn shared
      // budget that lands here; scopedFetchDue's active-worker gate curbs that.
      logUsageOutcome(prior, "rate-limited", "account meter probe rate-limited", { retryAfterMs: res.retryAfterMs, backoffMs, streak });
      return { error: { error: "rate-limited", retryAfterMs: backoffMs, rateLimitStreak: streak } };
    }
    if (res.status === 401 || res.status === 403) {
      logUsageOutcome(prior, "auth", "auth failed", { status: res.status });
      // 401/403 isn't transient; back off AUTH_BACKOFF_MS so a dead token doesn't hammer (garden login overwrites the snapshot to heal early).
      return { error: { error: "login expired", retryAfterMs: AUTH_BACKOFF_MS } };
    }
    logUsageOutcome(prior, "server", "unexpected status", { status: res.status });
    return { error: { error: `http ${res.status}` } };
  } catch (err) {
    const { summary, data } = describeFetchError(err);
    logUsageOutcome(prior, "transient", "usage fetch failed", { error: summary, ...data });
    return { error: { error: summary } };
  }
}

// The secondary fetch: the model-scoped weekly bar (and extra-usage credits)
// from the throttled oauth endpoint. Skipped entirely unless the primary token
// worked (no point pinging the stricter endpoint with a dead/rate-limited
// token) and the cadence is due — hourly while a scoped-model (Fable) worker is
// actively running, else the slow idle keepalive (or a forced refresh). Every
// failure stays quiet at debug and never touches the primary bars; the scoped
// bar just keeps its last value. The failure is *surfaced* (onto the scoped
// row) only when a Fable worker was active or the operator forced it — i.e.
// when the bar is actually consequential — so an idle-keepalive miss stays fully
// silent.
async function fetchScopedIfDue(
  token: string,
  prior: UsageSnapshot | null | undefined,
  force: boolean,
  primary: PrimaryOutcome,
): Promise<ScopedOutcome> {
  if (primary.error) return { fetched: false };
  const active = anyScopedModelWorkerActive(prior, Date.now());
  if (!force && !scopedFetchDue(prior, Date.now(), active)) return { fetched: false };
  // A failure is only worth showing when the bar matters right now.
  const surface = (err: string): string | undefined => (active || force ? err : undefined);
  try {
    const res = await fetchUsageRaw(token);
    if (res.status === 200) {
      try {
        const d = normalizeUsage(JSON.parse(res.body));
        return { fetched: true, data: { scoped: d.scoped, extraUsage: d.extraUsage } };
      } catch {
        log.debug("usage", "scoped (Fable) fetch: unparseable body");
        return { fetched: true, error: surface("unparseable") };
      }
    }
    if (res.status === 429) {
      log.debug("usage", "scoped (Fable) fetch rate-limited — scoped bar keeps last value", { data: { retryAfterMs: res.retryAfterMs, active } });
      return { fetched: true, error: surface("rate-limited") };
    }
    log.debug("usage", "scoped (Fable) fetch: unexpected status", { data: { status: res.status } });
    return { fetched: true, error: surface(`http ${res.status}`) };
  } catch (err) {
    const { summary } = describeFetchError(err);
    log.debug("usage", "scoped (Fable) fetch failed", { data: { error: summary } });
    return { fetched: true, error: surface(summary) };
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
  // These credential-failure paths never reach either fetch, so carry the
  // scoped-cadence bookkeeping forward — otherwise a credential blip would drop
  // scopedAttemptedAt and force an off-cadence scoped refetch on recovery.
  if (prior?.scopedAt && merged.scopedAt === undefined) merged.scopedAt = prior.scopedAt;
  if (prior?.scopedAttemptedAt && merged.scopedAttemptedAt === undefined) {
    merged.scopedAttemptedAt = prior.scopedAttemptedAt;
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
const LABEL_WIDTH = 6; // widest fixed label; dynamic model labels are truncated to fit
const INDENT = "    ";  // 4-space indent mirrors worker rows in the status pane
const STALE_AFTER_MS = 30 * 60 * 1000; // 30 min — long enough to survive the endpoint's long rate-limit windows

// Fixed parts of a meter line (no bar, no reset): INDENT + LABEL + 2gap + 2gap + pct.
const FIXED_LINE_WIDTH = INDENT.length + LABEL_WIDTH + 2 + 2 + 4;
// "10d 23h" is the longest bare reset duration (2-space gap precedes it).
const RESET_TEXT_WIDTH = 7;

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

// Leading blank for breathing room under the pane-border label, then the
// meter rows (two flat bars plus one per model-scoped meter), then an optional
// one-line health tag *underneath* the meters when the snapshot is stale or in
// error. The tag is rendered once instead
// of repeated on every meter row — a long error like "refresh failed: network:
// getaddrinfo ENOTFOUND platform.claude.com" repeated on every row overflows
// the 112-col pane and wraps each meter row. Placing the tag below (and the
// pane auto-resizes by one row when it appears) keeps transient errors from
// dominating the visual top of the pane.
export function renderUsagePane(nowMs: number = Date.now(), paneWidth?: number): string {
  const claudeLines = buildClaudeLines(nowMs, paneWidth);

  // A second meter for Codex, in the empty space to the right. It appears once
  // any Codex process has reported rate_limits (read role-agnostically from the
  // newest rollout on the watchdog tick — codex-usage.ts), so a fleet that has
  // never run Codex leaves the pane unchanged. Claude keeps its full-width fit;
  // Codex fills the remainder.
  const codexSnap = readCodexUsage();
  if (!codexSnap || codexSnap.data.windows.length === 0) {
    return finalizePane(["", ...claudeLines]);
  }

  const leftWidth = Math.max(0, ...claudeLines.map(visibleWidth));
  const rightAvail = paneWidth !== undefined ? paneWidth - leftWidth - COLUMN_GAP : undefined;
  // Too narrow for a second column — stay single-column (data still captured,
  // shows once the terminal is wide enough).
  if (rightAvail !== undefined && rightAvail < CODEX_MIN_WIDTH) {
    return finalizePane(["", ...claudeLines]);
  }

  const codexLines = renderCodexColumn(codexSnap.data, nowMs, computeMeterFit(rightAvail));
  const codexWidth = Math.max(0, ...codexLines.map(visibleWidth));
  const gap = " ".repeat(computeColumnGap(paneWidth, leftWidth, codexWidth));
  // Keep the leading blank line: the two-column path used to spend it on the
  // header row, which put the column labels hard against the pane border and
  // read as cramped. The pane auto-sizes to its content, so the extra row costs
  // nothing but the space it is there to provide.
  // The labels are underlined: the rule runs the full width of the column it
  // heads, so it reads as a divider for the meters beneath rather than as
  // decoration on the word. A blank row follows it — the rule sits at the very
  // bottom of the label's cell, so without one the first meter bar butts
  // straight against it. A terminal only spaces in whole rows, so a full row is
  // the smallest gap available (operator call, 2026-07-21).
  const header =
    `${padVisible(`${INDENT}${columnHeader("claude", leftWidth - INDENT.length)}`, leftWidth)}` +
    `${gap}${columnHeader("codex", codexWidth)}`;
  const rows: string[] = ["", header, ""];
  const n = Math.max(claudeLines.length, codexLines.length);
  for (let i = 0; i < n; i++) {
    const left = claudeLines[i] ?? "";
    const right = codexLines[i];
    rows.push(right ? `${padVisible(left, leftWidth)}${gap}${right}` : left);
  }
  // Closing rule, mirroring the header's: each column's own width, so the two
  // rules stack into a pair of bounds around the meters. Its own row, with no
  // blank above — the rule rides the bottom of otherwise-empty cells, so the
  // row itself is the clearance.
  rows.push(
    `${padVisible(`${INDENT}${columnRule(leftWidth - INDENT.length)}`, leftWidth)}` +
    `${gap}${columnRule(codexWidth)}`,
  );
  return finalizePane(rows);
}

// The Claude column: the meter rows (5h / week / model-scoped) or a status message,
// without the leading blank/header line. Extracted so the two-column path can
// place it beside the Codex column.
function buildClaudeLines(nowMs: number, paneWidth: number | undefined): string[] {
  // Provider-only fleet: the poller is gated off (startUsagePoller), so the
  // snapshot would sit stale forever. Say why the meter is off.
  let metered = true;
  try { metered = anyAnthropicMeteredProject(); } catch { /* config unavailable: keep meter */ }
  if (!metered) return [`${INDENT}${dim("claude usage  off — every project uses a provider")}`];

  const snap = readUsageSnapshot();
  if (!snap) return [`${INDENT}${dim("claude usage  loading…")}`];
  if (!snap.data) return [`${INDENT}${dim(`claude usage  ${snap.error ?? "loading…"}`)}`];

  const tag = formatHealthTag(snap, nowMs);
  const d = snap.data;
  const fit = computeMeterFit(paneWidth);
  const lines: string[] = [];
  lines.push(renderMeterLine("5h",   d.fiveHour, nowMs, FIVE_HOUR_MS, fit));
  lines.push(renderMeterLine("week", d.weekly,   nowMs, SEVEN_DAY_MS, fit));
  // One bar per model-scoped weekly meter (Fable, etc.), labeled by the model.
  // No scoped meters → no extra row; a rolled-over window renders "—" per entry.
  for (const s of d.scoped ?? []) {
    lines.push(renderMeterLine(s.label.toLowerCase(), s, nowMs, SEVEN_DAY_MS, fit));
  }
  // Extra usage (pay-as-you-go credits) sits below the meters as a dim footnote
  // and above the health tag — real data first, freshness annotation last.
  if (d.extraUsage) lines.push(formatExtraUsageLine(d.extraUsage, paneWidth));
  if (tag) lines.push(formatHealthLine(tag, paneWidth));
  return lines;
}

// The Codex column: one bar per rolling window (already sorted smaller-first,
// so a 5h window renders above the 30d), plus a credits line when the account
// has a nonzero pay-as-you-go balance. Mirrors renderMeterLine; resetsAt is
// epoch seconds.
function renderCodexColumn(
  data: CodexUsageData,
  nowMs: number,
  fit: { barWidth: number; showReset: boolean },
): string[] {
  const lines: string[] = [];
  for (const w of data.windows) {
    const label = codexWindowLabel(w.windowMinutes).padEnd(LABEL_WIDTH);
    const resetsAtMs = w.resetsAt * 1000;
    // Window rolled over since capture — our pct describes the previous one.
    if (resetsAtMs <= nowMs) { lines.push(`${label}  ${dim("—")}`); continue; }
    const pct = Math.max(0, Math.min(100, w.usedPercent));
    const windowMs = w.windowMinutes * 60_000;
    const timePct = Math.max(0, Math.min(100, ((windowMs - (resetsAtMs - nowMs)) / windowMs) * 100));
    const bar = renderBar(pct, fit.barWidth, timePct);
    const pctText = `${pct.toFixed(0).padStart(3)}%`;
    const resetPart = fit.showReset ? `  ${dim(formatDurationBare(resetsAtMs - nowMs))}` : "";
    lines.push(`${label}  ${bar}  ${pctText}${resetPart}`);
  }
  // A zero balance is the steady state for a subscription account with no
  // pay-as-you-go credits — a permanent "$0.00" row carries no information, so
  // the footer only appears once there is a balance to watch.
  // "credits" (7 chars) is one wider than LABEL_WIDTH, so it overflows the
  // shared column instead of padding to it — harmless since this row has no
  // bar to keep aligned with the window rows above it.
  if (typeof data.creditBalance === "number" && data.creditBalance > 0) {
    lines.push(`${"credits".padEnd(LABEL_WIDTH)}  ${dim(`$${data.creditBalance.toFixed(2)}`)}`);
  } else if (data.creditsUnlimited) {
    lines.push(`${"credits".padEnd(LABEL_WIDTH)}  ${dim("unlimited")}`);
  }
  return lines;
}

// window_minutes -> a compact human label: 300 -> "5h", 10080 -> "week"
// (matching the Claude meter's weekly label rather than "7d"), 43200 -> "30d".
function codexWindowLabel(minutes: number): string {
  if (minutes === 10080) return "week";
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

// Minimum separation between the two columns — also what the fit check budgets
// for, so the Codex column is always measured against its tightest layout.
const COLUMN_GAP = 3;
// Ceiling on the widened gap. Past this the columns stop reading as a pair and
// start reading as two unrelated things at opposite edges, so extra slack is
// left on the right instead of being poured into the gap.
const MAX_COLUMN_GAP = 16;
// Right margin held back when widening, mirroring INDENT on the left so the
// content sits inside symmetric margins rather than running to the pane edge.
const RIGHT_MARGIN = INDENT.length;
const CODEX_MIN_WIDTH = MIN_BAR_WIDTH + LABEL_WIDTH + 8; // label + bar + "  NN%"

// Spread the two columns into the dead space on the right rather than leaving
// them bunched at the left with a ragged empty margin. The Codex column is
// rendered first at the minimum gap (so it is measured with the most room it
// could have), then pushed right by whatever slack is left over — which is why
// this can only ever consume existing emptiness, never overflow the pane.
function computeColumnGap(
  paneWidth: number | undefined,
  leftWidth: number,
  codexWidth: number,
): number {
  if (paneWidth === undefined) return COLUMN_GAP;
  const slack = paneWidth - leftWidth - codexWidth - RIGHT_MARGIN;
  return Math.max(COLUMN_GAP, Math.min(MAX_COLUMN_GAP, slack));
}

// Visible width ignoring the SGR color codes garden applies (the only escapes
// present in these lines), for aligning the two columns.
function visibleWidth(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}
function padVisible(s: string, width: number): string {
  const w = visibleWidth(s);
  return w >= width ? s : s + " ".repeat(width - w);
}
// Trailing blank to match the leading one: without it the last meter sits hard
// against the pane's bottom border (the status bar directly beneath it), which
// reads as cramped from below the same way the header did from above. The pane
// auto-sizes to its line count, so this costs the row it provides.
function finalizePane(lines: string[]): string {
  return [...lines, ""].map(l => l + "\x1b[K").join("\n");
}

// Indented, fully-dimmed footer row under the meters. Truncates with an
// ellipsis when the content would exceed the pane and wrap — wrapping would
// add extra rows to the pane height the auto-resize in writeUsageRendered
// doesn't budget for. Shared by the health tag and the extra-usage line.
function dimFooterLine(text: string, paneWidth: number | undefined): string {
  if (paneWidth === undefined) return `${INDENT}${dim(text)}`;
  const budget = Math.max(1, paneWidth - INDENT.length);
  const fitted = text.length <= budget ? text : text.slice(0, Math.max(1, budget - 1)) + "…";
  return `${INDENT}${dim(fitted)}`;
}

// Width-aware single-line health row, e.g. "(stale 2h, rate-limited)".
function formatHealthLine(tag: string, paneWidth: number | undefined): string {
  return dimFooterLine(`(${tag})`, paneWidth);
}

// Dim credit footer for pay-as-you-go extra usage. Not a resetting time-window
// bar — an absolute credit tally — so it renders as text under the meter bars
// with a matching label column, dimmed so it reads as a footnote rather than a
// peer resetting-window meter.
function formatExtraUsageLine(extra: ExtraUsage, paneWidth: number | undefined): string {
  const text = `${"extra".padEnd(LABEL_WIDTH)}  ${formatExtraUsageCredits(extra)}`;
  return dimFooterLine(text, paneWidth);
}

const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;

// Trust signal for the operator: when bars are real-time we say nothing
// (uncluttered). When data is unexpectedly old or the last fetch errored, the
// renderer surfaces a one-line tag below the meters so the source of trouble
// is obvious without digging through `garden logs`. A rate-limited tag also
// says when the next attempt fires (mirroring decideRefresh's required age),
// so a frozen meter carries its own recovery time instead of sending the
// operator to the Claude app. Returns the inner text (no parens, no ANSI) so
// the renderer can wrap, truncate, and dim. Examples:
//   no problems        → ""
//   data 2h old        → "stale 2h"
//   error after fresh  → "rate-limited, retrying in 1h 10m"
//   error + data old   → "stale 2h, rate-limited, retrying in 1h 10m"
function formatHealthTag(snap: UsageSnapshot, nowMs: number): string {
  const dataAt = Date.parse(snap.dataAt ?? snap.fetchedAt);
  const ageMs = Number.isFinite(dataAt) ? nowMs - dataAt : Infinity;
  const stale = ageMs > STALE_AFTER_MS;
  if (!snap.error && !stale && !snap.scopedError) return "";
  const parts: string[] = [];
  if (stale) parts.push(`stale ${formatBriefAge(ageMs)}`);
  // The primary error freezes the whole meter; name it as the account 5h/weekly
  // probe so it can't be mistaken for the model-scoped (Fable) fetch, which
  // never freezes the bars.
  if (snap.error === "rate-limited") parts.push("account meter rate-limited");
  else if (snap.error) parts.push(snap.error);
  if (snap.error === "rate-limited") {
    const fetchedAt = Date.parse(snap.fetchedAt);
    const retryAt = Number.isFinite(fetchedAt)
      ? fetchedAt + Math.max(snap.retryAfterMs ?? 0, RATE_LIMIT_FLOOR_MS)
      : NaN;
    if (Number.isFinite(retryAt) && retryAt > nowMs) {
      parts.push(`retrying ${formatDuration(retryAt - nowMs)}`);
    }
  }
  // A scoped (Fable) fetch failure holds that one bar at its last value — the
  // primary bars are still live. Surfaced (only when a Fable worker was active,
  // per fetchScopedIfDue) so the rate-limit is explicit on the bar it affects.
  if (snap.scopedError) {
    const label = snap.data?.scoped?.[0]?.label ?? "scoped";
    parts.push(`${label} meter ${snap.scopedError}`);
  }
  return parts.join(", ");
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
  windowMs: number | undefined,
  fit: { barWidth: number; showReset: boolean },
): string {
  const paddedLabel = label.length > LABEL_WIDTH ? label.slice(0, LABEL_WIDTH) : label.padEnd(LABEL_WIDTH);
  if (!meter) return `${INDENT}${paddedLabel}  ${dim("—")}`;
  const resetsAt = Date.parse(meter.resetsAt);
  // The server-side window has rolled over since our cached pct was fetched —
  // the bucket is in a new window and our pct describes the previous one.
  // Rendering the stale value as if it were current would lie until the next
  // successful poll; em-dash is the truthful "no current value" signal.
  if (Number.isFinite(resetsAt) && resetsAt <= nowMs) {
    return `${INDENT}${paddedLabel}  ${dim("—")}`;
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
    ? formatDurationBare(resetsAt - nowMs)
    : "";
  const resetPart = resetText ? `  ${dim(resetText)}` : "";
  return `${INDENT}${paddedLabel}  ${bar}  ${pctText}${resetPart}`;
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

// A column heading: the provider name in bold, then the underline carried
// across the rest of the column so the rule spans the meters it heads. Both
// runs pin the SAME explicit grey (90) rather than leaning on dim — a bold run
// with dim omitted inherits the default foreground and renders bright white,
// which read as a mismatch against the grey rule it continues into. Weight is
// the only difference between the two runs.
const HEADER_GREY = "90";
function columnHeader(name: string, width: number): string {
  return `\x1b[1;${HEADER_GREY};4m${name}\x1b[0m` + columnRule(width - name.length);
}

// A bare run of the same grey underline, no label. Heads nothing — it closes
// the meter block from below, so the column reads as bounded on both sides
// rather than trailing off into the pane. On its own row the rule paints at
// the bottom of empty cells, which is what supplies the clearance from the
// last meter above it (the header needed an explicit blank row for the same
// reason, in the other direction).
function columnRule(width: number): string {
  const rule = " ".repeat(Math.max(0, width));
  return rule ? `\x1b[${HEADER_GREY};4m${rule}\x1b[0m` : "";
}

export function formatDuration(ms: number): string {
  const bare = formatDurationBare(ms);
  return bare === "now" ? bare : `in ${bare}`;
}

// Bare duration with no "in"/"resets" wording, for the usage-pane meter rows
// where position (right after the pct) already reads as "time until reset".
function formatDurationBare(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "now";
  const totalMin = Math.floor(ms / 60000);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
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
  // After the cooldown check (cheap snapshot read) so the hook path only
  // pays a config read when a refresh would actually fire. Provider-only
  // fleets never refresh — same gate as startUsagePoller.
  try { if (!anyAnthropicMeteredProject()) return; } catch { /* config unavailable: refresh anyway */ }
  try {
    spawn("sh", ["-c", `${gardenRunner} dashboard _usage-refresh 2>/dev/null`], {
      detached: true,
      stdio: "ignore",
    }).unref();
  } catch { /* background poller will catch up within 10 minutes */ }
}

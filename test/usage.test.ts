import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  normalizeUsage,
  parseUnifiedHeaders,
  scopedFetchDue,
  scopedModelInUse,
  formatScopedAge,
  mergeUsageData,
  assembleSnapshot,
  formatDuration,
  formatExtraUsageCredits,
  formatBriefAge,
  shouldRefreshOnHookWith,
  decideRefresh,
  parseRetryAfter,
  describeFetchError,
  HOOK_REFRESH_COOLDOWN_MS,
  POLL_OK_MS,
  POLL_MIN_MS,
  SCOPED_POLL_MS,
  SCOPED_IDLE_POLL_MS,
  SCOPED_ACTIVE_MS,
  SCOPED_AGE_TAG_AFTER_MS,
  RATE_LIMIT_FLOOR_MS,
  RATE_LIMIT_MARGIN_MS,
  RATE_LIMIT_MAX_BACKOFF_MS,
  rateLimitBackoff,
  classifyUsageErrorKind,
  usageLogLevel,
  type UsageSnapshot,
  type PrimaryOutcome,
  type ScopedOutcome,
} from "../src/dashboard/usage.js";
import { useTmpHome } from "./helpers.js";

describe("normalizeUsage", () => {
  it("extracts the flat 5h/weekly meters and a scoped meter from the limits array", () => {
    const raw = {
      five_hour:        { utilization: 62, resets_at: "2026-04-15T20:00:00Z" },
      seven_day:        { utilization: 34, resets_at: "2026-04-19T04:00:00Z" },
      seven_day_sonnet: null,
      limits: [
        { kind: "weekly_scoped", percent: 4, resets_at: "2026-04-20T15:00:00Z",
          scope: { model: { id: null, display_name: "Fable" } } },
      ],
    };
    const out = normalizeUsage(raw);
    expect(out.fiveHour).toEqual({ pct: 62, resetsAt: "2026-04-15T20:00:00Z" });
    expect(out.weekly).toEqual({ pct: 34, resetsAt: "2026-04-19T04:00:00Z" });
    expect(out.scoped).toEqual([{ label: "Fable", pct: 4, resetsAt: "2026-04-20T15:00:00Z" }]);
  });

  it("parses multiple weekly_scoped limits and skips malformed / non-scoped entries", () => {
    const raw = {
      five_hour: { utilization: 5, resets_at: "2026-04-15T20:00:00Z" },
      limits: [
        { kind: "session", percent: 5, resets_at: "2026-04-15T20:00:00Z" }, // not scoped → ignored
        { kind: "weekly_scoped", percent: 12, resets_at: "2026-04-20T15:00:00Z",
          scope: { model: { id: null, display_name: "Fable" } } },
        { kind: "weekly_scoped", percent: 7, resets_at: "2026-04-20T15:00:00Z",
          scope: { model: { id: null, display_name: "Haiku" } } },
        { kind: "weekly_scoped", percent: "9", resets_at: "2026-04-20T15:00:00Z",
          scope: { model: { display_name: "BadPct" } } }, // wrong-typed pct → skipped
        { kind: "weekly_scoped", percent: 3, resets_at: "2026-04-20T15:00:00Z",
          scope: { model: {} } }, // no display_name → skipped
      ],
    };
    const out = normalizeUsage(raw);
    expect(out.scoped).toEqual([
      { label: "Fable", pct: 12, resetsAt: "2026-04-20T15:00:00Z" },
      { label: "Haiku", pct: 7, resetsAt: "2026-04-20T15:00:00Z" },
    ]);
  });

  it("treats null buckets as absent", () => {
    const raw = {
      five_hour:        { utilization: 4, resets_at: "2026-04-15T23:00:00Z" },
      seven_day:        { utilization: 32, resets_at: "2026-04-17T15:00:00Z" },
      seven_day_sonnet: null,
    };
    const out = normalizeUsage(raw);
    expect(out.fiveHour?.pct).toBe(4);
    expect(out.weekly?.pct).toBe(32);
    expect(out.scoped).toBeUndefined();
  });

  it("omits buckets with missing or wrong-typed fields instead of throwing", () => {
    const raw = {
      five_hour: { utilization: 10, resets_at: "2026-04-15T20:00:00Z" },
      seven_day: { utilization: "34", resets_at: "2026-04-19T04:00:00Z" }, // bad type
      seven_day_sonnet: null,
    };
    const out = normalizeUsage(raw);
    expect(out.fiveHour?.pct).toBe(10);
    expect(out.weekly).toBeUndefined();
    expect(out.scoped).toBeUndefined();
  });

  it("handles empty / non-object input gracefully", () => {
    expect(normalizeUsage(null)).toEqual({});
    expect(normalizeUsage("nope")).toEqual({});
    expect(normalizeUsage({})).toEqual({});
  });

  it("surfaces extra_usage only when enabled, defensively parsing partial buckets", () => {
    const base = { five_hour: { utilization: 5, resets_at: "2026-04-15T20:00:00Z" } };
    // Disabled → dropped so the pane adds no extra-usage footer row.
    expect(normalizeUsage({ ...base, extra_usage: { is_enabled: false, monthly_limit: 5000, used_credits: 0 } }).extraUsage)
      .toBeUndefined();
    // Enabled and fully populated.
    expect(normalizeUsage({ ...base, extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1234, utilization: 25 } }).extraUsage)
      .toEqual({ enabled: true, monthlyLimit: 5000, usedCredits: 1234, utilization: 25 });
    // Enabled but uncapped (null limit / utilization) → keeps only the fields it carries.
    expect(normalizeUsage({ ...base, extra_usage: { is_enabled: true, monthly_limit: null, used_credits: 1234, utilization: null } }).extraUsage)
      .toEqual({ enabled: true, usedCredits: 1234 });
  });
});

describe("parseUnifiedHeaders — primary bars from /v1/messages response headers", () => {
  // Real header values captured from a live probe: utilization is a 0..1
  // fraction, reset is unix epoch seconds.
  const live = {
    "anthropic-ratelimit-unified-5h-utilization": "0.62",
    "anthropic-ratelimit-unified-5h-reset": "1784145600",
    "anthropic-ratelimit-unified-7d-utilization": "0.61",
    "anthropic-ratelimit-unified-7d-reset": "1784458800",
    "anthropic-ratelimit-unified-5h-status": "allowed",
  };

  it("scales the 0..1 fraction to percent and converts epoch-seconds reset to ISO", () => {
    const out = parseUnifiedHeaders(live);
    expect(out.fiveHour).toEqual({ pct: 62, resetsAt: new Date(1784145600 * 1000).toISOString() });
    expect(out.weekly).toEqual({ pct: 61, resetsAt: new Date(1784458800 * 1000).toISOString() });
    // The headers carry no per-model bucket — the scoped bar never comes from here.
    expect(out.scoped).toBeUndefined();
  });

  it("omits a window whose utilization or reset header is missing", () => {
    const out = parseUnifiedHeaders({
      "anthropic-ratelimit-unified-5h-utilization": "0.5",
      // no 5h-reset → 5h dropped; no 7d headers at all → weekly dropped
    });
    expect(out.fiveHour).toBeUndefined();
    expect(out.weekly).toBeUndefined();
  });

  it("omits a window with a non-numeric header rather than emitting NaN", () => {
    const out = parseUnifiedHeaders({
      "anthropic-ratelimit-unified-5h-utilization": "n/a",
      "anthropic-ratelimit-unified-5h-reset": "1784145600",
    });
    expect(out.fiveHour).toBeUndefined();
  });

  it("returns an empty object when no unified headers are present", () => {
    expect(parseUnifiedHeaders({ "content-type": "application/json" })).toEqual({});
  });

  it("reads the first value when a header arrives as an array", () => {
    const out = parseUnifiedHeaders({
      "anthropic-ratelimit-unified-5h-utilization": ["0.4", "0.9"],
      "anthropic-ratelimit-unified-5h-reset": ["1784145600"],
    });
    expect(out.fiveHour?.pct).toBe(40);
  });
});

describe("scopedFetchDue — cadence for the throttled scoped fetch", () => {
  const now = Date.now();
  it("is due when the snapshot never attempted a scoped fetch (either cadence)", () => {
    expect(scopedFetchDue(null, now, true)).toBe(true);
    expect(scopedFetchDue(null, now, false)).toBe(true);
    expect(scopedFetchDue({ fetchedAt: new Date(now).toISOString() }, now, false)).toBe(true);
  });
  it("is not due within SCOPED_POLL_MS of the last attempt while a scoped worker is active", () => {
    const snap = { fetchedAt: "", scopedAttemptedAt: new Date(now - SCOPED_POLL_MS / 2).toISOString() };
    expect(scopedFetchDue(snap, now, true)).toBe(false);
  });
  it("becomes due once SCOPED_POLL_MS has elapsed while a scoped worker is active", () => {
    const snap = { fetchedAt: "", scopedAttemptedAt: new Date(now - SCOPED_POLL_MS - 1000).toISOString() };
    expect(scopedFetchDue(snap, now, true)).toBe(true);
  });
  it("holds the slow idle keepalive cadence when no scoped worker is active", () => {
    // An hour past the last attempt: due if active, but not on the idle cadence.
    const snap = { fetchedAt: "", scopedAttemptedAt: new Date(now - SCOPED_POLL_MS - 1000).toISOString() };
    expect(scopedFetchDue(snap, now, false)).toBe(false);
    const stale = { fetchedAt: "", scopedAttemptedAt: new Date(now - SCOPED_IDLE_POLL_MS - 1000).toISOString() };
    expect(scopedFetchDue(stale, now, false)).toBe(true);
  });
  it("gates on the last attempt, not the last success — a 429'd attempt still waits", () => {
    // scopedAt (success) is old, but scopedAttemptedAt (the 429) is recent.
    const snap = {
      fetchedAt: "",
      scopedAt: new Date(now - 3 * SCOPED_POLL_MS).toISOString(),
      scopedAttemptedAt: new Date(now - 60_000).toISOString(),
    };
    expect(scopedFetchDue(snap, now, true)).toBe(false);
  });
});

describe("scopedModelInUse — gate the Fable fetch on an active Fable worker", () => {
  const now = Date.now();
  const fresh = { lastEventAt: now - 60_000 };       // fired a hook a minute ago
  const stale = { lastEventAt: now - SCOPED_ACTIVE_MS - 60_000 }; // quiet for over an hour
  it("is true when a live worker's pinned model matches a scoped label", () => {
    const workers = [{ name: "w", model: "claude-fable-5", ...fresh }] as never;
    expect(scopedModelInUse(["Fable"], now, workers)).toBe(true);
  });
  it("falls back to matching 'fable' before any scoped label has been learned", () => {
    const workers = [{ name: "w", model: "claude-fable-5", ...fresh }] as never;
    expect(scopedModelInUse([], now, workers)).toBe(true);
  });
  it("matches a trellis vine's workerModel", () => {
    const workers = [{ name: "v", trellis: { name: "t", path: "/t", workerModel: "claude-fable-5" }, ...fresh }] as never;
    expect(scopedModelInUse(["Fable"], now, workers)).toBe(true);
  });
  it("is false when the matching worker has been quiet past the active window", () => {
    const workers = [{ name: "w", model: "claude-fable-5", ...stale }] as never;
    expect(scopedModelInUse(["Fable"], now, workers)).toBe(false);
  });
  it("is false when no live worker runs a scoped model", () => {
    const workers = [
      { name: "a", model: "claude-opus-4-8", ...fresh },
    ] as never;
    expect(scopedModelInUse(["Fable"], now, workers)).toBe(false);
  });
  it("is false for an unpinned worker when nothing can observe what it runs", () => {
    const workers = [{ name: "b", ...fresh }] as never; // account default, unknowable
    expect(scopedModelInUse(["Fable"], now, workers)).toBe(false);
  });

  // The pin is only a pin: an unpinned worker runs the account default, which is
  // routinely the scoped model itself. Reading the pin alone reported "idle" for
  // a fleet that was entirely Fable and froze the bar on the 12h keepalive.
  it("is true when an unpinned live worker is observed running a scoped model", () => {
    const workers = [{ name: "b", ...fresh }] as never;
    expect(scopedModelInUse(["Fable"], now, workers, () => "claude-fable-5")).toBe(true);
  });
  it("is false when an unpinned live worker is observed running an unscoped model", () => {
    const workers = [{ name: "b", ...fresh }] as never;
    expect(scopedModelInUse(["Fable"], now, workers, () => "claude-opus-5")).toBe(false);
  });
  it("prefers the pin over the observed model — no read when the pin answers", () => {
    const workers = [{ name: "w", model: "claude-fable-5", ...fresh }] as never;
    const observed = vi.fn(() => "claude-opus-5");
    expect(scopedModelInUse(["Fable"], now, workers, observed)).toBe(true);
    expect(observed).not.toHaveBeenCalled();
  });
  it("never observes a worker that is quiet past the active window", () => {
    const workers = [{ name: "w", ...stale }] as never;
    const observed = vi.fn(() => "claude-fable-5");
    expect(scopedModelInUse(["Fable"], now, workers, observed)).toBe(false);
    expect(observed).not.toHaveBeenCalled();
  });
});

describe("formatScopedAge — the scoped row's own freshness annotation", () => {
  const now = Date.now();
  it("is silent while the bar is within its active cadence", () => {
    expect(formatScopedAge(new Date(now - 40 * 60_000).toISOString(), now)).toBe("");
  });
  it("is silent right up to the threshold, so an hourly refresh never flickers it", () => {
    expect(formatScopedAge(new Date(now - SCOPED_AGE_TAG_AFTER_MS + 60_000).toISOString(), now)).toBe("");
  });
  it("carries the age once the bar outlives its cadence", () => {
    expect(formatScopedAge(new Date(now - 11 * 60 * 60_000).toISOString(), now)).toBe("11h old");
  });
  it("is silent when the scoped bar has never been fetched", () => {
    expect(formatScopedAge(undefined, now)).toBe("");
    expect(formatScopedAge("not-a-date", now)).toBe("");
  });
});

describe("mergeUsageData — layering the two sources over prior data", () => {
  const fh = { pct: 62, resetsAt: "2026-07-15T20:00:00Z" };
  const wk = { pct: 61, resetsAt: "2026-07-19T11:00:00Z" };
  const scopedFable = [{ pct: 41, resetsAt: "2026-07-19T11:00:00Z", label: "Fable" }];

  it("takes primary bars fresh and preserves prior scoped when scoped wasn't fetched", () => {
    const out = mergeUsageData({ fiveHour: fh, weekly: wk }, undefined, { scoped: scopedFable });
    expect(out.fiveHour).toEqual(fh);
    expect(out.weekly).toEqual(wk);
    expect(out.scoped).toEqual(scopedFable); // preserved from prior
  });

  it("preserves prior primary bars when the header fetch returned nothing", () => {
    const out = mergeUsageData(undefined, undefined, { fiveHour: fh, weekly: wk, scoped: scopedFable });
    expect(out.fiveHour).toEqual(fh);
    expect(out.weekly).toEqual(wk);
    expect(out.scoped).toEqual(scopedFable);
  });

  it("a fetched-but-empty scoped source is authoritative and drops a since-removed bar", () => {
    const out = mergeUsageData({ fiveHour: fh }, { scoped: undefined, extraUsage: undefined }, { scoped: scopedFable });
    expect(out.scoped).toBeUndefined(); // fresh scoped fetch says there is none
  });

  it("layers a freshly fetched scoped bar over primary header bars", () => {
    const out = mergeUsageData({ fiveHour: fh, weekly: wk }, { scoped: scopedFable }, undefined);
    expect(out.scoped).toEqual(scopedFable);
  });
});

describe("assembleSnapshot — folding fetch outcomes into the next snapshot", () => {
  const fetchedAt = "2026-07-15T17:00:00.000Z";
  const fh = { pct: 62, resetsAt: "2026-07-15T20:00:00Z" };
  const wk = { pct: 61, resetsAt: "2026-07-19T11:00:00Z" };
  const scopedFable = [{ pct: 41, resetsAt: "2026-07-19T11:00:00Z", label: "Fable" }];
  const prior: UsageSnapshot = {
    fetchedAt: "2026-07-15T16:50:00.000Z",
    dataAt: "2026-07-15T16:50:00.000Z",
    data: { fiveHour: { pct: 50, resetsAt: fh.resetsAt }, weekly: { pct: 55, resetsAt: wk.resetsAt }, scoped: scopedFable },
    scopedAt: "2026-07-15T16:20:00.000Z",
    scopedAttemptedAt: "2026-07-15T16:20:00.000Z",
  };

  it("advances dataAt only when a primary bar actually arrived", () => {
    const primary: PrimaryOutcome = { data: { fiveHour: fh, weekly: wk } };
    const scoped: ScopedOutcome = { fetched: false };
    const snap = assembleSnapshot(fetchedAt, primary, scoped, prior);
    expect(snap.dataAt).toBe(fetchedAt);
    expect(snap.data?.fiveHour).toEqual(fh);
    // scoped not fetched this cycle → prior bar + prior scoped timestamps preserved.
    expect(snap.data?.scoped).toEqual(scopedFable);
    expect(snap.scopedAt).toBe(prior.scopedAt);
    expect(snap.scopedAttemptedAt).toBe(prior.scopedAttemptedAt);
  });

  it("holds dataAt at the prior value when the header fetch failed (bars stay, stale accrues)", () => {
    const primary: PrimaryOutcome = { error: { error: "rate-limited", retryAfterMs: 90 * 60_000, rateLimitStreak: 1 } };
    const snap = assembleSnapshot(fetchedAt, primary, { fetched: false }, prior);
    expect(snap.dataAt).toBe(prior.dataAt); // not advanced onto missing data
    expect(snap.error).toBe("rate-limited");
    expect(snap.retryAfterMs).toBe(90 * 60_000);
    expect(snap.data?.fiveHour).toEqual(prior.data?.fiveHour); // preserved
  });

  it("does not advance dataAt for a 200 that carried no unified headers", () => {
    const primary: PrimaryOutcome = { data: {}, error: { error: "no rate-limit headers" } };
    const snap = assembleSnapshot(fetchedAt, primary, { fetched: false }, prior);
    expect(snap.dataAt).toBe(prior.dataAt);
    expect(snap.error).toBe("no rate-limit headers");
    expect(snap.data?.fiveHour).toEqual(prior.data?.fiveHour); // preserved bars
  });

  it("updates scopedAt and scopedAttemptedAt on a successful scoped fetch", () => {
    const primary: PrimaryOutcome = { data: { fiveHour: fh, weekly: wk } };
    const scoped: ScopedOutcome = { fetched: true, data: { scoped: scopedFable } };
    const snap = assembleSnapshot(fetchedAt, primary, scoped, prior);
    expect(snap.scopedAt).toBe(fetchedAt);
    expect(snap.scopedAttemptedAt).toBe(fetchedAt);
    expect(snap.data?.scoped).toEqual(scopedFable);
  });

  it("advances scopedAttemptedAt but NOT scopedAt when the scoped fetch failed", () => {
    const primary: PrimaryOutcome = { data: { fiveHour: fh, weekly: wk } };
    const scoped: ScopedOutcome = { fetched: true }; // attempted, no data (429/error)
    const snap = assembleSnapshot(fetchedAt, primary, scoped, prior);
    expect(snap.scopedAttemptedAt).toBe(fetchedAt); // spaces the next retry an hour out
    expect(snap.scopedAt).toBe(prior.scopedAt);     // bar freshness unchanged
    expect(snap.data?.scoped).toEqual(scopedFable); // last-good bar preserved
  });

  it("carries no scoped timestamps when none were ever set and none fetched", () => {
    const snap = assembleSnapshot(fetchedAt, { data: { fiveHour: fh } }, { fetched: false }, null);
    expect(snap.scopedAt).toBeUndefined();
    expect(snap.scopedAttemptedAt).toBeUndefined();
    expect(snap.dataAt).toBe(fetchedAt);
  });

  it("records a surfaced scoped error, preserves it across a not-fetched cycle, and clears it on success", () => {
    const primary: PrimaryOutcome = { data: { fiveHour: fh, weekly: wk } };
    // A surfaced scoped failure (Fable worker was active) → scopedError set.
    const failed = assembleSnapshot(fetchedAt, primary, { fetched: true, error: "rate-limited" }, prior);
    expect(failed.scopedError).toBe("rate-limited");
    // Next cycle, scoped not due → note carried forward with the held bar.
    const held = assembleSnapshot(fetchedAt, primary, { fetched: false }, failed);
    expect(held.scopedError).toBe("rate-limited");
    // A later successful scoped fetch clears the note.
    const ok = assembleSnapshot(fetchedAt, primary, { fetched: true, data: { scoped: scopedFable } }, held);
    expect(ok.scopedError).toBeUndefined();
  });

  it("leaves scopedError unset when a scoped miss was not surfaced (idle keepalive)", () => {
    const primary: PrimaryOutcome = { data: { fiveHour: fh, weekly: wk } };
    // fetched but no error field → an unsurfaced idle-keepalive miss stays quiet.
    const snap = assembleSnapshot(fetchedAt, primary, { fetched: true }, prior);
    expect(snap.scopedError).toBeUndefined();
  });
});

describe("formatExtraUsageCredits", () => {
  it("shows used / limit with utilization when fully populated", () => {
    expect(formatExtraUsageCredits({ enabled: true, monthlyLimit: 5000, usedCredits: 1234, utilization: 25 }))
      .toBe("1234 / 5000 credits (25%)");
  });
  it("rounds a fractional utilization", () => {
    expect(formatExtraUsageCredits({ enabled: true, monthlyLimit: 5000, usedCredits: 1234, utilization: 24.68 }))
      .toBe("1234 / 5000 credits (25%)");
  });
  it("falls back to used-only when the limit is absent", () => {
    expect(formatExtraUsageCredits({ enabled: true, usedCredits: 1234 })).toBe("1234 credits used");
  });
  it("falls back to limit-only when usage is absent", () => {
    expect(formatExtraUsageCredits({ enabled: true, monthlyLimit: 5000 })).toBe("5000 credits limit");
  });
  it("says 'enabled' when no figures are present", () => {
    expect(formatExtraUsageCredits({ enabled: true })).toBe("enabled");
  });
});

describe("describeFetchError", () => {
  it("summarizes a DNS lookup failure using syscall + code", () => {
    const err = Object.assign(new Error("getaddrinfo ENOTFOUND api.anthropic.com"), {
      code: "ENOTFOUND",
      errno: -3008,
      syscall: "getaddrinfo",
      hostname: "api.anthropic.com",
    });
    const { summary, data } = describeFetchError(err);
    expect(summary).toBe("getaddrinfo ENOTFOUND");
    expect(data.code).toBe("ENOTFOUND");
    expect(data.syscall).toBe("getaddrinfo");
    expect(data.hostname).toBe("api.anthropic.com");
    expect(data.errno).toBe(-3008);
    expect(data.message).toBe("getaddrinfo ENOTFOUND api.anthropic.com");
  });

  it("falls back to code alone when syscall is absent", () => {
    const err = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    const { summary, data } = describeFetchError(err);
    expect(summary).toBe("ECONNRESET");
    expect(data.code).toBe("ECONNRESET");
    expect(data.message).toBe("socket hang up");
  });

  it("uses the message when no code/syscall is set", () => {
    const err = new Error("timeout");
    const { summary } = describeFetchError(err);
    expect(summary).toBe("timeout");
  });

  it("returns a concrete fallback rather than empty when the error has no message or code", () => {
    const err = new Error("");
    const { summary } = describeFetchError(err);
    expect(summary).toBe("unknown error (no message or code)");
  });

  it("prefers the error's name over generic 'Error' when message is empty", () => {
    class AbortError extends Error {
      override name = "AbortError";
    }
    const err = new AbortError();
    const { summary } = describeFetchError(err);
    expect(summary).toBe("AbortError");
  });

  it("handles non-Error throws (strings, undefined) without crashing", () => {
    expect(describeFetchError("boom").summary).toBe("boom");
    expect(describeFetchError(undefined).summary).toBe("unknown error (no message or code)");
    expect(describeFetchError(null).summary).toBe("unknown error (no message or code)");
  });

  it("extracts cause fields when present (Node fetch wraps the underlying socket error)", () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), {
      code: "ECONNREFUSED",
    });
    const err = Object.assign(new Error("fetch failed"), { cause });
    const { data, summary } = describeFetchError(err);
    expect(summary).toBe("fetch failed");
    expect(data.causeCode).toBe("ECONNREFUSED");
    expect(data.causeMessage).toBe("connect ECONNREFUSED 127.0.0.1:443");
  });

  it("caps summary length so a runaway message can't blow out a log line", () => {
    const huge = "x".repeat(500);
    const { summary } = describeFetchError(new Error(huge));
    expect(summary.length).toBe(120);
  });
});

describe("normalizeUsage — schema-shift warning", () => {
  const env = useTmpHome();
  beforeEach(() => { vi.resetModules(); });

  async function importNormalize() {
    const mod = await import("../src/dashboard/usage.js");
    return mod.normalizeUsage;
  }

  function readUsageWarnings(): { data: { shape: unknown } }[] {
    const logFile = path.join(env.sessionsDir, "dashboard.log");
    if (!fs.existsSync(logFile)) return [];
    return fs.readFileSync(logFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((e) => e.level === "warn" && e.src === "usage");
  }

  it("stays quiet on a wrapped envelope whose buckets are all null (legit no-usage account)", async () => {
    const normalize = await importNormalize();
    const out = normalize({
      schema_version: 2,
      quota: {
        five_hour: null,
        seven_day: null,
        seven_day_sonnet: null,
      },
    });
    expect(out).toEqual({});
    expect(readUsageWarnings()).toHaveLength(0);
  });

  it("warns on a wrapped envelope whose bucket keys are renamed (real schema shift)", async () => {
    const normalize = await importNormalize();
    const out = normalize({
      schema_version: 2,
      quota: {
        // Top-level keys inside `quota` were renamed — none of our expected
        // bucket names appear, so this is unambiguously a schema rename
        // rather than an empty-bucket account.
        usage_5h:   { utilization: 50, resets_at: "2026-04-15T20:00:00Z" },
        usage_week: { utilization: 30, resets_at: "2026-04-19T04:00:00Z" },
      },
    });
    expect(out).toEqual({});
    const warns = readUsageWarnings();
    expect(warns).toHaveLength(1);
    // Preview targets the inner object so the rename inside `quota` is logged.
    const shape = warns[0].data.shape as Record<string, unknown>;
    expect(shape).toHaveProperty("usage_5h");
    expect(shape).toHaveProperty("usage_week");
  });
});

describe("formatDuration", () => {
  it("formats sub-hour durations as minutes", () => {
    expect(formatDuration(5 * 60_000)).toBe("in 5m");
    expect(formatDuration(45 * 60_000)).toBe("in 45m");
  });
  it("formats multi-hour durations with minutes", () => {
    expect(formatDuration((2 * 60 + 14) * 60_000)).toBe("in 2h 14m");
  });
  it("formats multi-day durations with hours", () => {
    expect(formatDuration((3 * 24 * 60 + 12 * 60) * 60_000)).toBe("in 3d 12h");
  });
  it("collapses past / zero durations to 'now'", () => {
    expect(formatDuration(0)).toBe("now");
    expect(formatDuration(-5000)).toBe("now");
  });
});

describe("shouldRefreshOnHookWith", () => {
  const now = Date.parse("2026-04-15T20:00:00Z");

  it("refreshes when no snapshot exists yet", () => {
    expect(shouldRefreshOnHookWith(null, now)).toBe(true);
  });

  it("refreshes when the snapshot is older than the cooldown", () => {
    const snap = { fetchedAt: new Date(now - HOOK_REFRESH_COOLDOWN_MS - 1000).toISOString() };
    expect(shouldRefreshOnHookWith(snap, now)).toBe(true);
  });

  it("skips when the snapshot is fresher than the cooldown", () => {
    const snap = { fetchedAt: new Date(now - 30_000).toISOString() };
    expect(shouldRefreshOnHookWith(snap, now)).toBe(false);
  });

  it("skips while the server's Retry-After window is still active", () => {
    const snap = {
      fetchedAt: new Date(now - 90_000).toISOString(),
      error: "rate-limited",
      retryAfterMs: 10 * 60_000,
    };
    expect(shouldRefreshOnHookWith(snap, now)).toBe(false);
  });

  it("allows refresh once the Retry-After window has passed", () => {
    const snap = {
      fetchedAt: new Date(now - 11 * 60_000).toISOString(),
      error: "rate-limited",
      retryAfterMs: 10 * 60_000,
    };
    expect(shouldRefreshOnHookWith(snap, now)).toBe(true);
  });

  it("refreshes when fetchedAt is unparseable (treat as unknown)", () => {
    const snap = { fetchedAt: "not-a-date" };
    expect(shouldRefreshOnHookWith(snap, now)).toBe(true);
  });
});

describe("renderUsagePane", () => {
  const env = useTmpHome();
  const now = Date.parse("2026-04-15T20:00:00Z");

  // usage.ts reads SESSIONS_DIR at module load — reset the cache inside each
  // test so the dynamic import below picks up the tmp HOME set by useTmpHome.
  beforeEach(() => { vi.resetModules(); });

  async function importRender() {
    const mod = await import("../src/dashboard/usage.js");
    return mod.renderUsagePane;
  }

  function writeSnapshot(snap: unknown) {
    fs.writeFileSync(path.join(env.sessionsDir, "claude-usage.json"), JSON.stringify(snap));
  }

  it("renders a loading line when no snapshot exists", async () => {
    const render = await importRender();
    const out = render(now);
    expect(out).toContain("loading");
  });

  it("renders an error line when the snapshot has an error", async () => {
    writeSnapshot({ fetchedAt: new Date(now).toISOString(), error: "rate-limited" });
    const render = await importRender();
    const out = render(now);
    expect(out).toContain("rate-limited");
  });

  it("tags the scoped row with its age once it outlives its own cadence", async () => {
    // The scoped bar refreshes on its own slow cadence, so it can be far older
    // than the primary bars without anything being wrong — but an hours-old bar
    // that renders identically to a live one is indistinguishable from a stuck
    // meter, which is exactly how a broken gate presented.
    writeSnapshot({
      fetchedAt: new Date(now).toISOString(),
      dataAt: new Date(now).toISOString(),
      scopedAt: new Date(now - 11 * 60 * 60_000).toISOString(),
      data: {
        fiveHour: { pct: 26, resetsAt: new Date(now + 2 * 60 * 60_000).toISOString() },
        weekly:   { pct: 35, resetsAt: new Date(now + 24 * 60 * 60_000).toISOString() },
        scoped:   [{ label: "Fable", pct: 85, resetsAt: new Date(now + 4 * 24 * 60 * 60_000).toISOString() }],
      },
    });
    const render = await importRender();
    const lines = render(now, 120).split("\n");
    const scopedRow = lines.find((l) => l.includes("fable"))!;
    expect(scopedRow).toContain("11h old");
    // The primary bars are current, so nothing else claims staleness.
    expect(lines.find((l) => l.includes("5h "))).not.toContain("old");
    expect(render(now, 120)).not.toContain("stale");
  });

  it("leaves the scoped row unannotated while it is within its cadence", async () => {
    writeSnapshot({
      fetchedAt: new Date(now).toISOString(),
      dataAt: new Date(now).toISOString(),
      scopedAt: new Date(now - 40 * 60_000).toISOString(),
      data: {
        fiveHour: { pct: 26, resetsAt: new Date(now + 2 * 60 * 60_000).toISOString() },
        scoped:   [{ label: "Fable", pct: 85, resetsAt: new Date(now + 4 * 24 * 60 * 60_000).toISOString() }],
      },
    });
    const render = await importRender();
    expect(render(now, 120)).not.toContain("old");
  });

  it("renders 5h, week, and a scoped model bar", async () => {
    writeSnapshot({
      fetchedAt: new Date(now).toISOString(),
      data: {
        fiveHour: { pct: 26, resetsAt: new Date(now + 2 * 60 * 60_000).toISOString() },
        weekly:   { pct: 35, resetsAt: new Date(now + 24 * 60 * 60_000).toISOString() },
        scoped:   [{ label: "Fable", pct: 4, resetsAt: new Date(now + 4 * 24 * 60 * 60_000).toISOString() }],
      },
    });
    const render = await importRender();
    const lines = render(now).split("\n");
    // Blank line above and below (breathing room inside the pane border) + 3 meters.
    expect(lines).toHaveLength(5);
    expect(lines[1]).toContain("5h");
    expect(lines[2]).toContain("week");
    expect(lines[3]).toContain("fable"); // model label, lowercased to match the column
    expect(lines[1]).toContain("26%");
    expect(lines[2]).toContain("35%");
    expect(lines[3]).toContain(" 4%");
  });

  it("renders one row per model-scoped meter, in array order", async () => {
    // The bar count is dynamic: two flat bars plus one per scoped meter. With
    // two scoped models the pane is five lines (blank + 5h + week + two model
    // bars), each labeled by its model in the response's array order.
    writeSnapshot({
      fetchedAt: new Date(now).toISOString(),
      data: {
        fiveHour: { pct: 26, resetsAt: new Date(now + 2 * 60 * 60_000).toISOString() },
        weekly:   { pct: 35, resetsAt: new Date(now + 24 * 60 * 60_000).toISOString() },
        scoped: [
          { label: "Fable", pct: 12, resetsAt: new Date(now + 4 * 24 * 60 * 60_000).toISOString() },
          { label: "Haiku", pct:  7, resetsAt: new Date(now + 4 * 24 * 60 * 60_000).toISOString() },
        ],
      },
    });
    const render = await importRender();
    const lines = render(now).split("\n");
    expect(lines).toHaveLength(6); // blank + 5h + week + fable + haiku + blank
    expect(lines[3]).toContain("fable");
    expect(lines[3]).toContain("12%");
    expect(lines[4]).toContain("haiku");
    expect(lines[4]).toContain(" 7%");
  });

  it("truncates a model-scoped label wider than the label column", async () => {
    // The label is data-driven now, so a display_name longer than LABEL_WIDTH
    // (6) must be truncated to keep the bar column aligned rather than pushing
    // the bar right and overflowing the pane.
    writeSnapshot({
      fetchedAt: new Date(now).toISOString(),
      data: {
        weekly: { pct: 35, resetsAt: new Date(now + 24 * 60 * 60_000).toISOString() },
        scoped: [{ label: "ClaudeSonnet", pct: 8, resetsAt: new Date(now + 4 * 24 * 60 * 60_000).toISOString() }],
      },
    });
    const render = await importRender();
    const lines = render(now).split("\n");
    const scopedLine = lines.find(l => l.includes("claude"));
    expect(scopedLine).toBeDefined();
    // Lowercased and truncated to the 6-char column — the full label never appears.
    expect(scopedLine).toContain("claud");
    expect(scopedLine).not.toContain("claudesonnet");
    // Alignment is preserved: the week and scoped rows share the same bar start.
    const weekLine = lines.find(l => l.includes("week"))!;
    const strip = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
    expect(strip(scopedLine!).indexOf("█")).toBe(strip(weekLine).indexOf("█"));
  });

  it("shows at least one filled cell for small non-zero percentages", async () => {
    // pct=1 would round to 0 cells at width 24 — the min-one-cell floor
    // keeps the bar visible. Marker is at cell 10 (3/7 elapsed), no collision.
    writeSnapshot({
      fetchedAt: new Date(now).toISOString(),
      data: {
        scoped: [{ label: "fable", pct: 1, resetsAt: new Date(now + 4 * 24 * 60 * 60_000).toISOString() }],
      },
    });
    const render = await importRender();
    const lines = render(now).split("\n");
    const scopedLine = lines.find(l => l.includes("fable"));
    expect(scopedLine).toBeDefined();
    expect(scopedLine).toMatch(/\u2588/);
  });

  it("overlays marker on green background when they collide", async () => {
    // pct=10 rounds to 2 filled cells (cells 0-1); marker is also at cell 1
    // (~4.3% of week elapsed). Cell 1 renders as green bg + bright marker fg
    // so both signals remain visible without the marker "eating" a cell.
    writeSnapshot({
      fetchedAt: new Date(now).toISOString(),
      data: {
        weekly: { pct: 10, resetsAt: new Date(now + (7 * 24 - 7.3) * 60 * 60_000).toISOString() },
      },
    });
    const render = await importRender();
    const lines = render(now).split("\n");
    const weekLine = lines.find(l => l.includes("week"));
    expect(weekLine).toBeDefined();
    expect(weekLine).toContain("\u2502");
    expect(weekLine).toMatch(/\x1b\[42m/);
  });

  it("never places the marker in cell 0 — a dim cell always precedes it", async () => {
    // Even at 0% time elapsed the marker shifts to cell 1, so the bar always
    // shows at least one leading dim cell to give the marker visual context.
    writeSnapshot({
      fetchedAt: new Date(now).toISOString(),
      data: {
        weekly: { pct: 0, resetsAt: new Date(now + 7 * 24 * 60 * 60_000).toISOString() },
      },
    });
    const render = await importRender();
    const lines = render(now).split("\n");
    const weekLine = lines.find(l => l.includes("week"));
    expect(weekLine).toBeDefined();
    // Strip ANSI to inspect cell positions.
    const visible = weekLine!.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
    const barStart = visible.indexOf("\u2591"); // first dim cell
    const markerPos = visible.indexOf("\u2502");
    expect(barStart).toBeGreaterThanOrEqual(0);
    expect(markerPos).toBeGreaterThan(barStart);
  });

  it("renders a scoped meter as an em-dash when its window has already reset", async () => {
    // A weekly_scoped entry whose resets_at is in the past describes a previous
    // window; an em-dash is the truer "no current value" signal than a stale
    // pct. Bar, percentage, and reset-text are all omitted.
    writeSnapshot({
      fetchedAt: new Date(now).toISOString(),
      dataAt:    new Date(now - 2 * 60 * 60_000).toISOString(),
      data: {
        weekly: { pct: 35, resetsAt: new Date(now + 1 * 24 * 60 * 60_000).toISOString() },
        scoped: [{ label: "fable", pct: 8, resetsAt: new Date(now - 60 * 60_000).toISOString() }],
      },
    });
    const render = await importRender();
    const lines = render(now).split("\n");
    const scopedLine = lines.find(l => l.includes("fable"));
    expect(scopedLine).toBeDefined();
    expect(scopedLine).toContain("\u2014");
    expect(scopedLine).not.toMatch(/\d+%/);
    expect(scopedLine).not.toContain("\u2588"); // no filled cells
    expect(scopedLine).not.toContain("\u2591"); // no dim cells
    expect(scopedLine).not.toContain("\u2502"); // no marker
  });

  it("renders no scoped row when there are no model-scoped meters", async () => {
    // The endpoint returns no weekly_scoped entry when no scoped usage has
    // accrued. There's simply no third bar then \u2014 the pane is two rows.
    writeSnapshot({
      fetchedAt: new Date(now).toISOString(),
      data: {
        fiveHour: { pct: 26, resetsAt: new Date(now + 2 * 60 * 60_000).toISOString() },
        weekly:   { pct: 35, resetsAt: new Date(now + 24 * 60 * 60_000).toISOString() },
      },
    });
    const render = await importRender();
    const lines = render(now).split("\n");
    expect(lines).toHaveLength(4); // leading blank + 5h + week + trailing blank
    expect(lines[1]).toContain("5h");
    expect(lines[2]).toContain("week");
  });

  it("renders em-dash for a bucket whose resetsAt has already passed", async () => {
    // Real-world scenario: a chain of failed fetches (e.g. transient DNS) leaves
    // the 5h bucket's cached resetsAt in the past while the weekly bucket is
    // still in its current window. Rendering the pre-reset pct would lie about
    // the bucket's true state. The post-reset bucket goes em-dash; siblings
    // still in window render normally.
    writeSnapshot({
      fetchedAt: new Date(now).toISOString(),
      dataAt:    new Date(now - 2 * 60 * 60_000).toISOString(),
      data: {
        fiveHour: { pct: 16, resetsAt: new Date(now - 60 * 60_000).toISOString() },
        weekly:   { pct: 42, resetsAt: new Date(now + 24 * 60 * 60_000).toISOString() },
      },
    });
    const render = await importRender();
    const lines = render(now).split("\n");
    const fiveLine = lines.find(l => l.includes("5h"));
    const weekLine = lines.find(l => l.includes("week"));
    expect(fiveLine).toBeDefined();
    expect(fiveLine).toContain("—");        // em-dash
    expect(fiveLine).not.toMatch(/16%/);          // pre-reset pct must not leak
    expect(fiveLine).not.toContain("█");    // no filled cells
    expect(weekLine).toContain("42%");            // sibling buckets unaffected
  });

  it("marks data stale with a compact age once dataAt > STALE_AFTER_MS old", async () => {
    writeSnapshot({
      fetchedAt: new Date(now - 60 * 60_000).toISOString(),
      data: {
        fiveHour: { pct: 26, resetsAt: new Date(now + 60 * 60_000).toISOString() },
      },
    });
    const render = await importRender();
    const out = render(now);
    expect(out).toContain("(stale 1h)");
  });

  it("appends clear-to-end-of-line to every line", async () => {
    writeSnapshot({
      fetchedAt: new Date(now).toISOString(),
      data: {
        fiveHour: { pct: 10, resetsAt: new Date(now + 60 * 60_000).toISOString() },
        weekly:   { pct: 20, resetsAt: new Date(now + 24 * 60 * 60_000).toISOString() },
        scoped:   [{ label: "fable", pct: 30, resetsAt: new Date(now + 3 * 24 * 60 * 60_000).toISOString() }],
      },
    });
    const render = await importRender();
    const lines = render(now).split("\n");
    for (const l of lines) expect(l).toMatch(/\x1b\[K$/);
  });

  it("renders a time marker on each bar based on window elapsed", async () => {
    // 5h meter: resetsAt in 1h → 4h elapsed out of 5h → 80% through window
    // week meter: resetsAt in 1d → 6d elapsed out of 7d → ~85.7%
    writeSnapshot({
      fetchedAt: new Date(now).toISOString(),
      data: {
        fiveHour: { pct: 26, resetsAt: new Date(now + 1 * 60 * 60_000).toISOString() },
        weekly:   { pct: 35, resetsAt: new Date(now + 1 * 24 * 60 * 60_000).toISOString() },
      },
    });
    const render = await importRender();
    const lines = render(now).split("\n");
    // The marker character │ (U+2502) should appear in both meter lines
    expect(lines[1]).toContain("\u2502"); // 5h
    expect(lines[2]).toContain("\u2502"); // week
  });

  it("omits time marker when resetsAt is unparseable", async () => {
    writeSnapshot({
      fetchedAt: new Date(now).toISOString(),
      data: {
        fiveHour: { pct: 50, resetsAt: "not-a-date" },
      },
    });
    const render = await importRender();
    const lines = render(now).split("\n");
    // Should still render the bar, just without a marker
    expect(lines[1]).toContain("50%");
    expect(lines[1]).not.toContain("\u2502");
  });

  it("shows an em-dash for a missing flat meter bucket instead of crashing", async () => {
    writeSnapshot({
      fetchedAt: new Date(now).toISOString(),
      data: {
        fiveHour: { pct: 42, resetsAt: new Date(now + 60 * 60_000).toISOString() },
        // weekly omitted; no scoped meters
      },
    });
    const render = await importRender();
    const lines = render(now).split("\n");
    // lines[0] is the leading blank; meters start at index 1.
    expect(lines[1]).toContain("42%");
    expect(lines[2]).toContain("\u2014");
    // No scoped meters \u2192 no third meter row.
    expect(lines).toHaveLength(4);
  });

  // Strips ANSI SGR + clear-to-EOL for display-width assertions.
  function visibleLen(s: string): number {
    return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").length;
  }

  it("fits within a narrow pane by shrinking the bar and dropping reset text", async () => {
    writeSnapshot({
      fetchedAt: new Date(now).toISOString(),
      data: {
        fiveHour: { pct: 26, resetsAt: new Date(now + 2 * 60 * 60_000).toISOString() },
        weekly:   { pct: 35, resetsAt: new Date(now + 24 * 60 * 60_000).toISOString() },
        scoped:   [{ label: "fable", pct: 4, resetsAt: new Date(now + 4 * 24 * 60 * 60_000).toISOString() }],
      },
    });
    const render = await importRender();
    // Simulates Cmd+ zoomed left column: ~32 cols wide.
    const lines = render(now, 32).split("\n");
    expect(lines).toHaveLength(5);
    for (const l of lines) expect(visibleLen(l)).toBeLessThanOrEqual(32);
    // Reset duration dropped at this width so the bar still has usable cells —
    // the line ends right after the pct, with no trailing "2h 0m".
    expect(lines[1].replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trimEnd()).toMatch(/26%$/);
  });

  it("keeps the reset duration at a moderately narrow width", async () => {
    writeSnapshot({
      fetchedAt: new Date(now).toISOString(),
      data: {
        fiveHour: { pct: 26, resetsAt: new Date(now + 2 * 60 * 60_000).toISOString() },
      },
    });
    const render = await importRender();
    // 48 cols has room for fixed(18) + minimum bar(6) + 2 + reset(7) = 33.
    const lines = render(now, 48).split("\n");
    for (const l of lines) expect(visibleLen(l)).toBeLessThanOrEqual(48);
    expect(lines[1].replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")).toContain("2h 0m");
  });

  it("renders preserved bars + error tag when data is fresh but last attempt failed", async () => {
    // After the 429-floor / data-preservation fix, a snapshot with a recent
    // `error` but prior `data` still shows bars. The error appears as an
    // inline tag on each row so the operator sees both the bars (still
    // accurate) and *why* refreshes are failing (without digging into logs).
    writeSnapshot({
      fetchedAt: new Date(now).toISOString(),
      error: "rate-limited",
      retryAfterMs: 0,
      dataAt: new Date(now - 60_000).toISOString(),
      data: {
        fiveHour: { pct: 42, resetsAt: new Date(now + 2 * 60 * 60_000).toISOString() },
        weekly:   { pct: 35, resetsAt: new Date(now + 24 * 60 * 60_000).toISOString() },
        scoped:   [{ label: "fable", pct: 4, resetsAt: new Date(now + 4 * 24 * 60 * 60_000).toISOString() }],
      },
    });
    const render = await importRender();
    const out = render(now);
    expect(out).toContain("42%");
    // retryAfterMs: 0 → countdown falls back to the floor decideRefresh enforces.
    // The primary rate-limit is labeled as the account meter (5h/weekly) probe,
    // distinct from a scoped (Fable) fetch miss.
    expect(out).toContain("(account meter rate-limited, retrying in 10m)");
    expect(out).not.toContain("stale"); // data within STALE_AFTER_MS — no stale prefix
  });

  it("combines stale-age and error in a single tag when both apply", async () => {
    writeSnapshot({
      fetchedAt: new Date(now).toISOString(),
      error: "rate-limited",
      dataAt: new Date(now - 2 * 60 * 60_000).toISOString(),
      data: {
        fiveHour: { pct: 42, resetsAt: new Date(now + 60 * 60_000).toISOString() },
      },
    });
    const render = await importRender();
    const out = render(now);
    expect(out).toContain("42%");
    expect(out).toContain("(stale 2h, account meter rate-limited, retrying in 10m)");
  });

  it("counts down to the next attempt from the stored rate-limit backoff", async () => {
    writeSnapshot({
      fetchedAt: new Date(now - 5 * 60_000).toISOString(),
      error: "rate-limited",
      retryAfterMs: 75 * 60_000,
      rateLimitStreak: 1,
      dataAt: new Date(now - 5 * 60_000).toISOString(),
      data: {
        fiveHour: { pct: 42, resetsAt: new Date(now + 60 * 60_000).toISOString() },
      },
    });
    const render = await importRender();
    expect(render(now)).toContain("(account meter rate-limited, retrying in 1h 10m)");
  });

  it("omits the countdown once the backoff window has passed", async () => {
    // Past-due means the next poller wake retries within a minute — a frozen
    // "retrying now" would outlive its own promise if the poller is dead, so
    // the tag reverts to the plain error.
    writeSnapshot({
      fetchedAt: new Date(now - 80 * 60_000).toISOString(),
      error: "rate-limited",
      retryAfterMs: 75 * 60_000,
      dataAt: new Date(now - 80 * 60_000).toISOString(),
      data: {
        fiveHour: { pct: 42, resetsAt: new Date(now + 60 * 60_000).toISOString() },
      },
    });
    const render = await importRender();
    const out = render(now);
    expect(out).toContain("stale 1h, account meter rate-limited");
    expect(out).not.toContain("retrying");
  });

  it("renders the health tag once on its own line below the meters, not appended to meter rows", async () => {
    // Repeating the tag across all three meter rows overflows a long error
    // (e.g. a network DNS message) and wraps each row. The tag must occupy a
    // single line *below* the meters, where transient errors don't dominate
    // the visual top of the pane.
    writeSnapshot({
      fetchedAt: new Date(now).toISOString(),
      error: "rate-limited",
      dataAt: new Date(now - 2 * 60 * 60_000).toISOString(),
      data: {
        fiveHour: { pct: 42, resetsAt: new Date(now + 60 * 60_000).toISOString() },
        weekly:   { pct: 35, resetsAt: new Date(now + 24 * 60 * 60_000).toISOString() },
        scoped:   [{ label: "fable", pct: 4, resetsAt: new Date(now + 4 * 24 * 60 * 60_000).toISOString() }],
      },
    });
    const render = await importRender();
    const lines = render(now).split("\n");
    // Leading blank + 3 meters + 1 tag + trailing blank = 6 lines when an error is present.
    expect(lines).toHaveLength(6);
    expect(lines[4]).toContain("(stale 2h, account meter rate-limited, retrying in 10m)");
    for (const l of lines.slice(0, 4)) {
      expect(l).not.toContain("stale");
      expect(l).not.toContain("rate-limited");
    }
  });

  it("omits the trailing tag line when the snapshot is healthy", async () => {
    // When there's nothing wrong, the pane stays at its natural 4-line height
    // (leading blank + 3 meters) — no empty trailing row.
    writeSnapshot({
      fetchedAt: new Date(now).toISOString(),
      data: {
        fiveHour: { pct: 26, resetsAt: new Date(now + 2 * 60 * 60_000).toISOString() },
        weekly:   { pct: 35, resetsAt: new Date(now + 24 * 60 * 60_000).toISOString() },
        scoped:   [{ label: "fable", pct: 4, resetsAt: new Date(now + 4 * 24 * 60 * 60_000).toISOString() }],
      },
    });
    const render = await importRender();
    const lines = render(now).split("\n");
    expect(lines).toHaveLength(5);
  });

  it("surfaces a scoped (Fable) fetch error as a health tag without freezing the primary bars", async () => {
    // scopedError set (a Fable worker was active when the scoped fetch 429'd),
    // but no primary error and data fresh → the primary bars render normally and
    // the tag names the Fable meter specifically, on its own line below.
    writeSnapshot({
      fetchedAt: new Date(now).toISOString(),
      dataAt: new Date(now).toISOString(),
      scopedError: "rate-limited",
      data: {
        fiveHour: { pct: 26, resetsAt: new Date(now + 2 * 60 * 60_000).toISOString() },
        weekly:   { pct: 35, resetsAt: new Date(now + 24 * 60 * 60_000).toISOString() },
        scoped:   [{ label: "Fable", pct: 4, resetsAt: new Date(now + 4 * 24 * 60 * 60_000).toISOString() }],
      },
    });
    const render = await importRender();
    const lines = render(now).split("\n");
    // Leading blank + 3 meters + 1 scoped-error tag + trailing blank = 6 lines.
    expect(lines).toHaveLength(6);
    expect(lines[1]).toContain("26%"); // primary bar still live
    expect(lines[4]).toContain("(Fable meter rate-limited)");
    expect(lines[4]).not.toContain("account meter"); // not the freezing primary error
  });

  it("truncates a long health tag with an ellipsis to fit paneWidth", async () => {
    // Defense against a wide-but-not-wide-enough pane: if the tag itself would
    // wrap, truncate so it stays on a single line below the meters.
    writeSnapshot({
      fetchedAt: new Date(now).toISOString(),
      error: "refresh failed: network: getaddrinfo ENOTFOUND platform.claude.com",
      dataAt: new Date(now).toISOString(),
      data: {
        fiveHour: { pct: 42, resetsAt: new Date(now + 60 * 60_000).toISOString() },
      },
    });
    const render = await importRender();
    const lines = render(now, 40).split("\n");
    const tagLine = lines[lines.length - 2]; // above the trailing blank
    const visible = tagLine.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
    expect(visible.length).toBeLessThanOrEqual(40);
    expect(visible).toContain("…"); // ellipsis
  });

  it("renders a dim extra-usage credit footer under the meters when enabled", async () => {
    writeSnapshot({
      fetchedAt: new Date(now).toISOString(),
      data: {
        fiveHour: { pct: 26, resetsAt: new Date(now + 2 * 60 * 60_000).toISOString() },
        weekly:   { pct: 35, resetsAt: new Date(now + 24 * 60 * 60_000).toISOString() },
        scoped:   [{ label: "fable", pct: 4, resetsAt: new Date(now + 4 * 24 * 60 * 60_000).toISOString() }],
        extraUsage: { enabled: true, monthlyLimit: 5000, usedCredits: 1234, utilization: 25 },
      },
    });
    const render = await importRender();
    const lines = render(now).split("\n");
    // Leading blank + 3 meters + 1 extra footer + trailing blank = 6 lines.
    expect(lines).toHaveLength(6);
    const extraLine = lines[4];
    expect(extraLine).toContain("extra");
    expect(extraLine).toContain("1234 / 5000 credits (25%)");
    expect(extraLine).toContain("\x1b[2m"); // fully dimmed footer
    expect(extraLine).not.toContain("█"); // not a bar
  });

  it("places the extra-usage footer above the health tag when both are present", async () => {
    writeSnapshot({
      fetchedAt: new Date(now).toISOString(),
      error: "rate-limited",
      dataAt: new Date(now - 2 * 60 * 60_000).toISOString(),
      data: {
        fiveHour: { pct: 42, resetsAt: new Date(now + 60 * 60_000).toISOString() },
        weekly:   { pct: 35, resetsAt: new Date(now + 24 * 60 * 60_000).toISOString() },
        scoped:   [{ label: "fable", pct: 4, resetsAt: new Date(now + 4 * 24 * 60 * 60_000).toISOString() }],
        extraUsage: { enabled: true, monthlyLimit: 5000, usedCredits: 1234, utilization: 25 },
      },
    });
    const render = await importRender();
    const lines = render(now).split("\n");
    // Leading blank + 3 meters + extra footer + health tag + trailing blank = 7 lines.
    expect(lines).toHaveLength(7);
    expect(lines[4]).toContain("1234 / 5000 credits");
    expect(lines[5]).toContain("(stale 2h, account meter rate-limited, retrying in 10m)");
  });

  it("degrades an uncapped extra-usage bucket to the fields it carries", async () => {
    writeSnapshot({
      fetchedAt: new Date(now).toISOString(),
      data: {
        fiveHour: { pct: 26, resetsAt: new Date(now + 2 * 60 * 60_000).toISOString() },
        extraUsage: { enabled: true, usedCredits: 1234 },
      },
    });
    const render = await importRender();
    const extraLine = render(now).split("\n").find(l => l.includes("extra"));
    expect(extraLine).toBeDefined();
    expect(extraLine).toContain("1234 credits used");
    expect(extraLine).not.toContain("/"); // no limit → no "used / limit" form
  });

  it("truncates a wide extra-usage footer to fit a narrow pane", async () => {
    writeSnapshot({
      fetchedAt: new Date(now).toISOString(),
      data: {
        fiveHour: { pct: 26, resetsAt: new Date(now + 2 * 60 * 60_000).toISOString() },
        extraUsage: { enabled: true, monthlyLimit: 500000, usedCredits: 123456, utilization: 25 },
      },
    });
    const render = await importRender();
    const lines = render(now, 24).split("\n");
    const extraLine = lines.find(l => l.includes("extra"))!;
    const visible = extraLine.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
    expect(visible.length).toBeLessThanOrEqual(24);
    expect(visible).toContain("…");
  });
});

describe("formatBriefAge", () => {
  it("formats sub-hour ages as minutes", () => {
    expect(formatBriefAge(0)).toBe("0m");
    expect(formatBriefAge(45 * 60_000)).toBe("45m");
  });
  it("formats sub-2-day ages as hours", () => {
    expect(formatBriefAge(3 * 60 * 60_000)).toBe("3h");
    expect(formatBriefAge(47 * 60 * 60_000)).toBe("47h");
  });
  it("formats multi-day ages as days", () => {
    expect(formatBriefAge(2 * 24 * 60 * 60_000)).toBe("2d");
    expect(formatBriefAge(10 * 24 * 60 * 60_000)).toBe("10d");
  });
  it("returns ? for nonsensical inputs", () => {
    expect(formatBriefAge(NaN)).toBe("?");
    expect(formatBriefAge(-1)).toBe("?");
  });
});

describe("parseRetryAfter", () => {
  const now = Date.parse("2026-04-15T20:00:00Z");

  it("parses delta-seconds form", () => {
    expect(parseRetryAfter("120", now)).toBe(120_000);
    expect(parseRetryAfter("0", now)).toBe(0);
  });

  it("parses HTTP-date form (RFC 9110)", () => {
    const future = new Date(now + 5 * 60_000).toUTCString();
    const ms = parseRetryAfter(future, now);
    expect(ms).toBeGreaterThanOrEqual(5 * 60_000 - 1000);
    expect(ms).toBeLessThanOrEqual(5 * 60_000 + 1000);
  });

  it("returns 0 (not negative) for past HTTP-dates", () => {
    const past = new Date(now - 10 * 60_000).toUTCString();
    expect(parseRetryAfter(past, now)).toBe(0);
  });

  it("returns undefined for missing or unparseable input", () => {
    expect(parseRetryAfter(undefined, now)).toBeUndefined();
    expect(parseRetryAfter("", now)).toBeUndefined();
    expect(parseRetryAfter("not a date", now)).toBeUndefined();
    expect(parseRetryAfter(123 as unknown as string, now)).toBeUndefined();
  });
});

describe("decideRefresh — rate-limit floor", () => {
  const now = Date.parse("2026-04-15T20:00:00Z");

  // The bug we fixed: a snapshot with `error: "rate-limited", retryAfterMs: 0`
  // used to fall through both guards (the `&&` against falsy 0). With the
  // floor in place, both hook and poller honor RATE_LIMIT_FLOOR_MS.
  it("does not refresh when rate-limited with retryAfterMs:0 inside the floor", () => {
    const snap = {
      fetchedAt: new Date(now - 60_000).toISOString(),
      error: "rate-limited",
      retryAfterMs: 0,
    };
    expect(decideRefresh(snap, now, "hook").shouldRefresh).toBe(false);
    expect(decideRefresh(snap, now, "poller").shouldRefresh).toBe(false);
  });

  it("does not refresh when rate-limited with retryAfterMs absent", () => {
    const snap = {
      fetchedAt: new Date(now - 60_000).toISOString(),
      error: "rate-limited",
    };
    expect(decideRefresh(snap, now, "hook").shouldRefresh).toBe(false);
  });

  it("allows refresh once the rate-limit floor has elapsed", () => {
    const snap = {
      fetchedAt: new Date(now - RATE_LIMIT_FLOOR_MS - 1000).toISOString(),
      error: "rate-limited",
      retryAfterMs: 0,
    };
    expect(decideRefresh(snap, now, "hook").shouldRefresh).toBe(true);
  });

  it("honors a server-provided retryAfterMs when larger than the floor", () => {
    const longBackoff = 50 * 60_000; // observed ~50min after 3 rapid probes
    const snap = {
      fetchedAt: new Date(now - 10 * 60_000).toISOString(),
      error: "rate-limited",
      retryAfterMs: longBackoff,
    };
    expect(decideRefresh(snap, now, "hook").shouldRefresh).toBe(false);
    // sleep target is at least the remaining backoff (40 min, plus 1s buffer).
    expect(decideRefresh(snap, now, "poller").nextAttemptInMs)
      .toBeGreaterThanOrEqual(40 * 60_000);
  });

  it("nextAttemptInMs is always >= POLL_MIN_MS", () => {
    const snap = { fetchedAt: new Date(now - 24 * 60 * 60_000).toISOString() };
    expect(decideRefresh(snap, now, "poller").nextAttemptInMs)
      .toBeGreaterThanOrEqual(POLL_MIN_MS);
  });

  it("uses POLL_OK_MS as the poller cadence on a healthy snapshot", () => {
    const snap = { fetchedAt: new Date(now).toISOString(), data: {} };
    const decision = decideRefresh(snap, now, "poller");
    expect(decision.shouldRefresh).toBe(false);
    // Just-fetched snapshot: next attempt ~ POLL_OK_MS away (plus small buffer).
    expect(decision.nextAttemptInMs).toBeGreaterThanOrEqual(POLL_OK_MS);
    expect(decision.nextAttemptInMs).toBeLessThanOrEqual(POLL_OK_MS + 5000);
  });
});

describe("decideRefresh — hook is a poller-liveness backstop", () => {
  const now = Date.parse("2026-04-15T20:00:00Z");

  // The ordering the whole budget math rests on: a live poller always fetches
  // first, so turn-end hooks add zero traffic in steady state.
  it("keeps the hook cooldown above the poller cadence", () => {
    expect(HOOK_REFRESH_COOLDOWN_MS).toBeGreaterThan(POLL_OK_MS);
  });

  it("lets the poller refresh a snapshot the hook still considers fresh", () => {
    const snap = { fetchedAt: new Date(now - POLL_OK_MS - 1000).toISOString(), data: {} };
    expect(decideRefresh(snap, now, "poller").shouldRefresh).toBe(true);
    expect(decideRefresh(snap, now, "hook").shouldRefresh).toBe(false);
  });

  it("lets the hook refresh once the poller has missed its window", () => {
    const snap = { fetchedAt: new Date(now - HOOK_REFRESH_COOLDOWN_MS - 1000).toISOString(), data: {} };
    expect(decideRefresh(snap, now, "hook").shouldRefresh).toBe(true);
  });
});

describe("rateLimitBackoff — margin and escalation", () => {
  const serverHour = 60 * 60_000; // the fixed Retry-After: 3600 observed since 2026-07

  it("adds the margin to the server hint on a first 429", () => {
    const out = rateLimitBackoff({ fetchedAt: "x" }, serverHour);
    expect(out).toEqual({ backoffMs: serverHour + RATE_LIMIT_MARGIN_MS, streak: 1 });
  });

  it("starts at streak 1 with no prior snapshot", () => {
    const out = rateLimitBackoff(null, serverHour);
    expect(out.streak).toBe(1);
  });

  it("doubles on a consecutive 429 and caps at the maximum", () => {
    const first = rateLimitBackoff({ fetchedAt: "x" }, serverHour);
    const second = rateLimitBackoff(
      { fetchedAt: "x", error: "rate-limited", rateLimitStreak: first.streak },
      serverHour,
    );
    expect(second).toEqual({ backoffMs: 2 * (serverHour + RATE_LIMIT_MARGIN_MS), streak: 2 });
    const third = rateLimitBackoff(
      { fetchedAt: "x", error: "rate-limited", rateLimitStreak: second.streak },
      serverHour,
    );
    // 4 × 75min = 300min exceeds the 4h ceiling.
    expect(third).toEqual({ backoffMs: RATE_LIMIT_MAX_BACKOFF_MS, streak: 3 });
  });

  it("treats a legacy rate-limited snapshot without a streak field as streak 1", () => {
    const out = rateLimitBackoff({ fetchedAt: "x", error: "rate-limited" }, serverHour);
    expect(out.streak).toBe(2);
  });

  it("resets the streak when the prior attempt failed for a non-429 reason", () => {
    const out = rateLimitBackoff(
      { fetchedAt: "x", error: "getaddrinfo ENOTFOUND", rateLimitStreak: 3 },
      serverHour,
    );
    expect(out.streak).toBe(1);
  });

  it("floors a missing/zero server hint before adding the margin", () => {
    const out = rateLimitBackoff({ fetchedAt: "x" }, undefined);
    expect(out.backoffMs).toBe(RATE_LIMIT_FLOOR_MS + RATE_LIMIT_MARGIN_MS);
  });
});

describe("classifyUsageErrorKind — persisted error string → coarse kind", () => {
  it("maps a successful (absent) error to ok", () => {
    expect(classifyUsageErrorKind(undefined)).toBe("ok");
    expect(classifyUsageErrorKind("")).toBe("ok");
  });

  it("maps the rate-limit sentinel to rate-limited", () => {
    expect(classifyUsageErrorKind("rate-limited")).toBe("rate-limited");
  });

  it("maps actionable credential failures to auth", () => {
    expect(classifyUsageErrorKind("login expired")).toBe("auth");
    expect(classifyUsageErrorKind("no Claude Code credentials found")).toBe("auth");
  });

  it("maps a token-refresh network failure to transient, not auth", () => {
    // The 'refresh failed: ...' bucket is a network reach to the OAuth host —
    // self-healing offline noise, not an actionable re-login prompt.
    expect(classifyUsageErrorKind("refresh failed: network: getaddrinfo ENOTFOUND platform.claude.com")).toBe("transient");
  });

  it("maps http-status and unparseable-body errors to server", () => {
    expect(classifyUsageErrorKind("http 503")).toBe("server");
    expect(classifyUsageErrorKind("http 529")).toBe("server");
    expect(classifyUsageErrorKind("200 with unparseable body: SyntaxError")).toBe("server");
  });

  it("maps socket/DNS errors — and any unknown string — to transient", () => {
    expect(classifyUsageErrorKind("getaddrinfo ENOTFOUND")).toBe("transient");
    expect(classifyUsageErrorKind("timeout")).toBe("transient");
    expect(classifyUsageErrorKind("read ECONNRESET")).toBe("transient");
    expect(classifyUsageErrorKind("connect EHOSTUNREACH 160.79.104.10:443")).toBe("transient");
    expect(classifyUsageErrorKind("some error we have never seen")).toBe("transient");
    // The header-source soft failure classifies as transient so a header outage
    // collapses to one info line + debug repeats, not a warn every poll.
    expect(classifyUsageErrorKind("no rate-limit headers")).toBe("transient");
  });
});

describe("usageLogLevel — transition-graded severity (log.ts's own contract)", () => {
  it("a steady-state success is a debug heartbeat; recovery from an error is info", () => {
    expect(usageLogLevel(undefined, "ok")).toBe("debug"); // ok → ok
    expect(usageLogLevel("rate-limited", "ok")).toBe("info"); // recovery
    expect(usageLogLevel("timeout", "ok")).toBe("info"); // recovery from offline
  });

  it("the first cycle of a self-healing episode is info; every repeat is debug", () => {
    expect(usageLogLevel(undefined, "transient")).toBe("info"); // episode start
    expect(usageLogLevel("timeout", "transient")).toBe("debug"); // repeat
    expect(usageLogLevel(undefined, "rate-limited")).toBe("info"); // first 429
    expect(usageLogLevel("rate-limited", "rate-limited")).toBe("debug"); // repeat 429
    expect(usageLogLevel("http 500", "server")).toBe("debug"); // repeat 5xx
  });

  it("collapses roaming between different offline errno of the same kind to debug", () => {
    // ENOTFOUND then ETIMEDOUT then ECONNRESET are all 'offline' — a laptop
    // moving between networks must NOT re-warn on each distinct errno.
    expect(usageLogLevel("getaddrinfo ENOTFOUND", "transient")).toBe("debug");
    expect(usageLogLevel("read ECONNRESET", "transient")).toBe("debug");
  });

  it("keeps an actionable auth failure at warn even in the middle of an offline stretch", () => {
    expect(usageLogLevel(undefined, "auth")).toBe("warn"); // first
    expect(usageLogLevel("timeout", "auth")).toBe("warn"); // transient → auth: a new actionable condition
    expect(usageLogLevel("login expired", "auth")).toBe("debug"); // repeat auth stays quiet
    expect(usageLogLevel("no Claude Code credentials found", "auth")).toBe("debug"); // same kind
  });

  it("logs the transition into a new kind at that kind's level", () => {
    expect(usageLogLevel("rate-limited", "transient")).toBe("info"); // 429 → offline
    expect(usageLogLevel("timeout", "rate-limited")).toBe("info"); // offline → 429
    expect(usageLogLevel("timeout", "server")).toBe("info"); // offline → 5xx
  });
});

describe("refreshUsage — file-lock claim", () => {
  const env = useTmpHome();

  beforeEach(() => { vi.resetModules(); });

  async function importRefresh() {
    const mod = await import("../src/dashboard/usage.js");
    return { refreshUsage: mod.refreshUsage, USAGE_FILE: mod.USAGE_FILE };
  }

  it("preserves prior data through a transient error (no-credentials path)", async () => {
    const now = Date.now();
    // Seed a stale snapshot with good prior data.
    const prior = {
      fetchedAt: new Date(now - 30 * 60_000).toISOString(),
      dataAt: new Date(now - 30 * 60_000).toISOString(),
      data: {
        fiveHour: { pct: 42, resetsAt: new Date(now + 60 * 60_000).toISOString() },
      },
    };
    fs.writeFileSync(path.join(env.sessionsDir, "claude-usage.json"), JSON.stringify(prior));

    // No GARDEN_CLAUDE_SESSION_KEY, no .credentials.json in tmp home — refreshUsage
    // takes the no-creds error path. The fix preserves prior data.
    delete process.env.GARDEN_CLAUDE_SESSION_KEY;
    const { refreshUsage, USAGE_FILE } = await importRefresh();
    const snap = await refreshUsage();

    expect(snap.error).toBeDefined();
    expect(snap.data?.fiveHour?.pct).toBe(42);
    expect(snap.dataAt).toBe(prior.dataAt);

    const onDisk = JSON.parse(fs.readFileSync(USAGE_FILE, "utf8"));
    expect(onDisk.data?.fiveHour?.pct).toBe(42);
  });

  it("skips the fetch when a sibling just refreshed (claim already held)", async () => {
    const now = Date.now();
    // Snapshot fetchedAt within the hook cooldown — no caller should fetch.
    const fresh = {
      fetchedAt: new Date(now - 5_000).toISOString(),
      dataAt: new Date(now - 5_000).toISOString(),
      data: {
        fiveHour: { pct: 7, resetsAt: new Date(now + 60 * 60_000).toISOString() },
      },
    };
    fs.writeFileSync(path.join(env.sessionsDir, "claude-usage.json"), JSON.stringify(fresh));

    // Even with no credentials, refreshUsage should bail before the no-creds
    // error path because the claim slot was already taken (snapshot is fresh).
    delete process.env.GARDEN_CLAUDE_SESSION_KEY;
    const { refreshUsage, USAGE_FILE } = await importRefresh();
    const snap = await refreshUsage();

    expect(snap.error).toBeUndefined();
    expect(snap.data?.fiveHour?.pct).toBe(7);
    expect(snap.fetchedAt).toBe(fresh.fetchedAt);

    const onDisk = JSON.parse(fs.readFileSync(USAGE_FILE, "utf8"));
    // fetchedAt unchanged proves the claim path bailed without bumping.
    expect(onDisk.fetchedAt).toBe(fresh.fetchedAt);
  });
});

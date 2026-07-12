import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  normalizeUsage,
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
  RATE_LIMIT_FLOOR_MS,
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
    // Disabled → dropped so the pane keeps three bars.
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
    // 1 leading blank (for breathing room under the pane border) + 3 meters.
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain("5h");
    expect(lines[2]).toContain("week");
    expect(lines[3]).toContain("fable"); // model label, lowercased to match the column
    expect(lines[1]).toContain("26%");
    expect(lines[2]).toContain("35%");
    expect(lines[3]).toContain(" 4%");
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
    expect(lines).toHaveLength(3); // leading blank + 5h + week
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
    // No scoped meters \u2192 no third row.
    expect(lines).toHaveLength(3);
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
    expect(lines).toHaveLength(4);
    for (const l of lines) expect(visibleLen(l)).toBeLessThanOrEqual(32);
    // Reset phrase dropped at this width so the bar still has usable cells.
    expect(lines[1]).not.toContain("resets");
    expect(lines[1]).toContain("26%");
  });

  it("keeps the reset phrase at a moderately narrow width", async () => {
    writeSnapshot({
      fetchedAt: new Date(now).toISOString(),
      data: {
        fiveHour: { pct: 26, resetsAt: new Date(now + 2 * 60 * 60_000).toISOString() },
      },
    });
    const render = await importRender();
    // 48 cols has room for fixed(18) + minimum bar(6) + 2 + reset(17) = 43.
    const lines = render(now, 48).split("\n");
    for (const l of lines) expect(visibleLen(l)).toBeLessThanOrEqual(48);
    expect(lines[1]).toContain("resets");
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
    expect(out).toContain("(rate-limited)");
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
    expect(out).toContain("(stale 2h, rate-limited)");
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
    // Leading blank + 3 meters + 1 tag = 5 lines when an error is present.
    expect(lines).toHaveLength(5);
    expect(lines[4]).toContain("(stale 2h, rate-limited)");
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
    expect(lines).toHaveLength(4);
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
    const tagLine = lines[lines.length - 1];
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
    // Leading blank + 3 meters + 1 extra footer = 5 lines.
    expect(lines).toHaveLength(5);
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
    // Leading blank + 3 meters + extra footer + health tag = 6 lines.
    expect(lines).toHaveLength(6);
    expect(lines[4]).toContain("1234 / 5000 credits");
    expect(lines[5]).toContain("(stale 2h, rate-limited)");
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

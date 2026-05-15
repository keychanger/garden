import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  normalizeUsage,
  formatDuration,
  formatBriefAge,
  shouldRefreshOnHookWith,
  decideRefresh,
  parseRetryAfter,
  HOOK_REFRESH_COOLDOWN_MS,
  POLL_OK_MS,
  POLL_MIN_MS,
  RATE_LIMIT_FLOOR_MS,
} from "../src/dashboard/usage.js";
import { useTmpHome } from "./helpers.js";

describe("normalizeUsage", () => {
  it("extracts all three meters from the observed api.anthropic.com shape", () => {
    const raw = {
      five_hour:        { utilization: 62, resets_at: "2026-04-15T20:00:00Z" },
      seven_day:        { utilization: 34, resets_at: "2026-04-19T04:00:00Z" },
      seven_day_sonnet: { utilization: 4,  resets_at: "2026-04-20T15:00:00Z" },
    };
    const out = normalizeUsage(raw);
    expect(out.fiveHour).toEqual({ pct: 62, resetsAt: "2026-04-15T20:00:00Z" });
    expect(out.weekly).toEqual({ pct: 34, resetsAt: "2026-04-19T04:00:00Z" });
    expect(out.sonnet).toEqual({ pct: 4, resetsAt: "2026-04-20T15:00:00Z" });
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
    expect(out.sonnet).toBeUndefined();
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
    expect(out.sonnet).toBeUndefined();
  });

  it("handles empty / non-object input gracefully", () => {
    expect(normalizeUsage(null)).toEqual({});
    expect(normalizeUsage("nope")).toEqual({});
    expect(normalizeUsage({})).toEqual({});
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

  it("renders three meter rows — 5h, week, sonnet", async () => {
    writeSnapshot({
      fetchedAt: new Date(now).toISOString(),
      data: {
        fiveHour: { pct: 26, resetsAt: new Date(now + 2 * 60 * 60_000).toISOString() },
        weekly:   { pct: 35, resetsAt: new Date(now + 24 * 60 * 60_000).toISOString() },
        sonnet:   { pct: 4,  resetsAt: new Date(now + 4 * 24 * 60 * 60_000).toISOString() },
      },
    });
    const render = await importRender();
    const lines = render(now).split("\n");
    // 1 leading blank (for breathing room under the pane border) + 3 meters.
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain("5h");
    expect(lines[2]).toContain("week");
    expect(lines[3]).toContain("sonnet");
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
        sonnet: { pct: 1, resetsAt: new Date(now + 4 * 24 * 60 * 60_000).toISOString() },
      },
    });
    const render = await importRender();
    const lines = render(now).split("\n");
    const sonnetLine = lines.find(l => l.includes("sonnet"));
    expect(sonnetLine).toBeDefined();
    expect(sonnetLine).toMatch(/\u2588/);
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

  it("renders sonnet as an em-dash when the seven_day_sonnet bucket is null", async () => {
    // /api/oauth/usage returns seven_day_sonnet: null when no Sonnet usage has
    // accrued. A flat-zero bar next to a populated weekly bar reads as broken,
    // so an em-dash is the truer signal — bar, percentage, and reset-text are
    // all omitted.
    writeSnapshot({
      fetchedAt: new Date(now).toISOString(),
      data: {
        weekly: { pct: 35, resetsAt: new Date(now + 1 * 24 * 60 * 60_000).toISOString() },
        // sonnet omitted (simulates seven_day_sonnet: null in API response)
      },
    });
    const render = await importRender();
    const lines = render(now).split("\n");
    const sonnetLine = lines.find(l => l.includes("sonnet"));
    expect(sonnetLine).toBeDefined();
    expect(sonnetLine).toContain("\u2014");
    expect(sonnetLine).not.toMatch(/\d+%/);
    expect(sonnetLine).not.toContain("\u2588"); // no filled cells
    expect(sonnetLine).not.toContain("\u2591"); // no dim cells
    expect(sonnetLine).not.toContain("\u2502"); // no marker
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
        sonnet:   { pct: 30, resetsAt: new Date(now + 3 * 24 * 60 * 60_000).toISOString() },
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

  it("shows an em-dash for missing meter buckets instead of crashing", async () => {
    writeSnapshot({
      fetchedAt: new Date(now).toISOString(),
      data: {
        fiveHour: { pct: 42, resetsAt: new Date(now + 60 * 60_000).toISOString() },
        // weekly and sonnet omitted
      },
    });
    const render = await importRender();
    const lines = render(now).split("\n");
    // lines[0] is the leading blank; meters start at index 1.
    expect(lines[1]).toContain("42%");
    expect(lines[2]).toContain("\u2014");
    expect(lines[3]).toContain("\u2014");
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
        sonnet:   { pct: 4,  resetsAt: new Date(now + 4 * 24 * 60 * 60_000).toISOString() },
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
        sonnet:   { pct: 4,  resetsAt: new Date(now + 4 * 24 * 60 * 60_000).toISOString() },
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

import { describe, it, expect } from "vitest";
import {
  normalizeUsage,
  formatDuration,
  shouldRefreshOnHookWith,
  HOOK_REFRESH_COOLDOWN_MS,
} from "../src/dashboard/usage.js";

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

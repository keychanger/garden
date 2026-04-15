import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  normalizeUsage,
  pickProfileBar,
  formatDuration,
  shouldRefreshOnHookWith,
  HOOK_REFRESH_COOLDOWN_MS,
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

describe("pickProfileBar", () => {
  it("returns the most-utilized bucket", () => {
    const data = {
      fiveHour: { pct: 30, resetsAt: "2026-04-15T20:00:00Z" },
      weekly: { pct: 80, resetsAt: "2026-04-19T04:00:00Z" },
      sonnet: { pct: 10, resetsAt: "2026-04-20T15:00:00Z" },
    };
    expect(pickProfileBar(data)).toEqual({ pct: 80, resetsAt: "2026-04-19T04:00:00Z" });
  });

  it("returns undefined when all buckets are absent", () => {
    expect(pickProfileBar({})).toBeUndefined();
  });

  it("returns the single available bucket", () => {
    const data = { fiveHour: { pct: 42, resetsAt: "2026-04-15T20:00:00Z" } };
    expect(pickProfileBar(data)?.pct).toBe(42);
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
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("5h");
    expect(lines[1]).toContain("week");
    expect(lines[2]).toContain("sonnet");
    expect(lines[0]).toContain("26%");
    expect(lines[1]).toContain("35%");
    expect(lines[2]).toContain(" 4%");
  });

  it("shows at least one filled bar cell for small non-zero percentages", async () => {
    writeSnapshot({
      fetchedAt: new Date(now).toISOString(),
      data: {
        sonnet: { pct: 4, resetsAt: new Date(now + 4 * 24 * 60 * 60_000).toISOString() },
      },
    });
    const render = await importRender();
    const lines = render(now).split("\n");
    const sonnetLine = lines.find(l => l.includes("sonnet"));
    expect(sonnetLine).toBeDefined();
    // At BAR_WIDTH=24, pct=4 rounds to 1 filled cell.
    expect(sonnetLine).toMatch(/\u2588/);
  });

  it("marks data stale after STALE_AFTER_MS", async () => {
    writeSnapshot({
      fetchedAt: new Date(now - 60 * 60_000).toISOString(),
      data: {
        fiveHour: { pct: 26, resetsAt: new Date(now + 60 * 60_000).toISOString() },
      },
    });
    const render = await importRender();
    const out = render(now);
    expect(out).toContain("(stale)");
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
    // 5h row has a percent
    expect(lines[0]).toContain("42%");
    // week and sonnet rows render em-dash placeholder
    expect(lines[1]).toContain("\u2014");
    expect(lines[2]).toContain("\u2014");
  });
});

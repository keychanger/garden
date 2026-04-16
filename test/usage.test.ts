import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  normalizeUsage,
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

  it("shows at least one filled bar cell for small non-zero percentages", async () => {
    writeSnapshot({
      fetchedAt: new Date(now).toISOString(),
      data: {
        // pct: 1 rounds to 0 cells at BAR_WIDTH=24 — the min-one-cell floor
        // is what guarantees the bar still paints something.
        sonnet: { pct: 1, resetsAt: new Date(now + 4 * 24 * 60 * 60_000).toISOString() },
      },
    });
    const render = await importRender();
    const lines = render(now).split("\n");
    const sonnetLine = lines.find(l => l.includes("sonnet"));
    expect(sonnetLine).toBeDefined();
    expect(sonnetLine).toMatch(/\u2588/);
  });

  it("paints green past the marker when pct exceeds elapsed-time pct", async () => {
    // 3% utilization 2h into the 7-day window: marker lands at index 0 (so
    // there's no room "before" the marker), but we still want one green cell
    // visible — placed after the marker.
    writeSnapshot({
      fetchedAt: new Date(now).toISOString(),
      data: {
        weekly: { pct: 3, resetsAt: new Date(now + (7 * 24 - 2) * 60 * 60_000).toISOString() },
      },
    });
    const render = await importRender();
    const lines = render(now).split("\n");
    const weekLine = lines.find(l => l.includes("week"));
    expect(weekLine).toBeDefined();
    expect(weekLine).toContain("\u2502"); // marker
    expect(weekLine).toMatch(/\u2588/);    // at least one filled cell visible
  });

  it("renders an empty sonnet bar with marker when sonnet bucket is null but weekly is present", async () => {
    // The /api/oauth/usage endpoint returns seven_day_sonnet: null when no
    // Sonnet usage has accrued. Sonnet shares weekly's 7-day window, so the
    // marker should still display by borrowing weekly.resetsAt.
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
    expect(sonnetLine).not.toContain("\u2014");
    expect(sonnetLine).toContain(" 0%");
    expect(sonnetLine).toContain("\u2502"); // time-tracker marker
    expect(sonnetLine).toContain("\u2591"); // empty bar cells
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
});

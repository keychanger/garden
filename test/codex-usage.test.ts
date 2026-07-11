// Codex usage meter: rate_limits parsing from a rollout tail and the
// two-column title-pane render (Claude left, Codex in the empty space right).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("codex usage meter", () => {
  let home: string;
  let origHome: string | undefined;
  let sessions: string;

  beforeEach(() => {
    vi.resetModules();
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-usage-")));
    origHome = process.env.HOME;
    process.env.HOME = home;
    sessions = path.join(home, ".garden", "sessions");
    fs.mkdirSync(sessions, { recursive: true });
  });
  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("parses rate_limits from a rollout tail and sorts windows smaller-first", async () => {
    const { parseCodexRateLimits } = await import("../src/dashboard/codex-usage.js");
    const roll = path.join(home, "rollout.jsonl");
    const nowS = Math.floor(Date.now() / 1000);
    // Real envelope: event_msg whose payload carries info + rate_limits.
    fs.writeFileSync(roll, [
      JSON.stringify({ timestamp: "t0", type: "response_item", payload: { type: "message" } }),
      JSON.stringify({
        timestamp: "t1", type: "event_msg",
        payload: {
          type: "token_count", info: {},
          rate_limits: {
            limit_id: "codex", limit_name: null,
            primary: { used_percent: 17, window_minutes: 43200, resets_at: nowS + 1_000_000 },
            secondary: { used_percent: 3, window_minutes: 300, resets_at: nowS + 3600 },
            credits: { has_credits: false, unlimited: false, balance: null },
          },
        },
      }),
    ].join("\n") + "\n");

    const data = parseCodexRateLimits(roll);
    expect(data).not.toBeNull();
    // Smaller window (5h = 300 min) first, then the 30d (43200).
    expect(data!.windows.map((w) => w.windowMinutes)).toEqual([300, 43200]);
    expect(data!.windows[1].usedPercent).toBe(17);
  });

  it("returns null when the rollout has no rate_limits", async () => {
    const { parseCodexRateLimits } = await import("../src/dashboard/codex-usage.js");
    const roll = path.join(home, "empty.jsonl");
    fs.writeFileSync(roll, JSON.stringify({ type: "event_msg", payload: { type: "message" } }) + "\n");
    expect(parseCodexRateLimits(roll)).toBeNull();
  });

  it("renders the Codex meter as a second column beside Claude", async () => {
    const now = Date.now();
    const iso = (msFromNow: number) => new Date(now + msFromNow).toISOString();
    fs.writeFileSync(path.join(sessions, "claude-usage.json"), JSON.stringify({
      fetchedAt: iso(0), dataAt: iso(0),
      data: {
        fiveHour: { pct: 28, resetsAt: iso(4 * 3600e3) },
        weekly: { pct: 20, resetsAt: iso(34 * 3600e3) },
        sonnet: null,
      },
    }));
    fs.writeFileSync(path.join(sessions, "codex-usage.json"), JSON.stringify({
      capturedAt: now,
      data: { windows: [{ windowMinutes: 43200, usedPercent: 17, resetsAt: Math.floor(now / 1000) + 1_000_000 }] },
    }));

    const { renderUsagePane } = await import("../src/dashboard/usage.js");
    const out = renderUsagePane(now, 120);
    // Print so the layout is eyeballable in the test run.
    // eslint-disable-next-line no-console
    console.log("\n" + out + "\n");

    expect(out).toContain("claude"); // column header
    expect(out).toContain("codex");  // column header
    expect(out).toContain("5h");     // claude window
    expect(out).toContain("30d");    // codex window label
    expect(out).toContain(" 28%");   // claude pct
    expect(out).toContain(" 17%");   // codex pct
    // Adjacency: the two columns are side by side, not stacked — the Claude 5h
    // row and the Codex 30d bar share one physical line (both percentages on it).
    const lines = out.split("\n");
    expect(lines.some((l) => l.includes(" 28%") && l.includes(" 17%"))).toBe(true);
  });

  it("stays single-column (no header) when no Codex data exists", async () => {
    const now = Date.now();
    const iso = (m: number) => new Date(now + m).toISOString();
    fs.writeFileSync(path.join(sessions, "claude-usage.json"), JSON.stringify({
      fetchedAt: iso(0), dataAt: iso(0),
      data: { fiveHour: { pct: 28, resetsAt: iso(4 * 3600e3) }, weekly: { pct: 20, resetsAt: iso(34 * 3600e3) }, sonnet: null },
    }));
    const { renderUsagePane } = await import("../src/dashboard/usage.js");
    const out = renderUsagePane(now, 120);
    expect(out).not.toContain("codex");
    expect(out).toContain("28%");
  });

  // Seeds a healthy Claude snapshot so the two-column path is reachable, then
  // whatever Codex data the test needs.
  function seedClaude(now: number) {
    const iso = (m: number) => new Date(now + m).toISOString();
    fs.writeFileSync(path.join(sessions, "claude-usage.json"), JSON.stringify({
      fetchedAt: iso(0), dataAt: iso(0),
      data: { fiveHour: { pct: 28, resetsAt: iso(4 * 3600e3) }, weekly: { pct: 20, resetsAt: iso(34 * 3600e3) }, sonnet: null },
    }));
  }
  function seedCodex(data: unknown, now: number) {
    fs.writeFileSync(path.join(sessions, "codex-usage.json"), JSON.stringify({ capturedAt: now, data }));
  }

  it("renders both windows smaller-first (5h above 30d) with the shorter-window bar", async () => {
    const now = Date.now();
    seedClaude(now);
    const nowS = Math.floor(now / 1000);
    seedCodex({ windows: [
      { windowMinutes: 300, usedPercent: 3, resetsAt: nowS + 3600 },
      { windowMinutes: 43200, usedPercent: 17, resetsAt: nowS + 1_000_000 },
    ] }, now);
    const { renderUsagePane } = await import("../src/dashboard/usage.js");
    const lines = renderUsagePane(now, 120).split("\n");
    const rowWith = (needle: string) => lines.findIndex((l) => l.includes(needle));
    // The Codex 5h window (3%) renders above its 30d window (smaller-first).
    expect(rowWith(" 3%")).toBeGreaterThanOrEqual(0);
    expect(rowWith("30d")).toBeGreaterThan(rowWith(" 3%"));
    expect(lines.join("\n")).toContain(" 17%"); // longer-window pct present
  });

  it("renders an em-dash for a Codex window whose reset time has already passed", async () => {
    const now = Date.now();
    seedClaude(now);
    const nowS = Math.floor(now / 1000);
    seedCodex({ windows: [{ windowMinutes: 43200, usedPercent: 17, resetsAt: nowS - 10 }] }, now);
    const { renderUsagePane } = await import("../src/dashboard/usage.js");
    const out = renderUsagePane(now, 120);
    // The Codex column shares a physical row with the Claude column, so isolate
    // the Codex portion (from its "30d" label onward) before asserting.
    const row = out.split("\n").find((l) => l.includes("30d"))!;
    const codexPart = row.slice(row.indexOf("30d"));
    expect(codexPart).toContain("—");        // em-dash
    expect(codexPart).not.toMatch(/17%/);         // stale pct must not leak
    expect(codexPart).not.toContain("█");    // no filled bar cell
  });

  it("renders a dim credit balance footer under the Codex bars", async () => {
    const now = Date.now();
    seedClaude(now);
    const nowS = Math.floor(now / 1000);
    seedCodex({
      windows: [{ windowMinutes: 43200, usedPercent: 17, resetsAt: nowS + 1_000_000 }],
      creditBalance: 12.5,
    }, now);
    const { renderUsagePane } = await import("../src/dashboard/usage.js");
    const out = renderUsagePane(now, 120);
    expect(out).toContain("credits");
    expect(out).toContain("$12.50");
  });

  it("renders 'unlimited' for an unlimited Codex credit balance", async () => {
    const now = Date.now();
    seedClaude(now);
    const nowS = Math.floor(now / 1000);
    seedCodex({
      windows: [{ windowMinutes: 43200, usedPercent: 17, resetsAt: nowS + 1_000_000 }],
      creditsUnlimited: true,
    }, now);
    const { renderUsagePane } = await import("../src/dashboard/usage.js");
    const out = renderUsagePane(now, 120);
    expect(out).toContain("credits");
    expect(out).toContain("unlimited");
  });

  it("stays single-column when the pane is too narrow for a second column", async () => {
    const now = Date.now();
    seedClaude(now);
    const nowS = Math.floor(now / 1000);
    seedCodex({ windows: [{ windowMinutes: 43200, usedPercent: 17, resetsAt: nowS + 1_000_000 }] }, now);
    const { renderUsagePane } = await import("../src/dashboard/usage.js");
    // 60 cols: the Claude meter alone consumes nearly the whole width, so the
    // remaining space is below CODEX_MIN_WIDTH and the second column drops.
    const out = renderUsagePane(now, 60);
    expect(out).not.toContain("codex"); // no two-column header
    expect(out).not.toContain("30d");   // codex column not rendered
    expect(out).toContain("28%");       // Claude meter still renders
  });

  it("captureCodexUsage parses a rollout and writes a snapshot readCodexUsage returns", async () => {
    const now = Date.now();
    const nowS = Math.floor(now / 1000);
    const roll = path.join(home, "capture.jsonl");
    fs.writeFileSync(roll, JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        rate_limits: {
          primary: { used_percent: 42, window_minutes: 43200, resets_at: nowS + 1_000_000 },
          credits: { balance: 5, unlimited: false },
        },
      },
    }) + "\n");
    const { captureCodexUsage, readCodexUsage } = await import("../src/dashboard/codex-usage.js");
    captureCodexUsage(roll);
    const snap = readCodexUsage();
    expect(snap).not.toBeNull();
    expect(snap!.data.windows[0].usedPercent).toBe(42);
    expect(snap!.data.creditBalance).toBe(5);
  });

  it("captureCodexUsage is a no-op on a missing path (prior snapshot preserved)", async () => {
    const nowS = Math.floor(Date.now() / 1000);
    const { writeCodexUsage, captureCodexUsage, readCodexUsage } = await import("../src/dashboard/codex-usage.js");
    writeCodexUsage({ windows: [{ windowMinutes: 43200, usedPercent: 9, resetsAt: nowS + 1000 }] });
    captureCodexUsage(undefined);
    captureCodexUsage(path.join(home, "does-not-exist.jsonl"));
    const snap = readCodexUsage();
    expect(snap!.data.windows[0].usedPercent).toBe(9); // untouched
  });
});

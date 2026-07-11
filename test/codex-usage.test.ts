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
});

// Codex usage meter: rate_limits parsing from a rollout tail and the
// two-column title-pane render (Claude left, Codex in the empty space right).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("codex usage meter", () => {
  let home: string;
  let origHome: string | undefined;
  let origCodexHome: string | undefined;
  let sessions: string;

  beforeEach(() => {
    vi.resetModules();
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-usage-")));
    origHome = process.env.HOME;
    process.env.HOME = home;
    // Unset so codexSessionsDir() resolves under the stubbed HOME rather than
    // the developer's real ~/.codex.
    origCodexHome = process.env.CODEX_HOME;
    delete process.env.CODEX_HOME;
    sessions = path.join(home, ".garden", "sessions");
    fs.mkdirSync(sessions, { recursive: true });
  });
  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = origCodexHome;
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

  it("parses a credit balance alongside the window", async () => {
    const nowS = Math.floor(Date.now() / 1000);
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
    const { parseCodexRateLimits } = await import("../src/dashboard/codex-usage.js");
    const data = parseCodexRateLimits(roll)!;
    expect(data.windows[0].usedPercent).toBe(42);
    expect(data.creditBalance).toBe(5);
  });

  it("returns null for an unreadable rollout path", async () => {
    const { parseCodexRateLimits } = await import("../src/dashboard/codex-usage.js");
    expect(parseCodexRateLimits(path.join(home, "does-not-exist.jsonl"))).toBeNull();
  });

  // Captured verbatim from a real rollout (codex 0.144.5): Codex emits
  // rate_limits every turn but populates it only periodically, so most entries
  // carry null windows and an empty credits object.
  const EMPTY_RATE_LIMITS = {
    limit_id: "premium", limit_name: null,
    primary: null, secondary: null,
    credits: { has_credits: false, unlimited: false, balance: null },
    individual_limit: null, plan_type: null, rate_limit_reached_type: null,
  };

  it("treats an all-null rate_limits as no reading, not as an empty snapshot", async () => {
    const { parseCodexRateLimits } = await import("../src/dashboard/codex-usage.js");
    const roll = path.join(home, "empty.jsonl");
    fs.writeFileSync(roll, JSON.stringify({
      type: "event_msg", payload: { type: "token_count", rate_limits: EMPTY_RATE_LIMITS },
    }) + "\n");
    expect(parseCodexRateLimits(roll)).toBeNull();
  });

  it("scans back past all-null entries to the last populated reading", async () => {
    const { parseCodexRateLimits } = await import("../src/dashboard/codex-usage.js");
    const roll = path.join(home, "mixed.jsonl");
    const populated = {
      ...EMPTY_RATE_LIMITS,
      primary: { used_percent: 61, window_minutes: 43200, resets_at: 9_999_999_999 },
    };
    fs.writeFileSync(roll, [
      JSON.stringify({ type: "event_msg", payload: { type: "token_count", rate_limits: populated } }),
      JSON.stringify({ type: "event_msg", payload: { type: "token_count", rate_limits: EMPTY_RATE_LIMITS } }),
      JSON.stringify({ type: "event_msg", payload: { type: "token_count", rate_limits: EMPTY_RATE_LIMITS } }),
    ].join("\n") + "\n");
    expect(parseCodexRateLimits(roll)!.windows[0].usedPercent).toBe(61);
  });

  describe("two-column spacing", () => {
    const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\[K/g, "");
    const widths = (out: string) => out.split("\n").map((l) => strip(l).length);

    function seedBoth(now: number) {
      seedClaude(now);
      seedCodex({ windows: [{ windowMinutes: 10080, usedPercent: 0, resetsAt: Math.floor(now / 1000) + 600_000 }] }, now);
    }

    it("opens with a blank line so the column headers clear the pane border", async () => {
      const now = Date.now();
      seedBoth(now);
      const { renderUsagePane } = await import("../src/dashboard/usage.js");
      const lines = renderUsagePane(now, 112).split("\n");
      expect(strip(lines[0]).trim()).toBe("");
      expect(strip(lines[1])).toContain("claude");
      expect(strip(lines[1])).toContain("codex");
    });

    it("spreads the columns into the right-hand slack instead of bunching them left", async () => {
      const now = Date.now();
      seedBoth(now);
      const { renderUsagePane } = await import("../src/dashboard/usage.js");
      const out = renderUsagePane(now, 112);
      const header = out.split("\n").map(strip).find((l) => l.includes("codex"))!;
      // The old fixed 3-col gap put "codex" immediately after the Claude column;
      // widening pushes it right, consuming the dead space that was on the right.
      expect(header.indexOf("codex")).toBeGreaterThan(55);
    });

    it("never overflows the pane, and holds a right margin", async () => {
      const now = Date.now();
      seedBoth(now);
      const { renderUsagePane } = await import("../src/dashboard/usage.js");
      for (const w of [90, 112, 140, 200]) {
        const max = Math.max(...widths(renderUsagePane(now, w)));
        expect(max).toBeLessThanOrEqual(w);
      }
      // At the operator's width the content sits inside symmetric margins:
      // 4-space INDENT on the left, the same held back on the right.
      expect(Math.max(...widths(renderUsagePane(now, 112)))).toBe(108);
    });

    it("caps the gap so a very wide pane does not strand the columns at opposite edges", async () => {
      const now = Date.now();
      seedBoth(now);
      const { renderUsagePane } = await import("../src/dashboard/usage.js");
      const at140 = Math.max(...widths(renderUsagePane(now, 140)));
      const at200 = Math.max(...widths(renderUsagePane(now, 200)));
      expect(at200).toBe(at140); // gap capped; extra slack stays on the right
    });
  });

  // The probe spends real Codex quota, so this gate is what stands between an
  // all-Claude garden and a pointless billed API call every 6h.
  describe("codexInFleet", () => {
    function writeConfig(projects: string): void {
      fs.mkdirSync(path.join(home, ".garden"), { recursive: true });
      fs.writeFileSync(path.join(home, ".garden", "config.yml"), `projects:\n${projects}`);
    }

    it("is false for an all-Claude fleet", async () => {
      writeConfig("  garden:\n    path: /tmp/garden\n");
      const { codexInFleet } = await import("../src/dashboard/codex-usage.js");
      expect(codexInFleet()).toBe(false);
    });

    it("is true when a review role uses codex (the claude-codex crew shape)", async () => {
      // Exactly the on-disk shape `garden config <p> crew claude-codex` writes:
      // no worker harness, codex on the three review roles.
      writeConfig(
        "  wolf:\n    path: /tmp/wolf\n    roles:\n" +
        "      reviewer:\n        harness: codex\n" +
        "      resolver:\n        harness: codex\n" +
        "      ciFix:\n        harness: codex\n",
      );
      const { codexInFleet } = await import("../src/dashboard/codex-usage.js");
      expect(codexInFleet()).toBe(true);
    });

    it("is true when a project's worker harness is codex", async () => {
      writeConfig("  p:\n    path: /tmp/p\n    harness: codex\n");
      const { codexInFleet } = await import("../src/dashboard/codex-usage.js");
      expect(codexInFleet()).toBe(true);
    });

    it("is true when a registered worker carries a codex crew", async () => {
      writeConfig("  p:\n    path: /tmp/p\n");
      fs.writeFileSync(path.join(sessions, "dashboard.registry.json"), JSON.stringify({
        workers: { p: [{ name: "w", project: "p", crew: "claude-codex" }] },
      }));
      const { codexInFleet } = await import("../src/dashboard/codex-usage.js");
      expect(codexInFleet()).toBe(true);
    });
  });

  it("coerces a string credit balance (Codex reports it as \"0\", not 0)", async () => {
    const { parseCodexRateLimits } = await import("../src/dashboard/codex-usage.js");
    const roll = path.join(home, "credits.jsonl");
    fs.writeFileSync(roll, JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        rate_limits: {
          primary: { used_percent: 5, window_minutes: 10080, resets_at: 9_999_999_999 },
          credits: { has_credits: true, unlimited: false, balance: "12.5" },
        },
      },
    }) + "\n");
    expect(parseCodexRateLimits(roll)!.creditBalance).toBe(12.5);
  });

  // captureCodexUsageLatest is the role-agnostic feed: it reads whatever rollout
  // is newest under $CODEX_HOME/sessions, so a headless reviewer/resolver/ci-fix
  // run (which fires no lifecycle hook) meters exactly like a worker turn.
  describe("captureCodexUsageLatest", () => {
    // Write a rollout at sessions/YYYY/MM/DD, optionally stamping its mtime.
    function writeRollout(day: string, name: string, usedPercent: number, mtimeMs?: number): string {
      const dir = path.join(home, ".codex", "sessions", ...day.split("-"));
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `rollout-${name}.jsonl`);
      fs.writeFileSync(file, JSON.stringify({
        type: "event_msg",
        payload: {
          type: "token_count",
          rate_limits: {
            primary: { used_percent: usedPercent, window_minutes: 43200, resets_at: 9_999_999_999 },
          },
        },
      }) + "\n");
      if (mtimeMs !== undefined) fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
      return file;
    }

    it("captures a rollout no worker owns (the reviewer-seat case)", async () => {
      writeRollout("2026-07-19", "2026-07-19T10-00-00-abc", 33);
      const { captureCodexUsageLatest, readCodexUsage } = await import("../src/dashboard/codex-usage.js");
      expect(captureCodexUsageLatest()).toBe(true);
      expect(readCodexUsage()!.data.windows[0].usedPercent).toBe(33);
    });

    it("returns false and writes nothing when there is no rollout at all", async () => {
      const { captureCodexUsageLatest, readCodexUsage } = await import("../src/dashboard/codex-usage.js");
      expect(captureCodexUsageLatest()).toBe(false);
      expect(readCodexUsage()).toBeNull();
    });

    it("backtracks past an empty newest day dir to the previous real one", async () => {
      writeRollout("2026-07-18", "2026-07-18T10-00-00-old", 21);
      fs.mkdirSync(path.join(home, ".codex", "sessions", "2026", "07", "19"), { recursive: true });
      const { captureCodexUsageLatest, readCodexUsage } = await import("../src/dashboard/codex-usage.js");
      expect(captureCodexUsageLatest()).toBe(true);
      expect(readCodexUsage()!.data.windows[0].usedPercent).toBe(21);
    });

    it("picks the newest by mtime, not by name — a long-running rollout keeps winning", async () => {
      const now = Date.now();
      // The later-NAMED run finished first; the earlier-named one is still being
      // appended, so it carries the fresher reading.
      writeRollout("2026-07-19", "2026-07-19T23-00-00-short", 40, now - 60_000);
      writeRollout("2026-07-19", "2026-07-19T09-00-00-long", 55, now);
      const { captureCodexUsageLatest, readCodexUsage } = await import("../src/dashboard/codex-usage.js");
      expect(captureCodexUsageLatest()).toBe(true);
      expect(readCodexUsage()!.data.windows[0].usedPercent).toBe(55);
    });

    it("falls through to an older rollout when the newest has no populated reading", async () => {
      const now = Date.now();
      const dir = path.join(home, ".codex", "sessions", "2026", "07", "19");
      fs.mkdirSync(dir, { recursive: true });
      // Newest: a short run that ended before Codex ever populated rate_limits.
      const bare = path.join(dir, "rollout-2026-07-19T12-00-00-bare.jsonl");
      fs.writeFileSync(bare, JSON.stringify({
        type: "event_msg", payload: { type: "token_count", rate_limits: EMPTY_RATE_LIMITS },
      }) + "\n");
      fs.utimesSync(bare, now / 1000, now / 1000);
      writeRollout("2026-07-19", "2026-07-19T09-00-00-real", 77, now - 60_000);
      const { captureCodexUsageLatest, readCodexUsage } = await import("../src/dashboard/codex-usage.js");
      expect(captureCodexUsageLatest()).toBe(true);
      expect(readCodexUsage()!.data.windows[0].usedPercent).toBe(77);
    });

    // Write a rollout whose rate_limits never populate — a short run that ended
    // before Codex filled the object in.
    function writeBareRollout(day: string, name: string, mtimeMs: number): void {
      const dir = path.join(home, ".codex", "sessions", ...day.split("-"));
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `rollout-${name}.jsonl`);
      fs.writeFileSync(file, JSON.stringify({
        type: "event_msg", payload: { type: "token_count", rate_limits: EMPTY_RATE_LIMITS },
      }) + "\n");
      fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
    }

    it("leaves a good prior snapshot alone when no rollout has a populated reading", async () => {
      const nowS = Math.floor(Date.now() / 1000);
      writeBareRollout("2026-07-19", "2026-07-19T12-00-00-bare", Date.now());
      const { captureCodexUsageLatest, writeCodexUsage, readCodexUsage } =
        await import("../src/dashboard/codex-usage.js");
      writeCodexUsage({ windows: [{ windowMinutes: 43200, usedPercent: 12, resetsAt: nowS + 1000 }] });
      expect(captureCodexUsageLatest()).toBe(false);
      expect(readCodexUsage()!.data.windows[0].usedPercent).toBe(12); // untouched
    });

    it("gives up after MAX_ROLLOUTS_TRIED bare rollouts rather than walking the whole day", async () => {
      // Six bare rollouts newer than the one real reading: the 5-deep cap stops
      // before reaching it, so the capture reports no move. This pins the bound
      // that keeps each watchdog tick to a few tail reads.
      const now = Date.now();
      for (let i = 0; i < 6; i++) writeBareRollout("2026-07-19", `bare-${i}`, now - i * 1000);
      writeRollout("2026-07-19", "real", 88, now - 60_000);
      const { captureCodexUsageLatest, readCodexUsage } = await import("../src/dashboard/codex-usage.js");
      expect(captureCodexUsageLatest()).toBe(false);
      expect(readCodexUsage()).toBeNull();
    });

    it("skips the write when the reading is unchanged (idle fleet never churns)", async () => {
      writeRollout("2026-07-19", "2026-07-19T10-00-00-abc", 33);
      const { captureCodexUsageLatest } = await import("../src/dashboard/codex-usage.js");
      expect(captureCodexUsageLatest()).toBe(true);
      expect(captureCodexUsageLatest()).toBe(false);
    });
  });
});

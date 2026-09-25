// `garden usage` reports both quota pools: the Claude snapshot and, once Codex
// has reported usage, the Codex one beside it.
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useTmpHome } from "./helpers.js";

const DAY_MS = 24 * 60 * 60_000;

describe("garden usage", () => {
  const tmp = useTmpHome();
  let logs: string[];
  let origPretty: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-16T12:00:00Z"));
    logs = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => { logs.push(line); });
    origPretty = process.env.GARDEN_PRETTY;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (origPretty === undefined) delete process.env.GARDEN_PRETTY;
    else process.env.GARDEN_PRETTY = origPretty;
  });

  function writeClaude(): void {
    const resetsAt = new Date(Date.now() + 3 * DAY_MS).toISOString();
    fs.writeFileSync(path.join(tmp.sessionsDir, "claude-usage.json"), JSON.stringify({
      fetchedAt: new Date().toISOString(),
      data: { weekly: { pct: 27, resetsAt } },
    }));
  }

  function writeCodex(windows: Array<{ windowMinutes: number; usedPercent: number; resetsAt: number }>): void {
    fs.writeFileSync(path.join(tmp.sessionsDir, "codex-usage.json"), JSON.stringify({
      capturedAt: Date.now() - 5 * 60_000,
      data: { windows, creditBalance: 0, creditsUnlimited: false },
    }));
  }

  async function run(pretty: boolean, args: string[] = []): Promise<string> {
    if (pretty) process.env.GARDEN_PRETTY = "1";
    else delete process.env.GARDEN_PRETTY;
    const { usage } = await import("../src/commands/usage.js");
    await usage(args);
    return logs.join("\n");
  }

  it("prints a Codex section with its own reset and age beside the Claude meter", async () => {
    writeClaude();
    writeCodex([{ windowMinutes: 10080, usedPercent: 91, resetsAt: Math.floor((Date.now() + 2 * DAY_MS) / 1000) + 60 }]);
    const text = await run(true);
    expect(text).toMatch(/^claude\n5h\s+—\nweek\s+27%\s+resets in 3d 0h\n\nfetched just now\n/);
    expect(text).toMatch(/\n\ncodex\nweek\s+91%\s+resets in 2d 0h\n\nfetched 5m ago$/);
  });

  it("shows a rolled-over Codex window as a dash rather than the previous window's percentage", async () => {
    writeClaude();
    writeCodex([{ windowMinutes: 10080, usedPercent: 91, resetsAt: Math.floor((Date.now() - DAY_MS) / 1000) }]);
    const text = await run(true);
    expect(text).toMatch(/codex\nweek\s+—\n/);
    expect(text).not.toContain("91%");
  });

  it("keeps the Codex section, with a placeholder, when the snapshot holds no window", async () => {
    writeClaude();
    writeCodex([]);
    const text = await run(true);
    expect(text).toMatch(/\n\ncodex\nno window reading yet\n\nfetched 5m ago$/);
  });

  it("adds codex as a key beside the unchanged Claude fields when piped", async () => {
    writeClaude();
    writeCodex([{ windowMinutes: 10080, usedPercent: 91, resetsAt: 9_999_999_999 }]);
    const json = JSON.parse(await run(false));
    expect(json.data.weekly.pct).toBe(27);
    expect(json.codex.data.windows[0].usedPercent).toBe(91);
  });

  it("leaves the output exactly as before when Codex has never reported usage", async () => {
    writeClaude();
    const text = await run(true);
    expect(text).not.toContain("codex");
    expect(text).toMatch(/^5h\s+—\nweek\s+27%/);
  });

  it("still shows the Codex meter on a provider-only fleet with no Claude meter", async () => {
    const { saveConfig } = await import("../src/config.js");
    saveConfig({
      projects: { a: { path: "/a", provider: "deepseek" } },
      providers: { deepseek: { baseUrl: "https://api.deepseek.com/anthropic", authTokenEnv: "DEEPSEEK_API_KEY" } },
    });
    vi.resetModules();
    writeCodex([{ windowMinutes: 10080, usedPercent: 40, resetsAt: 9_999_999_999 }]);
    const text = await run(true);
    expect(text).toContain("usage meter off — every project uses a provider");
    expect(text).toMatch(/codex\nweek\s+40%/);
  });

  it.each([
    { creditBalance: 12.5, creditsUnlimited: false, expected: "credits $12.50" },
    { creditBalance: 0, creditsUnlimited: true, expected: "credits unlimited" },
    { creditBalance: 0, creditsUnlimited: false, expected: null },
  ])("renders the credit footer for $creditBalance / unlimited=$creditsUnlimited", async ({ expected, ...credits }) => {
    writeCodex([]);
    const file = path.join(tmp.sessionsDir, "codex-usage.json");
    const snap = JSON.parse(fs.readFileSync(file, "utf8"));
    Object.assign(snap.data, credits);
    fs.writeFileSync(file, JSON.stringify(snap));
    const text = await run(true);
    if (expected) expect(text).toContain(expected);
    else expect(text).not.toContain("credits");
  });

  async function mockRefresh(anthropic: boolean, codex: boolean) {
    process.env.GARDEN_PRETTY = "1";
    const config = await import("../src/config.js");
    const claudeUsage = await import("../src/dashboard/usage.js");
    const codexUsage = await import("../src/dashboard/codex-usage.js");
    const header = await import("../src/dashboard/header.js");
    vi.spyOn(config, "anyAnthropicMeteredProject").mockReturnValue(anthropic);
    vi.spyOn(codexUsage, "codexInFleet").mockReturnValue(codex);
    const probe = vi.spyOn(codexUsage, "probeCodexUsage").mockImplementation(() => {
      writeCodex([{ windowMinutes: 10080, usedPercent: 42, resetsAt: 9_999_999_999 }]);
      return true;
    });
    const refresh = vi.spyOn(claudeUsage, "refreshUsage").mockResolvedValue({
      fetchedAt: new Date().toISOString(), data: { weekly: { pct: 28 } },
    });
    vi.spyOn(header, "refreshDashboard").mockImplementation(() => {});
    return { probe, refresh };
  }

  it("prints both newly refreshed readings", async () => {
    const { probe, refresh } = await mockRefresh(true, true);
    const text = await run(true, ["refresh"]);
    expect(probe).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledWith(true);
    expect(text).toMatch(/week\s+28%/);
    expect(text).toMatch(/codex\nweek\s+42%/);
  });

  it("refreshes Codex when the Claude pool is unmetered", async () => {
    const { probe, refresh } = await mockRefresh(false, true);
    const text = await run(true, ["refresh"]);
    expect(probe).toHaveBeenCalledOnce();
    expect(refresh).not.toHaveBeenCalled();
    expect(text).toMatch(/codex\nweek\s+42%/);
  });

  it("does not spend Codex quota on an all-Claude fleet", async () => {
    const { probe, refresh } = await mockRefresh(true, false);
    await run(true, ["refresh"]);
    expect(probe).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledWith(true);
  });

  it("still prints Claude and the cached Codex reading when the probe throws", async () => {
    writeCodex([{ windowMinutes: 10080, usedPercent: 40, resetsAt: 9_999_999_999 }]);
    const { probe, refresh } = await mockRefresh(true, true);
    probe.mockImplementation(() => { throw new Error("probe unavailable"); });
    const text = await run(true, ["refresh"]);
    expect(refresh).toHaveBeenCalledWith(true);
    expect(text).toMatch(/week\s+28%/);
    expect(text).toMatch(/codex\nweek\s+40%/);
  });
});

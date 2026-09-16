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
    logs = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => { logs.push(line); });
    origPretty = process.env.GARDEN_PRETTY;
  });
  afterEach(() => {
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

  async function run(pretty: boolean): Promise<string> {
    if (pretty) process.env.GARDEN_PRETTY = "1";
    else delete process.env.GARDEN_PRETTY;
    const { usage } = await import("../src/commands/usage.js");
    await usage([]);
    return logs.join("\n");
  }

  it("prints a Codex section with its own reset and age beside the Claude meter", async () => {
    writeClaude();
    writeCodex([{ windowMinutes: 10080, usedPercent: 91, resetsAt: Math.floor((Date.now() + 2 * DAY_MS) / 1000) + 60 }]);
    const text = await run(true);
    expect(text).toMatch(/^claude\n5h\s+—\nweek\s+27%\s+resets in 2d 23h\n\nfetched just now\n/);
    expect(text).toMatch(/\n\ncodex\nweek\s+91%\s+resets in 2d 0h\n\nfetched 5m ago$/);
  });

  it("shows a rolled-over Codex window as a dash rather than the previous window's percentage", async () => {
    writeClaude();
    writeCodex([{ windowMinutes: 10080, usedPercent: 91, resetsAt: Math.floor((Date.now() - DAY_MS) / 1000) }]);
    const text = await run(true);
    expect(text).toMatch(/codex\nweek\s+—\n/);
    expect(text).not.toContain("91%");
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
});

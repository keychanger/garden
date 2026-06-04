// Harness registry + claude-code adapter dialect (docs/MULTI-MODEL.md
// "Layer 3"). The command-shape tests pin the exact strings the launch
// paths previously inlined — the Phase 3 extraction is bit-for-bit, so
// these are the regression net for the collapse.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/dashboard/tmux.js", () => ({
  // Mirror the real shellEscape: safe tokens pass through unquoted.
  shellEscape: vi.fn((s: string) =>
    /^[a-zA-Z0-9_./:=-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`,
  ),
  pasteAndSubmit: vi.fn(),
}));

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.resetModules());

async function importHarness() {
  return await import("../src/dashboard/harness/index.js");
}
async function importCore() {
  return await import("../src/dashboard/harness/core.js");
}

describe("harness registries", () => {
  it("resolves the default adapter when no name is given", async () => {
    const { getHarness } = await importHarness();
    expect(getHarness().name).toBe("claude-code");
    expect(getHarness(undefined).name).toBe("claude-code");
  });

  it("falls back to the default on unknown names with a warning", async () => {
    const { getHarness } = await importHarness();
    const { log } = await import("../src/dashboard/log.js");
    expect(getHarness("codex").name).toBe("claude-code");
    expect(log.warn).toHaveBeenCalledWith(
      "harness", expect.stringContaining("unknown harness"), expect.anything(),
    );
  });

  it("core registry resolves the same names with the same fallback", async () => {
    const { getHarnessCore } = await importCore();
    expect(getHarnessCore().name).toBe("claude-code");
    expect(getHarnessCore("ghost").name).toBe("claude-code");
  });

  it("the full adapter is the core plus installRuntimeConfig", async () => {
    const { getHarness } = await importHarness();
    const { getHarnessCore } = await importCore();
    const full = getHarness();
    const core = getHarnessCore();
    expect(typeof full.installRuntimeConfig).toBe("function");
    expect(full.buildAgentCommand).toBe(core.buildAgentCommand);
    expect(full.isTransientError).toBe(core.isTransientError);
  });
});

describe("claude-code adapter dialect", () => {
  it("builds the interactive launch command (new session)", async () => {
    const { getHarnessCore } = await importCore();
    const cmd = getHarnessCore().buildAgentCommand({
      sessionId: "abc-123", resume: false, contextFile: "/tmp/ctx.md",
      envPrefix: "CLAUDE_CONFIG_DIR=/p ",
    });
    expect(cmd).toBe(
      "CLAUDE_CONFIG_DIR=/p claude --rc --session-id abc-123 --append-system-prompt-file /tmp/ctx.md",
    );
  });

  it("builds the resume command with a model pin", async () => {
    const { getHarnessCore } = await importCore();
    const cmd = getHarnessCore().buildAgentCommand({
      sessionId: "abc-123", resume: true, contextFile: "/tmp/ctx.md",
      model: "deepseek-v4-pro", envPrefix: "",
    });
    expect(cmd).toBe(
      "claude --rc --model deepseek-v4-pro --resume abc-123 --append-system-prompt-file /tmp/ctx.md",
    );
  });

  it("builds the headless command core", async () => {
    const { getHarnessCore } = await importCore();
    const cmd = getHarnessCore().buildHeadlessCommand({
      promptFile: "/tmp/p.txt", resultFile: "/tmp/r.txt",
      model: "opus", envPrefix: "CLAUDE_CONFIG_DIR=/p ", inlineEnv: "GARDEN_REVIEWER=1 ",
    });
    expect(cmd).toBe(
      "GARDEN_REVIEWER=1 CLAUDE_CONFIG_DIR=/p claude -p --model opus < /tmp/p.txt > /tmp/r.txt 2>&1",
    );
  });

  it("mints UUID session ids", async () => {
    const { getHarnessCore } = await importCore();
    expect(getHarnessCore().allocateSessionId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("declares Tier A capabilities", async () => {
    const { getHarnessCore } = await importCore();
    expect(getHarnessCore().capabilities).toEqual({
      turnEnd: true,
      promptSubmitted: true,
      toolActivity: true,
      askingSignal: true,
      resume: true,
      sandbox: true,
      skills: true,
    });
  });

  it("routes prompt delivery through pasteAndSubmit", async () => {
    const { getHarnessCore } = await importCore();
    const { pasteAndSubmit } = await import("../src/dashboard/tmux.js");
    getHarnessCore().deliverPrompt("%5", "hello");
    expect(pasteAndSubmit).toHaveBeenCalledWith("%5", "hello");
  });
});

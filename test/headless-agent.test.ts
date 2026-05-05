import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    unlinkSync: vi.fn(),
  },
}));

vi.mock("../src/dashboard/tmux.js", () => ({
  tmux: vi.fn(),
  windowExists: vi.fn(() => false),
  killWindowSafe: vi.fn(),
  // Mirror the real shellEscape: pass safe-token strings through unquoted,
  // wrap others in single quotes with the inner-quote escape.
  shellEscape: vi.fn((s: string) =>
    /^[a-zA-Z0-9_./:=-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`,
  ),
}));

vi.mock("../src/session.js", () => ({
  DASHBOARD_SESSION: "garden-dashboard",
}));

import fs from "node:fs";
import { tmux, windowExists, killWindowSafe } from "../src/dashboard/tmux.js";
import { launchHeadlessAgent } from "../src/dashboard/headless-agent.js";

function baseOpts(overrides: Partial<Parameters<typeof launchHeadlessAgent>[0]> = {}) {
  return {
    cwd: "/tmp/wt/myproject/bold-ash",
    windowName: "_myproject-review-bold-ash",
    prompt: "Review this branch.",
    promptFile: "/tmp/sessions/myproject-bold-ash-review-prompt.txt",
    resultFile: "/tmp/sessions/myproject-bold-ash-review-result.txt",
    envPrefix: "",
    signalFifo: "/tmp/sessions/myproject-poll-signal",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(windowExists).mockReturnValue(false);
});

describe("launchHeadlessAgent", () => {
  it("writes the prompt to disk before launching", () => {
    launchHeadlessAgent(baseOpts());
    // atomicWriteFile writes to a sibling .tmp path then renames into place;
    // the fs.writeFileSync call carries the original file's path as a substring.
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("myproject-bold-ash-review-prompt.txt"),
      "Review this branch.",
    );
    expect(fs.renameSync).toHaveBeenCalled();
  });

  it("removes a pre-existing result file before launching", () => {
    launchHeadlessAgent(baseOpts());
    expect(fs.unlinkSync).toHaveBeenCalledWith(
      "/tmp/sessions/myproject-bold-ash-review-result.txt",
    );
  });

  it("tolerates a missing result file (unlink throws but is swallowed)", () => {
    vi.mocked(fs.unlinkSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(() => launchHeadlessAgent(baseOpts())).not.toThrow();
  });

  it("kills a pre-existing window with the same name", () => {
    vi.mocked(windowExists).mockReturnValue(true);
    launchHeadlessAgent(baseOpts());
    expect(killWindowSafe).toHaveBeenCalledWith("_myproject-review-bold-ash");
  });

  it("does not call killWindowSafe if the window does not exist", () => {
    vi.mocked(windowExists).mockReturnValue(false);
    launchHeadlessAgent(baseOpts());
    expect(killWindowSafe).not.toHaveBeenCalled();
  });

  it("issues a single tmux new-window with the expected args", () => {
    launchHeadlessAgent(baseOpts());
    expect(tmux).toHaveBeenCalledTimes(1);
    expect(tmux).toHaveBeenCalledWith(
      "new-window", "-d", "-t", "garden-dashboard",
      "-n", "_myproject-review-bold-ash",
      "-c", "/tmp/wt/myproject/bold-ash",
      "bash", "-c", expect.any(String),
    );
  });

  it("inlines envVars before the claude invocation", () => {
    launchHeadlessAgent(baseOpts({
      envVars: { GARDEN_REVIEWER: "1", FOO: "bar" },
    }));
    const cmd = vi.mocked(tmux).mock.calls[0][10] as string;
    // Safe-token values (1, bar) pass through shellEscape unquoted; bash
    // assignment semantics are identical with or without the surrounding quotes.
    expect(cmd).toMatch(/^GARDEN_REVIEWER=1 FOO=bar claude -p /);
  });

  it("prepends envPrefix when provided", () => {
    launchHeadlessAgent(baseOpts({ envPrefix: "CLAUDE_CONFIG_DIR=/tmp/.claude " }));
    const cmd = vi.mocked(tmux).mock.calls[0][10] as string;
    expect(cmd).toMatch(/^CLAUDE_CONFIG_DIR=\/tmp\/\.claude claude -p /);
  });

  it("redirects stdin from promptFile and stdout/stderr to resultFile", () => {
    launchHeadlessAgent(baseOpts());
    const cmd = vi.mocked(tmux).mock.calls[0][10] as string;
    expect(cmd).toContain("< /tmp/sessions/myproject-bold-ash-review-prompt.txt");
    expect(cmd).toContain("> /tmp/sessions/myproject-bold-ash-review-result.txt 2>&1");
  });

  it("pokes the signal FIFO with a [-p] guard so a missing FIFO is a no-op", () => {
    launchHeadlessAgent(baseOpts());
    const cmd = vi.mocked(tmux).mock.calls[0][10] as string;
    expect(cmd).toContain("[ -p /tmp/sessions/myproject-poll-signal ]");
    expect(cmd).toContain("(echo > /tmp/sessions/myproject-poll-signal) 2>/dev/null");
  });

  it("calls onLaunched exactly once after launch", () => {
    const onLaunched = vi.fn();
    launchHeadlessAgent(baseOpts({ onLaunched }));
    expect(onLaunched).toHaveBeenCalledTimes(1);
  });

  it("returns the window name and a current launchedAt timestamp", () => {
    const before = Date.now();
    const result = launchHeadlessAgent(baseOpts());
    const after = Date.now();
    expect(result.windowName).toBe("_myproject-review-bold-ash");
    expect(result.launchedAt).toBeGreaterThanOrEqual(before);
    expect(result.launchedAt).toBeLessThanOrEqual(after);
  });

  it("shell-escapes single quotes in env var values", () => {
    launchHeadlessAgent(baseOpts({
      envVars: { TRICKY: "it's \"fine\"" },
    }));
    const cmd = vi.mocked(tmux).mock.calls[0][10] as string;
    // Single quotes inside a single-quoted value must be split-quoted as '\''.
    expect(cmd).toContain(`TRICKY='it'\\''s "fine"'`);
  });
});

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(() => "{}"),
    renameSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    statSync: vi.fn(() => ({ size: 0 })),
    unlinkSync: vi.fn(),
    constants: { O_CREAT: 0, O_EXCL: 0, O_WRONLY: 0 },
  },
}));

vi.mock("../src/session.js", () => ({
  dashboardExists: vi.fn(() => false),
  DASHBOARD_SESSION: "garden-dashboard",
}));

vi.mock("../src/config.js", () => ({
  loadConfig: vi.fn(() => ({ projects: { myproject: { path: "/repo/myproject" } } })),
  tryGetProject: vi.fn(() => ({ path: "/repo/myproject" })),
  getFocusedProjectNames: vi.fn(() => ["myproject"]),
  SESSIONS_DIR: "/tmp/fake-sessions",
}));

vi.mock("../src/rules.js", () => ({
  buildRulesContext: vi.fn(() => "rules"),
  buildWorktreeRules: vi.fn(() => "worktree rules"),
}));

vi.mock("../src/dashboard/state.js", () => ({
  readDashState: vi.fn(() => ({
    activeProject: null,
    statusPaneId: null,
    gardenShellPaneId: null,
    gardenPaneType: null,
    gardenWindowName: null,
    activePaneId: null,
    activePaneType: null,
    activeWindowName: null,
    lastActiveWorker: {},
  })),
  writeDashState: vi.fn(),
  STATE_FILE: "/tmp/fake-sessions/dashboard.state.json",
}));

vi.mock("../src/dashboard/layout.js", () => ({
  restoreFromHidden: vi.fn(),
}));

vi.mock("../src/dashboard/hotkeys.js", () => ({
  setupKeybindings: vi.fn(),
}));

vi.mock("../src/dashboard/header.js", () => ({
  setupStatusBar: vi.fn(),
  buildStatusCommand: vi.fn(() => "status-command"),
  updateHeaderVar: vi.fn(),
}));

vi.mock("../src/commands/status.js", () => ({
  renderQuickStatus: vi.fn(() => "status output"),
}));

vi.mock("../src/dashboard/tmux.js", () => ({
  tmux: vi.fn(),
  tmuxOutput: vi.fn(() => ""),
  tmuxSplit: vi.fn(() => "%1"),
  setPaneTitle: vi.fn(),
  setPaneLabel: vi.fn(),
  setPaneVar: vi.fn(),
  getFirstPaneId: vi.fn(() => "%5"),
  shellEscape: vi.fn((s: string) => s),
  getPaneSize: vi.fn(() => ({ width: 200, height: 50 })),
  resizeWindow: vi.fn(),
  listAllWindowNames: vi.fn(() => []),
}));

vi.mock("../src/dashboard/registry.js", () => ({
  readRegistry: vi.fn(() => ({ workers: {} })),
  updateWorkerFields: vi.fn(),
}));

vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  truncateLog: vi.fn(),
}));

vi.mock("../src/dashboard/validate.js", () => ({
  validateAndHeal: vi.fn((state: unknown) => state),
}));

vi.mock("../src/dashboard/poller.js", () => ({
  startProjectPoller: vi.fn(),
  signalFifoPath: vi.fn(() => "/tmp/fake-sessions/myproject-poll-signal"),
}));

vi.mock("../src/dashboard/git.js", () => ({
  installPollTriggerHook: vi.fn(),
  worktreeExists: vi.fn(() => true),
  resolveBaseBranch: vi.fn(() => "main"),
  getRemoteHost: vi.fn(() => "github.com"),
}));

vi.mock("../src/dashboard/window-names.js", async () => {
  const actual = await vi.importActual("../src/dashboard/window-names.js");
  return actual;
});

import fs from "node:fs";
import {
  resolveGardenRunner,
  createShellWindow,
  createLogsWindow,
  createGardenConsoleWindow,
  createGardenRootWindow,
  installClaudeHooks,
  buildWorkerCommand,
  buildResumeCommand,
  buildWorktreeWorkerCommand,
  buildWorktreeBootstrapScript,
} from "../src/dashboard/create.js";
import { tmux, tmuxSplit, getFirstPaneId, setPaneLabel, setPaneTitle, shellEscape } from "../src/dashboard/tmux.js";

const savedArgv1 = process.argv[1];
afterAll(() => { process.argv[1] = savedArgv1; });

beforeEach(() => {
  vi.clearAllMocks();
  process.argv[1] = "/usr/local/bin/garden";
});

describe("resolveGardenRunner", () => {
  it("uses node with absolute path for compiled .js binary", () => {
    process.argv[1] = "/usr/local/bin/garden";
    const result = resolveGardenRunner();
    expect(result).toContain(process.execPath);
    expect(result).toContain("/usr/local/bin/garden");
  });

  it("uses tsx when argv ends in .ts and tsx binary exists", () => {
    process.argv[1] = "/code/garden/src/cli.ts";
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const result = resolveGardenRunner();
    expect(result).toContain("tsx");
    expect(result).toContain("/code/garden/src/cli.ts");
  });

  it("falls back to npx tsx when tsx binary not found", () => {
    process.argv[1] = "/code/garden/src/cli.ts";
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const result = resolveGardenRunner();
    expect(result).toContain("npx tsx");
    expect(result).toContain("/code/garden/src/cli.ts");
  });
});

describe("installClaudeHooks", () => {
  it("writes hooks JSON to .claude/settings.local.json", () => {
    process.argv[1] = "/usr/local/bin/garden";
    installClaudeHooks("/repo/myproject", { path: "/repo/myproject" });
    expect(fs.mkdirSync).toHaveBeenCalledWith(
      expect.stringContaining(".claude"),
      { recursive: true },
    );
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("settings.local.json"),
      expect.any(String),
    );
  });

  it("includes all required hook events", () => {
    process.argv[1] = "/usr/local/bin/garden";
    installClaudeHooks("/repo/myproject", { path: "/repo/myproject" });
    const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
    const parsed = JSON.parse(written);
    expect(parsed.hooks.SessionStart).toBeDefined();
    expect(parsed.hooks.UserPromptSubmit).toBeDefined();
    expect(parsed.hooks.Stop).toBeDefined();
    expect(parsed.hooks.PreToolUse).toBeDefined();
    expect(parsed.hooks.PostToolUse).toBeDefined();
  });

  it("sets permissions.defaultMode to acceptEdits for autonomous edits inside sandbox", () => {
    process.argv[1] = "/usr/local/bin/garden";
    installClaudeHooks("/repo/myproject", { path: "/repo/myproject" });
    const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
    const parsed = JSON.parse(written);
    expect(parsed.permissions).toEqual({ defaultMode: "acceptEdits" });
  });
});

describe("buildWorkerCommand", () => {
  it("includes session-id flag", () => {
    const cmd = buildWorkerCommand("myproject", "/repo/myproject", "session-123");
    expect(cmd).toContain("--session-id session-123");
  });

  it("includes append-system-prompt-file flag", () => {
    const cmd = buildWorkerCommand("myproject", "/repo/myproject", "session-123");
    expect(cmd).toContain("--append-system-prompt-file");
  });

  it("includes exit hook and shell fallback", () => {
    const cmd = buildWorkerCommand("myproject", "/repo/myproject", "session-123");
    expect(cmd).toContain("_claude-hook stop");
    expect(cmd).toContain("exec $SHELL");
  });
});

describe("buildResumeCommand", () => {
  it("includes resume flag instead of session-id", () => {
    const cmd = buildResumeCommand("myproject", "/repo/myproject", "session-123");
    expect(cmd).toContain("--resume session-123");
    expect(cmd).not.toContain("--session-id");
  });

  it("includes exit hook and shell fallback", () => {
    const cmd = buildResumeCommand("myproject", "/repo/myproject", "session-123");
    expect(cmd).toContain("_claude-hook stop");
    expect(cmd).toContain("exec $SHELL");
  });
});

describe("buildWorktreeWorkerCommand", () => {
  it("includes session-id and context file", () => {
    const cmd = buildWorktreeWorkerCommand("myproject", "/repo/myproject", "bold-ash", "bold-ash", "session-123");
    expect(cmd).toContain("--session-id session-123");
    expect(cmd).toContain("--append-system-prompt-file");
  });
});

describe("createShellWindow", () => {
  it("creates tmux window with project path", () => {
    createShellWindow("myproject", "/repo/myproject");
    expect(tmux).toHaveBeenCalledWith(
      "new-window", "-d", "-t", "garden-dashboard",
      "-n", "_myproject-shell", "-c", "/repo/myproject",
    );
  });

  it("sets pane label and title", () => {
    createShellWindow("myproject", "/repo/myproject");
    expect(setPaneLabel).toHaveBeenCalledWith("%5", "shell-myproject");
    expect(setPaneTitle).toHaveBeenCalledWith("%5", "myproject");
  });
});

describe("createLogsWindow", () => {
  it("creates tmux window running logs script", () => {
    createLogsWindow();
    expect(tmux).toHaveBeenCalledWith(
      "new-window", "-d", "-t", "garden-dashboard",
      "-n", "_garden-logs",
      expect.any(String), expect.any(String), expect.any(String),
    );
  });

  it("sets pane label to logs", () => {
    createLogsWindow();
    expect(setPaneLabel).toHaveBeenCalledWith("%5", "logs");
  });
});

describe("createGardenConsoleWindow", () => {
  it("creates window and sends init command", () => {
    createGardenConsoleWindow("garden-runner");
    expect(tmux).toHaveBeenCalledWith(
      "new-window", "-d", "-t", "garden-dashboard",
      "-n", "_garden-garden",
    );
    expect(tmux).toHaveBeenCalledWith(
      "send-keys", "-t", "%5",
      expect.stringContaining("source"),
      "Enter",
    );
  });

  it("sets pane label to garden", () => {
    createGardenConsoleWindow("garden-runner");
    expect(setPaneLabel).toHaveBeenCalledWith("%5", "garden");
  });
});

describe("createGardenRootWindow", () => {
  it("creates window with root label", () => {
    createGardenRootWindow();
    expect(tmux).toHaveBeenCalledWith(
      "new-window", "-d", "-t", "garden-dashboard",
      "-n", "_garden-root",
    );
    expect(setPaneLabel).toHaveBeenCalledWith("%5", "root");
  });
});

describe("buildWorktreeBootstrapScript", () => {
  it("branches worktree off origin/<base>, not main checkout HEAD", () => {
    process.argv[1] = "/usr/local/bin/garden";
    buildWorktreeBootstrapScript(
      "myproject", "/repo/myproject", "bold-ash", "bold-ash",
      "session-123", "/wt/myproject/bold-ash", "main",
    );
    const call = vi.mocked(fs.writeFileSync).mock.calls.find(
      c => typeof c[0] === "string" && c[0].includes("bootstrap-myproject"),
    );
    expect(call).toBeDefined();
    const script = call![1] as string;
    // Must branch off the remote ref so stale main checkout never infects
    // workers. The literal "origin/main" at the end of the worktree-add
    // command is the load-bearing piece.
    expect(script).toMatch(/worktree add \/wt\/myproject\/bold-ash -b 'bold-ash' 'origin\/main'/);
  });

  it("defaults to branching off origin/main when baseBranch is omitted", () => {
    process.argv[1] = "/usr/local/bin/garden";
    buildWorktreeBootstrapScript(
      "myproject", "/repo/myproject", "bold-ash", "bold-ash",
      "session-123", "/wt/myproject/bold-ash",
    );
    const call = vi.mocked(fs.writeFileSync).mock.calls.find(
      c => typeof c[0] === "string" && c[0].includes("bootstrap-myproject"),
    );
    expect(call).toBeDefined();
    expect(call![1] as string).toMatch(/worktree add .* 'origin\/main'/);
  });

  it("calls _bootstrap-alert and does not swallow fetch/merge errors", () => {
    process.argv[1] = "/usr/local/bin/garden";
    buildWorktreeBootstrapScript(
      "myproject", "/repo/myproject", "bold-ash", "bold-ash",
      "session-123", "/wt/myproject/bold-ash", "develop",
    );
    const call = vi.mocked(fs.writeFileSync).mock.calls.find(
      c => typeof c[0] === "string" && c[0].includes("bootstrap-myproject"),
    );
    expect(call).toBeDefined();
    const script = call![1] as string;
    // Fetch and merge output must not be discarded via 2>/dev/null any more.
    expect(script).not.toMatch(/git -C .* fetch .* 2>\/dev\/null \|\| true/);
    expect(script).not.toMatch(/git -C .* merge --ff-only .* 2>\/dev\/null \|\| true/);
    // On failure, the bootstrap shells out to the internal alert command.
    expect(script).toContain("dashboard _bootstrap-alert 'myproject' 'develop'");
  });

  it("uses origin/<base> for the worktree branch when baseBranch has a slash in the name", () => {
    process.argv[1] = "/usr/local/bin/garden";
    buildWorktreeBootstrapScript(
      "myproject", "/repo/myproject", "bold-ash", "bold-ash",
      "session-123", "/wt/myproject/bold-ash", "release/2026-04",
    );
    const call = vi.mocked(fs.writeFileSync).mock.calls.find(
      c => typeof c[0] === "string" && c[0].includes("bootstrap-myproject"),
    );
    expect(call).toBeDefined();
    expect(call![1] as string).toMatch(/worktree add .* 'origin\/release\/2026-04'/);
  });
});

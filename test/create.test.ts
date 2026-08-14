import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";

vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(() => "{}"),
    appendFileSync: vi.fn(),
    renameSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    statSync: vi.fn(() => ({ size: 0 })),
    unlinkSync: vi.fn(),
    rmSync: vi.fn(),
    constants: { O_CREAT: 0, O_EXCL: 0, O_WRONLY: 0 },
  },
}));

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => "/repo/myproject/.git\n"),
}));

vi.mock("../src/session.js", () => ({
  dashboardExists: vi.fn(() => false),
  DASHBOARD_SESSION: "garden-dashboard",
}));

vi.mock("../src/config.js", () => {
  const tryResolveProvider = vi.fn(() => null);
  const loadConfig = vi.fn(() => ({ projects: { myproject: { path: "/repo/myproject" } } }));
  return {
    logColorKeyForProject: vi.fn(() => null),
    loadConfig,
    tryGetProject: vi.fn(() => ({ path: "/repo/myproject" })),
    tryResolveClaudeProfile: vi.fn(() => null),
    tryResolveProvider,
    resolveProvider: vi.fn((project: { provider?: string }, config?: { providers?: Record<string, Record<string, unknown>> }) => {
      const provider = tryResolveProvider(project);
      if (provider) return provider;
      if (!project.provider) return null;
      const definition = (config ?? loadConfig()).providers?.[project.provider];
      if (!definition) throw new Error(`Unknown provider '${project.provider}'.`);
      return { ...definition, name: project.provider, label: definition.label ?? project.provider };
    }),
    anyAnthropicMeteredProject: vi.fn(() => true),
    // Mirror the real one-rule resolver: beadsDir wins, else the checkout's
    // own .beads (beadsEnvExports tests assert the generated exports).
    resolveBeadsDir: vi.fn((p: { path: string; beadsDir?: string }) =>
      p.beadsDir ?? `${p.path}/.beads`),
    ENV_VAR_NAME_RE: /^[A-Z_][A-Z0-9_]*$/,
    getFocusedProjectNames: vi.fn(() => ["myproject"]),
    SESSIONS_DIR: "/tmp/fake-sessions",
  };
});

vi.mock("../src/rules.js", () => ({
  buildRulesContext: vi.fn(() => "rules"),
  buildWorktreeRules: vi.fn(() => "worktree rules"),
}));

describe("provider env in worker commands", () => {
  it("prepends the provider env ahead of the claude binary", async () => {
    const { tryResolveProvider } = await import("../src/config.js");
    vi.mocked(tryResolveProvider).mockReturnValue({
      name: "deepseek", label: "deepseek",
      baseUrl: "https://api.deepseek.com/anthropic",
      authTokenEnv: "DEEPSEEK_API_KEY",
      modelMap: { opus: "deepseek-v4-pro" },
    });
    const { buildWorkerCommand } = await import("../src/dashboard/create.js");
    const cmd = buildWorkerCommand("myproject", "/repo/myproject", "sess-1");
    vi.mocked(tryResolveProvider).mockReturnValue(null);
    expect(cmd).toContain("ANTHROPIC_BASE_URL=");
    expect(cmd).toMatch(/ANTHROPIC_AUTH_TOKEN="\$GARDEN_PROVIDER_TOKEN_[A-F0-9]+"/);
    expect(cmd).toMatch(/env -u GARDEN_PROVIDER_TOKEN_[A-F0-9]+ claude --rc/);
    expect(cmd).not.toContain("$DEEPSEEK_API_KEY");
    expect(cmd).toContain("ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek-v4-pro");
    // The env assignments must precede the binary they configure.
    expect(cmd.indexOf("ANTHROPIC_BASE_URL=")).toBeLessThan(cmd.indexOf("claude --rc"));
  });
});

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
    lastActiveProjectByPlot: {},
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
  buildUsageCommand: vi.fn(() => "usage-command"),
  buildHistoryCommand: vi.fn(() => "history-command"),
  buildAlertsCommand: vi.fn(() => "alerts-command"),
  statusRenderedHeight: vi.fn(() => 23),
  usageRenderedHeight: vi.fn(() => 8),
  updateHeaderVar: vi.fn(),
  setPaneProjectColor: vi.fn(),
}));

vi.mock("../src/commands/status.js", () => ({
  renderQuickStatus: vi.fn(() => "status output"),
}));

vi.mock("../src/dashboard/tmux.js", () => ({
  tmux: vi.fn(),
  newDashboardWindow: vi.fn(),
  tmuxOutput: vi.fn(() => ""),
  tmuxSplit: vi.fn(() => "%1"),
  setPaneTitle: vi.fn(),
  setPaneLabel: vi.fn(),
  setPaneVar: vi.fn(),
  getFirstPaneId: vi.fn(() => "%5"),
  // Mirror the real shellEscape: pass safe-token strings through unquoted,
  // wrap others in single quotes with the inner-quote escape. Tests assert
  // the actual generated bash, so the mock has to match production semantics.
  shellEscape: vi.fn((s: string) =>
    /^[a-zA-Z0-9_./:=-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`,
  ),
  getPaneSize: vi.fn(() => ({ width: 200, height: 50 })),
  resizeWindow: vi.fn(),
  listAllWindowNames: vi.fn(() => []),
  disablePaneInput: vi.fn(),
  lockPaneMouse: vi.fn(),
  killWindowSafe: vi.fn(),
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
  getWorkerBaseBranch: vi.fn((entry: { baseBranch?: string }) => entry.baseBranch ?? "main"),
  getRemoteHost: vi.fn(() => "github.com"),
}));

vi.mock("../src/dashboard/window-names.js", async () => {
  const actual = await vi.importActual("../src/dashboard/window-names.js");
  return actual;
});

import fs from "node:fs";
import { claudeCodeAdapter } from "../src/dashboard/harness/claude-code.js";
import {
  createShellWindow,
  createLogsWindow,
  createGardenGrowhouseWindow,
  createGardenRootWindow,
  buildWorkerCommand,
  buildResumeCommand,
  beadsEnvExports,
  buildWorktreeWorkerCommand,
  buildWorktreeBootstrapScript,
  buildWorktreeResumeCommand,
  respawnWorkerWindow,
  respawnStatusPane,
  respawnUsagePane,
  respawnHistoryPane,
  respawnAlertsPane,
} from "../src/dashboard/create.js";
import { tmux, newDashboardWindow, tmuxSplit, getFirstPaneId, setPaneLabel, setPaneTitle, setPaneVar, shellEscape, disablePaneInput, killWindowSafe } from "../src/dashboard/tmux.js";
import { tryGetProject, tryResolveProvider } from "../src/config.js";

const savedArgv1 = process.argv[1];
afterAll(() => { process.argv[1] = savedArgv1; });

beforeEach(() => {
  vi.clearAllMocks();
  process.argv[1] = "/usr/local/bin/garden";
  vi.mocked(tryGetProject).mockReset().mockReturnValue({ path: "/repo/myproject" });
  vi.mocked(tryResolveProvider).mockReset().mockReturnValue(null);
});

describe("claude-code adapter installRuntimeConfig", () => {
  // Moved from create.ts onto the harness adapter (docs/MULTI-MODEL.md
  // "Layer 3"); the behavioral contract is unchanged.
  it("writes hooks JSON to .claude/settings.json", () => {
    process.argv[1] = "/usr/local/bin/garden";
    claudeCodeAdapter.installRuntimeConfig("/repo/myproject", { path: "/repo/myproject" });
    expect(fs.mkdirSync).toHaveBeenCalledWith(
      expect.stringContaining(".claude"),
      { recursive: true },
    );
    // atomicWriteFile renames the tmp file onto the final settings.json path.
    expect(fs.renameSync).toHaveBeenCalledWith(
      expect.stringMatching(/\.claude\/settings\.json\.[0-9a-f-]+\.tmp$/),
      expect.stringMatching(/\.claude\/settings\.json$/),
    );
  });

  it("does not write to settings.local.json (Claude Code auto-edits it)", () => {
    process.argv[1] = "/usr/local/bin/garden";
    claudeCodeAdapter.installRuntimeConfig("/repo/myproject", { path: "/repo/myproject" });
    // Settings.local.json must not appear as a rename target either.
    const renameTargets = vi.mocked(fs.renameSync).mock.calls.map(c => String(c[1]));
    expect(renameTargets.every(p => !p.endsWith("settings.local.json"))).toBe(true);
  });

  // Find the writeFileSync call whose tmp path corresponds to settings.json.
  function settingsJsonContent(): string {
    const writes = vi.mocked(fs.writeFileSync).mock.calls;
    const call = writes.find(c => /\.claude\/settings\.json\.[0-9a-f-]+\.tmp$/.test(String(c[0])));
    if (!call) throw new Error("settings.json write not found");
    return String(call[1]);
  }

  it("includes all required hook events", () => {
    process.argv[1] = "/usr/local/bin/garden";
    claudeCodeAdapter.installRuntimeConfig("/repo/myproject", { path: "/repo/myproject" });
    const parsed = JSON.parse(settingsJsonContent());
    expect(parsed.hooks.SessionStart).toBeDefined();
    expect(parsed.hooks.UserPromptSubmit).toBeDefined();
    expect(parsed.hooks.Stop).toBeDefined();
    expect(parsed.hooks.PreToolUse).toBeDefined();
    expect(parsed.hooks.PermissionRequest).toBeDefined();
    expect(parsed.hooks.PostToolUse).toBeDefined();
  });

  it("registers a PermissionRequest hook that flips the worker to idle on approval prompts", () => {
    process.argv[1] = "/usr/local/bin/garden";
    claudeCodeAdapter.installRuntimeConfig("/repo/myproject", { path: "/repo/myproject" });
    const parsed = JSON.parse(settingsJsonContent());
    const permReq = parsed.hooks.PermissionRequest[0];
    expect(permReq.matcher).toBe("");
    expect(permReq.hooks[0].command).toContain("hook.js pretooluse");
  });

  it("registers a catch-all PostToolUse hook so asking flips back to working after any tool completes", () => {
    process.argv[1] = "/usr/local/bin/garden";
    claudeCodeAdapter.installRuntimeConfig("/repo/myproject", { path: "/repo/myproject" });
    const parsed = JSON.parse(settingsJsonContent());
    const catchAll = parsed.hooks.PostToolUse.find((h: { matcher: string }) => h.matcher === "");
    expect(catchAll).toBeDefined();
    expect(catchAll.hooks[0].command).toContain("hook.js posttooluse");
  });

  it("also writes the bundled `done` skill at .claude/skills/done/SKILL.md (Claude Code's required dir+SKILL.md layout)", () => {
    process.argv[1] = "/usr/local/bin/garden";
    claudeCodeAdapter.installRuntimeConfig("/repo/myproject", { path: "/repo/myproject" });
    const writes = vi.mocked(fs.writeFileSync).mock.calls;
    // atomic-write goes through a tmp path; match the prefix.
    const skillCall = writes.find(c => /\.claude\/skills\/done\/SKILL\.md\.[0-9a-f-]+\.tmp$/.test(String(c[0])));
    expect(skillCall).toBeDefined();
    const content = String(skillCall![1]);
    expect(content).toMatch(/^---\nname: done\n/);
    expect(content).toContain(".garden-done");
    expect(content).toContain("description:");
    expect(fs.mkdirSync).toHaveBeenCalledWith(
      expect.stringContaining(".claude/skills/done"),
      { recursive: true },
    );
    // The legacy flat-file path must be removed so refreshes/bounces of pre-fix worktrees heal.
    expect(fs.rmSync).toHaveBeenCalledWith(
      "/repo/myproject/.claude/skills/done.md",
      { force: true },
    );
  });

  it("sets permissions.defaultMode to auto and pre-allows tmux plus read-only tail utilities so compound tmux chains don't escalate", () => {
    process.argv[1] = "/usr/local/bin/garden";
    claudeCodeAdapter.installRuntimeConfig("/repo/myproject", { path: "/repo/myproject" });
    const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
    const parsed = JSON.parse(written);
    expect(parsed.permissions).toEqual({
      defaultMode: "auto",
      allow: [
        "Bash(tmux:*)",
        "Bash(echo:*)",
        "Bash(head:*)",
        "Bash(tail:*)",
        "Bash(cat:*)",
        "Bash(grep:*)",
        "Bash(wc:*)",
      ],
    });
  });

  // Worktrees spawned before a new exclude pattern was added (e.g. .garden/
  // when the grow workflow shipped) carry stale info/exclude — the bootstrap
  // script's exclude block runs once at spawn, never again. installRuntimeConfig
  // runs on every refresh + bounce + post-merge auto-continue, so it's the
  // hook that heals existing workers without requiring a re-bootstrap.
  it("appends missing exclude patterns to .git/info/exclude on existing worktrees", async () => {
    process.argv[1] = "/usr/local/bin/garden";
    const childProcess = await import("node:child_process");
    vi.mocked(childProcess.execFileSync).mockReturnValueOnce(
      "/repo/myproject/.git\n" as unknown as Buffer,
    );
    // exclude file currently has only the original two patterns; the grow
    // pattern is missing.
    vi.mocked(fs.readFileSync).mockReturnValueOnce(".claude/\n.garden-hooks/\n");

    claudeCodeAdapter.installRuntimeConfig("/repo/myproject", { path: "/repo/myproject" });

    const appendCall = vi.mocked(fs.appendFileSync).mock.calls.find(
      c => String(c[0]).endsWith("info/exclude"),
    );
    expect(appendCall).toBeDefined();
    expect(String(appendCall![1])).toContain(".garden/");
    // Patterns already present must NOT be re-appended.
    expect(String(appendCall![1])).not.toContain(".claude/");
    expect(String(appendCall![1])).not.toContain(".garden-hooks/");
  });

  // wolf's main accidentally absorbed a committed .garden-done on 2026-05-06;
  // every new worker inherited it via git checkout, the Stop hook tripped
  // terminal `done` from the file's mere presence, and post-merge
  // auto-continue stayed silent. ensureWorktreeExcludes must add the
  // sentinel to info/exclude on heal so an accidental `git add -A` in a
  // future review can't reproduce the same trap.
  it("heals existing worktrees by adding .garden-done to info/exclude", async () => {
    process.argv[1] = "/usr/local/bin/garden";
    const childProcess = await import("node:child_process");
    vi.mocked(childProcess.execFileSync).mockReturnValueOnce(
      "/repo/myproject/.git\n" as unknown as Buffer,
    );
    vi.mocked(fs.readFileSync).mockReturnValueOnce(
      ".claude/\n.garden-hooks/\n.garden/\n",
    );

    claudeCodeAdapter.installRuntimeConfig("/repo/myproject", { path: "/repo/myproject" });

    const appendCall = vi.mocked(fs.appendFileSync).mock.calls.find(
      c => String(c[0]).endsWith("info/exclude"),
    );
    expect(appendCall).toBeDefined();
    expect(String(appendCall![1])).toContain(".garden-done");
  });

  it("does not touch info/exclude when all patterns are already present", async () => {
    process.argv[1] = "/usr/local/bin/garden";
    const childProcess = await import("node:child_process");
    vi.mocked(childProcess.execFileSync).mockReturnValueOnce(
      "/repo/myproject/.git\n" as unknown as Buffer,
    );
    vi.mocked(fs.readFileSync).mockReturnValueOnce(
      ".claude/\n.garden-hooks/\n.garden/\n.garden-done\n.garden-awaiting-input\n",
    );

    claudeCodeAdapter.installRuntimeConfig("/repo/myproject", { path: "/repo/myproject" });

    const appendCalls = vi.mocked(fs.appendFileSync).mock.calls.filter(
      c => String(c[0]).endsWith("info/exclude"),
    );
    expect(appendCalls).toHaveLength(0);
  });

  it("silently skips when the exclude file or git common dir is unreachable (best-effort)", async () => {
    process.argv[1] = "/usr/local/bin/garden";
    const childProcess = await import("node:child_process");
    // git rev-parse fails (worktree may not exist yet on first install).
    vi.mocked(childProcess.execFileSync).mockImplementationOnce(() => {
      throw new Error("not a git repo");
    });

    expect(() =>
      claudeCodeAdapter.installRuntimeConfig("/repo/myproject", { path: "/repo/myproject" }),
    ).not.toThrow();
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

  it("includes --rc so worker surfaces in Claude app remote sessions", () => {
    const cmd = buildWorkerCommand("myproject", "/repo/myproject", "session-123");
    expect(cmd).toContain("--rc");
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

  it("includes --rc so resumed worker surfaces in Claude app remote sessions", () => {
    const cmd = buildResumeCommand("myproject", "/repo/myproject", "session-123");
    expect(cmd).toContain("--rc");
  });

  it("includes exit hook and shell fallback", () => {
    const cmd = buildResumeCommand("myproject", "/repo/myproject", "session-123");
    expect(cmd).toContain("_claude-hook stop");
    expect(cmd).toContain("exec $SHELL");
  });
});

describe("respawnWorkerWindow capability gate", () => {
  it("does not recreate an existing worker after its harness/provider pair becomes incompatible", () => {
    const result = respawnWorkerWindow(
      "myproject",
      { name: "myproject", path: "/repo/myproject", provider: "deepseek" },
      {
        name: "bold-ash",
        sessionId: "session-1",
        task: "",
        harness: "codex",
        workflow: "default",
      },
      null,
    );

    expect(result).toBeNull();
    expect(newDashboardWindow).not.toHaveBeenCalled();
  });

  // The attach-time resume loop calls this before keybindings, the pollers,
  // and the watchdog are started, so an escaping launch error takes the whole
  // dashboard down with it — dead hotkeys and no review pipeline for every
  // project — over one worker whose provider token is in neither the shell nor
  // the vault. Report it as an unresumed worker (null) instead, and don't
  // leave the placeholder window standing in for a worker that never launched.
  it("reports a failed provider launch as unresumed rather than throwing", async () => {
    const { tryResolveProvider } = await import("../src/config.js");
    vi.mocked(tryResolveProvider).mockReturnValue({
      name: "deepseek", label: "deepseek",
      baseUrl: "https://api.deepseek.com/anthropic",
      authTokenEnv: "DEEPSEEK_API_KEY_ABSENT",
    });
    try {
      const result = respawnWorkerWindow(
        "myproject",
        { name: "myproject", path: "/repo/myproject", provider: "deepseek" },
        { name: "bold-ash", sessionId: "session-1", task: "", workflow: "default" },
        null,
      );

      expect(result).toBeNull();
      expect(killWindowSafe).toHaveBeenCalledWith("_myproject-worker-bold-ash");
    } finally {
      vi.mocked(tryResolveProvider).mockReturnValue(null);
    }
  });
});

describe("buildWorktreeWorkerCommand", () => {
  it("includes session-id and context file", () => {
    const cmd = buildWorktreeWorkerCommand("myproject", "/repo/myproject", "bold-ash", "bold-ash", "session-123");
    expect(cmd).toContain("--session-id session-123");
    expect(cmd).toContain("--append-system-prompt-file");
  });

  it("includes --rc so worker surfaces in Claude app remote sessions", () => {
    const cmd = buildWorktreeWorkerCommand("myproject", "/repo/myproject", "bold-ash", "bold-ash", "session-123");
    expect(cmd).toContain("--rc");
  });

  // The per-worker backend (the build member's axis-1 half). These three cases
  // are the whole contract of WorkerEntry.provider's encoding, checked where it
  // actually matters: the env the worker launches with.
  describe("per-worker provider", () => {
    // Resolve against whatever project view the builder passes, so the test
    // observes the override rather than a fixed mock answer.
    const byProject = async () => {
      const { tryResolveProvider } = await import("../src/config.js");
      vi.mocked(tryResolveProvider).mockImplementation((p: { provider?: string }) =>
        p?.provider
          ? {
              name: p.provider, label: p.provider,
              baseUrl: `https://api.${p.provider}.com/anthropic`,
              authTokenEnv: "TOKEN_ENV",
            }
          : null);
    };
    const project = { name: "myproject", path: "/repo/myproject", provider: "deepseek" };

    beforeEach(async () => {
      await byProject();
      const { tryGetProject } = await import("../src/config.js");
      vi.mocked(tryGetProject).mockReturnValue(project as ReturnType<typeof tryGetProject>);
    });

    afterEach(async () => {
      const { tryResolveProvider } = await import("../src/config.js");
      vi.mocked(tryResolveProvider).mockReturnValue(null);
    });

    it("no per-worker answer inherits the project's provider", () => {
      const cmd = buildWorktreeWorkerCommand("myproject", "/repo/myproject", "bold-ash", "bold-ash", "s1");
      expect(cmd).toContain("https://api.deepseek.com/anthropic");
    });

    it("a named backend overrides the project's", () => {
      const cmd = buildWorktreeWorkerCommand("myproject", "/repo/myproject", "bold-ash", "bold-ash", "s1",
        undefined, { provider: "othervendor" });
      expect(cmd).toContain("https://api.othervendor.com/anthropic");
      expect(cmd).not.toContain("deepseek");
    });

    it("the empty-string marker clears the project's provider (explicitly first-party)", () => {
      // The load-bearing case. Absent and "" must NOT behave alike: a member
      // that named no backend means first-party, so this worker has to launch
      // with no provider env even though its project has one.
      const cmd = buildWorktreeWorkerCommand("myproject", "/repo/myproject", "bold-ash", "bold-ash", "s1",
        undefined, { provider: "" });
      expect(cmd).not.toContain("ANTHROPIC_BASE_URL=");
      expect(cmd).not.toContain("deepseek");
    });
  });
});

describe("createShellWindow", () => {
  it("creates tmux window with project path", () => {
    createShellWindow("myproject", "/repo/myproject");
    expect(newDashboardWindow).toHaveBeenCalledWith(
      "_myproject-shell", "-c", "/repo/myproject",
    );
  });

  it("sets pane label and title", () => {
    createShellWindow("myproject", "/repo/myproject");
    expect(setPaneLabel).toHaveBeenCalledWith("%5", "shell-myproject");
    expect(setPaneTitle).toHaveBeenCalledWith("%5", "myproject");
  });

  it("sets the wall-clock pane var so the right-pane shell shows the clock", () => {
    createShellWindow("myproject", "/repo/myproject");
    expect(setPaneVar).toHaveBeenCalledWith("%5", "garden_clock", "1");
  });
});

describe("createLogsWindow", () => {
  it("creates tmux window running logs script", () => {
    createLogsWindow();
    expect(newDashboardWindow).toHaveBeenCalledWith(
      "_garden-logs",
      expect.any(String), expect.any(String), expect.any(String),
    );
  });

  it("sets pane label to logs", () => {
    createLogsWindow();
    expect(setPaneLabel).toHaveBeenCalledWith("%5", "logs");
  });

  it("hard-disables pane input so logs stays read-only across swaps", () => {
    createLogsWindow();
    expect(disablePaneInput).toHaveBeenCalledWith("%5");
  });
});

describe("passive pane respawn helpers (garden redraw)", () => {
  const baseState = {
    statusPaneId: "%2",
    usagePaneId: "%3",
    gardenShellPaneId: "%0",
    gardenPaneType: "growhouse",
  } as never;

  it("respawnStatusPane preserves the rendered content-derived height", () => {
    respawnStatusPane(baseState);
    expect(tmux).toHaveBeenCalledWith("respawn-pane", "-k", "-t", "%2", "sh", "-c", "status-command");
    expect(tmux).toHaveBeenCalledWith("resize-pane", "-t", "%2", "-y", "23");
  });

  it("respawnUsagePane preserves the rendered height and re-disables input", () => {
    respawnUsagePane(baseState);
    expect(tmux).toHaveBeenCalledWith("respawn-pane", "-k", "-t", "%3", "sh", "-c", "usage-command");
    expect(tmux).toHaveBeenCalledWith("resize-pane", "-t", "%3", "-y", "8");
    expect(disablePaneInput).toHaveBeenCalledWith("%3");
  });

  it("respawnUsagePane no-ops without a usagePaneId", () => {
    respawnUsagePane({ ...(baseState as object), usagePaneId: null } as never);
    expect(tmux).not.toHaveBeenCalled();
  });

  it("respawnHistoryPane targets the garden slot when history is the active view", () => {
    respawnHistoryPane({ ...(baseState as object), gardenPaneType: "history" } as never);
    expect(tmux).toHaveBeenCalledWith("respawn-pane", "-k", "-t", "%0", "sh", "-c", "history-command");
    expect(disablePaneInput).toHaveBeenCalledWith("%0");
  });

  it("respawnHistoryPane targets the hidden _garden-history window otherwise", () => {
    respawnHistoryPane(baseState);
    expect(getFirstPaneId).toHaveBeenCalledWith("garden-dashboard:_garden-history");
    expect(tmux).toHaveBeenCalledWith("respawn-pane", "-k", "-t", "%5", "sh", "-c", "history-command");
  });

  it("respawnAlertsPane targets the hidden _garden-alerts window when not active", () => {
    respawnAlertsPane(baseState);
    expect(getFirstPaneId).toHaveBeenCalledWith("garden-dashboard:_garden-alerts");
    expect(tmux).toHaveBeenCalledWith("respawn-pane", "-k", "-t", "%5", "sh", "-c", "alerts-command");
  });

  it("respawn helpers no-op when the hidden window does not exist", () => {
    vi.mocked(getFirstPaneId).mockImplementationOnce(() => { throw new Error("no window"); });
    respawnAlertsPane(baseState);
    expect(tmux).not.toHaveBeenCalled();
  });
});

describe("createGardenGrowhouseWindow", () => {
  it("creates window and sends init command", () => {
    createGardenGrowhouseWindow("garden-runner");
    expect(newDashboardWindow).toHaveBeenCalledWith("_garden-growhouse");
    expect(tmux).toHaveBeenCalledWith(
      "send-keys", "-t", "%5",
      expect.stringContaining("source"),
      "Enter",
    );
  });

  it("sets pane label to growhouse", () => {
    createGardenGrowhouseWindow("garden-runner");
    expect(setPaneLabel).toHaveBeenCalledWith("%5", "growhouse");
  });
});

describe("createGardenRootWindow", () => {
  it("creates window with root label", () => {
    createGardenRootWindow();
    expect(newDashboardWindow).toHaveBeenCalledWith("_garden-root");
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
    // workers. The "origin/$BASE" at the end of the worktree-add command is
    // the load-bearing piece — $BASE is initialized to the requested base
    // and may be rewritten by the missing-base fallback path.
    expect(script).toContain("BASE=main");
    expect(script).toMatch(/worktree add \/wt\/myproject\/bold-ash -b bold-ash "origin\/\$BASE"/);
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
    const script = call![1] as string;
    expect(script).toContain("BASE=main");
    expect(script).toMatch(/worktree add .* "origin\/\$BASE"/);
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
    // $BASE is initialized to the requested base; the alert receives its
    // runtime value (rewritten when the missing-base fallback fires).
    expect(script).toContain("BASE=develop");
    expect(script).toContain('dashboard _bootstrap-alert myproject "$BASE"');
  });

  it("writes Claude hooks to .claude/settings.json, not settings.local.json", () => {
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
    expect(script).toContain("/.claude/settings.json");
    expect(script).not.toContain("/.claude/settings.local.json");
  });

  it("inlines the bundled `done` skill at .claude/skills/done/SKILL.md so new workers can invoke it without a refresh round-trip", () => {
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
    expect(script).toContain("mkdir -p /wt/myproject/bold-ash/.claude/skills/done");
    expect(script).toContain("/.claude/skills/done/SKILL.md");
    expect(script).toContain("name: done");
  });

  it("also inlines the bundled `handoff` skill so new workers can invoke it without a refresh round-trip", () => {
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
    expect(script).toContain("mkdir -p /wt/myproject/bold-ash/.claude/skills/handoff");
    expect(script).toContain("/.claude/skills/handoff/SKILL.md");
    expect(script).toContain("name: handoff");
  });

  it("launches claude with --rc so worker surfaces in Claude app remote sessions", () => {
    process.argv[1] = "/usr/local/bin/garden";
    buildWorktreeBootstrapScript(
      "myproject", "/repo/myproject", "bold-ash", "bold-ash",
      "session-123", "/wt/myproject/bold-ash", "main",
    );
    const call = vi.mocked(fs.writeFileSync).mock.calls.find(
      c => typeof c[0] === "string" && c[0].includes("bootstrap-myproject"),
    );
    expect(call).toBeDefined();
    expect(call![1] as string).toContain("claude --rc --session-id session-123");
  });

  // The launch env and the sandbox egress allowlist must name the SAME backend.
  // A worker whose build member named a provider the project does not use would
  // otherwise launch at that endpoint with only the project's host allowlisted.
  it("allowlists the per-worker provider's inference host in the sandbox, not the project's", async () => {
    process.argv[1] = "/usr/local/bin/garden";
    const { tryResolveProvider, tryGetProject } = await import("../src/config.js");
    vi.mocked(tryGetProject).mockReturnValue({
      name: "myproject", path: "/repo/myproject", provider: "deepseek",
    } as ReturnType<typeof tryGetProject>);
    vi.mocked(tryResolveProvider).mockImplementation((p: { provider?: string }) =>
      p?.provider
        ? {
            name: p.provider, label: p.provider,
            baseUrl: `https://api.${p.provider}.com/anthropic`,
            authTokenEnv: "TOKEN_ENV",
          }
        : null);
    try {
      buildWorktreeBootstrapScript(
        "myproject", "/repo/myproject", "bold-ash", "bold-ash",
        "session-123", "/wt/myproject/bold-ash", "main", { provider: "othervendor" },
      );
      const call = vi.mocked(fs.writeFileSync).mock.calls.find(
        c => typeof c[0] === "string" && c[0].includes("bootstrap-myproject"),
      );
      const script = call![1] as string;
      expect(script).toContain("api.othervendor.com");
      expect(script).not.toContain("api.deepseek.com");
    } finally {
      vi.mocked(tryResolveProvider).mockReturnValue(null);
      vi.mocked(tryGetProject).mockReturnValue({ path: "/repo/myproject" } as ReturnType<typeof tryGetProject>);
    }
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
    const script = call![1] as string;
    // $BASE is initialized as a shell variable so the missing-base fallback
    // can rewrite it mid-script; the worktree-add uses "origin/$BASE" so a
    // rewrite (e.g. release/2026-04 → main) is reflected.
    expect(script).toContain("BASE=release/2026-04");
    expect(script).toMatch(/worktree add .* "origin\/\$BASE"/);
  });

  it("exports worker identity env vars so `garden whoami` and `garden logs -w $GARDEN_WORKER` work inside the worker shell", () => {
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
    expect(script).toContain("export GARDEN_PROJECT=myproject");
    expect(script).toContain("export GARDEN_WORKER=bold-ash");
    expect(script).toContain("export GARDEN_BRANCH=bold-ash");
    // BASE is a shell variable initialized to the requested base; it may
    // be rewritten by the missing-base fallback before/while Claude runs.
    expect(script).toContain("BASE=develop");
    expect(script).toContain('export GARDEN_BASE_BRANCH="$BASE"');
  });

  // Regression: wolf's main accidentally absorbed a committed .garden-done on
  // 2026-05-06. Every new wolf worker inherited it via `git worktree add`,
  // tripped terminal `done` from the file's mere presence in the first Stop
  // hook, and silently suppressed post-merge auto-continue across multiple
  // merge cycles. The bootstrap must defuse a tracked sentinel before the
  // first Stop hook fires, using skip-worktree so `git status` stays clean
  // and `git checkout HEAD -- .garden-done` cannot resurrect it.
  it("neutralizes a .garden-done sentinel tracked in HEAD of the base branch", () => {
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
    // Detection: list HEAD for the path; grep distinguishes "tracked" from
    // empty output. The neutralization runs only when the file is tracked.
    expect(script).toMatch(/git -C \/wt\/myproject\/bold-ash ls-tree HEAD \.garden-done/);
    // skip-worktree keeps `git status` clean and breaks path-scoped checkout
    // from HEAD (the specific failure mode swift-trim-knoll hit).
    expect(script).toContain("update-index --skip-worktree .garden-done");
    expect(script).toContain("rm -f /wt/myproject/bold-ash/.garden-done");
  });

  // The done skill description points workers at info/exclude as the
  // why-shouldn't-I-`git add`-it answer. The bootstrap must wire that
  // promise into the actual exclude file or the skill text is a lie.
  it("appends .garden-done to the common info/exclude alongside the dir patterns", () => {
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
    expect(script).toMatch(/for pattern in .claude\/ .garden-hooks\/ .garden\/ .garden-done .garden-awaiting-input; do/);
  });

  // The poll-trigger hooksPath must be worktree-scoped, never a plain --local
  // write (which leaks into the shared .git/config and makes the operator's
  // main checkout run this sandbox-writable hook unsandboxed).
  it("scopes the poll-trigger hooksPath to the worktree, not the shared config", () => {
    process.argv[1] = "/usr/local/bin/garden";
    buildWorktreeBootstrapScript(
      "myproject", "/repo/myproject", "bold-ash", "bold-ash",
      "session-123", "/wt/myproject/bold-ash", "main",
    );
    const call = vi.mocked(fs.writeFileSync).mock.calls.find(
      c => typeof c[0] === "string" && c[0].includes("bootstrap-myproject"),
    );
    const script = call![1] as string;
    expect(script).toContain("config extensions.worktreeConfig true");
    expect(script).toContain("config --worktree core.hooksPath");
    // The shell migration var must survive as shell (not JS-interpolated away).
    expect(script).toContain("$_gh_leaked");
    // The leak-prone form must be gone.
    expect(script).not.toMatch(/config --local core\.hooksPath \S*\.garden-hooks/);
  });

  // Regression: lex 2026-05-12 — operator merged a PR and deleted the branch
  // on origin while the main checkout was still parked on that branch. The
  // existing local refs/remotes/origin/<base> ref let branchExistsOnOrigin
  // pass at hotkey time; bootstrap then exited 1, the right-slot pane died,
  // and every subsequent park/swap returned "active pane missing or dead"
  // until garden was rebuilt. The fix: detect the missing-base case in the
  // bootstrap script and either fall back to origin's default branch or
  // keep the pane alive (exec $SHELL) so the dashboard layout never loses
  // its right-slot pane.
  it("falls back to origin's default branch when the requested base is missing on origin", () => {
    process.argv[1] = "/usr/local/bin/garden";
    buildWorktreeBootstrapScript(
      "myproject", "/repo/myproject", "bold-ash", "bold-ash",
      "session-123", "/wt/myproject/bold-ash", "fix/sophia-errors",
    );
    const call = vi.mocked(fs.writeFileSync).mock.calls.find(
      c => typeof c[0] === "string" && c[0].includes("bootstrap-myproject"),
    );
    expect(call).toBeDefined();
    const script = call![1] as string;
    // The fallback resolves origin's default via ls-remote --symref HEAD,
    // notifies the dashboard so the registry entry's baseBranch updates,
    // and prunes the stale local remote ref so future workers don't trip
    // on the same dead branch.
    expect(script).toContain("ls-remote --symref origin HEAD");
    expect(script).toContain('dashboard _bootstrap-rebase myproject bold-ash "$DEFAULT_BRANCH"');
    expect(script).toContain('update-ref -d "refs/remotes/origin/$ORIG_BASE"');
    // After the fallback rewrites $BASE, the script must re-fetch under the
    // new base — otherwise the worktree add would still race against the
    // pre-fallback ref.
    expect(script).toMatch(/Falling back to origin default/);
  });

  // Regression: 2026-08-13 GitHub outage — git auth degraded, so both fetch
  // and ls-remote failed with "Permission denied (publickey)" (exit 128).
  // The script treated ANY non-zero ls-remote exit as "branch gone from
  // origin" and aborted with "base main missing on origin and origin/HEAD
  // unresolved", sending the operator to fix a checkout that was healthy.
  // ls-remote --exit-code distinguishes the cases: exit 2 means origin
  // answered and the ref is absent; any other failure means origin was
  // unreachable and the base must not be second-guessed.
  it("falls back only on ls-remote exit 2 and reports other failures as origin unreachable", () => {
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
    // The missing-base fallback fires on exit 2 specifically, not on any
    // non-zero exit.
    expect(script).toContain('[ "$LS_RC" -eq 2 ]');
    expect(script).not.toMatch(/^\s*if \[ "\$LS_RC" -ne 0 \]/m);
    // Every other non-zero exit (auth failure, outage, DNS) aborts with a
    // message naming the real condition and remedy — never the misleading
    // "missing on origin" advice.
    expect(script).toMatch(/could not reach origin to verify base/);
    expect(script).toContain(
      'dashboard _bootstrap-fail myproject bold-ash "could not reach origin',
    );
    // The unreachable abort keeps the right-slot pane alive like the other
    // abort paths.
    expect(script).toMatch(/elif \[ "\$LS_RC" -ne 0 \]; then[\s\S]*?exec \$SHELL/);
  });

  it("traps unhandled errors with exec \\$SHELL so a failure outside the missing-base path still keeps the right-slot pane alive", () => {
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
    // The ERR trap catches set-e exits anywhere (e.g. `git worktree add`
    // colliding on directory) and execs $SHELL — without it, those paths
    // also tmux-close the right slot.
    expect(script).toContain("trap '_rc=$?;");
    expect(script).toMatch(/Bootstrap aborted unexpectedly/);
    expect(script).toContain("exec $SHELL");
  });

  it("keeps the pane alive (exec \\$SHELL) when bootstrap cannot resolve a usable base", () => {
    process.argv[1] = "/usr/local/bin/garden";
    buildWorktreeBootstrapScript(
      "myproject", "/repo/myproject", "bold-ash", "bold-ash",
      "session-123", "/wt/myproject/bold-ash", "fix/sophia-errors",
    );
    const call = vi.mocked(fs.writeFileSync).mock.calls.find(
      c => typeof c[0] === "string" && c[0].includes("bootstrap-myproject"),
    );
    expect(call).toBeDefined();
    const script = call![1] as string;
    // Removing the registry entry (via _bootstrap-fail) prevents the orphan
    // (agentStatus="exited" + no worktree) that the ghost sweep can't drop.
    expect(script).toContain('dashboard _bootstrap-fail myproject bold-ash');
    // exec $SHELL keeps the right-slot pane alive — exit 1 would let tmux
    // close it, leaving state.activePaneId stale and wedging park/swap.
    expect(script).toContain("exec $SHELL");
    expect(script).not.toMatch(/^\s*exit 1\s*$/m);
  });
});

describe("buildWorktreeResumeCommand", () => {
  it("prefixes claude with worker identity exports so the interactive shell inherits them after claude exits", () => {
    process.argv[1] = "/usr/local/bin/garden";
    const cmd = buildWorktreeResumeCommand(
      "myproject", "/repo/myproject", "bold-ash", "bold-ash",
      "session-123", "develop",
    );
    expect(cmd).toContain("GARDEN_PROJECT=myproject");
    expect(cmd).toContain("GARDEN_WORKER=bold-ash");
    expect(cmd).toContain("GARDEN_BRANCH=bold-ash");
    expect(cmd).toContain("GARDEN_BASE_BRANCH=develop");
    expect(cmd).toContain("--resume session-123");
  });

  it("includes --rc so resumed worker surfaces in Claude app remote sessions", () => {
    process.argv[1] = "/usr/local/bin/garden";
    const cmd = buildWorktreeResumeCommand(
      "myproject", "/repo/myproject", "bold-ash", "bold-ash",
      "session-123", "main",
    );
    expect(cmd).toContain("--rc");
  });

  it("defaults GARDEN_BASE_BRANCH to main when baseBranch is omitted", () => {
    process.argv[1] = "/usr/local/bin/garden";
    const cmd = buildWorktreeResumeCommand(
      "myproject", "/repo/myproject", "bold-ash", "bold-ash", "session-123",
    );
    expect(cmd).toContain("GARDEN_BASE_BRANCH=main");
  });
});

describe("writeGrowhouseInitScript", () => {
  async function generateScript(): Promise<string> {
    vi.mocked(fs.writeFileSync).mockClear();
    const { writeGrowhouseInitScript } = await import("../src/dashboard/create.js");
    writeGrowhouseInitScript("node /opt/garden/cli.js");
    const write = vi.mocked(fs.writeFileSync).mock.calls
      .map(c => String(c[1]))
      .find(content => content.includes("Garden growhouse init"));
    if (!write) throw new Error("growhouse init script was not written");
    return write;
  }

  it("shadows garden subcommands that collide with real PATH binaries so the pane is never hijacked", async () => {
    const script = await generateScript();
    // /usr/bin/login is interactive and would hijack the pane; whoami/reset
    // also shadow real binaries that pre-empt the not-found handler.
    expect(script).toContain('login()  { node /opt/garden/cli.js login "$@"; }');
    expect(script).toContain('whoami() { node /opt/garden/cli.js whoami "$@"; }');
    expect(script).toContain('reset()  { node /opt/garden/cli.js reset "$@"; }');
  });

  it("still routes unknown words to garden via the not-found handler", async () => {
    const script = await generateScript();
    expect(script).toContain("command_not_found_handler()");
    expect(script).toContain("command_not_found_handle()");
    expect(script).toContain('node /opt/garden/cli.js "$@"');
  });
});

describe("writeDiaryViewScript (via createGardenDiaryWindow)", () => {
  async function generateScript(): Promise<string> {
    vi.mocked(fs.writeFileSync).mockClear();
    const { createGardenDiaryWindow } = await import("../src/dashboard/create.js");
    createGardenDiaryWindow("node /opt/garden/cli.js");
    const write = vi.mocked(fs.writeFileSync).mock.calls
      .map(c => String(c[1]))
      .find(content => content.includes("Garden diary view"));
    if (!write) throw new Error("diary view script was not written");
    return write;
  }

  it("launches nano/pico with -b so long diary lines wrap to the pane width", async () => {
    const script = await generateScript();
    // Shell mirror of editorIsNano: take the first $EDITOR token, reduce to its
    // basename, and only nano/pico get -b (word wrap). Others run with no flag.
    expect(script).toContain('bin="${ed%% *}"');
    expect(script).toContain('bin="${bin##*/}"');
    expect(script).toContain('nano|pico) wrap="-b" ;;');
  });

  it("keeps $ed and $wrap unquoted (word-split) but quotes the diary path", async () => {
    const script = await generateScript();
    // $ed must split so "code -w" becomes command+args; an empty $wrap must
    // collapse to nothing rather than pass an empty argument; "$f" stays quoted
    // so a diary path with spaces is one argument.
    expect(script).toContain('$ed $wrap "$f"');
  });
});

// The worker-env half of the shared-store resolution rule (board DELEGATION.md
// Decision 15): BEADS_DIR follows resolveBeadsDir, so a configured beadsDir
// points the worker's bd verbs at the same store the intake pass reads.
describe("beadsEnvExports", () => {
  it("is empty for projects without beadIntake", () => {
    vi.mocked(tryGetProject).mockReturnValue({ path: "/repo/myproject" });
    expect(beadsEnvExports("myproject", "swift-oak")).toBe("");
  });

  it("exports the checkout's own .beads by default", () => {
    vi.mocked(tryGetProject).mockReturnValue({ path: "/repo/myproject", beadIntake: true });
    const exports = beadsEnvExports("myproject", "swift-oak");
    expect(exports).toContain("BEADS_ACTOR=swift-oak");
    expect(exports).toContain("BEADS_DIR=/repo/myproject/.beads");
  });

  it("exports the configured shared store when beadsDir is set", () => {
    vi.mocked(tryGetProject).mockReturnValue({
      path: "/repo/myproject", beadIntake: true, beadsDir: "/board/.beads",
    });
    const exports = beadsEnvExports("myproject", "swift-oak");
    expect(exports).toContain("BEADS_DIR=/board/.beads");
    expect(exports).not.toContain("/repo/myproject/.beads");
  });
});

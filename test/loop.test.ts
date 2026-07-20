import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}));

vi.mock("node:fs", () => ({
  default: {
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  },
}));

vi.mock("../src/config.js", () => ({
  tryGetProject: vi.fn(),
  tryResolveClaudeProfile: vi.fn(() => null),
  tryResolveProvider: vi.fn(() => null),
  anyAnthropicMeteredProject: vi.fn(() => true),
  ENV_VAR_NAME_RE: /^[A-Z_][A-Z0-9_]*$/,
  SESSIONS_DIR: "/tmp/garden-sessions-test",
}));

vi.mock("../src/session.js", () => ({
  DASHBOARD_SESSION: "garden-dashboard",
  dashboardExists: vi.fn(() => false),
}));

vi.mock("../src/dashboard/state.js", () => ({
  readDashState: vi.fn(),
}));

vi.mock("../src/dashboard/registry.js", () => ({
  findWorkerByName: vi.fn(),
  updateWorkerFields: vi.fn(),
}));

vi.mock("../src/dashboard/tmux.js", () => ({
  tmux: vi.fn(),
  shellEscape: vi.fn((s: string) =>
    /^[a-zA-Z0-9_./:=-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`),
  getFirstPaneId: vi.fn(() => "%20"),
  paneExists: vi.fn(() => true),
  windowExists: vi.fn(() => true),
}));

vi.mock("../src/dashboard/window-names.js", () => ({
  workerWindowName: (project: string, worker: string) => `_${project}-worker-${worker}`,
}));

vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/dashboard/create.js", () => ({
  buildWorktreeWorkerCommand: vi.fn(() => "claude --resume sess-mock"),
  // Pure helper — real semantics ("" clears the project's provider, absent
  // inherits it), so the respawn's runtime-config view is genuinely exercised.
  workerProject: (project: { provider?: string }, provider: string | undefined) =>
    provider === undefined ? project : { ...project, provider: provider || undefined },
}));

vi.mock("../src/dashboard/continue.js", () => ({
  dispatchDelayedSeed: vi.fn(),
  paneHasOperatorDraft: vi.fn(() => false),
}));

vi.mock("../src/dashboard/runner.js", () => ({
  resolveGardenRunner: vi.fn(() => "/usr/local/bin/garden"),
}));

vi.mock("../src/dashboard/harness/index.js", () => {
  // One stable adapter object so assertions reach the same mocks the code
  // under test called (same pattern as workers.test.ts).
  const adapter = {
    name: "claude-code",
    allocateSessionId: vi.fn(() => "fresh-uuid-5678"),
    installRuntimeConfig: vi.fn(),
  };
  return { getHarness: vi.fn(() => adapter), DEFAULT_HARNESS: "claude-code" };
});

import {
  persistIteration, dispatchDelayedLoopContinue, loopAutoContinueAfterMerge,
  type LoopHooks,
} from "../src/dashboard/loop.js";
import { findWorkerByName, updateWorkerFields } from "../src/dashboard/registry.js";
import { readDashState } from "../src/dashboard/state.js";
import { tryGetProject } from "../src/config.js";
import { tmux, paneExists, windowExists, getFirstPaneId } from "../src/dashboard/tmux.js";
import { dispatchDelayedSeed, paneHasOperatorDraft } from "../src/dashboard/continue.js";
import { buildWorktreeWorkerCommand } from "../src/dashboard/create.js";
import { getHarness } from "../src/dashboard/harness/index.js";
import { spawn } from "node:child_process";
import fs from "node:fs";
import type { WorkerEntry } from "../src/dashboard/registry.js";
import type { DashboardState } from "../src/dashboard/state.js";

function makeState(overrides: Partial<DashboardState> = {}): DashboardState {
  return {
    activeProject: "myproject",
    statusPaneId: null,
    gardenShellPaneId: null,
    gardenPaneType: null,
    gardenWindowName: null,
    activePaneId: null,
    activePaneType: null,
    activeWindowName: null,
    lastActiveWorker: {},
    lastActiveProjectByPlot: {},
    ...overrides,
  };
}

function makeWorker(overrides: Partial<WorkerEntry> = {}): WorkerEntry {
  return {
    name: "bold-ash",
    sessionId: "old-sess-id",
    task: "",
    worktreePath: "/tmp/wt/myproject/bold-ash",
    branchName: "bold-ash",
    baseBranch: "main",
    agentStatus: "idle",
    workflow: "trellis",
    ...overrides,
  };
}

// Hooks fixture used across loopAutoContinueAfterMerge tests. Records all
// invocations so tests can assert what the primitive routed through hooks.
function makeHooks(): LoopHooks & {
  _readSpy: ReturnType<typeof vi.fn>;
  _writeSpy: ReturnType<typeof vi.fn>;
  _setSpy: ReturnType<typeof vi.fn>;
  _promptSpy: ReturnType<typeof vi.fn>;
} {
  const _readSpy = vi.fn(() => ({ iteration: 2, maxIterations: 5 }));
  const _writeSpy = vi.fn();
  const _setSpy = vi.fn();
  const _promptSpy = vi.fn(() => "[garden] iter 3 of 5\n\nDo the work.");
  return {
    logTag: "trellis",
    readIteration: _readSpy,
    writeIteration: _writeSpy,
    setInMemoryIteration: _setSpy,
    buildContinuePrompt: _promptSpy,
    _readSpy, _writeSpy, _setSpy, _promptSpy,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(paneExists).mockReturnValue(true);
  vi.mocked(windowExists).mockReturnValue(true);
  vi.mocked(paneHasOperatorDraft).mockReturnValue(false);
  vi.mocked(getFirstPaneId).mockReturnValue("%30");
  vi.mocked(readDashState).mockReturnValue(makeState());
  vi.mocked(tryGetProject).mockReturnValue({ path: "/tmp/projects/myproject" });
  vi.mocked(buildWorktreeWorkerCommand).mockReturnValue("claude --resume mock");
});

// ─── persistIteration ─────────────────────────────────────────────────────

describe("persistIteration", () => {
  it("calls both writeIteration and setInMemoryIteration with the new value", () => {
    const entry = makeWorker({ trellis: { name: "t", path: "/t/path", iteration: 4, maxIterations: 30 } });
    const hooks = makeHooks();

    persistIteration("myproject", "bold-ash", entry, hooks, 5);

    expect(hooks._writeSpy).toHaveBeenCalledWith("myproject", "bold-ash", 5);
    expect(hooks._setSpy).toHaveBeenCalledWith(entry, 5);
  });
});

// ─── dispatchDelayedLoopContinue ──────────────────────────────────────────

describe("dispatchDelayedLoopContinue", () => {
  it("spawns a detached sh trampoline that invokes the supplied subcommand with --delay-ms 5000", () => {
    dispatchDelayedLoopContinue(
      "/usr/local/bin/garden", "myproject", "bold-ash",
      "_trellis-continue-after-merge",
    );

    // Delay lives inside the spawned Node child via --delay-ms (no `sleep N
    // &&` prefix). The `sh -c` trampoline stays — gardenRunner is a
    // multi-token shell command — but it just exec's into garden.
    expect(spawn).toHaveBeenCalledTimes(1);
    const [shCmd, args, opts] = vi.mocked(spawn).mock.calls[0];
    expect(shCmd).toBe("sh");
    const cmd = (args as string[])[1];
    expect(cmd).not.toMatch(/\bsleep\b/);
    expect(cmd).toContain("/usr/local/bin/garden dashboard _trellis-continue-after-merge --delay-ms 5000");
    expect(cmd).toContain(" myproject ");
    expect(cmd).toContain(" bold-ash ");
    expect(opts).toEqual(expect.objectContaining({ detached: true, stdio: "ignore" }));
  });

  it("uses a different subcommand when supplied (forward-compat for grow)", () => {
    dispatchDelayedLoopContinue(
      "garden", "myproject", "bold-ash", "_grow-continue-after-merge",
    );

    const [, args] = vi.mocked(spawn).mock.calls[0];
    const cmd = (args as string[])[1];
    expect(cmd).toContain("garden dashboard _grow-continue-after-merge --delay-ms 5000");
  });

  it("swallows spawn errors so a failed dispatch never crashes the caller", () => {
    vi.mocked(spawn).mockImplementation(() => { throw new Error("EAGAIN"); });
    expect(() =>
      dispatchDelayedLoopContinue("g", "p", "w", "_x-continue-after-merge"),
    ).not.toThrow();
  });
});

// ─── loopAutoContinueAfterMerge ───────────────────────────────────────────

describe("loopAutoContinueAfterMerge", () => {
  it("returns false and does not respawn when the worker is missing", () => {
    vi.mocked(findWorkerByName).mockReturnValue(undefined);

    const result = loopAutoContinueAfterMerge(
      "myproject", "ghost", makeHooks(), {},
    );

    expect(result).toBe(false);
    expect(tmux).not.toHaveBeenCalled();
    expect(dispatchDelayedSeed).not.toHaveBeenCalled();
  });

  it("returns false when the worktree path is missing", () => {
    vi.mocked(findWorkerByName).mockReturnValue(
      makeWorker({ worktreePath: undefined }),
    );

    const result = loopAutoContinueAfterMerge(
      "myproject", "bold-ash", makeHooks(), {},
    );

    expect(result).toBe(false);
    expect(tmux).not.toHaveBeenCalled();
  });

  it("returns false when no pane can be located", () => {
    vi.mocked(findWorkerByName).mockReturnValue(makeWorker());
    vi.mocked(windowExists).mockReturnValue(false);
    vi.mocked(readDashState).mockReturnValue(makeState({ activePaneId: null }));

    const result = loopAutoContinueAfterMerge(
      "myproject", "bold-ash", makeHooks(), {},
    );

    expect(result).toBe(false);
    expect(tmux).not.toHaveBeenCalled();
  });

  it.each(["working", "asking", "paused"] as const)(
    "defers (no respawn, stays merged) when the worker is %s",
    (agentStatus) => {
      vi.mocked(findWorkerByName).mockReturnValue(makeWorker({ agentStatus }));
      vi.mocked(readDashState).mockReturnValue(makeState({
        activeWindowName: "_myproject-worker-bold-ash",
        activePaneId: "%9",
      }));

      const result = loopAutoContinueAfterMerge(
        "myproject", "bold-ash", makeHooks(), { trellisRelativePath: ".garden/trellises/foo.md" },
      );

      // Bail before any destructive step: no respawn-pane kill, no state clear,
      // so prState stays merged for the gate-reopen sweep to replay.
      expect(result).toBe(false);
      expect(tmux).not.toHaveBeenCalled();
      expect(dispatchDelayedSeed).not.toHaveBeenCalled();
      expect(updateWorkerFields).not.toHaveBeenCalled();
    },
  );

  it("defers when the operator has an unsent draft in the input box", () => {
    vi.mocked(findWorkerByName).mockReturnValue(makeWorker({ agentStatus: "idle" }));
    vi.mocked(readDashState).mockReturnValue(makeState({
      activeWindowName: "_myproject-worker-bold-ash",
      activePaneId: "%9",
    }));
    vi.mocked(paneHasOperatorDraft).mockReturnValue(true);

    const result = loopAutoContinueAfterMerge(
      "myproject", "bold-ash", makeHooks(), { trellisRelativePath: ".garden/trellises/foo.md" },
    );

    expect(result).toBe(false);
    expect(tmux).not.toHaveBeenCalled();
    expect(updateWorkerFields).not.toHaveBeenCalled();
  });

  it("on success: regenerates sessionId, respawns the pane, clears pendingContinue*, writes the seed file, dispatches seed", () => {
    const entry = makeWorker({
      sessionId: "old-uuid",
      pendingContinueChangedFiles: ["src/foo.ts"],
      pendingContinueSyncFailed: true,
    });
    vi.mocked(findWorkerByName).mockReturnValue(entry);
    vi.mocked(readDashState).mockReturnValue(makeState({
      activeWindowName: "_myproject-worker-bold-ash",
      activePaneId: "%9",
    }));

    const hooks = makeHooks();
    const result = loopAutoContinueAfterMerge(
      "myproject", "bold-ash", hooks, { trellisRelativePath: ".garden/trellises/foo.md" },
    );

    expect(result).toBe(true);

    // installRuntimeConfig fired before the respawn so settings.json is fresh.
    expect(vi.mocked(getHarness)().installRuntimeConfig).toHaveBeenCalledWith(
      "/tmp/wt/myproject/bold-ash",
      expect.objectContaining({ path: "/tmp/projects/myproject" }),
    );

    // updateWorkerFields includes a fresh sessionId (different from the old)
    // and clears the pending-continue scaffolding plus mergedAt.
    const updateCall = vi.mocked(updateWorkerFields).mock.calls[0];
    const fields = updateCall[2];
    expect(fields.sessionId).toEqual(expect.any(String));
    expect(fields.sessionId).not.toEqual("old-uuid");
    expect(fields.agentStatus).toBe("loading");
    expect(fields.pendingContinueChangedFiles).toBeUndefined();
    expect(fields.pendingContinueSyncFailed).toBeUndefined();
    expect(fields.mergedAt).toBeUndefined();

    // tmux respawn-pane fired with -k and the worktree path.
    const tmuxCalls = vi.mocked(tmux).mock.calls;
    const respawn = tmuxCalls.find(c => c[0] === "respawn-pane");
    expect(respawn).toBeDefined();
    expect(respawn).toContain("-k");
    expect(respawn).toContain("/tmp/wt/myproject/bold-ash");

    // buildWorktreeWorkerCommand called with the workerCommandOpts caller passed.
    expect(buildWorktreeWorkerCommand).toHaveBeenCalledWith(
      "myproject",
      "/tmp/projects/myproject",
      "bold-ash",
      "bold-ash",
      expect.any(String), // sessionId
      "main",             // baseBranch
      { trellisRelativePath: ".garden/trellises/foo.md" },
    );

    // The continue prompt was built via hooks (workflow-specific) and stashed
    // to a seed file; dispatchDelayedSeed received the path.
    expect(hooks._promptSpy).toHaveBeenCalledWith(entry);
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringMatching(/trellis-seed-myproject-bold-ash-\d+\.txt$/),
      "[garden] iter 3 of 5\n\nDo the work.",
    );
    expect(dispatchDelayedSeed).toHaveBeenCalledWith(
      "/usr/local/bin/garden",
      "myproject",
      "bold-ash",
      expect.stringMatching(/trellis-seed-myproject-bold-ash-\d+\.txt$/),
    );
  });

  it("uses the hook's logTag in the seed file name", () => {
    const entry = makeWorker();
    vi.mocked(findWorkerByName).mockReturnValue(entry);
    vi.mocked(readDashState).mockReturnValue(makeState({
      activeWindowName: "_myproject-worker-bold-ash",
      activePaneId: "%9",
    }));

    const hooks = makeHooks();
    hooks.logTag = "grow";

    loopAutoContinueAfterMerge("myproject", "bold-ash", hooks, {});

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringMatching(/grow-seed-myproject-bold-ash-\d+\.txt$/),
      expect.any(String),
    );
  });

  it("returns false and does not dispatch seed when the seed-file write fails", () => {
    const entry = makeWorker();
    vi.mocked(findWorkerByName).mockReturnValue(entry);
    vi.mocked(readDashState).mockReturnValue(makeState({
      activeWindowName: "_myproject-worker-bold-ash",
      activePaneId: "%9",
    }));
    vi.mocked(fs.writeFileSync).mockImplementation(() => {
      throw new Error("ENOSPC");
    });

    const result = loopAutoContinueAfterMerge(
      "myproject", "bold-ash", makeHooks(), {},
    );

    expect(result).toBe(false);
    expect(dispatchDelayedSeed).not.toHaveBeenCalled();
  });

  it("returns false and does not dispatch seed when the respawn-pane call throws", () => {
    const entry = makeWorker();
    vi.mocked(findWorkerByName).mockReturnValue(entry);
    vi.mocked(readDashState).mockReturnValue(makeState({
      activeWindowName: "_myproject-worker-bold-ash",
      activePaneId: "%9",
    }));
    vi.mocked(tmux).mockImplementation((cmd: string) => {
      if (cmd === "respawn-pane") throw new Error("tmux died");
      return undefined as unknown as ReturnType<typeof tmux>;
    });

    const result = loopAutoContinueAfterMerge(
      "myproject", "bold-ash", makeHooks(), {},
    );

    expect(result).toBe(false);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(dispatchDelayedSeed).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";

// Registry mock with real read-modify-write behavior
const entries: Record<string, import("../src/dashboard/registry.js").WorkerEntry[]> = {};

vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => ""),
  execFileSync: vi.fn(() => "0"),
}));

vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn(() => false),
    statSync: vi.fn(() => ({ isFIFO: () => false })),
    openSync: vi.fn(() => 3),
    writeSync: vi.fn(),
    closeSync: vi.fn(),
    unlinkSync: vi.fn(),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(() => "{}"),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    constants: { O_CREAT: 0, O_EXCL: 0, O_WRONLY: 0 },
  },
}));

vi.mock("../src/config.js", () => ({
  tryGetProject: vi.fn(() => ({ path: "/repo/garden" })),
  loadConfig: vi.fn(() => ({ projects: { garden: { path: "/repo/garden" } } })),
  SESSIONS_DIR: "/tmp/fake-sessions",
  getFocusedProjectNames: vi.fn(() => ["garden"]),
}));

vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/dashboard/tmux.js", () => ({
  tmux: vi.fn(),
  tmuxOutput: vi.fn(() => ""),
  getFirstPaneId: vi.fn(() => null),
  getPaneTitle: vi.fn(() => ""),
  getPanePid: vi.fn(() => null),
  getPaneSize: vi.fn(() => null),  // null triggers resize since current size unknown
  windowExists: vi.fn(() => false),
  setPaneVar: vi.fn(),
  listAllWindowNames: vi.fn(() => []),
}));

vi.mock("../src/dashboard/state.js", () => ({
  readDashState: vi.fn(() => ({
    activeProject: "garden",
    statusPaneId: null,
    gardenShellPaneId: null,
    activePaneId: null,
    activePaneType: null,
    activeWindowName: null,
  })),
}));

vi.mock("../src/dashboard/registry.js", () => ({
  readRegistry: vi.fn(() => ({ workers: entries })),
  getWorkers: vi.fn((project: string) => entries[project] ?? []),
  findWorkerByName: vi.fn(
    (project: string, name: string) =>
      (entries[project] ?? []).find(e => e.name === name),
  ),
  updateWorkerFields: vi.fn(
    (project: string, name: string, fields: Record<string, unknown>) => {
      const list = entries[project];
      if (!list) return;
      const entry = list.find(e => e.name === name);
      if (entry) Object.assign(entry, fields);
    },
  ),
  batchUpdateWorkerFields: vi.fn(),
}));

vi.mock("../src/dashboard/git.js", () => ({
  resolveBaseBranch: vi.fn(() => "main"),
  currentBranch: vi.fn(() => "main"),
}));

vi.mock("../src/dashboard/poller.js", () => ({
  triggerProjectPoll: vi.fn(),
  signalFifoPath: vi.fn(() => "/tmp/fake-sessions/garden-poll-signal"),
}));

vi.mock("../src/session.js", () => ({
  DASHBOARD_SESSION: "garden-dashboard",
}));

vi.mock("../src/version.js", () => ({
  GARDEN_VERSION: "test",
}));

vi.mock("../src/dashboard/alerts.js", () => ({
  addAlert: vi.fn(),
  unreadAlertCount: vi.fn(() => 0),
  formatRightBar: vi.fn(() => ""),
  refreshAlertBadge: vi.fn(),
}));

vi.mock("../src/commands/status.js", () => ({
  renderQuickStatus: vi.fn(() => ""),
}));

import { handleClaudeHook } from "../src/dashboard/header.js";
import { addAlert } from "../src/dashboard/alerts.js";
import { updateWorkerFields } from "../src/dashboard/registry.js";
import { log } from "../src/dashboard/log.js";
import { tmux } from "../src/dashboard/tmux.js";
import { readDashState } from "../src/dashboard/state.js";

const originalCwd = process.cwd;
const originalGardenReviewer = process.env.GARDEN_REVIEWER;

function setCwd(project: string, worker: string) {
  const home = process.env.HOME ?? "";
  process.cwd = () => `${home}/.garden/worktrees/${project}/${worker}`;
}

function seedWorker(
  project: string,
  name: string,
  fields: Partial<import("../src/dashboard/registry.js").WorkerEntry> = {},
) {
  if (!entries[project]) entries[project] = [];
  const existing = entries[project].find(e => e.name === name);
  if (existing) {
    Object.assign(existing, fields);
  } else {
    entries[project].push({
      name,
      sessionId: "test-session",
      task: "",
      claudeStatus: "working",
      ...fields,
    });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  process.cwd = originalCwd;
  delete process.env.GARDEN_REVIEWER;
  for (const key of Object.keys(entries)) delete entries[key];
});

afterAll(() => {
  if (originalGardenReviewer !== undefined) {
    process.env.GARDEN_REVIEWER = originalGardenReviewer;
  }
});

describe("handleClaudeHook — mid-turn asking", () => {
  it("notification sets asking when worker is working", () => {
    seedWorker("garden", "bold-ash", { claudeStatus: "working" });
    setCwd("garden", "bold-ash");

    // Verify cwd mock is active
    const home = process.env.HOME ?? "";
    expect(process.cwd()).toBe(`${home}/.garden/worktrees/garden/bold-ash`);

    let threw: unknown;
    try {
      handleClaudeHook("notification");
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeUndefined();

    expect(updateWorkerFields).toHaveBeenCalledWith(
      "garden", "bold-ash",
      expect.objectContaining({ claudeStatus: "asking" }),
    );
  });

  it("pretooluse sets asking when worker is working", () => {
    seedWorker("garden", "bold-ash", { claudeStatus: "working" });
    setCwd("garden", "bold-ash");

    handleClaudeHook("pretooluse");

    expect(updateWorkerFields).toHaveBeenCalledWith(
      "garden", "bold-ash",
      expect.objectContaining({ claudeStatus: "asking" }),
    );
  });

  it("notification skips when worker is already idle", () => {
    seedWorker("garden", "bold-ash", { claudeStatus: "idle" });
    setCwd("garden", "bold-ash");

    handleClaudeHook("notification");

    // updateWorkerFields still called for lastHookAt, but without claudeStatus
    expect(updateWorkerFields).toHaveBeenCalledWith(
      "garden", "bold-ash",
      expect.not.objectContaining({ claudeStatus: expect.anything() }),
    );
    expect(log.info).toHaveBeenCalledWith(
      "hook", "mid-turn asking hook skipped (not working)",
      expect.anything(),
    );
  });

  it("pretooluse fires alert when worker is asking for input", () => {
    seedWorker("garden", "bold-ash", { claudeStatus: "working" });
    setCwd("garden", "bold-ash");

    handleClaudeHook("pretooluse");

    expect(addAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        source: "worker",
        project: "garden",
        worker: "bold-ash",
        message: expect.stringContaining("is asking for input"),
      }),
    );
  });

  it("notification does not fire alert", () => {
    seedWorker("garden", "bold-ash", { claudeStatus: "working" });
    setCwd("garden", "bold-ash");

    handleClaudeHook("notification");

    expect(addAlert).not.toHaveBeenCalled();
  });

  it("pretooluse skips when worker is ready", () => {
    seedWorker("garden", "bold-ash", { claudeStatus: "ready" });
    setCwd("garden", "bold-ash");

    handleClaudeHook("pretooluse");

    expect(updateWorkerFields).toHaveBeenCalledWith(
      "garden", "bold-ash",
      expect.not.objectContaining({ claudeStatus: expect.anything() }),
    );
  });

  it("posttooluse sets working when worker is asking", () => {
    seedWorker("garden", "bold-ash", { claudeStatus: "asking" });
    setCwd("garden", "bold-ash");

    handleClaudeHook("posttooluse");

    expect(updateWorkerFields).toHaveBeenCalledWith(
      "garden", "bold-ash",
      expect.objectContaining({ claudeStatus: "working" }),
    );
  });

  it("posttooluse does not revive a worker whose turn ended (idle)", () => {
    seedWorker("garden", "bold-ash", { claudeStatus: "idle" });
    setCwd("garden", "bold-ash");

    handleClaudeHook("posttooluse");

    // idle means the Stop hook already fired. A stray PostToolUse must not
    // flip the worker back to working — that would show the wrong state for
    // the remainder of the time between turns.
    expect(updateWorkerFields).toHaveBeenCalledWith(
      "garden", "bold-ash",
      expect.not.objectContaining({ claudeStatus: expect.anything() }),
    );
  });

  it("posttooluse skips when worker is working", () => {
    seedWorker("garden", "bold-ash", { claudeStatus: "working" });
    setCwd("garden", "bold-ash");

    handleClaudeHook("posttooluse");

    // Should not overwrite working with working — the guard only fires on asking
    expect(updateWorkerFields).toHaveBeenCalledWith(
      "garden", "bold-ash",
      expect.not.objectContaining({ claudeStatus: expect.anything() }),
    );
  });
});

describe("handleClaudeHook — core events", () => {
  it("sessionstart sets ready", () => {
    seedWorker("garden", "bold-ash", { claudeStatus: "loading" });
    setCwd("garden", "bold-ash");

    handleClaudeHook("sessionstart");

    expect(updateWorkerFields).toHaveBeenCalledWith(
      "garden", "bold-ash",
      expect.objectContaining({ claudeStatus: "ready" }),
    );
  });

  it("prompt sets working", () => {
    seedWorker("garden", "bold-ash", { claudeStatus: "idle" });
    setCwd("garden", "bold-ash");

    handleClaudeHook("prompt");

    expect(updateWorkerFields).toHaveBeenCalledWith(
      "garden", "bold-ash",
      expect.objectContaining({ claudeStatus: "working" }),
    );
  });

  it("stop sets idle", () => {
    seedWorker("garden", "bold-ash", { claudeStatus: "working" });
    setCwd("garden", "bold-ash");

    handleClaudeHook("stop");

    expect(updateWorkerFields).toHaveBeenCalledWith(
      "garden", "bold-ash",
      expect.objectContaining({ claudeStatus: "idle" }),
    );
  });

  it("unknown event logs warning and does not update", () => {
    seedWorker("garden", "bold-ash", { claudeStatus: "working" });
    setCwd("garden", "bold-ash");

    handleClaudeHook("bogus");

    expect(log.warn).toHaveBeenCalledWith(
      "hook", "unknown claude hook event",
      expect.anything(),
    );
    expect(updateWorkerFields).not.toHaveBeenCalled();
  });
});

describe("writeQuickStatus — status pane resize", () => {
  const stateWithPane = {
    activeProject: "garden",
    statusPaneId: "%0",
    gardenShellPaneId: null,
    activePaneId: null,
    activePaneType: null as null,
    activeWindowName: null,
  };
  const stateWithoutPane = {
    ...stateWithPane,
    statusPaneId: null,
  };

  afterEach(() => {
    vi.mocked(readDashState).mockReturnValue(stateWithoutPane);
  });

  it("resizes status pane to content line count when statusPaneId is set", () => {
    vi.mocked(readDashState).mockReturnValue(stateWithPane);
    seedWorker("garden", "bold-ash", { claudeStatus: "idle" });
    setCwd("garden", "bold-ash");

    handleClaudeHook("stop");

    // renderQuickStatus is mocked to return ""; "".split("\n").length === 1,
    // Math.max(4, 1) + 1 === 5 (the +1 accounts for pane-border-status top)
    expect(vi.mocked(tmux)).toHaveBeenCalledWith("resize-pane", "-t", "%0", "-y", "5");
  });

  it("skips resize when statusPaneId is null", () => {
    seedWorker("garden", "bold-ash", { claudeStatus: "idle" });
    setCwd("garden", "bold-ash");

    handleClaudeHook("stop");

    expect(vi.mocked(tmux)).not.toHaveBeenCalledWith(
      "resize-pane", expect.any(String), expect.any(String), expect.any(String), expect.any(String),
    );
  });
});

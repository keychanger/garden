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
  loadConfig: vi.fn(() => ({
    projects: { garden: { path: "/repo/garden" } },
    // 5+ projects in a plot so the derived floor hits the 5-project cap
    // (largestPlotSize → Math.min(5, ...) → floorLines = 3*5 + 1 = 16).
    plots: { all: { projects: ["garden", "p2", "p3", "p4", "p5"] } },
  })),
  SESSIONS_DIR: "/tmp/fake-sessions",
  getFocusedProjectNames: vi.fn(() => ["garden"]),
  plotsMap: vi.fn((cfg: { plots?: Record<string, unknown> }) => cfg.plots ?? {}),
  isPlotFocused: vi.fn((plot: { focused?: boolean }) => plot.focused !== false),
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
  getWorkerBaseBranch: vi.fn((entry: { baseBranch?: string }) => entry.baseBranch ?? "main"),
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
  readAlerts: vi.fn(() => ({ alerts: [] })),
  unreadAlertCount: vi.fn(() => 0),
  formatRightBar: vi.fn(() => ""),
  refreshAlertBadge: vi.fn(),
}));

vi.mock("../src/commands/status.js", () => ({
  renderQuickStatus: vi.fn(() => ""),
  resolveWorkerStatus: vi.fn(() => "idle"),
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

  it("notification self-heals idle to asking", () => {
    // A user-input tool firing is definitive proof of active turn, so an
    // idle worker at this point has stale status — transition to asking.
    seedWorker("garden", "bold-ash", { claudeStatus: "idle" });
    setCwd("garden", "bold-ash");

    handleClaudeHook("notification");

    expect(updateWorkerFields).toHaveBeenCalledWith(
      "garden", "bold-ash",
      expect.objectContaining({ claudeStatus: "asking" }),
    );
  });

  it("pretooluse does not fire an operator alert (status pane is the signal)", () => {
    seedWorker("garden", "bold-ash", { claudeStatus: "working" });
    setCwd("garden", "bold-ash");

    handleClaudeHook("pretooluse");

    // The `asking` status + yellow row is the visual signal; the bottom-bar
    // alert badge is reserved for things that warrant attention beyond
    // "a worker is waiting on you."
    expect(addAlert).not.toHaveBeenCalled();
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

  it("posttooluse self-heals idle to working", () => {
    // A tool-use event arriving while idle means the turn is actually
    // active and the status is stale — trust the event and flip to working.
    seedWorker("garden", "bold-ash", { claudeStatus: "idle" });
    setCwd("garden", "bold-ash");

    handleClaudeHook("posttooluse");

    expect(updateWorkerFields).toHaveBeenCalledWith(
      "garden", "bold-ash",
      expect.objectContaining({ claudeStatus: "working" }),
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

  it("sessionstart with source=startup sets ready", async () => {
    const fs = (await import("node:fs")).default;
    vi.mocked(fs.readFileSync).mockReturnValueOnce(JSON.stringify({ source: "startup" }));
    seedWorker("garden", "bold-ash", { claudeStatus: "loading" });
    setCwd("garden", "bold-ash");

    handleClaudeHook("sessionstart");

    expect(updateWorkerFields).toHaveBeenCalledWith(
      "garden", "bold-ash",
      expect.objectContaining({ claudeStatus: "ready" }),
    );
  });

  it("sessionstart with source=resume preserves working (auto-compact mid-turn)", async () => {
    const fs = (await import("node:fs")).default;
    vi.mocked(fs.readFileSync).mockReturnValueOnce(JSON.stringify({ source: "resume" }));
    seedWorker("garden", "bold-ash", { claudeStatus: "working" });
    setCwd("garden", "bold-ash");

    handleClaudeHook("sessionstart");

    // Must not include claudeStatus — the existing "working" must be preserved.
    expect(updateWorkerFields).toHaveBeenCalledWith(
      "garden", "bold-ash",
      expect.not.objectContaining({ claudeStatus: expect.anything() }),
    );
  });

  it("sessionstart with source=compact preserves working", async () => {
    const fs = (await import("node:fs")).default;
    vi.mocked(fs.readFileSync).mockReturnValueOnce(JSON.stringify({ source: "compact" }));
    seedWorker("garden", "bold-ash", { claudeStatus: "working" });
    setCwd("garden", "bold-ash");

    handleClaudeHook("sessionstart");

    expect(updateWorkerFields).toHaveBeenCalledWith(
      "garden", "bold-ash",
      expect.not.objectContaining({ claudeStatus: expect.anything() }),
    );
  });

  it("sessionstart with source=resume preserves asking", async () => {
    const fs = (await import("node:fs")).default;
    vi.mocked(fs.readFileSync).mockReturnValueOnce(JSON.stringify({ source: "resume" }));
    seedWorker("garden", "bold-ash", { claudeStatus: "asking" });
    setCwd("garden", "bold-ash");

    handleClaudeHook("sessionstart");

    expect(updateWorkerFields).toHaveBeenCalledWith(
      "garden", "bold-ash",
      expect.not.objectContaining({ claudeStatus: expect.anything() }),
    );
  });

  it("sessionstart with source=resume sets ready when worker was idle", async () => {
    const fs = (await import("node:fs")).default;
    vi.mocked(fs.readFileSync).mockReturnValueOnce(JSON.stringify({ source: "resume" }));
    seedWorker("garden", "bold-ash", { claudeStatus: "idle" });
    setCwd("garden", "bold-ash");

    handleClaudeHook("sessionstart");

    expect(updateWorkerFields).toHaveBeenCalledWith(
      "garden", "bold-ash",
      expect.objectContaining({ claudeStatus: "ready" }),
    );
  });

  it("sessionstart with unknown source falls through to ready (back-compat)", async () => {
    const fs = (await import("node:fs")).default;
    vi.mocked(fs.readFileSync).mockReturnValueOnce(JSON.stringify({ source: "future-thing" }));
    seedWorker("garden", "bold-ash", { claudeStatus: "working" });
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

  it("stop restores prState=merged when .garden-done is present and no commits ahead", async () => {
    seedWorker("garden", "bold-ash", {
      claudeStatus: "working",
      worktreePath: "/tmp/wt/garden/bold-ash",
    });
    setCwd("garden", "bold-ash");

    const fs = (await import("node:fs")).default;
    vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
      return String(p) === "/tmp/wt/garden/bold-ash/.garden-done";
    });
    const { execFileSync } = await import("node:child_process");
    vi.mocked(execFileSync).mockImplementation((...args: unknown[]) => {
      const argv = args[1] as string[] | undefined;
      if (argv && argv[0] === "rev-list") return "0" as unknown as Buffer;
      return "" as unknown as Buffer;
    });

    handleClaudeHook("stop");

    // First call: claudeStatus = idle (existing behavior).
    expect(updateWorkerFields).toHaveBeenCalledWith(
      "garden", "bold-ash",
      expect.objectContaining({ claudeStatus: "idle" }),
    );
    // Second call: prState = merged + mergedAt timestamp (the new behavior).
    expect(updateWorkerFields).toHaveBeenCalledWith(
      "garden", "bold-ash",
      expect.objectContaining({
        prState: "merged",
        mergedAt: expect.any(String),
      }),
    );
  });

  it("stop does NOT restore merged when .garden-done is absent", async () => {
    seedWorker("garden", "bold-ash", {
      claudeStatus: "working",
      worktreePath: "/tmp/wt/garden/bold-ash",
    });
    setCwd("garden", "bold-ash");

    // Explicit reset — clearAllMocks clears call history but preserves
    // mockImplementation set by earlier tests, so we must reassert the
    // default to make .garden-done genuinely absent here.
    const fs = (await import("node:fs")).default;
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const { execFileSync } = await import("node:child_process");
    vi.mocked(execFileSync).mockImplementation((...args: unknown[]) => {
      const argv = args[1] as string[] | undefined;
      if (argv && argv[0] === "rev-list") return "0" as unknown as Buffer;
      return "" as unknown as Buffer;
    });

    handleClaudeHook("stop");

    const mergedCall = vi.mocked(updateWorkerFields).mock.calls.find(
      c => (c[2] as Record<string, unknown>).prState === "merged",
    );
    expect(mergedCall).toBeUndefined();
  });

  it("stop with commits ahead AND .garden-done queues review (does NOT restore merged)", async () => {
    seedWorker("garden", "bold-ash", {
      claudeStatus: "working",
      worktreePath: "/tmp/wt/garden/bold-ash",
    });
    setCwd("garden", "bold-ash");

    const fs = (await import("node:fs")).default;
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const { execFileSync } = await import("node:child_process");
    vi.mocked(execFileSync).mockImplementation((...args: unknown[]) => {
      const argv = args[1] as string[] | undefined;
      if (argv && argv[0] === "rev-list") return "1" as unknown as Buffer;
      return "" as unknown as Buffer;
    });

    handleClaudeHook("stop");

    // Review path takes priority — finalizeMerge will set merged itself
    // after the merge cycle completes. The .done sentinel is checked
    // there via maybeAutoContinue.
    expect(updateWorkerFields).toHaveBeenCalledWith(
      "garden", "bold-ash",
      expect.objectContaining({ pendingReviewAt: expect.any(Number) }),
    );
    const mergedCall = vi.mocked(updateWorkerFields).mock.calls.find(
      c => (c[2] as Record<string, unknown>).prState === "merged",
    );
    expect(mergedCall).toBeUndefined();
  });

  it("stop fires base-drift alert when rev-list against origin/<base> throws", async () => {
    seedWorker("garden", "bold-ash", {
      claudeStatus: "working",
      baseBranch: "improvement/hardening",
    });
    setCwd("garden", "bold-ash");

    const { execFileSync } = await import("node:child_process");
    // Stop handler runs rev-list, which should fail when origin/<base> is missing.
    // Other execFileSync callers (e.g., git helpers, renderQuickStatus) should not
    // be disturbed, so only the rev-list call throws.
    vi.mocked(execFileSync).mockImplementation((...args: unknown[]) => {
      const argv = args[1] as string[] | undefined;
      if (argv && argv[0] === "rev-list") {
        throw new Error("unknown revision origin/improvement/hardening");
      }
      return "0" as unknown as Buffer;
    });

    handleClaudeHook("stop");

    expect(addAlert).toHaveBeenCalledWith(expect.objectContaining({
      level: "warn",
      source: "worker",
      project: "garden",
      worker: "bold-ash",
      message: expect.stringContaining("origin/improvement/hardening"),
    }));
    const msg = vi.mocked(addAlert).mock.calls[0][0].message;
    expect(msg).toContain("[base-drift]");
  });

  it("stop skips duplicate base-drift alert within cooldown window", async () => {
    seedWorker("garden", "bold-ash", {
      claudeStatus: "working",
      baseBranch: "improvement/hardening",
    });
    setCwd("garden", "bold-ash");

    const { execFileSync } = await import("node:child_process");
    vi.mocked(execFileSync).mockImplementation((...args: unknown[]) => {
      const argv = args[1] as string[] | undefined;
      if (argv && argv[0] === "rev-list") {
        throw new Error("unknown revision");
      }
      return "0" as unknown as Buffer;
    });

    const { readAlerts } = await import("../src/dashboard/alerts.js");
    vi.mocked(readAlerts).mockReturnValue({
      alerts: [{
        id: "prev",
        ts: new Date().toISOString(),
        level: "warn",
        source: "worker",
        project: "garden",
        worker: "bold-ash",
        message: "earlier alert [base-drift]",
      }],
    });

    handleClaudeHook("stop");

    expect(addAlert).not.toHaveBeenCalled();
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
    // Math.max(16, 1) + 1 === 17 (the +1 accounts for pane-border-status top;
    // the 16 is the 5-project floor: 2 pad + 5*(header+body) + 4 separators)
    expect(vi.mocked(tmux)).toHaveBeenCalledWith("resize-pane", "-t", "%0", "-y", "17");
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

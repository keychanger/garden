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

import { handleClaudeHook } from "../src/dashboard/hook-dispatcher.js";
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

// Reads the worker's actual claudeStatus from the in-memory registry mock —
// the mock applies updates via Object.assign, so this is a state assertion,
// not a mock-call assertion.
function statusAfter(project: string, worker: string): string | undefined {
  return entries[project]?.find(e => e.name === worker)?.claudeStatus;
}

describe("handleClaudeHook — mid-turn asking transitions (differential)", () => {
  // notification and pretooluse share the same rule: working|idle → asking,
  // every other state is preserved. The parameterized table below is the rule.
  // If the rule changes, the table changes — there is no implicit re-statement
  // of the rule in each test body.
  const askingRule: Array<[string, string]> = [
    ["working", "asking"],
    ["idle", "asking"],
    ["ready", "ready"],
    ["asking", "asking"],
    ["loading", "loading"],
    ["exited", "exited"],
  ];
  it.each(askingRule)(
    "notification: %s → %s",
    (start, expected) => {
      seedWorker("garden", "bold-ash", { claudeStatus: start });
      setCwd("garden", "bold-ash");
      handleClaudeHook("notification");
      expect(statusAfter("garden", "bold-ash")).toBe(expected);
    },
  );
  it.each(askingRule)(
    "pretooluse: %s → %s",
    (start, expected) => {
      seedWorker("garden", "bold-ash", { claudeStatus: start });
      setCwd("garden", "bold-ash");
      handleClaudeHook("pretooluse");
      expect(statusAfter("garden", "bold-ash")).toBe(expected);
    },
  );

  // posttooluse has the OPPOSITE rule: asking|idle → working. Pairing it with
  // notification/pretooluse in the same suite is the differential — a bug that
  // collapsed the two rules into "always set working" would pass the
  // notification table for "working" but fail every other row.
  const workingRule: Array<[string, string]> = [
    ["asking", "working"],
    ["idle", "working"],
    ["working", "working"],
    ["ready", "ready"],
    ["loading", "loading"],
    ["exited", "exited"],
  ];
  it.each(workingRule)(
    "posttooluse: %s → %s",
    (start, expected) => {
      seedWorker("garden", "bold-ash", { claudeStatus: start });
      setCwd("garden", "bold-ash");
      handleClaudeHook("posttooluse");
      expect(statusAfter("garden", "bold-ash")).toBe(expected);
    },
  );

  it("pretooluse and posttooluse have OPPOSITE effects on the same starting state", () => {
    seedWorker("garden", "bold-ash", { claudeStatus: "working" });
    setCwd("garden", "bold-ash");
    handleClaudeHook("pretooluse");
    expect(statusAfter("garden", "bold-ash")).toBe("asking");
    handleClaudeHook("posttooluse");
    expect(statusAfter("garden", "bold-ash")).toBe("working");
  });

  it("notification does not fire an operator alert (status pane is the signal)", () => {
    seedWorker("garden", "bold-ash", { claudeStatus: "working" });
    setCwd("garden", "bold-ash");
    handleClaudeHook("notification");
    expect(addAlert).not.toHaveBeenCalled();
  });

  it("pretooluse does not fire an operator alert", () => {
    seedWorker("garden", "bold-ash", { claudeStatus: "working" });
    setCwd("garden", "bold-ash");
    handleClaudeHook("pretooluse");
    expect(addAlert).not.toHaveBeenCalled();
  });
});

describe("handleClaudeHook — guards", () => {
  it("ignores hook when cwd is outside any worktree (workerFromCwd returns null)", () => {
    seedWorker("garden", "bold-ash", { claudeStatus: "working" });
    process.cwd = () => "/somewhere/else";
    handleClaudeHook("notification");
    expect(updateWorkerFields).not.toHaveBeenCalled();
    expect(statusAfter("garden", "bold-ash")).toBe("working");
  });

  it("ignores hook when GARDEN_REVIEWER=1 (reviewer's hooks must not write registry)", () => {
    seedWorker("garden", "bold-ash", { claudeStatus: "working" });
    setCwd("garden", "bold-ash");
    process.env.GARDEN_REVIEWER = "1";
    try {
      handleClaudeHook("notification");
      expect(updateWorkerFields).not.toHaveBeenCalled();
      expect(statusAfter("garden", "bold-ash")).toBe("working");
    } finally {
      delete process.env.GARDEN_REVIEWER;
    }
  });
});

describe("handleClaudeHook — core events", () => {
  // sessionstart's source-variant rules — table is the rule. The integration
  // tier covers the no-source path (real fs); these unit tests cover the
  // stdin-driven source paths because integration can't easily provide stdin.
  async function sessionstartWithSource(source: string | null) {
    if (source !== null) {
      const fs = (await import("node:fs")).default;
      vi.mocked(fs.readFileSync).mockReturnValueOnce(JSON.stringify({ source }));
    }
    handleClaudeHook("sessionstart");
  }

  // resume/compact: preserve working/asking, otherwise set ready.
  // Any other source (or no source): always ready.
  const sessionstartTable: Array<[string | null, string, string]> = [
    [null,        "loading", "ready"],
    ["startup",   "loading", "ready"],
    ["resume",    "working", "working"],   // preserved
    ["resume",    "asking",  "asking"],    // preserved
    ["resume",    "idle",    "ready"],     // not in preserve set
    ["compact",   "working", "working"],   // preserved
    ["future-thing", "working", "ready"],  // unknown source falls through
  ];
  it.each(sessionstartTable)(
    "sessionstart source=%s starting=%s → %s",
    async (source, start, expected) => {
      seedWorker("garden", "bold-ash", { claudeStatus: start });
      setCwd("garden", "bold-ash");
      await sessionstartWithSource(source);
      expect(statusAfter("garden", "bold-ash")).toBe(expected);
    },
  );

  it("prompt sets working from any prior state", () => {
    seedWorker("garden", "bold-ash", { claudeStatus: "idle" });
    setCwd("garden", "bold-ash");
    handleClaudeHook("prompt");
    expect(statusAfter("garden", "bold-ash")).toBe("working");
  });

  it("prompt clears prState=done AND deletes the .garden-done sentinel", async () => {
    seedWorker("garden", "bold-ash", {
      claudeStatus: "idle",
      prState: "done",
      worktreePath: "/tmp/wt/garden/bold-ash",
    });
    setCwd("garden", "bold-ash");

    const fs = (await import("node:fs")).default;
    handleClaudeHook("prompt");

    const entry = entries.garden.find(e => e.name === "bold-ash")!;
    expect(entry.claudeStatus).toBe("working");
    expect(entry.prState).toBeUndefined();
    expect(fs.unlinkSync).toHaveBeenCalledWith("/tmp/wt/garden/bold-ash/.garden-done");
  });

  it("prompt does NOT touch the sentinel when prState was not merged/done", async () => {
    seedWorker("garden", "bold-ash", {
      claudeStatus: "idle",
      worktreePath: "/tmp/wt/garden/bold-ash",
    });
    setCwd("garden", "bold-ash");

    const fs = (await import("node:fs")).default;
    handleClaudeHook("prompt");

    const entry = entries.garden.find(e => e.name === "bold-ash")!;
    expect(entry.claudeStatus).toBe("working");
    expect(fs.unlinkSync).not.toHaveBeenCalled();
  });

  it("stop sets idle from any prior state", () => {
    seedWorker("garden", "bold-ash", { claudeStatus: "working" });
    setCwd("garden", "bold-ash");
    handleClaudeHook("stop");
    expect(statusAfter("garden", "bold-ash")).toBe("idle");
  });

  it("stop sets prState=done when .garden-done is present and no commits ahead", async () => {
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

    const entry = entries.garden.find(e => e.name === "bold-ash")!;
    expect(entry.claudeStatus).toBe("idle");
    expect(entry.prState).toBe("done");
    expect(typeof entry.mergedAt).toBe("string");
  });

  it("stop does NOT set done when .garden-done is absent", async () => {
    seedWorker("garden", "bold-ash", {
      claudeStatus: "working",
      worktreePath: "/tmp/wt/garden/bold-ash",
    });
    setCwd("garden", "bold-ash");

    // clearAllMocks resets call history but preserves mockImplementation;
    // re-assert the default so .garden-done is genuinely absent here.
    const fs = (await import("node:fs")).default;
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const { execFileSync } = await import("node:child_process");
    vi.mocked(execFileSync).mockImplementation((...args: unknown[]) => {
      const argv = args[1] as string[] | undefined;
      if (argv && argv[0] === "rev-list") return "0" as unknown as Buffer;
      return "" as unknown as Buffer;
    });

    handleClaudeHook("stop");

    const entry = entries.garden.find(e => e.name === "bold-ash")!;
    expect(entry.claudeStatus).toBe("idle");
    expect(entry.prState).toBeUndefined();
  });

  it("stop with commits ahead AND .garden-done queues review (does NOT set done)", async () => {
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

    // Review path takes priority — finalizeMerge picks the terminal state
    // (merged or done) itself after the merge cycle completes, based on
    // whether .garden-done is present at merge time. The stop hook MUST NOT
    // pre-set either terminal state here.
    const entry = entries.garden.find(e => e.name === "bold-ash")!;
    expect(entry.claudeStatus).toBe("idle");
    expect(typeof entry.pendingReviewAt).toBe("number");
    expect(entry.prState).toBeUndefined();
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

// pretooluse/posttooluse fire on every Claude tool call and dominate hook
// traffic. When they don't flip claudeStatus or prState, refreshDashboard
// must NOT cascade — the perf optimization in this commit. Detection: every
// refreshDashboard ends with tmux refresh-client -S via setBarVars; counting
// those calls is the cleanest signal that the cascade ran (or didn't).
describe("handleClaudeHook — refresh skip on no-op transitions", () => {
  it("pretooluse on a non-working/non-idle worker skips the dashboard refresh", () => {
    seedWorker("garden", "bold-ash", { claudeStatus: "ready" });
    setCwd("garden", "bold-ash");

    handleClaudeHook("pretooluse");

    const refreshCalls = vi.mocked(tmux).mock.calls.filter(
      c => c[0] === "refresh-client" && c[1] === "-S",
    );
    expect(refreshCalls).toHaveLength(0);
  });

  it("posttooluse on a working worker skips the dashboard refresh (no claudeStatus flip)", () => {
    seedWorker("garden", "bold-ash", { claudeStatus: "working" });
    setCwd("garden", "bold-ash");

    handleClaudeHook("posttooluse");

    const refreshCalls = vi.mocked(tmux).mock.calls.filter(
      c => c[0] === "refresh-client" && c[1] === "-S",
    );
    expect(refreshCalls).toHaveLength(0);
  });

  it("pretooluse that flips working → asking DOES refresh the dashboard", () => {
    seedWorker("garden", "bold-ash", { claudeStatus: "working" });
    setCwd("garden", "bold-ash");

    handleClaudeHook("pretooluse");

    const refreshCalls = vi.mocked(tmux).mock.calls.filter(
      c => c[0] === "refresh-client" && c[1] === "-S",
    );
    expect(refreshCalls.length).toBeGreaterThan(0);
  });

  it("stop always refreshes (claudeStatus → idle is a state change)", () => {
    seedWorker("garden", "bold-ash", { claudeStatus: "idle" });
    setCwd("garden", "bold-ash");

    handleClaudeHook("stop");

    const refreshCalls = vi.mocked(tmux).mock.calls.filter(
      c => c[0] === "refresh-client" && c[1] === "-S",
    );
    expect(refreshCalls.length).toBeGreaterThan(0);
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

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
  logColorKeyForProject: vi.fn(() => null),
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
  tmuxBatch: vi.fn(),
  tmuxOutput: vi.fn(() => ""),
  getFirstPaneId: vi.fn(() => null),
  getPaneTitle: vi.fn(() => ""),
  getPanePid: vi.fn(() => null),
  getPaneSize: vi.fn(() => null),  // null triggers resize since current size unknown
  windowExists: vi.fn(() => false),
  setPaneVar: vi.fn(),
  listAllWindowNames: vi.fn(() => []),
  // resolveGardenRunner() (transitively imported via hook dispatch) needs the
  // real safe-token regex so it can pre-escape the runner tokens.
  shellEscape: (s: string) => /^[a-zA-Z0-9_./:=-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`,
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

vi.mock("../src/dashboard/registry.js", () => {
  const updateWorkerFields = vi.fn(
    (project: string, name: string, fields: Record<string, unknown>) => {
      const list = entries[project];
      if (!list) return;
      const entry = list.find(e => e.name === name);
      if (entry) Object.assign(entry, fields);
    },
  );
  return {
    readRegistry: vi.fn(() => ({ workers: entries })),
    getWorkers: vi.fn((project: string) => entries[project] ?? []),
    findWorkerByName: vi.fn(
      (project: string, name: string) =>
        (entries[project] ?? []).find(e => e.name === name),
    ),
    updateWorkerFields,
    updateWorkerFieldsIf: vi.fn(
      (project: string, name: string, decide: (entry: { name: string }) => {
        fields: Record<string, unknown> | null;
        result: unknown;
      }) => {
        const entry = entries[project]?.find(candidate => candidate.name === name);
        if (!entry) return undefined;
        const decision = decide(entry);
        if (decision.fields !== null) updateWorkerFields(project, name, decision.fields);
        return decision.result;
      },
    ),
    // Mirrors the real write-only-on-change helper so the hook tests exercise
    // the same no-op-when-unchanged path production takes.
    setReviewBlockedReason: vi.fn(
      (project: string, entry: { name: string; reviewBlockedReason?: string }, reason?: string) => {
        if (entry.reviewBlockedReason === reason) return false;
        updateWorkerFields(project, entry.name, { reviewBlockedReason: reason });
        return true;
      },
    ),
    batchUpdateWorkerFields: vi.fn(),
  };
});

vi.mock("../src/dashboard/git.js", () => ({
  resolveBaseBranch: vi.fn(() => "main"),
  getWorkerBaseBranch: vi.fn((entry: { baseBranch?: string }) => entry.baseBranch ?? "main"),
  currentBranch: vi.fn(() => "main"),
  currentBranchFast: vi.fn(() => "main"),
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
  statusBarStyle: vi.fn(() => "bg=green,fg=black"),
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
import { tmux, tmuxBatch, getPaneTitle } from "../src/dashboard/tmux.js";
import { readDashState } from "../src/dashboard/state.js";
import { _resetHeaderCachesForTest } from "../src/dashboard/header.js";

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
      agentStatus: "working",
      ...fields,
    });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  process.cwd = originalCwd;
  delete process.env.GARDEN_REVIEWER;
  for (const key of Object.keys(entries)) delete entries[key];
  // header.ts caches identity-equal writes/refreshes; reset across tests so
  // each "first hook fires" scenario starts fresh.
  _resetHeaderCachesForTest();
});

afterAll(() => {
  if (originalGardenReviewer !== undefined) {
    process.env.GARDEN_REVIEWER = originalGardenReviewer;
  }
});

// Reads the worker's actual agentStatus from the in-memory registry mock —
// the mock applies updates via Object.assign, so this is a state assertion,
// not a mock-call assertion.
function statusAfter(project: string, worker: string): string | undefined {
  return entries[project]?.find(e => e.name === worker)?.agentStatus;
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
      seedWorker("garden", "bold-ash", { agentStatus: start });
      setCwd("garden", "bold-ash");
      handleClaudeHook("notification");
      expect(statusAfter("garden", "bold-ash")).toBe(expected);
    },
  );
  it.each(askingRule)(
    "pretooluse: %s → %s",
    (start, expected) => {
      seedWorker("garden", "bold-ash", { agentStatus: start });
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
      seedWorker("garden", "bold-ash", { agentStatus: start });
      setCwd("garden", "bold-ash");
      handleClaudeHook("posttooluse");
      expect(statusAfter("garden", "bold-ash")).toBe(expected);
    },
  );

  it("pretooluse and posttooluse have OPPOSITE effects on the same starting state", () => {
    seedWorker("garden", "bold-ash", { agentStatus: "working" });
    setCwd("garden", "bold-ash");
    handleClaudeHook("pretooluse");
    expect(statusAfter("garden", "bold-ash")).toBe("asking");
    handleClaudeHook("posttooluse");
    expect(statusAfter("garden", "bold-ash")).toBe("working");
  });

  it("notification does not fire an operator alert (status pane is the signal)", () => {
    seedWorker("garden", "bold-ash", { agentStatus: "working" });
    setCwd("garden", "bold-ash");
    handleClaudeHook("notification");
    expect(addAlert).not.toHaveBeenCalled();
  });

  it("pretooluse does not fire an operator alert", () => {
    seedWorker("garden", "bold-ash", { agentStatus: "working" });
    setCwd("garden", "bold-ash");
    handleClaudeHook("pretooluse");
    expect(addAlert).not.toHaveBeenCalled();
  });
});

describe("handleClaudeHook — guards", () => {
  it("ignores hook when cwd is outside any worktree (workerFromCwd returns null)", () => {
    seedWorker("garden", "bold-ash", { agentStatus: "working" });
    process.cwd = () => "/somewhere/else";
    handleClaudeHook("notification");
    expect(updateWorkerFields).not.toHaveBeenCalled();
    expect(statusAfter("garden", "bold-ash")).toBe("working");
  });

  it("ignores hook when GARDEN_REVIEWER=1 (reviewer's hooks must not write registry)", () => {
    seedWorker("garden", "bold-ash", { agentStatus: "working" });
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

  // resume/compact: preserve the existing agentStatus verbatim — the resume
  // dispatcher (resolveResumeAgentStatus) is authoritative and a resumed worker
  // never returns to the one-time "ready" (STATUS.md). Any other source (or no
  // source): fresh session, set ready.
  const sessionstartTable: Array<[string | null, string | undefined, string]> = [
    [null,        "loading", "ready"],
    ["startup",   "loading", "ready"],
    ["resume",    "working", "working"],   // preserved
    ["resume",    "asking",  "asking"],    // preserved
    ["resume",    "idle",    "idle"],      // preserved (was the strand-at-ready bug)
    ["resume",    "paused",  "paused"],    // preserved — operator hold survives a rebuild
    ["resume",    undefined, "idle"],      // self-heal a missing value (never "ready")
    ["compact",   "idle",    "idle"],      // preserved
    ["compact",   "working", "working"],   // preserved
    ["future-thing", "working", "ready"],  // unknown source falls through
  ];
  it.each(sessionstartTable)(
    "sessionstart source=%s starting=%s → %s",
    async (source, start, expected) => {
      seedWorker("garden", "bold-ash", { agentStatus: start });
      setCwd("garden", "bold-ash");
      await sessionstartWithSource(source);
      expect(statusAfter("garden", "bold-ash")).toBe(expected);
    },
  );

  it("prompt sets working from any prior state", () => {
    seedWorker("garden", "bold-ash", { agentStatus: "idle" });
    setCwd("garden", "bold-ash");
    handleClaudeHook("prompt");
    expect(statusAfter("garden", "bold-ash")).toBe("working");
  });

  it("prompt clears prState=done AND deletes the .garden-done sentinel", async () => {
    seedWorker("garden", "bold-ash", {
      agentStatus: "idle",
      prState: "done",
      worktreePath: "/tmp/wt/garden/bold-ash",
    });
    setCwd("garden", "bold-ash");

    const fs = (await import("node:fs")).default;
    handleClaudeHook("prompt");

    const entry = entries.garden.find(e => e.name === "bold-ash")!;
    expect(entry.agentStatus).toBe("working");
    expect(entry.prState).toBeUndefined();
    expect(fs.unlinkSync).toHaveBeenCalledWith("/tmp/wt/garden/bold-ash/.garden-done");
  });

  it("prompt clears continueSentAt (a landed prompt empties the input box)", () => {
    // continueSentAt marks a garden paste with no prompt landed since — the
    // stuck-paste recovery's evidence. Any prompt landing (garden's own or
    // the operator's) means the box was submitted or superseded, so the
    // marker must clear or a later operator paste could be misclassified as
    // garden's stuck text.
    seedWorker("garden", "bold-ash", { agentStatus: "idle", continueSentAt: 123 });
    setCwd("garden", "bold-ash");
    handleClaudeHook("prompt");
    const entry = entries.garden.find(e => e.name === "bold-ash")!;
    expect(entry.continueSentAt).toBeUndefined();
  });

  it("prompt does NOT touch the .garden-done sentinel when prState was not merged/done", async () => {
    seedWorker("garden", "bold-ash", {
      agentStatus: "idle",
      worktreePath: "/tmp/wt/garden/bold-ash",
    });
    setCwd("garden", "bold-ash");

    const fs = (await import("node:fs")).default;
    handleClaudeHook("prompt");

    const entry = entries.garden.find(e => e.name === "bold-ash")!;
    expect(entry.agentStatus).toBe("working");
    expect(fs.unlinkSync).not.toHaveBeenCalledWith("/tmp/wt/garden/bold-ash/.garden-done");
  });

  it("prompt clears the .garden-awaiting-input sentinel unconditionally (even mid-task, prState still working)", async () => {
    seedWorker("garden", "bold-ash", {
      agentStatus: "idle",
      prState: "working",
      worktreePath: "/tmp/wt/garden/bold-ash",
    });
    setCwd("garden", "bold-ash");

    const fs = (await import("node:fs")).default;
    handleClaudeHook("prompt");

    const entry = entries.garden.find(e => e.name === "bold-ash")!;
    expect(entry.agentStatus).toBe("working");
    // The human-gate sentinel clears on the operator's next prompt regardless of
    // prState — unlike .garden-done, which only clears from a terminal state.
    expect(fs.unlinkSync).toHaveBeenCalledWith("/tmp/wt/garden/bold-ash/.garden-awaiting-input");
    expect(fs.unlinkSync).not.toHaveBeenCalledWith("/tmp/wt/garden/bold-ash/.garden-done");
  });

  it("stop sets idle from any prior state", () => {
    seedWorker("garden", "bold-ash", { agentStatus: "working" });
    setCwd("garden", "bold-ash");
    handleClaudeHook("stop");
    expect(statusAfter("garden", "bold-ash")).toBe("idle");
  });

  it("stop sets prState=done when .garden-done is present and no commits ahead", async () => {
    seedWorker("garden", "bold-ash", {
      agentStatus: "working",
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
    expect(entry.agentStatus).toBe("idle");
    expect(entry.prState).toBe("done");
    expect(typeof entry.mergedAt).toBe("string");
  });


  it("stop does NOT set done when .garden-done is absent", async () => {
    seedWorker("garden", "bold-ash", {
      agentStatus: "working",
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
    expect(entry.agentStatus).toBe("idle");
    expect(entry.prState).toBeUndefined();
  });

  it("stop with commits ahead AND .garden-done queues review (does NOT set done)", async () => {
    seedWorker("garden", "bold-ash", {
      agentStatus: "working",
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
    expect(entry.agentStatus).toBe("idle");
    expect(typeof entry.pendingReviewAt).toBe("number");
    expect(entry.prState).toBeUndefined();
  });

  it("stop with commits ahead does not queue review when cleanliness is indeterminate", async () => {
    seedWorker("garden", "bold-ash", {
      agentStatus: "working",
      worktreePath: "/tmp/wt/garden/bold-ash",
    });
    setCwd("garden", "bold-ash");

    const { execFileSync } = await import("node:child_process");
    vi.mocked(execFileSync).mockImplementation((...args: unknown[]) => {
      const argv = args[1] as string[] | undefined;
      if (argv?.[0] === "rev-list") return "1" as unknown as Buffer;
      if (argv?.[0] === "status") throw new Error("git status timed out");
      return "" as unknown as Buffer;
    });

    handleClaudeHook("stop");

    const entry = entries.garden.find(e => e.name === "bold-ash")!;
    expect(entry.agentStatus).toBe("idle");
    expect(entry.pendingReviewAt).toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      "hook",
      "stop hook skipped review (worktree not provably clean)",
      expect.objectContaining({
        worker: "bold-ash",
        data: expect.objectContaining({ dirty: "indeterminate" }),
      }),
    );
    expect(entry.reviewBlockedReason).toBe("indeterminate");
    expect(addAlert).not.toHaveBeenCalled();
  });

  it("records WHY a dirty worktree blocked the review so the row can show it", async () => {
    // The stall this makes visible: commits ahead, nothing dirty about them,
    // but a stray untracked file means no review is ever armed. prState stays
    // unset, so the row renders a plain `idle` — identical to a worker that
    // finished — and the only other evidence is one info log line.
    seedWorker("garden", "bold-ash", {
      agentStatus: "working",
      worktreePath: "/tmp/wt/garden/bold-ash",
    });
    setCwd("garden", "bold-ash");

    const { execFileSync } = await import("node:child_process");
    vi.mocked(execFileSync).mockImplementation((...args: unknown[]) => {
      const argv = args[1] as string[] | undefined;
      if (argv?.[0] === "rev-list") return "1" as unknown as Buffer;
      if (argv?.[0] === "status") return "?? poetry.lock\n" as unknown as Buffer;
      return "" as unknown as Buffer;
    });

    handleClaudeHook("stop");

    const entry = entries.garden.find(e => e.name === "bold-ash")!;
    expect(entry.pendingReviewAt).toBeUndefined();
    expect(entry.reviewBlockedReason).toBe("dirty");
  });

  it("clears the blocked reason once the tree is clean and the review arms", async () => {
    seedWorker("garden", "bold-ash", {
      agentStatus: "working",
      worktreePath: "/tmp/wt/garden/bold-ash",
      reviewBlockedReason: "dirty",
    });
    setCwd("garden", "bold-ash");

    const { execFileSync } = await import("node:child_process");
    vi.mocked(execFileSync).mockImplementation((...args: unknown[]) => {
      const argv = args[1] as string[] | undefined;
      if (argv?.[0] === "rev-list") return "1" as unknown as Buffer;
      return "" as unknown as Buffer;
    });

    handleClaudeHook("stop");

    const entry = entries.garden.find(e => e.name === "bold-ash")!;
    expect(typeof entry.pendingReviewAt).toBe("number");
    expect(entry.reviewBlockedReason).toBeUndefined();
  });

  it("clears the blocked reason when the branch no longer has commits to review", async () => {
    // The commits the gate was holding are gone (merged, reset, rebased away),
    // so the flag must not outlive them on the row.
    seedWorker("garden", "bold-ash", {
      agentStatus: "working",
      worktreePath: "/tmp/wt/garden/bold-ash",
      reviewBlockedReason: "dirty",
    });
    setCwd("garden", "bold-ash");

    const { execFileSync } = await import("node:child_process");
    vi.mocked(execFileSync).mockImplementation((...args: unknown[]) => {
      const argv = args[1] as string[] | undefined;
      if (argv?.[0] === "rev-list") return "0" as unknown as Buffer;
      return "" as unknown as Buffer;
    });

    handleClaudeHook("stop");

    const entry = entries.garden.find(e => e.name === "bold-ash")!;
    expect(entry.reviewBlockedReason).toBeUndefined();
  });

  it("stop fires base-drift alert when rev-list against origin/<base> throws", async () => {
    seedWorker("garden", "bold-ash", {
      agentStatus: "working",
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
      agentStatus: "working",
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

  it("unknown event logs at debug and does not update", () => {
    seedWorker("garden", "bold-ash", { agentStatus: "working" });
    setCwd("garden", "bold-ash");

    handleClaudeHook("bogus");

    // debug, not warn: this fires once per hook invocation, so a misconfigured
    // or stale session must not firehose warn-level logs. See hook-dispatcher.ts.
    expect(log.debug).toHaveBeenCalledWith(
      "hook", "unhandled claude hook event",
      expect.anything(),
    );
    expect(log.warn).not.toHaveBeenCalled();
    expect(updateWorkerFields).not.toHaveBeenCalled();
  });
});

describe("handleClaudeHook — session id capture (self-assigning harness)", () => {
  it("captures session_id when the worker has none yet (codex assigns its own)", async () => {
    const fs = (await import("node:fs")).default;
    seedWorker("garden", "bold-ash", { agentStatus: "working", sessionId: "" });
    setCwd("garden", "bold-ash");
    vi.mocked(fs.readFileSync).mockReturnValueOnce(
      JSON.stringify({
        session_id: "codex-thread-abc",
        transcript_path: "/x/rollout-2026-08-13T17-07-18-codex-thread-abc.jsonl",
      }),
    );
    handleClaudeHook("posttooluse");
    const entry = entries["garden"]?.find(e => e.name === "bold-ash");
    expect(entry?.sessionId).toBe("codex-thread-abc");
    expect(entry?.transcriptPath).toBe(
      "/x/rollout-2026-08-13T17-07-18-codex-thread-abc.jsonl",
    );
  });

  it("does NOT overwrite an existing session id (claude mints its own at creation)", async () => {
    const fs = (await import("node:fs")).default;
    seedWorker("garden", "bold-ash", { agentStatus: "working", sessionId: "claude-uuid" });
    setCwd("garden", "bold-ash");
    vi.mocked(fs.readFileSync).mockReturnValueOnce(JSON.stringify({ session_id: "different-id" }));
    handleClaudeHook("posttooluse");
    const entry = entries["garden"]?.find(e => e.name === "bold-ash");
    expect(entry?.sessionId).toBe("claude-uuid");
  });
});

describe("handleClaudeHook — transcript path capture (session ownership)", () => {
  it("rejects another thread's path during first-session capture", async () => {
    const fs = (await import("node:fs")).default;
    seedWorker("garden", "bold-ash", { agentStatus: "working", sessionId: "" });
    setCwd("garden", "bold-ash");
    vi.mocked(fs.readFileSync).mockReturnValueOnce(JSON.stringify({
      session_id: "main-thread-id",
      transcript_path: "/s/rollout-2026-08-13T17-07-18-subagent-id.jsonl",
    }));
    handleClaudeHook("posttooluse");
    const entry = entries["garden"]?.find(e => e.name === "bold-ash");
    expect(entry?.sessionId).toBe("main-thread-id");
    expect(entry?.transcriptPath).toBeUndefined();
  });

  it("rejects a transcript path from another thread (codex subagent rollout)", async () => {
    const fs = (await import("node:fs")).default;
    seedWorker("garden", "bold-ash", {
      agentStatus: "working",
      sessionId: "main-thread-id",
      transcriptPath: "/s/2026/08/07/rollout-2026-08-07T10-21-22-main-thread-id.jsonl",
    });
    setCwd("garden", "bold-ash");
    vi.mocked(fs.readFileSync).mockReturnValueOnce(JSON.stringify({
      session_id: "main-thread-id",
      transcript_path: "/s/2026/08/13/rollout-2026-08-13T17-07-18-subagent-id.jsonl",
    }));
    handleClaudeHook("posttooluse");
    const entry = entries["garden"]?.find(e => e.name === "bold-ash");
    expect(entry?.transcriptPath).toBe(
      "/s/2026/08/07/rollout-2026-08-07T10-21-22-main-thread-id.jsonl",
    );
  });

  it("requires the session id in the filename, not elsewhere in the path", async () => {
    const fs = (await import("node:fs")).default;
    seedWorker("garden", "bold-ash", {
      agentStatus: "working",
      sessionId: "main-thread-id",
      transcriptPath: "/s/rollout-2026-08-07T10-21-22-main-thread-id.jsonl",
    });
    setCwd("garden", "bold-ash");
    vi.mocked(fs.readFileSync).mockReturnValueOnce(JSON.stringify({
      session_id: "main-thread-id",
      transcript_path: "/s/main-thread-id/rollout-2026-08-13T17-07-18-subagent-id.jsonl",
    }));
    handleClaudeHook("posttooluse");
    const entry = entries["garden"]?.find(e => e.name === "bold-ash");
    expect(entry?.transcriptPath).toBe(
      "/s/rollout-2026-08-07T10-21-22-main-thread-id.jsonl",
    );
  });

  it("accepts Claude's exact session-id filename", async () => {
    const fs = (await import("node:fs")).default;
    seedWorker("garden", "bold-ash", {
      agentStatus: "working",
      sessionId: "main-thread-id",
    });
    setCwd("garden", "bold-ash");
    vi.mocked(fs.readFileSync).mockReturnValueOnce(JSON.stringify({
      session_id: "main-thread-id",
      transcript_path: "/s/main-thread-id.jsonl",
    }));
    handleClaudeHook("posttooluse");
    const entry = entries["garden"]?.find(e => e.name === "bold-ash");
    expect(entry?.transcriptPath).toBe("/s/main-thread-id.jsonl");
  });

  it("accepts a changed transcript path that names the worker's own session (heals a stomped entry)", async () => {
    const fs = (await import("node:fs")).default;
    seedWorker("garden", "bold-ash", {
      agentStatus: "working",
      sessionId: "main-thread-id",
      transcriptPath: "/s/2026/08/13/rollout-2026-08-13T17-07-18-subagent-id.jsonl",
    });
    setCwd("garden", "bold-ash");
    vi.mocked(fs.readFileSync).mockReturnValueOnce(JSON.stringify({
      session_id: "main-thread-id",
      transcript_path: "/s/2026/08/07/rollout-2026-08-07T10-21-22-main-thread-id.jsonl",
    }));
    handleClaudeHook("posttooluse");
    const entry = entries["garden"]?.find(e => e.name === "bold-ash");
    expect(entry?.transcriptPath).toBe(
      "/s/2026/08/07/rollout-2026-08-07T10-21-22-main-thread-id.jsonl",
    );
  });
});

// pretooluse/posttooluse fire on every Claude tool call and dominate hook
// traffic. When they don't flip agentStatus or prState, refreshDashboard
// must NOT cascade — the perf optimization in this commit. Detection: every
// refreshDashboard ends with a refresh-client -S in setBarVars' batched
// tmuxBatch call; counting those groups is the cleanest signal that the cascade
// ran (or didn't).
describe("handleClaudeHook — refresh skip on no-op transitions", () => {
  it("pretooluse on a non-working/non-idle worker skips the dashboard refresh", () => {
    seedWorker("garden", "bold-ash", { agentStatus: "ready" });
    setCwd("garden", "bold-ash");

    handleClaudeHook("pretooluse");

    const refreshCalls = vi.mocked(tmuxBatch).mock.calls.flat().filter(
      g => g[0] === "refresh-client" && g[1] === "-S",
    );
    expect(refreshCalls).toHaveLength(0);
  });

  it("posttooluse on a working worker skips the dashboard refresh (no agentStatus flip)", () => {
    seedWorker("garden", "bold-ash", { agentStatus: "working" });
    setCwd("garden", "bold-ash");

    handleClaudeHook("posttooluse");

    const refreshCalls = vi.mocked(tmuxBatch).mock.calls.flat().filter(
      g => g[0] === "refresh-client" && g[1] === "-S",
    );
    expect(refreshCalls).toHaveLength(0);
  });

  it("posttooluse repaints a changed task even without a state transition", () => {
    seedWorker("garden", "bold-ash", {
      agentStatus: "working",
      task: "old task",
    });
    setCwd("garden", "bold-ash");
    vi.mocked(readDashState).mockReturnValueOnce({
      activeProject: "garden",
      statusPaneId: null,
      gardenShellPaneId: null,
      activePaneId: "%5",
      activePaneType: "worker",
      activeWindowName: "_garden-worker-bold-ash",
    });
    vi.mocked(getPaneTitle).mockReturnValueOnce("Investigate blank task summaries");

    handleClaudeHook("posttooluse");

    expect(entries.garden[0].task).toBe("Investigate blank task summaries");
    const refreshCalls = vi.mocked(tmuxBatch).mock.calls.flat().filter(
      g => g[0] === "refresh-client" && g[1] === "-S",
    );
    expect(refreshCalls.length).toBeGreaterThan(0);
  });

  it("pretooluse that flips working → asking DOES refresh the dashboard", () => {
    seedWorker("garden", "bold-ash", { agentStatus: "working" });
    setCwd("garden", "bold-ash");

    handleClaudeHook("pretooluse");

    const refreshCalls = vi.mocked(tmuxBatch).mock.calls.flat().filter(
      g => g[0] === "refresh-client" && g[1] === "-S",
    );
    expect(refreshCalls.length).toBeGreaterThan(0);
  });

  it("stop always refreshes (agentStatus → idle is a state change)", () => {
    seedWorker("garden", "bold-ash", { agentStatus: "idle" });
    setCwd("garden", "bold-ash");

    handleClaudeHook("stop");

    const refreshCalls = vi.mocked(tmuxBatch).mock.calls.flat().filter(
      g => g[0] === "refresh-client" && g[1] === "-S",
    );
    expect(refreshCalls.length).toBeGreaterThan(0);
  });
});

// pretooluse/posttooluse fire on every Claude tool call. A heartbeat hook
// (no agentStatus/prState change) refreshes lastEventAt at most once per
// HOOK_HEARTBEAT_MS (10s) per worker, so N busy agents don't churn the
// registry lock + tmux server on every tool. A real transition is never
// throttled. lastEventAt is consumed only by 15-minute staleness checks, so
// coarse heartbeat resolution is safe.
describe("handleClaudeHook — heartbeat throttle (perf)", () => {
  it("posttooluse with a recent lastEventAt and no state change skips the registry write", () => {
    seedWorker("garden", "bold-ash", { agentStatus: "working", lastEventAt: Date.now() });
    setCwd("garden", "bold-ash");

    handleClaudeHook("posttooluse");

    expect(updateWorkerFields).not.toHaveBeenCalled();
  });

  it("the skipped heartbeat does not fork tmux to read the pane title", () => {
    seedWorker("garden", "bold-ash", { agentStatus: "working", lastEventAt: Date.now() });
    setCwd("garden", "bold-ash");

    handleClaudeHook("posttooluse");

    expect(getPaneTitle).not.toHaveBeenCalled();
  });

  it("posttooluse with a stale lastEventAt refreshes the heartbeat", () => {
    seedWorker("garden", "bold-ash", { agentStatus: "working", lastEventAt: Date.now() - 30_000 });
    setCwd("garden", "bold-ash");

    handleClaudeHook("posttooluse");

    expect(updateWorkerFields).toHaveBeenCalled();
    const entry = entries.garden.find(e => e.name === "bold-ash")!;
    expect(Date.now() - (entry.lastEventAt ?? 0)).toBeLessThan(5_000);
  });

  it("a heartbeat with no prior lastEventAt is not throttled (undefined reads as stale)", () => {
    seedWorker("garden", "bold-ash", { agentStatus: "working" });
    setCwd("garden", "bold-ash");

    handleClaudeHook("posttooluse");

    expect(updateWorkerFields).toHaveBeenCalled();
  });

  // A Codex worker's task is derived from its rollout, not from a pane-title
  // event, so nothing else discovers the operator's opening prompt. Throttling
  // the discovery would leave the `awaiting task` placeholder on the row for up
  // to a heartbeat interval after the worker was actually given work.
  it("a codex worker still carrying the creation placeholder is not throttled", () => {
    seedWorker("garden", "bold-ash", {
      agentStatus: "working",
      lastEventAt: Date.now(),
      harness: "codex",
      task: "awaiting task",
    });
    setCwd("garden", "bold-ash");

    handleClaudeHook("posttooluse");

    expect(updateWorkerFields).toHaveBeenCalled();
  });

  it("a codex worker with a real summary is throttled like any other", () => {
    seedWorker("garden", "bold-ash", {
      agentStatus: "working",
      lastEventAt: Date.now(),
      harness: "codex",
      task: "Auditing the poller's merge path",
    });
    setCwd("garden", "bold-ash");

    handleClaudeHook("posttooluse");

    expect(updateWorkerFields).not.toHaveBeenCalled();
  });

  it("a state-changing hook is NEVER throttled, even with a fresh lastEventAt", () => {
    // asking → working is a real transition; it must write regardless of how
    // recently the heartbeat fired, or the worker would appear stuck in asking.
    seedWorker("garden", "bold-ash", { agentStatus: "asking", lastEventAt: Date.now() });
    setCwd("garden", "bold-ash");

    handleClaudeHook("posttooluse");

    expect(updateWorkerFields).toHaveBeenCalled();
    expect(statusAfter("garden", "bold-ash")).toBe("working");
  });
});

// Row ordering keys on lastStateChangeAt (the last real transition), not the
// heartbeat lastEventAt — so a working agent's silent 10s heartbeats don't
// reshuffle the status pane and then snap on the operator's next navigation.
// applyAndLog stamps lastStateChangeAt only when agentStatus/prState moves.
describe("handleClaudeHook — lastStateChangeAt (row-ordering timestamp)", () => {
  it("a state-changing hook stamps lastStateChangeAt", () => {
    seedWorker("garden", "bold-ash", { agentStatus: "idle", lastStateChangeAt: 1 });
    setCwd("garden", "bold-ash");

    handleClaudeHook("posttooluse"); // idle → working is a real transition

    const entry = entries.garden.find(e => e.name === "bold-ash")!;
    expect(entry.agentStatus).toBe("working");
    expect(Date.now() - (entry.lastStateChangeAt ?? 0)).toBeLessThan(5_000);
  });

  it("a heartbeat hook bumps lastEventAt but leaves lastStateChangeAt fixed", () => {
    // working + a stale heartbeat: posttooluse is a no-op transition (stays
    // working), so it refreshes the heartbeat without touching the order key.
    seedWorker("garden", "bold-ash", {
      agentStatus: "working", lastEventAt: Date.now() - 30_000, lastStateChangeAt: 12345,
    });
    setCwd("garden", "bold-ash");

    handleClaudeHook("posttooluse");

    const entry = entries.garden.find(e => e.name === "bold-ash")!;
    expect(Date.now() - (entry.lastEventAt ?? 0)).toBeLessThan(5_000); // heartbeat advanced
    expect(entry.lastStateChangeAt).toBe(12345);                        // order key fixed
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
    seedWorker("garden", "bold-ash", { agentStatus: "idle" });
    setCwd("garden", "bold-ash");

    handleClaudeHook("stop");

    // renderQuickStatus is mocked to return ""; "".split("\n").length === 1,
    // Math.max(16, 1) + 1 === 17 (the +1 accounts for pane-border-status top;
    // the 16 is the 5-project floor: 2 pad + 5*(header+body) + 4 separators)
    expect(vi.mocked(tmux)).toHaveBeenCalledWith("resize-pane", "-t", "%0", "-y", "17");
  });

  it("skips resize when statusPaneId is null", () => {
    seedWorker("garden", "bold-ash", { agentStatus: "idle" });
    setCwd("garden", "bold-ash");

    handleClaudeHook("stop");

    expect(vi.mocked(tmux)).not.toHaveBeenCalledWith(
      "resize-pane", expect.any(String), expect.any(String), expect.any(String), expect.any(String),
    );
  });
});

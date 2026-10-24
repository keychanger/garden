import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";

// Registry mock with real read-modify-write behavior
const entries: Record<string, import("../src/dashboard/registry.js").WorkerEntry[]> = {};

vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => ""),
  execFileSync: vi.fn(() => "0"),
  spawn: vi.fn(() => ({ unref: vi.fn() })),
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
  paneExists: vi.fn(() => true),
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
    isDelegating: vi.fn(() => false),
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
  refreshWorkerTasks: vi.fn(() => null),
}));

import { gitSubcommandArgs } from "./helpers.js";
import { SAFE_GIT_CONFIG } from "../src/dashboard/git-exec.js";
import { handleClaudeHook } from "../src/dashboard/hook-dispatcher.js";
import { addAlert } from "../src/dashboard/alerts.js";
import { updateWorkerFields } from "../src/dashboard/registry.js";
import { log } from "../src/dashboard/log.js";
import { tmux, tmuxBatch, getPaneTitle, getFirstPaneId, paneExists, windowExists } from "../src/dashboard/tmux.js";
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

// The hook handlers run unsandboxed in the worker's worktree on every Stop and
// Bash tool call, so every git they issue must carry SAFE_GIT_CONFIG.
afterEach(async () => {
  const { execFileSync } = await import("node:child_process");
  const unsafe = vi.mocked(execFileSync).mock.calls
    .filter(([cmd, argv]) => cmd === "git" && !SAFE_GIT_CONFIG.every((arg, i) => (argv as string[])[i] === arg))
    .map(([, argv]) => (argv as string[]).join(" "));
  expect(unsafe).toEqual([]);
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

describe("handleClaudeHook — permission dialog watcher", () => {
  async function spawnedCommands(): Promise<string[]> {
    const { spawn } = await import("node:child_process");
    return vi.mocked(spawn).mock.calls.map(call => String((call[1] as string[])[1]));
  }

  async function fireBlocked(input: Record<string, unknown>) {
    const fs = (await import("node:fs")).default;
    vi.mocked(fs.readFileSync).mockReturnValueOnce(JSON.stringify(input));
    handleClaudeHook("pretooluse");
  }

  it("watches the episode a PermissionRequest raised", async () => {
    seedWorker("garden", "bold-ash", { agentStatus: "working" });
    setCwd("garden", "bold-ash");
    await fireBlocked({ hook_event_name: "PermissionRequest" });
    const askedAt = entries.garden[0].lastStateChangeAt;
    expect(statusAfter("garden", "bold-ash")).toBe("asking");
    const commands = await spawnedCommands();
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain(`dashboard _await-permission garden bold-ash ${askedAt}`);
  });

  it("does not watch an AskUserQuestion, which clears through its own PostToolUse", async () => {
    seedWorker("garden", "bold-ash", { agentStatus: "working" });
    setCwd("garden", "bold-ash");
    await fireBlocked({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion" });
    expect(statusAfter("garden", "bold-ash")).toBe("asking");
    expect(await spawnedCommands()).toEqual([]);
  });

  it("does not watch when the request raised no new asking episode", async () => {
    seedWorker("garden", "bold-ash", { agentStatus: "paused" });
    setCwd("garden", "bold-ash");
    await fireBlocked({ hook_event_name: "PermissionRequest" });
    expect(await spawnedCommands()).toEqual([]);
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

  // The prompt IS the answer the worker was blocked on, so the question stops
  // being true. Both halves of a block clear together — the sentinel that
  // suppresses auto-continue and the field that flags the row — or the operator
  // keeps being asked for something they already gave.
  it("prompt clears a blocked question along with the human-gate sentinel", async () => {
    seedWorker("garden", "bold-ash", {
      agentStatus: "idle",
      prState: "merged",
      worktreePath: "/tmp/wt/garden/bold-ash",
      blockedQuestion: "Commit binary ledgers?",
      blockedAt: 123,
    });
    setCwd("garden", "bold-ash");

    const fs = (await import("node:fs")).default;
    handleClaudeHook("prompt");

    const entry = entries.garden.find(e => e.name === "bold-ash")!;
    expect(entry.blockedQuestion).toBeUndefined();
    expect(entry.blockedAt).toBeUndefined();
    expect(entry.agentStatus).toBe("working");
    expect(fs.unlinkSync).toHaveBeenCalledWith("/tmp/wt/garden/bold-ash/.garden-awaiting-input");
  });

  it("keeps the question visible when the human-gate sentinel cannot be cleared", async () => {
    seedWorker("garden", "bold-ash", {
      agentStatus: "idle",
      prState: "working",
      worktreePath: "/tmp/wt/garden/bold-ash",
      blockedQuestion: "Commit binary ledgers?",
      blockedAt: 123,
    });
    setCwd("garden", "bold-ash");
    const fs = (await import("node:fs")).default;
    // A refused unlink means the sentinel SURVIVES, which is the whole reason the
    // flag must stay: auto-continue still reads it and still skips. The surviving
    // file is the load-bearing half of the scenario, so the mock has to report it
    // — a throw alone describes a world where the gate quietly vanished.
    vi.mocked(fs.unlinkSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });
    vi.mocked(fs.existsSync).mockImplementation(
      (p: fs.PathLike) => String(p).endsWith(".garden-awaiting-input"),
    );

    handleClaudeHook("prompt");

    const entry = entries.garden.find(e => e.name === "bold-ash")!;
    expect(entry.blockedQuestion).toBe("Commit binary ledgers?");
    expect(entry.blockedAt).toBe(123);
    expect(entry.agentStatus).toBe("working");
  });

  // validate.ts clears entry.worktreePath when the worktree goes missing, and a
  // blocked worker can outlive its worktree. With no path there is no sentinel to
  // hold the gate — isAwaitingInput returns false, so auto-continue is NOT being
  // skipped — yet the row would keep claiming a block. Nothing could clear it:
  // `garden resume` refuses a worker with no worktreePath, so the operator's only
  // escape was deleting the worker.
  it("clears a block on a worker whose worktree is gone, where no gate is held", async () => {
    seedWorker("garden", "bold-ash", {
      agentStatus: "idle",
      prState: "merged",
      blockedQuestion: "Commit binary ledgers?",
      blockedAt: 123,
    });
    setCwd("garden", "bold-ash");

    handleClaudeHook("prompt");

    const entry = entries.garden.find(e => e.name === "bold-ash")!;
    expect(entry.blockedQuestion).toBeUndefined();
    expect(entry.blockedAt).toBeUndefined();
  });

  // A `!` shell command typed into the pane (the usual answer to "run gcloud
  // auth login") starts a new turn without firing UserPromptSubmit. The row
  // kept reading `asking` while the worker carried on, and auto-continue
  // stayed suppressed. The resumed turn's tool calls are the evidence instead.
  it("stop stamps the end of a blocked turn", () => {
    seedWorker("garden", "bold-ash", {
      agentStatus: "working",
      worktreePath: "/tmp/wt/garden/bold-ash",
      blockedQuestion: "Run gcloud auth login?",
      blockedAt: 123,
    });
    setCwd("garden", "bold-ash");
    handleClaudeHook("stop");
    expect(entries.garden.find(e => e.name === "bold-ash")!.blockedTurnEndedAt).toEqual(expect.any(Number));
  });

  it("stop does not stamp an unblocked worker or a Codex worker", () => {
    seedWorker("garden", "bold-ash", { agentStatus: "working" });
    seedWorker("garden", "calm-oak", {
      agentStatus: "working",
      harness: "codex",
      blockedQuestion: "Run gcloud auth login?",
      blockedAt: 123,
    });
    setCwd("garden", "bold-ash");
    handleClaudeHook("stop");
    setCwd("garden", "calm-oak");
    handleClaudeHook("stop");
    expect(entries.garden.find(e => e.name === "bold-ash")!.blockedTurnEndedAt).toBeUndefined();
    expect(entries.garden.find(e => e.name === "calm-oak")!.blockedTurnEndedAt).toBeUndefined();
  });

  it("a main-thread tool call after the blocked turn ended clears the block", async () => {
    seedWorker("garden", "bold-ash", {
      agentStatus: "idle",
      worktreePath: "/tmp/wt/garden/bold-ash",
      blockedQuestion: "Run gcloud auth login?",
      blockedAt: 123,
      blockedTurnEndedAt: 456,
    });
    setCwd("garden", "bold-ash");
    const fs = (await import("node:fs")).default;
    vi.mocked(fs.existsSync).mockImplementation(() => false);

    handleClaudeHook("posttooluse");

    const entry = entries.garden.find(e => e.name === "bold-ash")!;
    expect(entry.agentStatus).toBe("working");
    expect(entry.blockedQuestion).toBeUndefined();
    expect(entry.blockedAt).toBeUndefined();
    expect(entry.blockedTurnEndedAt).toBeUndefined();
    expect(fs.unlinkSync).toHaveBeenCalledWith("/tmp/wt/garden/bold-ash/.garden-awaiting-input");
  });

  it("retries clearing a block without throttling or hiding the row change", async () => {
    seedWorker("garden", "bold-ash", {
      agentStatus: "idle",
      worktreePath: "/tmp/wt/garden/bold-ash",
      blockedQuestion: "Run gcloud auth login?",
      blockedAt: 123,
      blockedTurnEndedAt: 456,
    });
    setCwd("garden", "bold-ash");
    const fs = (await import("node:fs")).default;
    let awaiting = true;
    vi.mocked(fs.existsSync).mockImplementation(p =>
      awaiting && String(p).endsWith(".garden-awaiting-input"));
    vi.mocked(fs.unlinkSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });

    handleClaudeHook("posttooluse");
    const entry = entries.garden.find(e => e.name === "bold-ash")!;
    expect(entry.agentStatus).toBe("working");
    expect(entry.blockedQuestion).toBe("Run gcloud auth login?");
    expect(entry.blockedTurnEndedAt).toBe(456);
    const transitionAt = entry.lastStateChangeAt;
    vi.mocked(fs.unlinkSync).mockImplementationOnce(() => { awaiting = false; });
    const header = await import("../src/dashboard/header.js");
    const refresh = vi.spyOn(header, "refreshDashboard");

    handleClaudeHook("posttooluse");
    const repaints = refresh.mock.calls.length;
    refresh.mockRestore();

    expect(awaiting).toBe(false);
    expect(entry.blockedQuestion).toBeUndefined();
    expect(entry.blockedAt).toBeUndefined();
    expect(entry.blockedTurnEndedAt).toBeUndefined();
    expect(entry.lastStateChangeAt).toBe(transitionAt);
    expect(repaints).toBe(1);
  });

  // Claude Code starts a turn on its own when a background command, Monitor or
  // async agent reports, and fires UserPromptSubmit for it like a typed prompt.
  // That turn is not the operator's answer: neither its prompt nor its tool
  // calls may clear the question. The operator's `!` answer after it still does.
  it("a background task's notification turn leaves a blocked question open", async () => {
    seedWorker("garden", "bold-ash", {
      agentStatus: "idle",
      worktreePath: "/tmp/wt/garden/bold-ash",
      blockedQuestion: "Approve the spend?",
      blockedAt: 123,
      blockedTurnEndedAt: 456,
    });
    setCwd("garden", "bold-ash");
    const fs = (await import("node:fs")).default;
    let awaiting = true;
    vi.mocked(fs.existsSync).mockImplementation(p =>
      awaiting && String(p).endsWith(".garden-awaiting-input"));
    vi.mocked(fs.unlinkSync).mockImplementation(p => {
      if (String(p).endsWith(".garden-awaiting-input")) awaiting = false;
    });
    const { execFileSync } = await import("node:child_process");
    vi.mocked(execFileSync).mockImplementation(() => "0" as unknown as Buffer);
    const entry = entries.garden.find(e => e.name === "bold-ash")!;

    vi.mocked(fs.readFileSync).mockReturnValueOnce(JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      prompt: "<task-notification>\n<task-id>b7k2</task-id>\n<status>completed</status>\n</task-notification>",
    }));
    handleClaudeHook("prompt");
    expect(entry.agentStatus).toBe("working");
    expect(entry.blockedQuestion).toBe("Approve the spend?");
    expect(awaiting).toBe(true);

    handleClaudeHook("posttooluse");
    expect(entry.blockedQuestion).toBe("Approve the spend?");
    expect(awaiting).toBe(true);

    handleClaudeHook("stop");
    expect(entry.blockedTurnEndedAt).toEqual(expect.any(Number));

    handleClaudeHook("posttooluse");
    expect(entry.blockedQuestion).toBeUndefined();
    expect(awaiting).toBe(false);
    vi.mocked(fs.unlinkSync).mockImplementation(() => undefined);
    vi.mocked(fs.existsSync).mockImplementation(() => false);
  });

  // An async agent's result arrives framed as a message from another session,
  // and a peer session's message is framed the same way: neither is the operator.
  it("a subagent's or peer session's message leaves a blocked question open", async () => {
    seedWorker("garden", "bold-ash", {
      agentStatus: "idle",
      worktreePath: "/tmp/wt/garden/bold-ash",
      blockedQuestion: "Approve the spend?",
      blockedAt: 123,
      blockedTurnEndedAt: 456,
    });
    setCwd("garden", "bold-ash");
    const fs = (await import("node:fs")).default;
    let awaiting = true;
    vi.mocked(fs.existsSync).mockImplementation(p =>
      awaiting && String(p).endsWith(".garden-awaiting-input"));
    vi.mocked(fs.unlinkSync).mockImplementation(p => {
      if (String(p).endsWith(".garden-awaiting-input")) awaiting = false;
    });
    vi.mocked(fs.readFileSync).mockReturnValueOnce(JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      prompt: "Another Claude session sent a message:\n<agent-message from=\"a1\">done</agent-message>",
    }));

    handleClaudeHook("prompt");

    const entry = entries.garden.find(e => e.name === "bold-ash")!;
    expect(entry.blockedQuestion).toBe("Approve the spend?");
    expect(entry.blockedTurnEndedAt).toBeUndefined();
    expect(awaiting).toBe(true);
    vi.mocked(fs.unlinkSync).mockImplementation(() => undefined);
    vi.mocked(fs.existsSync).mockImplementation(() => false);
  });

  // The `garden blocked` call is itself a tool call in the turn that asks.
  it("a tool call in the turn that asked keeps the block", async () => {
    seedWorker("garden", "bold-ash", {
      agentStatus: "working",
      worktreePath: "/tmp/wt/garden/bold-ash",
      blockedQuestion: "Run gcloud auth login?",
      blockedAt: 123,
    });
    setCwd("garden", "bold-ash");
    const fs = (await import("node:fs")).default;

    handleClaudeHook("posttooluse");

    expect(entries.garden.find(e => e.name === "bold-ash")!.blockedQuestion).toBe("Run gcloud auth login?");
    expect(fs.unlinkSync).not.toHaveBeenCalledWith("/tmp/wt/garden/bold-ash/.garden-awaiting-input");
  });

  it("stop sets idle from any prior state", () => {
    seedWorker("garden", "bold-ash", { agentStatus: "working" });
    setCwd("garden", "bold-ash");
    handleClaudeHook("stop");
    expect(statusAfter("garden", "bold-ash")).toBe("idle");
  });

  // A turn that dies on an API error fires StopFailure, registered on the stop
  // route. It must end the turn, or the worker reads `working` until the
  // operator types into it.
  it("a StopFailure ends the turn like stop and logs the error category", async () => {
    seedWorker("garden", "bold-ash", { agentStatus: "working" });
    setCwd("garden", "bold-ash");
    const fs = (await import("node:fs")).default;
    vi.mocked(fs.readFileSync).mockReturnValueOnce(JSON.stringify({ hook_event_name: "StopFailure", error: "rate_limit" }));
    handleClaudeHook("stop");
    expect(statusAfter("garden", "bold-ash")).toBe("idle");
    const { log } = await import("../src/dashboard/log.js");
    expect(log.info).toHaveBeenCalledWith("hook", "turn ended on an API error", {
      worker: "bold-ash", data: { project: "garden", error: "rate_limit" },
    });
  });

  it("a failed tool (PostToolUseFailure) clears asking like a successful one", async () => {
    seedWorker("garden", "bold-ash", { agentStatus: "asking" });
    setCwd("garden", "bold-ash");
    const fs = (await import("node:fs")).default;
    vi.mocked(fs.readFileSync).mockReturnValueOnce(JSON.stringify({
      hook_event_name: "PostToolUseFailure", tool_name: "Bash", error: "Exit code 1",
    }));
    handleClaudeHook("posttooluse");
    expect(statusAfter("garden", "bold-ash")).toBe("working");
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
      const argv = gitSubcommandArgs(args[1] as string[] | undefined);
      if (argv && argv[0] === "rev-list") return "0" as unknown as Buffer;
      return "" as unknown as Buffer;
    });

    handleClaudeHook("stop");

    const entry = entries.garden.find(e => e.name === "bold-ash")!;
    expect(entry.agentStatus).toBe("idle");
    expect(entry.prState).toBe("done");
    expect(typeof entry.mergedAt).toBe("string");
  });

  // The pipeline states belong to the poller, and two of them meet this
  // branch's condition: a holistic pass reviews a branch fast-forwarded to
  // base, and a merge has pushed before its terminal write. A Stop there (an
  // operator question answered mid-pass) must not overwrite them. An unknown
  // value from a newer build is skipped the same way.
  it.each(["reviewing", "merge-pending", "resolving", "ci-fixing", "failing", "landing"])(
    "stop leaves prState %s alone despite .garden-done and no commits ahead",
    async (prState) => {
      seedWorker("garden", "bold-ash", {
        agentStatus: "working",
        worktreePath: "/tmp/wt/garden/bold-ash",
        prState: prState as import("../src/dashboard/registry.js").PrState,
        holisticFinalActive: true,
        reviewWindowName: "_garden-review-bold-ash",
      });
      setCwd("garden", "bold-ash");
      const fs = (await import("node:fs")).default;
      vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) =>
        String(p) === "/tmp/wt/garden/bold-ash/.garden-done");
      const { execFileSync } = await import("node:child_process");
      vi.mocked(execFileSync).mockImplementation((...args: unknown[]) => {
        const argv = gitSubcommandArgs(args[1] as string[] | undefined);
        if (argv && argv[0] === "rev-list") return "0" as unknown as Buffer;
        return "" as unknown as Buffer;
      });

      handleClaudeHook("stop");

      const entry = entries.garden.find(e => e.name === "bold-ash")!;
      expect(entry.agentStatus).toBe("idle");
      expect(entry.prState).toBe(prState);
      expect(entry.mergedAt).toBeUndefined();
      expect(log.info).not.toHaveBeenCalledWith("hook", "stop hook set done prState", expect.anything());
    },
  );

  // `working` is where the finalize race leaves a worker whose sentinel is
  // still on disk (STATUS.md: its no-commit Stop re-trips done); `merged` is
  // the spec's other Stop edge; `done` re-pokes the poller for a holistic
  // dispatch that deferred while the worker was working.
  it.each(["working", "merged", "done"])(
    "stop still sets done from prState %s with .garden-done and no commits ahead",
    async (prState) => {
      seedWorker("garden", "bold-ash", {
        agentStatus: "working",
        worktreePath: "/tmp/wt/garden/bold-ash",
        prState: prState as import("../src/dashboard/registry.js").PrState,
      });
      setCwd("garden", "bold-ash");
      const fs = (await import("node:fs")).default;
      vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) =>
        String(p) === "/tmp/wt/garden/bold-ash/.garden-done");
      const { execFileSync } = await import("node:child_process");
      vi.mocked(execFileSync).mockImplementation((...args: unknown[]) => {
        const argv = gitSubcommandArgs(args[1] as string[] | undefined);
        if (argv && argv[0] === "rev-list") return "0" as unknown as Buffer;
        return "" as unknown as Buffer;
      });

      handleClaudeHook("stop");

      const entry = entries.garden.find(e => e.name === "bold-ash")!;
      expect(entry.prState).toBe("done");
      expect(typeof entry.mergedAt).toBe("string");
    },
  );

  // `done` is the operator's cleanup signal, and removal deletes the worktree
  // with --force. A tree whose cleanliness is unknown counts as dirty, as it
  // does for the review gate.
  it.each([
    ["has uncommitted changes", () => " M src/app.ts\n?? notes.txt\n", "info", true],
    ["cannot be checked", () => { throw new Error("git status timed out"); }, "warn", "indeterminate"],
  ] as const)(
    "stop does NOT set done when the tree %s",
    async (_case, status, level, dirty) => {
      seedWorker("garden", "bold-ash", {
        agentStatus: "working",
        worktreePath: "/tmp/wt/garden/bold-ash",
      });
      setCwd("garden", "bold-ash");
      const fs = (await import("node:fs")).default;
      vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) =>
        String(p) === "/tmp/wt/garden/bold-ash/.garden-done");
      const { execFileSync } = await import("node:child_process");
      vi.mocked(execFileSync).mockImplementation((...args: unknown[]) => {
        const argv = gitSubcommandArgs(args[1] as string[] | undefined);
        if (argv?.[0] === "rev-list") return "0" as unknown as Buffer;
        if (argv?.[0] === "status") return status() as unknown as Buffer;
        return "" as unknown as Buffer;
      });

      handleClaudeHook("stop");

      const entry = entries.garden.find(e => e.name === "bold-ash")!;
      expect(entry.agentStatus).toBe("idle");
      expect(entry.prState).toBeUndefined();
      expect(entry.mergedAt).toBeUndefined();
      expect(log[level]).toHaveBeenCalledWith("hook", "stop hook skipped done (worktree not provably clean)", {
        worker: "bold-ash", data: { project: "garden", dirty },
      });
    },
  );

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
      const argv = gitSubcommandArgs(args[1] as string[] | undefined);
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
      const argv = gitSubcommandArgs(args[1] as string[] | undefined);
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
    // Counted against origin's branch by its full name: a same-named tag or
    // branch in the shared refs store would otherwise decide whether a review runs.
    const subcommands = vi.mocked(execFileSync).mock.calls.map(c => gitSubcommandArgs(c[1] as string[] | undefined));
    expect(subcommands).toContainEqual(["rev-list", "--count", "--end-of-options", "refs/remotes/origin/main..HEAD"]);
  });

  it("stop with commits ahead does not queue review when cleanliness is indeterminate", async () => {
    seedWorker("garden", "bold-ash", {
      agentStatus: "working",
      worktreePath: "/tmp/wt/garden/bold-ash",
    });
    setCwd("garden", "bold-ash");

    const { execFileSync } = await import("node:child_process");
    vi.mocked(execFileSync).mockImplementation((...args: unknown[]) => {
      const argv = gitSubcommandArgs(args[1] as string[] | undefined);
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
      const argv = gitSubcommandArgs(args[1] as string[] | undefined);
      if (argv?.[0] === "rev-list") return "1" as unknown as Buffer;
      if (argv?.[0] === "status") return "?? poetry.lock\n" as unknown as Buffer;
      return "" as unknown as Buffer;
    });

    handleClaudeHook("stop");

    const entry = entries.garden.find(e => e.name === "bold-ash")!;
    expect(entry.pendingReviewAt).toBeUndefined();
    expect(entry.reviewBlockedReason).toBe("dirty");
  });

  it("does not flag a dirty tree while the worker waits on its background tasks", async () => {
    // A worker that runs its checks in the background ends its turn with edits
    // uncommitted and commits when the result wakes it — mid-task, not stuck.
    seedWorker("garden", "bold-ash", {
      agentStatus: "working",
      worktreePath: "/tmp/wt/garden/bold-ash",
      backgroundTasks: { transcriptPath: "/tmp/t.jsonl", offset: 0, pending: ["b098jjyed"] },
    });
    setCwd("garden", "bold-ash");

    const { execFileSync } = await import("node:child_process");
    vi.mocked(execFileSync).mockImplementation((...args: unknown[]) => {
      const argv = gitSubcommandArgs(args[1] as string[] | undefined);
      if (argv?.[0] === "rev-list") return "1" as unknown as Buffer;
      if (argv?.[0] === "status") return " M src/a.ts\n" as unknown as Buffer;
      return "" as unknown as Buffer;
    });

    handleClaudeHook("stop");

    const entry = entries.garden.find(e => e.name === "bold-ash")!;
    expect(entry.pendingReviewAt).toBeUndefined();
    expect(entry.reviewBlockedReason).toBeUndefined();
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
      const argv = gitSubcommandArgs(args[1] as string[] | undefined);
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
      const argv = gitSubcommandArgs(args[1] as string[] | undefined);
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
      const argv = gitSubcommandArgs(args[1] as string[] | undefined);
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
      const argv = gitSubcommandArgs(args[1] as string[] | undefined);
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

// Hooks reach a worker by cwd alone, and other sessions fire them from its
// worktree. Codex runs a `/side` conversation as its own thread inside the
// worker's process, with its own session id: on burnt-mild-reed (2026-09-22)
// the side thread's start, prompt and Stop moved the worker to ready, working
// and idle while its own thread sat mid-turn, and tight-shrewd-drift
// (2026-09-17) showed the same with a `startup` source.
describe("handleClaudeHook — events from another session in the worktree", () => {
  async function fire(event: string, input: Record<string, unknown>) {
    const fs = (await import("node:fs")).default;
    vi.mocked(fs.readFileSync).mockReturnValueOnce(JSON.stringify(input));
    handleClaudeHook(event);
  }

  function worker() {
    return entries.garden.find(e => e.name === "bold-ash")!;
  }

  it("a side thread's Stop leaves the worker working and arms no review", async () => {
    seedWorker("garden", "bold-ash", {
      agentStatus: "working", sessionId: "main-thread", worktreePath: "/tmp/wt/garden/bold-ash",
    });
    setCwd("garden", "bold-ash");
    const { execFileSync } = await import("node:child_process");
    vi.mocked(execFileSync).mockImplementation((...args: unknown[]) => {
      const argv = gitSubcommandArgs(args[1] as string[] | undefined);
      if (argv?.[0] === "rev-list") return "1" as unknown as Buffer;
      return "" as unknown as Buffer;
    });

    await fire("stop", { session_id: "side-thread", hook_event_name: "Stop" });

    expect(worker().agentStatus).toBe("working");
    expect(worker().pendingReviewAt).toBeUndefined();
  });

  // A session naming a transcript of its own can be the pane's own
  // conversation after a switch whose start never arrived. Dropping its
  // events would freeze the row at its pre-switch status.
  it("takes a turn end from a session that names its own transcript, even unadopted", async () => {
    seedWorker("garden", "bold-ash", {
      agentStatus: "working", sessionId: "old-session", worktreePath: "/tmp/wt/garden/bold-ash",
    });
    setCwd("garden", "bold-ash");

    await fire("stop", {
      session_id: "new-session", transcript_path: "/p/new-session.jsonl", hook_event_name: "Stop",
    });

    expect(worker().agentStatus).toBe("idle");
  });

  it("a side thread's prompt keeps the worker's terminal state, gates and question", async () => {
    seedWorker("garden", "bold-ash", {
      agentStatus: "idle",
      sessionId: "main-thread",
      prState: "done",
      worktreePath: "/tmp/wt/garden/bold-ash",
      blockedQuestion: "Ship it?",
      blockedAt: 123,
      continueSentAt: 456,
    });
    setCwd("garden", "bold-ash");
    const fs = (await import("node:fs")).default;
    vi.mocked(fs.existsSync).mockReturnValue(false);

    await fire("prompt", { session_id: "side-thread", prompt: "Why is this so slow?" });

    expect(worker().agentStatus).toBe("idle");
    expect(worker().prState).toBe("done");
    expect(worker().blockedQuestion).toBe("Ship it?");
    expect(worker().continueSentAt).toBe(456);
    expect(fs.unlinkSync).not.toHaveBeenCalled();
  });

  // Codex 0.163 relays a spawned subagent's task message as UserPromptSubmit
  // carrying agent_id and the root session's id.
  it("a subagent's prompt is not the operator's", async () => {
    seedWorker("garden", "bold-ash", { agentStatus: "idle", sessionId: "main-thread", prState: "merged" });
    setCwd("garden", "bold-ash");

    await fire("prompt", { session_id: "main-thread", agent_id: "agent-1", prompt: "audit the fixtures" });

    expect(worker().agentStatus).toBe("idle");
    expect(worker().prState).toBe("merged");
  });

  // A side thread is ephemeral, so no transcript is named for it; and a
  // compaction is a session continuing, never the pane switching to it.
  it.each([
    ["fork", null],
    ["startup", null],
    ["fork", "/s/rollout-2026-09-21T14-28-31-main-thread.jsonl"],
    ["compact", "/p/side-thread.jsonl"],
  ])("a side thread's %s session start never returns the worker to ready (transcript %s)",
    async (source, transcript) => {
      seedWorker("garden", "bold-ash", { agentStatus: "working", sessionId: "main-thread" });
      setCwd("garden", "bold-ash");

      await fire("sessionstart", { session_id: "side-thread", source, transcript_path: transcript });

      expect(worker().agentStatus).toBe("working");
      expect(worker().sessionId).toBe("main-thread");
    });

  it("a side thread's tool call reads as background work, not the worker resuming", async () => {
    seedWorker("garden", "bold-ash", { agentStatus: "idle", sessionId: "main-thread" });
    setCwd("garden", "bold-ash");

    await fire("posttooluse", { session_id: "side-thread", tool_name: "Read" });

    expect(worker().agentStatus).toBe("idle");
    expect(typeof worker().subagentActivityAt).toBe("number");
  });

  it("a side thread's permission request does not flag the worker as asking", async () => {
    seedWorker("garden", "bold-ash", { agentStatus: "working", sessionId: "main-thread" });
    setCwd("garden", "bold-ash");

    await fire("pretooluse", { session_id: "side-thread", hook_event_name: "PermissionRequest", tool_name: "Bash" });

    expect(worker().agentStatus).toBe("working");
  });

  // The pane's own conversation can change under it: `/clear` and `/resume`,
  // and Claude Code's `/branch` (which starts the branch with a `fork` source),
  // switch it in place. Every later event carries the new id, so a start that
  // reports a transcript named for it is adopted.
  it.each([
    ["clear", "/p/new-session.jsonl", "ready"],
    ["fork", "/p/new-session.jsonl", undefined],
    ["resume", "/s/rollout-2026-10-01T10-00-00-new-session.jsonl", "idle"],
  ])("adopts the session the pane switched to with a %s start", async (source, transcript, status) => {
    seedWorker("garden", "bold-ash", {
      agentStatus: "idle", sessionId: "old-session", transcriptPath: "/p/old-session.jsonl",
    });
    setCwd("garden", "bold-ash");

    await fire("sessionstart", { session_id: "new-session", source, transcript_path: transcript });

    expect(worker().sessionId).toBe("new-session");
    expect(worker().transcriptPath).toBe(transcript);
    if (status) expect(worker().agentStatus).toBe(status);

    await fire("prompt", { session_id: "new-session" });
    expect(worker().agentStatus).toBe("working");
  });

  // A resume start preserves agentStatus, and a Codex worker writes no
  // background-task baseline, so nothing else lifts the heartbeat throttle.
  it("adopts a Codex /resume switch that lands inside the heartbeat window", async () => {
    seedWorker("garden", "bold-ash", {
      harness: "codex",
      task: "D1 SOXS historical fault analysis",
      agentStatus: "idle",
      sessionId: "old-thread",
      lastEventAt: Date.now(),
    });
    setCwd("garden", "bold-ash");
    const transcript = "/s/rollout-2026-10-01T10-00-00-new-thread.jsonl";

    await fire("sessionstart", { session_id: "new-thread", source: "resume", transcript_path: transcript });

    expect(worker().sessionId).toBe("new-thread");
    expect(worker().transcriptPath).toBe(transcript);
  });
});

// Claude Code builds every tool-scoped hook input from the calling thread's
// context, so a subagent's PermissionRequest carries its agent_id (verified on
// 2.1.310). Its dialog blocks the operator while the main thread may sit idle,
// firing nothing, and no hook reports a denied or expired request: on
// garden/long-grave-core (2026-10-24) a background agent's unanswered rm prompt
// was denied after 2 minutes and the row read `asking` for 41.
describe("handleClaudeHook — a subagent's dialog over the main thread", () => {
  async function fire(event: string, input: Record<string, unknown>) {
    const fs = (await import("node:fs")).default;
    vi.mocked(fs.readFileSync).mockReturnValueOnce(JSON.stringify({ session_id: "main-thread", ...input }));
    handleClaudeHook(event);
  }

  const permission = (agent?: string) =>
    ({ hook_event_name: "PermissionRequest", tool_name: "Bash", ...(agent && { agent_id: agent }) });
  const toolDone = (agent?: string, hook_event_name = "PostToolUse") =>
    ({ hook_event_name, tool_name: "Read", ...(agent && { agent_id: agent }) });

  function worker() {
    return entries.garden.find(e => e.name === "bold-ash")!;
  }

  function seed(agentStatus: "idle" | "working") {
    seedWorker("garden", "bold-ash", { agentStatus, sessionId: "main-thread" });
    setCwd("garden", "bold-ash");
  }

  // Every read of the clock moves it on, so no two writes share a stamp (each
  // hook is its own process) and a stamp taken twice within one hook differs.
  let clock = 0;
  beforeEach(() => {
    clock = 1_792_820_167_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock++);
  });

  afterEach(() => {
    vi.mocked(Date.now).mockRestore();
  });

  it("raises asking over an idle main thread and records the agent", async () => {
    seed("idle");
    await fire("pretooluse", permission("agent-a"));
    expect(worker().agentStatus).toBe("asking");
    expect(worker().subagentAsk).toEqual({ agent: "agent-a", at: worker().lastStateChangeAt, resume: "idle" });
  });

  it.each(["PostToolUse", "PostToolUseFailure"])("that agent's next %s returns the worker to idle", async event => {
    seed("idle");
    await fire("pretooluse", permission("agent-a"));
    await fire("posttooluse", toolDone("agent-a", event));
    expect(worker().agentStatus).toBe("idle");
    expect(worker().subagentAsk).toBeUndefined();
  });

  it("returns the worker to working when the main thread was mid-turn", async () => {
    seed("working");
    await fire("pretooluse", permission("agent-a"));
    expect(worker().agentStatus).toBe("asking");
    await fire("posttooluse", toolDone("agent-a"));
    expect(worker().agentStatus).toBe("working");
  });

  it("another agent's tool event leaves the worker asking", async () => {
    seed("idle");
    await fire("pretooluse", permission("agent-a"));
    await fire("posttooluse", toolDone("agent-b"));
    expect(worker().agentStatus).toBe("asking");
    await fire("posttooluse", toolDone("agent-a"));
    expect(worker().agentStatus).toBe("idle");
  });

  it("the old agent's event does not end a later main-thread episode", async () => {
    seed("idle");
    await fire("pretooluse", permission("agent-a"));
    await fire("prompt", { prompt: "carry on" });
    await fire("pretooluse", { hook_event_name: "PreToolUse", tool_name: "AskUserQuestion" });
    expect(worker().agentStatus).toBe("asking");
    await fire("posttooluse", toolDone("agent-a"));
    expect(worker().agentStatus).toBe("asking");
  });

  // The second request lands inside the 10s heartbeat window, and a throttled
  // disowning write would leave the first agent able to end both dialogs.
  it.each([["the main thread", undefined], ["another subagent", "agent-b"]])(
    "a dialog from %s in the same episode means no one agent can end it",
    async (_label, second) => {
      seed("idle");
      await fire("pretooluse", permission("agent-a"));
      await fire("pretooluse", permission(second));
      expect(worker().subagentAsk).toMatchObject({ agent: "", resume: "idle" });
      await fire("posttooluse", toolDone("agent-a"));
      await fire("posttooluse", toolDone("agent-b"));
      // Another session's event carries no agent_id either.
      await fire("posttooluse", { ...toolDone(), session_id: "side-thread" });
      expect(worker().agentStatus).toBe("asking");
    },
  );

  it("watches the subagent's episode under the stamp it recorded", async () => {
    const { spawn } = await import("node:child_process");
    seed("idle");
    await fire("pretooluse", permission("agent-a"));
    const commands = vi.mocked(spawn).mock.calls.map(call => String((call[1] as string[])[1]));
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain(`dashboard _await-permission garden bold-ash ${worker().subagentAsk!.at}`);
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

  it("posttooluse reads the task from the worker's own window once the slot's recorded pane is gone", () => {
    // Dashboard state still names the worker in the right slot, but tmux no
    // longer has that pane; the worker runs in its own hidden window.
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
    vi.mocked(paneExists).mockReturnValueOnce(false);
    vi.mocked(windowExists).mockReturnValueOnce(true);
    vi.mocked(getFirstPaneId).mockReturnValueOnce("%12");
    vi.mocked(getPaneTitle).mockImplementationOnce(id => id === "%12" ? "Investigate blank task summaries" : "");

    handleClaudeHook("posttooluse");

    expect(entries.garden[0].task).toBe("Investigate blank task summaries");
    expect(getPaneTitle).not.toHaveBeenCalledWith("%5");
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

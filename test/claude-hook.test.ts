import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

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

vi.mock("../src/commands/status.js", () => ({
  renderQuickStatus: vi.fn(() => ""),
}));

import { handleClaudeHook } from "../src/dashboard/header.js";
import { updateWorkerFields } from "../src/dashboard/registry.js";
import { log } from "../src/dashboard/log.js";

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

describe("handleClaudeHook — mid-turn idle", () => {
  it("notification sets idle when worker is working", () => {
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
      expect.objectContaining({ claudeStatus: "idle" }),
    );
  });

  it("pretooluse sets idle when worker is working", () => {
    seedWorker("garden", "bold-ash", { claudeStatus: "working" });
    setCwd("garden", "bold-ash");

    handleClaudeHook("pretooluse");

    expect(updateWorkerFields).toHaveBeenCalledWith(
      "garden", "bold-ash",
      expect.objectContaining({ claudeStatus: "idle" }),
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
      "hook", "mid-turn idle hook skipped (not working)",
      expect.anything(),
    );
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

  it("posttooluse sets working when worker is idle", () => {
    seedWorker("garden", "bold-ash", { claudeStatus: "idle" });
    setCwd("garden", "bold-ash");

    handleClaudeHook("posttooluse");

    expect(updateWorkerFields).toHaveBeenCalledWith(
      "garden", "bold-ash",
      expect.objectContaining({ claudeStatus: "working" }),
    );
  });

  it("posttooluse skips when worker is not idle", () => {
    seedWorker("garden", "bold-ash", { claudeStatus: "working" });
    setCwd("garden", "bold-ash");

    handleClaudeHook("posttooluse");

    // Should not overwrite working with working — the guard prevents transition
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

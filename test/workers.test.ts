import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mocks ---

vi.mock("node:crypto", () => ({
  default: { randomUUID: vi.fn(() => "fake-uuid-1234") },
  randomUUID: vi.fn(() => "fake-lock-uuid"),
  createHash: vi.fn(() => {
    const hash = {
      update: vi.fn(() => hash),
      digest: vi.fn(() => "A1B2C3D4E5F6"),
    };
    return hash;
  }),
}));

vi.mock("node:fs", () => ({
  default: {
    readFileSync: vi.fn(() => { throw new Error("ENOENT"); }),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    unlinkSync: vi.fn(),
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    constants: { O_CREAT: 0, O_EXCL: 0, O_WRONLY: 0 },
  },
}));

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}));

vi.mock("../src/session.js", () => ({
  DASHBOARD_SESSION: "garden-dashboard",
  dashboardExists: vi.fn(() => false),
}));

vi.mock("../src/config.js", () => {
  const tryResolveProvider = vi.fn(() => null);
  const loadConfig = vi.fn(() => ({ projects: {}, plots: {} }));
  return {
    logColorKeyForProject: vi.fn(() => null),
    getProject: vi.fn(() => ({ name: "myproject", path: "/repo/myproject" })),
    tryGetProject: vi.fn(() => ({ name: "myproject", path: "/repo/myproject" })),
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
    ENV_VAR_NAME_RE: /^[A-Z_][A-Z0-9_]*$/,
    loadConfig,
    plotsMap: vi.fn(() => ({})),
    SESSIONS_DIR: "/tmp/fake-sessions",
  };
});

vi.mock("../src/dashboard/navigate.js", () => ({
  swapVisibleToProject: vi.fn(),
}));

vi.mock("../src/dashboard/state.js", () => ({
  readDashState: vi.fn(),
  writeDashState: vi.fn(),
  withStateLock: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock("../src/dashboard/layout.js", () => ({
  parkToHidden: vi.fn(),
  restoreFromHidden: vi.fn(),
}));

vi.mock("../src/dashboard/header.js", () => ({
  refreshDashboard: vi.fn(),
  setPaneProjectColor: vi.fn(),
}));

vi.mock("../src/dashboard/tmux.js", () => ({
  tmux: vi.fn(),
  tmuxWithHiddenEnvironment: vi.fn(),
  tmuxDisplay: vi.fn(),
  newDashboardWindowPaned: vi.fn(() => "%10"),
  setPaneLabel: vi.fn(),
  setPaneVar: vi.fn(),
  shellEscape: vi.fn((s: string) => `'${s}'`),
  getFirstPaneId: vi.fn(() => "%20"),
  paneExists: vi.fn(() => true),
  windowExists: vi.fn(() => true),
  listHiddenWorkerWindows: vi.fn(() => []),
  killWindowSafe: vi.fn(),
  getPaneSize: vi.fn(() => ({ width: 120, height: 50 })),
  resizeWindow: vi.fn(),
}));

vi.mock("../src/dashboard/names.js", () => ({
  generateWorkerName: vi.fn(() => "bold-ash"),
}));

vi.mock("../src/dashboard/registry.js", async (importActual) => {
  // Spread the real module so pure sort helpers (compareWorkerFreshness et al.,
  // used by killPane's replacement-window selection) stay live; only the
  // stateful accessors below are faked.
  const actual = await importActual<typeof import("../src/dashboard/registry.js")>();
  const addWorker = vi.fn();
  const getAllWorkerNames = vi.fn((): string[] => []);
  return {
    ...actual,
    addWorker,
    addWorkerWithUniqueName: vi.fn((project: string, createEntry: (names: string[]) => unknown) => {
      const entry = createEntry(getAllWorkerNames());
      addWorker(project, entry);
      return entry;
    }),
    removeWorker: vi.fn(),
    findWorkerByName: vi.fn(() => null),
    getAllWorkerNames,
    getWorkers: vi.fn(() => []),
    updateWorkerFields: vi.fn(),
    // Pure status helper — use the real logic so bounce's resume-status routing
    // (working → "ready" sentinel, else "idle") is genuinely exercised. Mirrors
    // registry.ts: the paused/asking hold check comes FIRST so an owed interrupt
    // flag on a held worker can't route it to "ready" (and auto-continue).
    resolveResumeAgentStatus: (entry: { agentStatus?: string; interruptedWhileWorking?: boolean }) =>
      entry.agentStatus === "paused" || entry.agentStatus === "asking"
        ? entry.agentStatus
        : entry.interruptedWhileWorking === true || entry.agentStatus === "working"
          ? "ready"
          : "idle",
  };
});

vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/dashboard/create.js", () => ({
  buildWorktreeBootstrapScript: vi.fn(() => "/tmp/fake-bootstrap.sh"),
  buildWorktreeResumeCommand: vi.fn(() => "claude --resume FAKE-ID"),
  buildResumeCommand: vi.fn(() => "claude --resume FAKE-ID-NW"),
  buildWorktreeContextText: vi.fn(() => "rules"),
  createShellWindow: vi.fn(),
  trellisRelativePathForEntry: vi.fn(() => undefined),
  // Pure helper — use the real semantics so the provider view bounce installs
  // its runtime config under is genuinely exercised ("" clears, absent inherits).
  workerProject: (project: { provider?: string }, provider: string | undefined) =>
    provider === undefined ? project : { ...project, provider: provider || undefined },
}));

vi.mock("../src/dashboard/harness/index.js", () => {
  // One stable adapter object so assertions can reach the same mocks the
  // code under test called, regardless of which getHarness() call made them.
  const adapter = {
    name: "claude-code",
    allocateSessionId: vi.fn(() => "fake-uuid-1234"),
    installRuntimeConfig: vi.fn(),
  };
  return { getHarness: vi.fn(() => adapter), DEFAULT_HARNESS: "claude-code" };
});

vi.mock("../src/dashboard/runner.js", () => ({
  resolveGardenRunner: vi.fn(() => "garden"),
}));

vi.mock("../src/dashboard/git.js", () => ({
  worktreePath: vi.fn(() => "/home/user/.garden/worktrees/myproject/bold-ash"),
  resolveBaseBranch: vi.fn(() => "main"),
  resolveSpawnBase: vi.fn((_project: unknown, override?: string) => override ?? "main"),
  branchExistsOnOrigin: vi.fn(() => true),
  tryPublishBranch: vi.fn(() => ({ ok: true })),
  gardenDoneTrackedInHead: vi.fn(() => false),
  getRemoteTrackingSha: vi.fn(() => "basesha1234"),
  workerCleanupMarkerPath: vi.fn(() => "/tmp/fake-sessions/worker-cleanup-myproject-swift-oak"),
}));

vi.mock("../src/dashboard/alerts.js", () => ({
  addAlert: vi.fn(),
}));

vi.mock("../src/dashboard/poller.js", () => ({
  ensureProjectPoller: vi.fn(),
  killReviewWindow: vi.fn(),
  stopProjectPoller: vi.fn(),
}));

// Capture the worker.created snapshot payload; the real telemetry writes JSONL
// to disk (best-effort), which we don't want in unit tests.
vi.mock("../src/dashboard/telemetry.js", () => ({
  recordWorkerCreated: vi.fn(),
  recordOperatorAction: vi.fn(),
  recordWorkerRemoved: vi.fn(),
  shortHash: vi.fn(() => "rulesHash"),
}));

// buildRulesContext reads global+project rules off disk; stub it so the
// snapshot block doesn't throw under the mocked fs (which ENOENTs every read).
vi.mock("../src/rules.js", () => ({
  buildRulesContext: vi.fn(() => "rules"),
}));

// --- Imports (after mocks) ---

import {
  newWorker, killPane, bounceWorker, bounceActiveWorker,
  decideHold, holdWorker, releaseWorker, holdActiveWorker,
} from "../src/dashboard/workers.js";
import { readDashState, writeDashState, withStateLock } from "../src/dashboard/state.js";
import { parkToHidden, restoreFromHidden } from "../src/dashboard/layout.js";
import { refreshDashboard } from "../src/dashboard/header.js";
import {
  tmux, tmuxDisplay, newDashboardWindowPaned, setPaneLabel, setPaneVar,
  getFirstPaneId, paneExists, windowExists,
  listHiddenWorkerWindows, killWindowSafe,
  getPaneSize, resizeWindow,
} from "../src/dashboard/tmux.js";
import { generateWorkerName } from "../src/dashboard/names.js";
import {
  addWorker, removeWorker, findWorkerByName, getAllWorkerNames, getWorkers,
  updateWorkerFields,
} from "../src/dashboard/registry.js";
import {
  buildWorktreeBootstrapScript, buildWorktreeResumeCommand, buildResumeCommand,
  createShellWindow,
} from "../src/dashboard/create.js";
import { getHarness } from "../src/dashboard/harness/index.js";
import { resolveGardenRunner } from "../src/dashboard/runner.js";
import {
  worktreePath, resolveBaseBranch, resolveSpawnBase, branchExistsOnOrigin, tryPublishBranch,
  gardenDoneTrackedInHead,
} from "../src/dashboard/git.js";
import { addAlert } from "../src/dashboard/alerts.js";
import { recordWorkerCreated, recordWorkerRemoved } from "../src/dashboard/telemetry.js";
import { ensureProjectPoller, killReviewWindow, stopProjectPoller } from "../src/dashboard/poller.js";
import { workerWindowName as workerWin, shellWindowName as shellWin, parseWorkerSuffix } from "../src/dashboard/window-names.js";
import { getProject, tryGetProject, tryResolveProvider, loadConfig } from "../src/config.js";
import { spawn } from "node:child_process";
import fs from "node:fs";
import crypto from "node:crypto";
import type { DashboardState } from "../src/dashboard/state.js";
import { dashboardExists } from "../src/session.js";

function makeState(overrides: Partial<DashboardState> = {}): DashboardState {
  return {
    activeProject: "myproject",
    statusPaneId: "%0",
    gardenShellPaneId: "%1",
    gardenPaneType: "growhouse",
    gardenWindowName: "_garden-growhouse",
    activePaneId: "%2",
    activePaneType: "worker",
    activeWindowName: "_myproject-worker-swift-oak",
    lastActiveWorker: {},
    lastActiveProjectByPlot: {},
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Reset default mock return values
  vi.mocked(paneExists).mockReturnValue(true);
  vi.mocked(windowExists).mockReturnValue(true);
  vi.mocked(newDashboardWindowPaned).mockReturnValue("%10");
  vi.mocked(getFirstPaneId).mockReturnValue("%20");
  vi.mocked(listHiddenWorkerWindows).mockReturnValue([]);
  vi.mocked(getWorkers).mockReturnValue([]);
  vi.mocked(findWorkerByName).mockReturnValue(null);
  vi.mocked(getPaneSize).mockReturnValue({ width: 120, height: 50 });
  vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error("ENOENT"); });
  vi.mocked(tryGetProject).mockReset().mockReturnValue({ name: "myproject", path: "/repo/myproject" });
  vi.mocked(tryResolveProvider).mockReset().mockReturnValue(null);
  vi.mocked(dashboardExists).mockReturnValue(false);
  delete process.env.GARDEN_TEST_PROVIDER_KEY;
  // clearAllMocks clears calls but not implementations, so a test that stubs a
  // stored-crew config would otherwise leak it into every later test.
  vi.mocked(loadConfig).mockReturnValue({ projects: {}, plots: {} } as ReturnType<typeof loadConfig>);
});

// =============================================================================
// newWorker
// =============================================================================

describe("newWorker", () => {
  it("shows error when no active project", () => {
    vi.mocked(readDashState).mockReturnValue(makeState({ activeProject: null }));
    newWorker();
    expect(vi.mocked(tmuxDisplay)).toHaveBeenCalledWith(
      "No project selected. Use ⌥1-⌥9 first.",
    );
    expect(vi.mocked(addWorker)).not.toHaveBeenCalled();
  });

  it("generates a worker name excluding existing names", () => {
    vi.mocked(readDashState).mockReturnValue(makeState());
    vi.mocked(getAllWorkerNames).mockReturnValue(["swift-oak"]);
    newWorker();
    expect(vi.mocked(generateWorkerName)).toHaveBeenCalledWith(["swift-oak"]);
  });

  it("builds a bootstrap script with correct parameters", () => {
    vi.mocked(readDashState).mockReturnValue(makeState());
    newWorker();
    expect(vi.mocked(buildWorktreeBootstrapScript)).toHaveBeenCalledWith(
      "myproject",
      "/repo/myproject",
      "bold-ash",
      "bold-ash",
      "fake-uuid-1234",
      "/home/user/.garden/worktrees/myproject/bold-ash",
      "main",
      {
        launchPlan: expect.objectContaining({
          role: "worker",
          harness: "claude-code",
          executionPolicy: "sandboxed-worker",
        }),
      },
    );
  });

  it("parks current pane before creating new window", () => {
    const state = makeState({ activeWindowName: "_myproject-worker-swift-oak" });
    vi.mocked(readDashState).mockReturnValue(state);
    newWorker();
    expect(vi.mocked(parkToHidden)).toHaveBeenCalledWith(
      "_myproject-worker-swift-oak",
      state,
    );
  });

  it("uses parking window name when activeWindowName is null", () => {
    const state = makeState({ activeWindowName: null });
    vi.mocked(readDashState).mockReturnValue(state);
    newWorker();
    expect(vi.mocked(parkToHidden)).toHaveBeenCalledWith(
      "_myproject-active",
      state,
    );
  });

  it("creates worker window with sleep placeholder then respawns bootstrap script", () => {
    vi.mocked(readDashState).mockReturnValue(makeState());
    newWorker();
    expect(vi.mocked(newDashboardWindowPaned)).toHaveBeenCalledWith(
      "_myproject-worker-bold-ash",
      "-c", "/repo/myproject",
      "sh", "-c", "exec sleep 86400",
    );
    expect(vi.mocked(tmux)).toHaveBeenCalledWith(
      "respawn-pane", "-k", "-c", "/repo/myproject", "-t", "%10",
      "sh", "-c", expect.stringContaining("/tmp/fake-bootstrap.sh"),
    );
  });

  it("pre-sizes new window to match active pane dimensions", () => {
    const state = makeState();
    vi.mocked(readDashState).mockReturnValue(state);
    newWorker();
    expect(vi.mocked(getPaneSize)).toHaveBeenCalledWith("%2");
    expect(vi.mocked(resizeWindow)).toHaveBeenCalledWith(
      "_myproject-worker-bold-ash", 120, 50,
    );
  });

  it("skips resize when activePaneId is null", () => {
    const state = makeState({ activePaneId: null });
    vi.mocked(readDashState).mockReturnValue(state);
    newWorker();
    expect(vi.mocked(resizeWindow)).not.toHaveBeenCalled();
  });

  it("sets pane label on new pane and restores into slot", () => {
    vi.mocked(readDashState).mockReturnValue(makeState());
    newWorker();
    expect(vi.mocked(setPaneLabel)).toHaveBeenCalledWith("%10", "bold-ash");
    expect(vi.mocked(restoreFromHidden)).toHaveBeenCalled();
  });

  it("re-applies pane label after restore", () => {
    const state = makeState();
    vi.mocked(readDashState).mockReturnValue(state);
    newWorker();
    // Should call setPaneLabel twice: once on the new pane, once on activePaneId after swap
    const calls = vi.mocked(setPaneLabel).mock.calls;
    expect(calls.length).toBe(2);
    expect(calls[1]).toEqual(["%2", "bold-ash"]);
    // The now-visible worker pane gets a wall clock in its border.
    expect(vi.mocked(setPaneVar)).toHaveBeenCalledWith("%2", "garden_clock", "1");
  });

  it("adds worker to registry with correct fields", () => {
    vi.mocked(readDashState).mockReturnValue(makeState());
    newWorker();
    expect(vi.mocked(addWorker)).toHaveBeenCalledWith("myproject", {
      name: "bold-ash",
      sessionId: "fake-uuid-1234",
      task: "",
      worktreePath: "/home/user/.garden/worktrees/myproject/bold-ash",
      branchName: "bold-ash",
      baseBranch: "main",
      // origin/<base> tip captured at creation — the cumulative-diff baseline
      // a later holistic review uses.
      baseBranchSha: "basesha1234",
      agentStatus: "loading",
      createdAt: expect.any(Number),
      workflow: "default",
    });
  });

  it("pins a --base override onto entry.baseBranch via resolveSpawnBase", () => {
    vi.mocked(readDashState).mockReturnValue(makeState());
    newWorker({ base: "release" });
    expect(vi.mocked(resolveSpawnBase)).toHaveBeenCalledWith(expect.anything(), "release");
    expect(vi.mocked(addWorker)).toHaveBeenCalledWith(
      "myproject",
      expect.objectContaining({ baseBranch: "release" }),
    );
  });

  it("stamps the handoff request id for crash-safe dispatch reconciliation", () => {
    vi.mocked(readDashState).mockReturnValue(makeState());
    newWorker({ handoffRequestId: "00000000-0000-4000-8000-000000000000" });
    expect(vi.mocked(addWorker)).toHaveBeenCalledWith(
      "myproject",
      expect.objectContaining({
        handoffRequestId: "00000000-0000-4000-8000-000000000000",
      }),
    );
  });

  it("raises a project-scoped alert when .garden-done is tracked in HEAD", () => {
    vi.mocked(readDashState).mockReturnValue(makeState());
    vi.mocked(gardenDoneTrackedInHead).mockReturnValue(true);
    newWorker();
    expect(vi.mocked(addAlert)).toHaveBeenCalledWith(expect.objectContaining({
      level: "warn",
      source: "create",
      project: "myproject",
      message: expect.stringContaining("`.garden-done` is tracked in HEAD of myproject"),
      // Stable key per project so 10 worker spawns into the same broken
      // project don't generate 10 alerts.
      dedupKey: "garden-done-tracked:myproject",
    }));
  });

  it("does NOT raise the .garden-done alert when the sentinel is not tracked", () => {
    vi.mocked(readDashState).mockReturnValue(makeState());
    vi.mocked(gardenDoneTrackedInHead).mockReturnValue(false);
    newWorker();
    const sentinelAlerts = vi.mocked(addAlert).mock.calls.filter(
      c => (c[0] as { dedupKey?: string }).dedupKey?.startsWith("garden-done-tracked:"),
    );
    expect(sentinelAlerts).toHaveLength(0);
  });

  it("starts the project poller", () => {
    vi.mocked(readDashState).mockReturnValue(makeState());
    newWorker();
    expect(vi.mocked(ensureProjectPoller)).toHaveBeenCalledWith("myproject", "garden");
  });

  it("updates state with new worker info and writes", () => {
    const state = makeState();
    vi.mocked(readDashState).mockReturnValue(state);
    newWorker();
    expect(vi.mocked(writeDashState)).toHaveBeenCalled();
    const written = vi.mocked(writeDashState).mock.calls[0][0];
    expect(written.activePaneType).toBe("worker");
    expect(written.activeWindowName).toBe("_myproject-worker-bold-ash");
    expect(written.lastActiveWorker["myproject"]).toBe("_myproject-worker-bold-ash");
  });

  it("refreshes dashboard after creation", () => {
    vi.mocked(readDashState).mockReturnValue(makeState());
    newWorker();
    expect(vi.mocked(refreshDashboard)).toHaveBeenCalledWith({ state: expect.any(Object) });
  });

  it("auto-publishes base branch and proceeds when origin ref is missing", () => {
    // Operator switched the main checkout to a brand-new local branch and
    // pressed ⌥n. Garden pushes it for them rather than refusing.
    vi.mocked(readDashState).mockReturnValue(makeState());
    vi.mocked(branchExistsOnOrigin).mockReturnValueOnce(false);
    vi.mocked(tryPublishBranch).mockReturnValueOnce({ ok: true });
    newWorker();
    expect(vi.mocked(tryPublishBranch)).toHaveBeenCalledWith("/repo/myproject", "main");
    expect(vi.mocked(addWorker)).toHaveBeenCalled();
    const msgs = vi.mocked(tmuxDisplay).mock.calls.map((c) => c[0] as string);
    expect(msgs.some((m) => m.includes("Published 'main' to origin"))).toBe(true);
  });

  it("publishes a missing base branch before entering the dashboard state lock", () => {
    vi.mocked(readDashState).mockReturnValue(makeState());
    vi.mocked(branchExistsOnOrigin).mockReturnValueOnce(false);
    newWorker();

    expect(vi.mocked(tryPublishBranch)).toHaveBeenCalled();
    expect(vi.mocked(withStateLock)).toHaveBeenCalled();
    expect(vi.mocked(tryPublishBranch).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(withStateLock).mock.invocationCallOrder[0]);
  });

  it("rejects creation when auto-publish fails, surfacing the git error", () => {
    vi.mocked(readDashState).mockReturnValue(makeState());
    vi.mocked(branchExistsOnOrigin).mockReturnValueOnce(false);
    vi.mocked(tryPublishBranch).mockReturnValueOnce({
      ok: false,
      error: "fatal: 'origin' does not appear to be a git repository",
    });
    newWorker();
    expect(vi.mocked(addWorker)).not.toHaveBeenCalled();
    const msgs = vi.mocked(tmuxDisplay).mock.calls.map((c) => c[0] as string);
    const errMsg = msgs.find((m) => m.includes("couldn't publish"));
    expect(errMsg).toBeDefined();
    expect(errMsg).toContain("main");
    expect(errMsg).toContain("does not appear to be a git repository");
  });

  // ===== Handoff path: opts.projectName + opts.seedMessageFile + background =====
  // Handoff creates the worker in a hidden window and explicitly does NOT
  // disturb the operator's visible pane: no cross-project switch, no
  // park/restore, no mutation of activePaneType/activeWindowName. The seed
  // dispatch still fires so the new worker receives its briefing.

  it("handoff path: targets opts.projectName instead of activeProject", () => {
    vi.mocked(readDashState).mockReturnValue(makeState({ activeProject: "myproject" }));
    vi.mocked(tryGetProject).mockReturnValueOnce({ name: "other", path: "/repo/other" });
    const name = newWorker({ projectName: "other", seedMessageFile: "/tmp/seed.txt", background: true });
    expect(name).toBe("bold-ash");
    expect(vi.mocked(addWorker)).toHaveBeenCalledWith("other", expect.any(Object));
    expect(vi.mocked(ensureProjectPoller)).toHaveBeenCalledWith("other", "garden");
  });

  it("background handoff does NOT call swapVisibleToProject (cross-project)", async () => {
    const { swapVisibleToProject } = await import("../src/dashboard/navigate.js");
    vi.mocked(readDashState).mockReturnValue(makeState({ activeProject: "myproject" }));
    vi.mocked(tryGetProject).mockReturnValueOnce({ name: "other", path: "/repo/other" });
    newWorker({ projectName: "other", seedMessageFile: "/tmp/seed.txt", background: true });
    expect(vi.mocked(swapVisibleToProject)).not.toHaveBeenCalled();
  });

  it("background handoff does not acquire the dashboard state lock", () => {
    vi.mocked(readDashState).mockReturnValue(makeState({ activeProject: "myproject" }));
    vi.mocked(tryGetProject).mockReturnValueOnce({ name: "other", path: "/repo/other" });
    newWorker({ projectName: "other", seedMessageFile: "/tmp/seed.txt", background: true });
    expect(vi.mocked(withStateLock)).not.toHaveBeenCalled();
  });

  it("background handoff does NOT park or restore the visible pane", () => {
    vi.mocked(readDashState).mockReturnValue(makeState({ activeProject: "myproject" }));
    vi.mocked(tryGetProject).mockReturnValueOnce({ name: "other", path: "/repo/other" });
    newWorker({ projectName: "other", seedMessageFile: "/tmp/seed.txt", background: true });
    expect(vi.mocked(parkToHidden)).not.toHaveBeenCalled();
    expect(vi.mocked(restoreFromHidden)).not.toHaveBeenCalled();
  });

  it("background handoff still creates the hidden worker window and respawns bootstrap script", () => {
    vi.mocked(readDashState).mockReturnValue(makeState({ activeProject: "myproject" }));
    vi.mocked(tryGetProject).mockReturnValueOnce({ name: "other", path: "/repo/other" });
    newWorker({ projectName: "other", seedMessageFile: "/tmp/seed.txt", background: true });
    expect(vi.mocked(newDashboardWindowPaned)).toHaveBeenCalledWith(
      "_other-worker-bold-ash",
      "-c", "/repo/other",
      "sh", "-c", "exec sleep 86400",
    );
    expect(vi.mocked(tmux)).toHaveBeenCalledWith(
      "respawn-pane", "-k", "-c", "/repo/other", "-t", "%10",
      "sh", "-c", expect.stringContaining("/tmp/fake-bootstrap.sh"),
    );
  });

  it("background handoff does NOT mutate activePaneType / activeWindowName / lastActiveWorker", () => {
    const state = makeState({
      activeProject: "myproject",
      activePaneType: "worker",
      activeWindowName: "_myproject-worker-swift-oak",
      activePaneId: "%2",
    });
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(tryGetProject).mockReturnValueOnce({ name: "other", path: "/repo/other" });
    newWorker({ projectName: "other", seedMessageFile: "/tmp/seed.txt", background: true });
    // No state write at all — operator's pane focus is untouched.
    expect(vi.mocked(writeDashState)).not.toHaveBeenCalled();
    expect(state.activePaneType).toBe("worker");
    expect(state.activeWindowName).toBe("_myproject-worker-swift-oak");
    expect(state.activePaneId).toBe("%2");
    expect(state.lastActiveWorker["other"]).toBeUndefined();
  });

  it("background handoff: dispatches the delayed seed via spawn so the new worker gets the briefing", () => {
    vi.mocked(readDashState).mockReturnValue(makeState({ activeProject: "myproject" }));
    vi.mocked(tryGetProject).mockReturnValueOnce({ name: "other", path: "/repo/other" });
    newWorker({ projectName: "other", seedMessageFile: "/tmp/seed.txt", background: true });
    const seedCall = vi.mocked(spawn).mock.calls.find(c =>
      Array.isArray(c[1]) && (c[1] as string[])[1]?.includes("_seed-worker"),
    );
    expect(seedCall).toBeDefined();
    const cmd = (seedCall![1] as string[])[1];
    expect(cmd).toContain("'other'");
    expect(cmd).toContain("'bold-ash'");
    expect(cmd).toContain("'/tmp/seed.txt'");
  });

  it("rolls back the registry entry when newDashboardWindowPaned throws so a sandbox-blocked spawn doesn't leave a ghost", () => {
    vi.mocked(readDashState).mockReturnValue(makeState({ activeProject: "myproject" }));
    vi.mocked(tryGetProject).mockReturnValueOnce({ name: "other", path: "/repo/other" });
    vi.mocked(newDashboardWindowPaned).mockImplementationOnce(() => {
      throw new Error("tmux new-window failed: Operation not permitted");
    });
    expect(() =>
      newWorker({ projectName: "other", seedMessageFile: "/tmp/seed.txt", background: true }),
    ).toThrow(/Operation not permitted/);
    // addWorker ran first, removeWorker undoes it before the throw escapes.
    expect(vi.mocked(addWorker)).toHaveBeenCalled();
    expect(vi.mocked(removeWorker)).toHaveBeenCalledWith("other", "bold-ash");
  });

  it("background handoff: bails (returns null) when target project is unknown, without touching state", () => {
    vi.mocked(readDashState).mockReturnValue(makeState());
    vi.mocked(tryGetProject).mockReturnValueOnce(undefined);
    const name = newWorker({ projectName: "ghost", seedMessageFile: "/tmp/seed.txt", background: true });
    expect(name).toBeNull();
    expect(vi.mocked(addWorker)).not.toHaveBeenCalled();
    // No seed dispatch on bailout — handoff command will unlink the seed file.
    const seedCall = vi.mocked(spawn).mock.calls.find(c =>
      Array.isArray(c[1]) && (c[1] as string[])[1]?.includes("_seed-worker"),
    );
    expect(seedCall).toBeUndefined();
  });

  it("hotkey path (no opts): does NOT dispatch a seed", () => {
    vi.mocked(readDashState).mockReturnValue(makeState());
    newWorker();
    const seedCall = vi.mocked(spawn).mock.calls.find(c =>
      Array.isArray(c[1]) && (c[1] as string[])[1]?.includes("_seed-worker"),
    );
    expect(seedCall).toBeUndefined();
  });

  it("returns the generated worker name on success", () => {
    vi.mocked(readDashState).mockReturnValue(makeState());
    expect(newWorker()).toBe("bold-ash");
  });

  it("returns null when no project is selected", () => {
    vi.mocked(readDashState).mockReturnValue(makeState({ activeProject: null }));
    expect(newWorker()).toBeNull();
  });

  // ===== Grow workflow plant path =====
  // The workflow can currently be planted via the programmatic newWorker
  // API; the CLI surface is not yet wired. The grow opts must be present
  // when --workflow grow is selected; absence is a caller bug.

  it("grow workflow: rejects when opts.grow is missing", () => {
    vi.mocked(readDashState).mockReturnValue(makeState());
    newWorker({ workflow: "grow" });
    expect(vi.mocked(addWorker)).not.toHaveBeenCalled();
    expect(vi.mocked(tmuxDisplay)).toHaveBeenCalledWith(
      "--workflow grow requires the grow options to be set (caller bug).",
    );
  });

  it("grow workflow: stamps entry.grow with seed, iteration: 0, maxIterations", () => {
    vi.mocked(readDashState).mockReturnValue(makeState());
    newWorker({
      workflow: "grow",
      grow: { seed: "harden auth flow", maxIterations: 5 },
    });
    expect(vi.mocked(addWorker)).toHaveBeenCalledWith(
      "myproject",
      expect.objectContaining({
        workflow: "grow",
        grow: {
          seed: "harden auth flow",
          iteration: 0,
          maxIterations: 5,
        },
      }),
    );
  });

  // ===== Botanist designer seat (workflow-level model/effort default) =====
  // The botanist workflow declares workerModel: "opus" + workerEffort: "xhigh".
  // newWorker layers those beneath a per-spawn --model/--effort, exactly as it
  // layers project.model/effort for default/grow. This is the seam that makes
  // the workflow-level default load-bearing (it was inert before Phase 2).

  it("botanist: stamps the Opus/xhigh designer default from the workflow definition", () => {
    vi.mocked(readDashState).mockReturnValue(makeState());
    newWorker({ workflow: "botanist" });
    expect(vi.mocked(addWorker)).toHaveBeenCalledWith(
      "myproject",
      expect.objectContaining({
        workflow: "botanist",
        model: "opus",
        effort: "xhigh",
      }),
    );
  });

  it("botanist: an explicit --model / --effort overrides the workflow default", () => {
    vi.mocked(readDashState).mockReturnValue(makeState());
    newWorker({ workflow: "botanist", model: "sonnet", effort: "high" });
    expect(vi.mocked(addWorker)).toHaveBeenCalledWith(
      "myproject",
      expect.objectContaining({
        workflow: "botanist",
        model: "sonnet",
        effort: "high",
      }),
    );
  });

  // ===== Ultracode preset (garden handoff --ultracode) =====
  // newWorker translates opts.ultracode into two stamped fields: entry.model
  // pinned to Opus and entry.ultracode. These branches are the seam between
  // the dispatch layer (handoff-dispatch.test.ts) and the render layer
  // (harness.test.ts), so they are exercised here directly.

  it("ultracode: stamps entry.model=opus[1m] and entry.ultracode on a default worker", () => {
    vi.mocked(readDashState).mockReturnValue(makeState());
    newWorker({ ultracode: true });
    expect(vi.mocked(addWorker)).toHaveBeenCalledWith(
      "myproject",
      expect.objectContaining({
        workflow: "default",
        model: "opus[1m]",
        ultracode: true,
      }),
    );
  });

  it("ultracode: an explicit --model wins over the Opus default, ultracode still stamped", () => {
    vi.mocked(readDashState).mockReturnValue(makeState());
    newWorker({ ultracode: true, model: "sonnet" });
    expect(vi.mocked(addWorker)).toHaveBeenCalledWith(
      "myproject",
      expect.objectContaining({
        model: "sonnet",
        ultracode: true,
      }),
    );
  });

  it("plain worker: neither model nor ultracode is stamped", () => {
    vi.mocked(readDashState).mockReturnValue(makeState());
    newWorker();
    const entry = vi.mocked(addWorker).mock.calls[0][1] as Record<string, unknown>;
    expect(entry.ultracode).toBeUndefined();
    expect(entry.model).toBeUndefined();
    expect(entry.effort).toBeUndefined();
  });

  // ===== Effort rung (composer effort dim / workers new --effort) =====

  it("effort: stamps entry.effort alongside a model pin on a default worker", () => {
    vi.mocked(readDashState).mockReturnValue(makeState());
    newWorker({ model: "sonnet", effort: "xhigh" });
    expect(vi.mocked(addWorker)).toHaveBeenCalledWith(
      "myproject",
      expect.objectContaining({ model: "sonnet", effort: "xhigh" }),
    );
  });

  it("effort: stamped on a grow worker (default-adjacent)", () => {
    vi.mocked(readDashState).mockReturnValue(makeState());
    newWorker({ workflow: "grow", grow: { seed: "harden", maxIterations: 3 }, effort: "high" });
    const entry = vi.mocked(addWorker).mock.calls[0][1] as Record<string, unknown>;
    expect(entry.effort).toBe("high");
  });

  it("effort: suppressed when ultracode is set (ultracode already fixes max effort)", () => {
    vi.mocked(readDashState).mockReturnValue(makeState());
    newWorker({ ultracode: true, effort: "high" });
    const entry = vi.mocked(addWorker).mock.calls[0][1] as Record<string, unknown>;
    expect(entry.ultracode).toBe(true);
    expect(entry.effort).toBeUndefined();
  });

  it("effort: ignored for trellis vines (they resolve their own model per iteration)", () => {
    vi.mocked(readDashState).mockReturnValue(makeState());
    newWorker({
      workflow: "trellis",
      trellis: { name: "auth", path: "/repo/myproject/.garden/trellises/auth.md", maxIterations: 30 },
      effort: "xhigh",
    });
    const entry = vi.mocked(addWorker).mock.calls[0][1] as Record<string, unknown>;
    expect(entry.workflow).toBe("trellis");
    expect(entry.effort).toBeUndefined();
  });

  it("ultracode: ignored for trellis vines (they resolve their own model per iteration)", () => {
    // The guard is `opts.ultracode === true && workflowName !== "trellis"`.
    // A trellis plant with ultracode:true must stamp NEITHER the Opus pin
    // (it would clobber per-iteration vine model resolution) nor entry.ultracode.
    vi.mocked(readDashState).mockReturnValue(makeState());
    newWorker({
      workflow: "trellis",
      trellis: { name: "auth", path: "/repo/myproject/.garden/trellises/auth.md", maxIterations: 30 },
      ultracode: true,
    });
    const entry = vi.mocked(addWorker).mock.calls[0][1] as Record<string, unknown>;
    expect(entry.workflow).toBe("trellis");
    expect(entry.ultracode).toBeUndefined();
    expect(entry.model).toBeUndefined();
    expect(entry.trellis).toBeDefined();
  });

  // ===== Project-level model/effort defaults (ProjectConfig.model/.effort) =====
  // These layer beneath the per-spawn opts in newWorker (per-spawn > project >
  // account default), exactly as resolveSpawnBase layers project.baseBranch
  // beneath --base. Applied to default+grow only; trellis and ultracode
  // interact per the precedence comment in newWorker.

  it("project model default: stamped when no per-spawn --model", () => {
    vi.mocked(tryGetProject).mockReturnValueOnce({ name: "myproject", path: "/repo/myproject", model: "sonnet" });
    vi.mocked(readDashState).mockReturnValue(makeState());
    newWorker();
    const entry = vi.mocked(addWorker).mock.calls[0][1] as Record<string, unknown>;
    expect(entry.model).toBe("sonnet");
  });

  it("per-spawn --model wins over the project model default", () => {
    vi.mocked(tryGetProject).mockReturnValueOnce({ name: "myproject", path: "/repo/myproject", model: "sonnet" });
    vi.mocked(readDashState).mockReturnValue(makeState());
    newWorker({ model: "opus" });
    const entry = vi.mocked(addWorker).mock.calls[0][1] as Record<string, unknown>;
    expect(entry.model).toBe("opus");
  });

  it("project effort default: stamped when no per-spawn --effort", () => {
    vi.mocked(tryGetProject).mockReturnValueOnce({ name: "myproject", path: "/repo/myproject", effort: "high" });
    vi.mocked(readDashState).mockReturnValue(makeState());
    newWorker();
    const entry = vi.mocked(addWorker).mock.calls[0][1] as Record<string, unknown>;
    expect(entry.effort).toBe("high");
  });

  it("per-spawn --effort wins over the project effort default", () => {
    vi.mocked(tryGetProject).mockReturnValueOnce({ name: "myproject", path: "/repo/myproject", effort: "low" });
    vi.mocked(readDashState).mockReturnValue(makeState());
    newWorker({ effort: "xhigh" });
    const entry = vi.mocked(addWorker).mock.calls[0][1] as Record<string, unknown>;
    expect(entry.effort).toBe("xhigh");
  });

  it("project effort default 'ultra' resolves to the ultracode preset", () => {
    vi.mocked(tryGetProject).mockReturnValueOnce({ name: "myproject", path: "/repo/myproject", effort: "ultra" });
    vi.mocked(readDashState).mockReturnValue(makeState());
    newWorker();
    const entry = vi.mocked(addWorker).mock.calls[0][1] as Record<string, unknown>;
    expect(entry.ultracode).toBe(true);
    expect(entry.model).toBe("opus[1m]"); // ULTRACODE_MODEL pin
    expect(entry.effort).toBeUndefined();
  });

  it("project model/effort defaults are ignored for a trellis vine", () => {
    vi.mocked(tryGetProject).mockReturnValueOnce({ name: "myproject", path: "/repo/myproject", model: "sonnet", effort: "high" });
    vi.mocked(readDashState).mockReturnValue(makeState());
    newWorker({
      workflow: "trellis",
      trellis: { name: "auth", path: "/repo/myproject/.garden/trellises/auth.md", maxIterations: 30 },
    });
    const entry = vi.mocked(addWorker).mock.calls[0][1] as Record<string, unknown>;
    expect(entry.workflow).toBe("trellis");
    // trellis vines resolve their own model per iteration (trellis.workerModel),
    // never entry.model; effort never applies.
    expect(entry.model).toBeUndefined();
    expect(entry.effort).toBeUndefined();
  });

  // ===== Harness selection (workers new --harness codex) =====
  // opts.harness is validated against the real registry (harness/core.js is
  // NOT mocked here, so isRegisteredHarness/harnessNames are real), stamped
  // onto the entry, and threaded into the bootstrap opts. An unknown harness
  // is refused before any worker is created.

  it("harness: rejects an unknown harness without creating a worker", () => {
    vi.mocked(readDashState).mockReturnValue(makeState());
    const name = newWorker({ harness: "bogus" });
    expect(name).toBeNull();
    expect(vi.mocked(addWorker)).not.toHaveBeenCalled();
    const msgs = vi.mocked(tmuxDisplay).mock.calls.map((c) => c[0] as string);
    expect(msgs.some((m) => m.includes("Unknown harness 'bogus'"))).toBe(true);
  });

  it("harness: stamps entry.harness for a codex worker", () => {
    vi.mocked(readDashState).mockReturnValue(makeState());
    expect(newWorker({ harness: "codex" })).toBe("bold-ash");
    expect(vi.mocked(addWorker)).toHaveBeenCalledWith(
      "myproject",
      expect.objectContaining({ workflow: "default", harness: "codex" }),
    );
  });

  it("harness: rejects a provider profile with a harness that cannot consume it", () => {
    vi.mocked(loadConfig).mockReturnValue({
      projects: {}, plots: {}, providers: { deepseek: {} },
    } as unknown as ReturnType<typeof loadConfig>);
    vi.mocked(readDashState).mockReturnValue(makeState());

    expect(newWorker({ harness: "codex", provider: "deepseek" })).toBeNull();
    expect(vi.mocked(addWorker)).not.toHaveBeenCalled();
    expect(vi.mocked(tmuxDisplay)).toHaveBeenCalledWith(
      expect.stringContaining("does not support provider profiles"),
    );
  });

  it("harness: rejects a workflow the selected harness does not support", () => {
    vi.mocked(readDashState).mockReturnValue(makeState());

    expect(newWorker({
      harness: "codex",
      workflow: "grow",
      grow: { seed: "ship it", maxIterations: 3 },
    })).toBeNull();
    expect(vi.mocked(addWorker)).not.toHaveBeenCalled();
    expect(vi.mocked(tmuxDisplay)).toHaveBeenCalledWith(
      expect.stringContaining("does not support workflow 'grow'"),
    );
  });

  it("crew: derives the build harness from the crew's worker member and stamps entry.crew", () => {
    vi.mocked(readDashState).mockReturnValue(makeState());
    expect(newWorker({ crew: "all-codex" })).toBe("bold-ash");
    expect(vi.mocked(addWorker)).toHaveBeenCalledWith(
      "myproject",
      expect.objectContaining({ harness: "codex", crew: "all-codex" }),
    );
  });

  it("crew: a claude-worker crew (claude-codex) pins the build harness to claude-code", () => {
    // The crew's worker member is authoritative — claude-codex builds with claude,
    // stamped explicitly (mirroring `--harness claude`) so the badge and the launch
    // agree, and so the project default can't override it below.
    vi.mocked(readDashState).mockReturnValue(makeState());
    newWorker({ crew: "claude-codex" });
    const entry = vi.mocked(addWorker).mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(entry.crew).toBe("claude-codex");
    expect(entry.harness).toBe("claude-code");
  });

  it("crew: a claude-worker crew builds with claude even on a project defaulting to codex", () => {
    // Regression: a crew is authoritative over the build harness, so `--crew
    // claude-codex` on a codex-default project must build with CLAUDE. The old
    // code skipped a claude-code crew member and fell through to project.harness,
    // silently launching codex — the operator asked for claude and got codex, and
    // the status pane then advertised a claude crew on a codex-building worker.
    vi.mocked(tryGetProject).mockReturnValueOnce({
      name: "myproject", path: "/repo/myproject", harness: "codex",
    } as ReturnType<typeof tryGetProject>);
    vi.mocked(readDashState).mockReturnValue(makeState());
    newWorker({ crew: "claude-codex" });
    const entry = vi.mocked(addWorker).mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(entry.crew).toBe("claude-codex");
    expect(entry.harness).toBe("claude-code");
  });

  // ===== Provider selection (the build member's axis-1 half) =====
  // A member is a (harness, provider) PAIR, so naming one answers both halves.
  // The project's provider key remains the default for any worker that names no
  // member at all.

  it("provider: stamps entry.provider for a provider-backed build member", () => {
    vi.mocked(loadConfig).mockReturnValue({
      projects: {}, plots: {}, providers: {
        deepseek: {
          baseUrl: "https://api.deepseek.example/anthropic",
          authTokenEnv: "GARDEN_TEST_PROVIDER_KEY",
        },
      },
    } as unknown as ReturnType<typeof loadConfig>);
    process.env.GARDEN_TEST_PROVIDER_KEY = "test-token";
    vi.mocked(dashboardExists).mockReturnValue(true);
    vi.mocked(readDashState).mockReturnValue(makeState());
    expect(newWorker({ harness: "claude", provider: "deepseek" })).toBe("bold-ash");
    const entry = vi.mocked(addWorker).mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(entry.provider).toBe("deepseek");
    expect(entry.harness).toBe("claude-code");
  });

  it("provider: rejects an unconfigured provider without creating a worker", () => {
    // Loudly at creation, rather than silently falling back to the first-party
    // path at launch — the operator asked for a backend and would otherwise get
    // billed to the wrong pool with no signal.
    vi.mocked(readDashState).mockReturnValue(makeState());
    expect(newWorker({ harness: "claude", provider: "nope" })).toBeNull();
    expect(vi.mocked(addWorker)).not.toHaveBeenCalled();
    const msgs = vi.mocked(tmuxDisplay).mock.calls.map((c) => c[0] as string);
    expect(msgs.some((m) => m.includes("Unknown provider 'nope'"))).toBe(true);
  });

  it("provider: an explicit member means first-party even on a provider-backed project", () => {
    // The pair semantics that keep the composer honest: naming `claude` must
    // build first-party, not inherit the project's backend. Without this there
    // is no way to spell "first-party" on such a project, and the build dim
    // would display a member the worker is not.
    //
    // Recorded as the EMPTY string, not omitted. Omission means "inherit the
    // project" to every reader downstream, so a bare omission here would hand
    // this worker the deepseek backend at launch — the exact bug the pair rule
    // exists to prevent. workerProject (create.ts) decodes "" back to
    // first-party.
    vi.mocked(tryGetProject).mockReturnValueOnce({
      name: "myproject", path: "/repo/myproject", provider: "deepseek",
    } as ReturnType<typeof tryGetProject>);
    vi.mocked(readDashState).mockReturnValue(makeState());
    newWorker({ harness: "claude" });
    const entry = vi.mocked(addWorker).mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(entry.provider).toBe("");
  });

  it("provider: a worker naming no member inherits the project's provider (unstamped)", () => {
    // The default path is untouched: the project key still applies, and nothing
    // is written to the entry because there is no per-worker override.
    vi.mocked(tryGetProject).mockReturnValueOnce({
      name: "myproject", path: "/repo/myproject", provider: "deepseek",
    } as ReturnType<typeof tryGetProject>);
    vi.mocked(loadConfig).mockReturnValue({
      projects: {}, plots: {}, providers: {
        deepseek: {
          baseUrl: "https://api.deepseek.example/anthropic",
          authTokenEnv: "GARDEN_TEST_PROVIDER_KEY",
        },
      },
    } as unknown as ReturnType<typeof loadConfig>);
    process.env.GARDEN_TEST_PROVIDER_KEY = "test-token";
    vi.mocked(dashboardExists).mockReturnValue(true);
    vi.mocked(readDashState).mockReturnValue(makeState());
    expect(newWorker({})).toBe("bold-ash");
    const entry = vi.mocked(addWorker).mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(entry.provider).toBeUndefined();
  });

  it("provider: pins a project-crew backend so resume cannot switch accounts", () => {
    vi.mocked(loadConfig).mockReturnValue({
      projects: {}, plots: {},
      providers: {
        deepseek: {
          baseUrl: "https://api.deepseek.example/anthropic",
          authTokenEnv: "GARDEN_TEST_PROVIDER_KEY",
        },
      },
      crews: {
        fleet: {
          worker: { member: "deepseek" },
          review: { member: "claude" },
        },
      },
    } as unknown as ReturnType<typeof loadConfig>);
    vi.mocked(tryGetProject).mockReturnValueOnce({
      name: "myproject", path: "/repo/myproject", crew: "fleet",
    } as ReturnType<typeof tryGetProject>);
    process.env.GARDEN_TEST_PROVIDER_KEY = "test-token";
    vi.mocked(dashboardExists).mockReturnValue(true);
    vi.mocked(readDashState).mockReturnValue(makeState());

    expect(newWorker({})).toBe("bold-ash");
    const entry = vi.mocked(addWorker).mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(entry.harness).toBe("claude-code");
    expect(entry.provider).toBe("deepseek");
  });

  it("crew: a codex-worker crew builds with codex even on a claude-default project", () => {
    // The mirror case — the crew wins over the (claude) project default too.
    vi.mocked(readDashState).mockReturnValue(makeState());
    newWorker({ crew: "codex-claude" });
    const entry = vi.mocked(addWorker).mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(entry.crew).toBe("codex-claude");
    expect(entry.harness).toBe("codex");
  });

  // Stored crews carry model + effort — the dims a generated crew namespace
  // cannot express. Each resolves in the layer beneath its flat project key.
  const HEAVY = {
    projects: {}, plots: {},
    crews: { heavy: { worker: { member: "claude", model: "opus", effort: "xhigh" }, review: { member: "claude" } } },
  };

  it("crew model/effort: a per-worker crew supplies both dims", () => {
    vi.mocked(loadConfig).mockReturnValue(HEAVY as ReturnType<typeof loadConfig>);
    vi.mocked(readDashState).mockReturnValue(makeState());
    newWorker({ crew: "heavy" });
    const entry = vi.mocked(addWorker).mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(entry.model).toBe("opus");
    expect(entry.effort).toBe("xhigh");
  });

  it("crew model/effort: a per-spawn --model/--effort still wins", () => {
    vi.mocked(loadConfig).mockReturnValue(HEAVY as ReturnType<typeof loadConfig>);
    vi.mocked(readDashState).mockReturnValue(makeState());
    newWorker({ crew: "heavy", model: "sonnet", effort: "low" });
    const entry = vi.mocked(addWorker).mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(entry.model).toBe("sonnet");
    expect(entry.effort).toBe("low");
  });

  it("crew model/effort: a project's bound crew applies, and its flat keys override it", () => {
    vi.mocked(loadConfig).mockReturnValue(HEAVY as ReturnType<typeof loadConfig>);
    vi.mocked(readDashState).mockReturnValue(makeState());
    vi.mocked(tryGetProject).mockReturnValueOnce({
      name: "myproject", path: "/repo/myproject", crew: "heavy",
    } as ReturnType<typeof tryGetProject>);
    newWorker({});
    let entry = vi.mocked(addWorker).mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(entry.model).toBe("opus");
    expect(entry.effort).toBe("xhigh");

    vi.mocked(tryGetProject).mockReturnValueOnce({
      name: "myproject", path: "/repo/myproject", crew: "heavy", model: "haiku",
    } as ReturnType<typeof tryGetProject>);
    newWorker({});
    entry = vi.mocked(addWorker).mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(entry.model).toBe("haiku");
    expect(entry.effort).toBe("xhigh");
  });

  it("crew effort 'ultra' promotes to the ultracode preset, as at the CLI", () => {
    vi.mocked(loadConfig).mockReturnValue({
      projects: {}, plots: {},
      crews: { max: { worker: { member: "claude", effort: "ultra" }, review: { member: "claude" } } },
    } as ReturnType<typeof loadConfig>);
    vi.mocked(readDashState).mockReturnValue(makeState());
    newWorker({ crew: "max" });
    const entry = vi.mocked(addWorker).mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(entry.ultracode).toBe(true);
    expect(entry.effort).toBeUndefined();
  });

  it("crew: the worker.created snapshot records the per-worker crew, not the project crew", () => {
    // Regression: the live review sites thread entry.crew, but the frozen
    // telemetry snapshot must too — else `garden stats --by crew` buckets a
    // per-worker-crew worker under the project's crew and its review harness
    // reads claude-code when the crew's reviewer is actually codex.
    vi.mocked(readDashState).mockReturnValue(makeState());
    newWorker({ crew: "all-codex" });
    const snapshot = vi.mocked(recordWorkerCreated).mock.calls.at(-1)![3] as {
      crew?: string | null;
      roles: { reviewer: { harness: string }; resolver: { harness: string }; ciFix: { harness: string } };
    };
    expect(snapshot.crew).toBe("all-codex");
    expect(snapshot.roles.reviewer.harness).toBe("codex");
    expect(snapshot.roles.resolver.harness).toBe("codex");
    expect(snapshot.roles.ciFix.harness).toBe("codex");
  });

  it("harness: canonicalizes the 'claude' alias to claude-code", () => {
    vi.mocked(readDashState).mockReturnValue(makeState());
    expect(newWorker({ harness: "claude" })).toBe("bold-ash");
    expect(vi.mocked(addWorker)).toHaveBeenCalledWith(
      "myproject",
      expect.objectContaining({ workflow: "default", harness: "claude-code" }),
    );
  });

  it("harness: threads harness into the bootstrap opts (8th arg)", () => {
    vi.mocked(readDashState).mockReturnValue(makeState());
    newWorker({ harness: "codex" });
    const call = vi.mocked(buildWorktreeBootstrapScript).mock.calls[0];
    expect(call).toHaveLength(8);
    expect(call[7]).toEqual(expect.objectContaining({
      launchPlan: expect.objectContaining({ harness: "codex" }),
    }));
  });

  it("harness: resolves a structured default launch plan for a plain worker", () => {
    vi.mocked(readDashState).mockReturnValue(makeState());
    newWorker();
    const entry = vi.mocked(addWorker).mock.calls[0][1] as Record<string, unknown>;
    expect(entry.harness).toBeUndefined();
    const call = vi.mocked(buildWorktreeBootstrapScript).mock.calls[0];
    expect(call).toHaveLength(8);
    expect(call[7]).toEqual(expect.objectContaining({
      launchPlan: expect.objectContaining({ harness: "claude-code" }),
    }));
  });

  // ===== Project-default harness (config <p> harness / crew) =====
  // A default worker inherits project.harness when no per-worker --harness is
  // given. But the project default is DEFAULT-WORKFLOW ONLY — a trellis/grow
  // plant (which passes no harness) must NOT inherit a codex project default,
  // mirroring the CLI's explicit --harness guard. Otherwise a project set to
  // `crew all-codex` would silently spawn an unsupported codex vine.

  it("harness: a default worker inherits project.harness when no --harness is given", () => {
    vi.mocked(readDashState).mockReturnValue(makeState());
    vi.mocked(tryGetProject).mockReturnValueOnce({
      name: "myproject", path: "/repo/myproject", harness: "codex",
    });
    newWorker();
    expect(vi.mocked(addWorker)).toHaveBeenCalledWith(
      "myproject",
      expect.objectContaining({ workflow: "default", harness: "codex" }),
    );
  });

  it("harness: an explicit --harness overrides the project default", () => {
    vi.mocked(readDashState).mockReturnValue(makeState());
    vi.mocked(tryGetProject).mockReturnValueOnce({
      name: "myproject", path: "/repo/myproject", harness: "codex",
    });
    newWorker({ harness: "claude-code" });
    expect(vi.mocked(addWorker)).toHaveBeenCalledWith(
      "myproject",
      expect.objectContaining({ harness: "claude-code" }),
    );
  });

  it("harness: project.harness does NOT leak to a trellis vine (default-workflow only)", () => {
    vi.mocked(readDashState).mockReturnValue(makeState());
    vi.mocked(tryGetProject).mockReturnValueOnce({
      name: "myproject", path: "/repo/myproject", harness: "codex",
    });
    newWorker({
      workflow: "trellis",
      trellis: { name: "auth", path: "/repo/myproject/.garden/trellises/auth.md", maxIterations: 30 },
    });
    const entry = vi.mocked(addWorker).mock.calls[0][1] as Record<string, unknown>;
    expect(entry.workflow).toBe("trellis");
    expect(entry.harness).toBeUndefined();
  });

  it("harness: project.harness does NOT leak to a grow worker (default-workflow only)", () => {
    vi.mocked(readDashState).mockReturnValue(makeState());
    vi.mocked(tryGetProject).mockReturnValueOnce({
      name: "myproject", path: "/repo/myproject", harness: "codex",
    });
    newWorker({
      workflow: "grow",
      grow: { seed: "harden auth flow", maxIterations: 5 },
    });
    const entry = vi.mocked(addWorker).mock.calls[0][1] as Record<string, unknown>;
    expect(entry.workflow).toBe("grow");
    expect(entry.harness).toBeUndefined();
  });
});

// =============================================================================
// killPane
// =============================================================================

describe("killPane", () => {
  it("shows error when trying to kill shell pane", () => {
    vi.mocked(readDashState).mockReturnValue(makeState({ activePaneType: "shell" }));
    killPane();
    expect(vi.mocked(tmuxDisplay)).toHaveBeenCalledWith(
      "Cannot kill project shell. Use ⌥x on workers only.",
    );
    expect(vi.mocked(removeWorker)).not.toHaveBeenCalled();
  });

  it("shows error when no pane exists", () => {
    vi.mocked(readDashState).mockReturnValue(makeState({ activePaneId: null }));
    killPane();
    expect(vi.mocked(tmuxDisplay)).toHaveBeenCalledWith("No pane to kill.");
  });

  it("shows error when pane does not exist in tmux", () => {
    vi.mocked(paneExists).mockReturnValue(false);
    vi.mocked(readDashState).mockReturnValue(makeState());
    killPane();
    expect(vi.mocked(tmuxDisplay)).toHaveBeenCalledWith("No pane to kill.");
  });

  it("silently writes state and returns when activeProject is null", () => {
    vi.mocked(readDashState).mockReturnValue(
      makeState({ activeProject: null, activePaneType: "worker" }),
    );
    killPane();
    expect(vi.mocked(writeDashState)).toHaveBeenCalled();
    expect(vi.mocked(removeWorker)).not.toHaveBeenCalled();
  });

  it("swaps to next hidden worker when available", () => {
    const state = makeState();
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(listHiddenWorkerWindows).mockReturnValue(["_myproject-worker-next-one"]);
    vi.mocked(getFirstPaneId).mockReturnValue("%30");

    vi.mocked(findWorkerByName).mockImplementation((_proj: string, name: string) => {
      if (name === "swift-oak") {
        return {
          name: "swift-oak", sessionId: "s1", task: "", branchName: "swift-oak",
          worktreePath: "/wt/swift-oak",
        };
      }
      if (name === "next-one") {
        return { name: "next-one", sessionId: "s2", task: "some task", branchName: "next-one" };
      }
      return null;
    });

    killPane();

    expect(vi.mocked(tmux)).toHaveBeenCalledWith(
      "swap-pane", "-s", "%2", "-t", "%30",
    );
    expect(vi.mocked(killWindowSafe)).toHaveBeenCalledWith("_myproject-worker-next-one");
    const written = vi.mocked(writeDashState).mock.calls[0][0];
    expect(written.activePaneType).toBe("worker");
    expect(written.activeWindowName).toBe("_myproject-worker-next-one");
  });

  it("swaps in the worker that now occupies the killed worker's status-pane row, not tmux window order", () => {
    // Four workers, freshest to stalest: alpha, bravo, charlie (killed/visible),
    // delta. In the status-pane's freshness order charlie sits directly above
    // delta, so closing charlie should promote delta into charlie's row — like
    // closing a browser tab hands focus to its neighbor, not to whichever tab
    // tmux happens to have created first.
    const state = makeState({ activeWindowName: "_myproject-worker-charlie" });
    vi.mocked(readDashState).mockReturnValue(state);
    // Deliberately NOT in freshness order, to prove selection ignores tmux's
    // raw window-list order.
    vi.mocked(listHiddenWorkerWindows).mockReturnValue([
      "_myproject-worker-delta",
      "_myproject-worker-alpha",
      "_myproject-worker-bravo",
    ]);
    vi.mocked(getWorkers).mockReturnValue([
      { name: "alpha", sessionId: "s1", task: "", lastStateChangeAt: 400_000 },
      { name: "bravo", sessionId: "s2", task: "", lastStateChangeAt: 300_000 },
      { name: "charlie", sessionId: "s3", task: "", lastStateChangeAt: 200_000 },
      { name: "delta", sessionId: "s4", task: "", lastStateChangeAt: 100_000 },
    ]);
    vi.mocked(getFirstPaneId).mockReturnValue("%30");

    killPane();

    expect(vi.mocked(tmux)).toHaveBeenCalledWith(
      "swap-pane", "-s", "%2", "-t", "%30",
    );
    expect(vi.mocked(killWindowSafe)).toHaveBeenCalledWith("_myproject-worker-delta");
    const written = vi.mocked(writeDashState).mock.calls[0][0];
    expect(written.activeWindowName).toBe("_myproject-worker-delta");
  });

  it("promotes the next-freshest worker when the killed worker held the top status-pane row", () => {
    const state = makeState({ activeWindowName: "_myproject-worker-alpha" });
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(listHiddenWorkerWindows).mockReturnValue([
      "_myproject-worker-delta",
      "_myproject-worker-bravo",
    ]);
    vi.mocked(getWorkers).mockReturnValue([
      { name: "alpha", sessionId: "s1", task: "", lastStateChangeAt: 300_000 },
      { name: "bravo", sessionId: "s2", task: "", lastStateChangeAt: 200_000 },
      { name: "delta", sessionId: "s4", task: "", lastStateChangeAt: 100_000 },
    ]);
    vi.mocked(getFirstPaneId).mockReturnValue("%30");

    killPane();

    expect(vi.mocked(killWindowSafe)).toHaveBeenCalledWith("_myproject-worker-bravo");
    const written = vi.mocked(writeDashState).mock.calls[0][0];
    expect(written.activeWindowName).toBe("_myproject-worker-bravo");
  });

  it("promotes the worker directly above when the killed worker held the bottom status-pane row", () => {
    // charlie is the stalest, so it sits at the bottom of the freshness order.
    // Closing the bottom tab hands focus upward to its neighbor (bravo) — the
    // row-position clamp (killedIdx exceeds the shortened list's last index).
    const state = makeState({ activeWindowName: "_myproject-worker-charlie" });
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(listHiddenWorkerWindows).mockReturnValue([
      "_myproject-worker-bravo",
      "_myproject-worker-alpha",
    ]);
    vi.mocked(getWorkers).mockReturnValue([
      { name: "alpha", sessionId: "s1", task: "", lastStateChangeAt: 300_000 },
      { name: "bravo", sessionId: "s2", task: "", lastStateChangeAt: 200_000 },
      { name: "charlie", sessionId: "s3", task: "", lastStateChangeAt: 100_000 },
    ]);
    vi.mocked(getFirstPaneId).mockReturnValue("%30");

    killPane();

    expect(vi.mocked(killWindowSafe)).toHaveBeenCalledWith("_myproject-worker-bravo");
    const written = vi.mocked(writeDashState).mock.calls[0][0];
    expect(written.activeWindowName).toBe("_myproject-worker-bravo");
  });

  it("pre-sizes next worker window before swap", () => {
    const state = makeState();
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(listHiddenWorkerWindows).mockReturnValue(["_myproject-worker-next-one"]);
    vi.mocked(getFirstPaneId).mockReturnValue("%30");

    killPane();

    expect(vi.mocked(resizeWindow)).toHaveBeenCalledWith(
      "_myproject-worker-next-one", 120, 50,
    );
  });

  it("re-applies pane label and task var on swapped-in worker", () => {
    const state = makeState();
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(listHiddenWorkerWindows).mockReturnValue(["_myproject-worker-next-one"]);
    vi.mocked(getFirstPaneId).mockReturnValue("%30");

    vi.mocked(findWorkerByName).mockImplementation((_proj: string, name: string) => {
      if (name === "next-one") return { name: "next-one", sessionId: "s2", task: "do stuff", branchName: "next-one" };
      if (name === "swift-oak") return { name: "swift-oak", sessionId: "s1", task: "", branchName: "swift-oak", worktreePath: "/wt/swift-oak" };
      return null;
    });

    killPane();

    expect(vi.mocked(setPaneLabel)).toHaveBeenCalledWith("%30", "next-one");
    expect(vi.mocked(setPaneVar)).toHaveBeenCalledWith("%30", "garden_task", "do stuff");
    // The surfaced worker pane keeps its wall clock (re-applied after swap-pane).
    expect(vi.mocked(setPaneVar)).toHaveBeenCalledWith("%30", "garden_clock", "1");
  });

  it("falls back to shell when no hidden workers", () => {
    const state = makeState();
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(listHiddenWorkerWindows).mockReturnValue([]);
    vi.mocked(getFirstPaneId).mockReturnValue("%25");

    vi.mocked(findWorkerByName).mockImplementation((_proj: string, name: string) => {
      if (name === "swift-oak") return { name: "swift-oak", sessionId: "s1", task: "", branchName: "swift-oak", worktreePath: "/wt/swift-oak" };
      return null;
    });

    killPane();

    expect(vi.mocked(tmux)).toHaveBeenCalledWith(
      "swap-pane", "-s", "%2", "-t", "%25",
    );
    const written = vi.mocked(writeDashState).mock.calls[0][0];
    expect(written.activePaneType).toBe("shell");
    expect(written.activeWindowName).toBe("_myproject-shell");
  });

  it("creates shell window if it does not exist", () => {
    const state = makeState();
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(listHiddenWorkerWindows).mockReturnValue([]);
    vi.mocked(windowExists).mockReturnValue(false);
    vi.mocked(getFirstPaneId).mockReturnValue("%25");

    vi.mocked(findWorkerByName).mockReturnValue({
      name: "swift-oak", sessionId: "s1", task: "", branchName: "swift-oak",
      worktreePath: "/wt/swift-oak",
    });

    killPane();

    expect(vi.mocked(createShellWindow)).toHaveBeenCalledWith("myproject", "/repo/myproject");
  });

  it("removes killed worker from registry", () => {
    const state = makeState();
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(getFirstPaneId).mockReturnValue("%25");

    vi.mocked(findWorkerByName).mockReturnValue({
      name: "swift-oak", sessionId: "s1", task: "", branchName: "swift-oak",
      worktreePath: "/wt/swift-oak",
    });

    killPane();

    expect(vi.mocked(removeWorker)).toHaveBeenCalledWith("myproject", "swift-oak");
  });

  it("kills review window for the worker", () => {
    const state = makeState();
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(getFirstPaneId).mockReturnValue("%25");

    vi.mocked(findWorkerByName).mockReturnValue({
      name: "swift-oak", sessionId: "s1", task: "", branchName: "swift-oak",
      worktreePath: "/wt/swift-oak",
    });

    killPane();

    expect(vi.mocked(killReviewWindow)).toHaveBeenCalledWith("myproject", "swift-oak");
  });

  it("stops project poller when last worker is removed", () => {
    const state = makeState();
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(getFirstPaneId).mockReturnValue("%25");
    vi.mocked(getWorkers).mockReturnValue([]);

    vi.mocked(findWorkerByName).mockReturnValue({
      name: "swift-oak", sessionId: "s1", task: "", branchName: "swift-oak",
      worktreePath: "/wt/swift-oak",
    });

    killPane();

    expect(vi.mocked(stopProjectPoller)).toHaveBeenCalledWith("myproject");
  });

  it("does not stop poller when other workers remain", () => {
    const state = makeState();
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(getFirstPaneId).mockReturnValue("%25");
    vi.mocked(getWorkers).mockReturnValue([
      { name: "other-worker", sessionId: "s2", task: "" },
    ]);

    vi.mocked(findWorkerByName).mockReturnValue({
      name: "swift-oak", sessionId: "s1", task: "", branchName: "swift-oak",
      worktreePath: "/wt/swift-oak",
    });

    killPane();

    expect(vi.mocked(stopProjectPoller)).not.toHaveBeenCalled();
  });

  it("clears lastActiveWorker when killing the active worker", () => {
    const state = makeState({
      lastActiveWorker: { myproject: "_myproject-worker-swift-oak" },
    });
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(getFirstPaneId).mockReturnValue("%25");

    vi.mocked(findWorkerByName).mockReturnValue({
      name: "swift-oak", sessionId: "s1", task: "", branchName: "swift-oak",
      worktreePath: "/wt/swift-oak",
    });

    killPane();

    const written = vi.mocked(writeDashState).mock.calls[0][0];
    expect(written.lastActiveWorker["myproject"]).toBeUndefined();
  });

  it("spawns background git cleanup after kill", () => {
    const state = makeState();
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(getFirstPaneId).mockReturnValue("%25");

    vi.mocked(findWorkerByName).mockReturnValue({
      name: "swift-oak", sessionId: "s1", task: "", branchName: "swift-oak",
      worktreePath: "/wt/swift-oak",
    });

    killPane();

    expect(vi.mocked(spawn)).toHaveBeenCalledWith(
      "sh", ["-c", expect.stringContaining("worktree remove")],
      { detached: true, stdio: "ignore" },
    );
  });

  it("does not spawn cleanup when no worker entry found", () => {
    const state = makeState();
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(getFirstPaneId).mockReturnValue("%25");

    vi.mocked(findWorkerByName).mockReturnValue(null);

    killPane();

    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
  });

  it("refreshes dashboard after kill", () => {
    vi.mocked(readDashState).mockReturnValue(makeState({ activePaneType: "shell" }));
    killPane();
    // Even if early-return for shell, refreshDashboard is not called because we return early
    // Check a normal kill path instead
    vi.clearAllMocks();
    const state = makeState();
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(getFirstPaneId).mockReturnValue("%25");

    vi.mocked(findWorkerByName).mockReturnValue(null);

    killPane();

    expect(vi.mocked(refreshDashboard)).toHaveBeenCalled();
  });
});

// =============================================================================
// killPane — always kills unconditionally
// =============================================================================

describe("killPane always kills", () => {
  it("kills a dirty worktree without any confirmation prompt", () => {
    const state = makeState();
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(getFirstPaneId).mockReturnValue("%25");

    vi.mocked(findWorkerByName).mockReturnValue({
      name: "swift-oak", sessionId: "s1", task: "", branchName: "swift-oak",
      worktreePath: "/wt/swift-oak",
    });

    killPane();

    expect(vi.mocked(tmuxDisplay)).not.toHaveBeenCalledWith(
      expect.stringContaining("uncommitted changes"),
    );
    expect(vi.mocked(removeWorker)).toHaveBeenCalledWith("myproject", "swift-oak");
  });

  it("tombstones the full final entry before removing it", () => {
    const state = makeState();
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(getFirstPaneId).mockReturnValue("%25");

    const entry = {
      name: "swift-oak", sessionId: "s1", task: "migrate the schema",
      branchName: "swift-oak", worktreePath: "/wt/swift-oak",
      createdAt: 42, workflow: "grow", mergeCount: 3,
    };
    vi.mocked(findWorkerByName).mockReturnValue(entry);

    killPane();

    expect(vi.mocked(recordWorkerRemoved)).toHaveBeenCalledWith(
      "myproject", "swift-oak", 42, "grow", entry,
    );
    // Tombstone written before the entry is erased — the snapshot must come
    // from the live registry, not a race with removeWorker.
    const removedOrder = vi.mocked(recordWorkerRemoved).mock.invocationCallOrder[0];
    const removeOrder = vi.mocked(removeWorker).mock.invocationCallOrder[0];
    expect(removedOrder).toBeLessThan(removeOrder);
  });
});

// =============================================================================
// bounceWorker
// =============================================================================

describe("bounceWorker", () => {
  beforeEach(() => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "swift-oak",
      sessionId: "sess-abc",
      task: "",
      branchName: "swift-oak",
      worktreePath: "/wt/swift-oak",
    });
    vi.mocked(readDashState).mockReturnValue(makeState());
  });

  it("respawns the worker pane with the resume command, preserving pane ID", () => {
    bounceWorker("myproject", "swift-oak");

    expect(vi.mocked(buildWorktreeResumeCommand)).toHaveBeenCalledWith(
      "myproject", "/repo/myproject", "swift-oak", "swift-oak", "sess-abc", "main",
      { launchPlan: expect.objectContaining({ harness: "claude-code", role: "worker" }) },
    );
    const respawnCall = vi.mocked(tmux).mock.calls.find(c => c[0] === "respawn-pane");
    expect(respawnCall).toBeDefined();
    expect(respawnCall).toEqual(expect.arrayContaining([
      "respawn-pane", "-k", "-c", "/wt/swift-oak", "-t", "%2",
      "sh", "-c", "claude --resume FAKE-ID",
    ]));
  });

  it("refuses a bounce after the worker's harness/provider pair becomes incompatible", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "swift-oak",
      sessionId: "sess-abc",
      task: "",
      branchName: "swift-oak",
      worktreePath: "/wt/swift-oak",
      harness: "codex",
      workflow: "default",
    });
    vi.mocked(tryGetProject).mockReturnValue({
      name: "myproject", path: "/repo/myproject", provider: "deepseek",
    });
    vi.mocked(tryResolveProvider).mockReturnValue({
      name: "deepseek",
      label: "deepseek",
      baseUrl: "https://api.deepseek.example/anthropic",
      authTokenEnv: "GARDEN_TEST_PROVIDER_KEY",
    });

    expect(() => bounceWorker("myproject", "swift-oak"))
      .toThrow(/does not support provider profiles/);
    expect(vi.mocked(tmux).mock.calls.some(call => call[0] === "respawn-pane")).toBe(false);
  });

  it("writes agentStatus=idle for a non-working worker (resume hook preserves it)", () => {
    // Default mock worker has no agentStatus → resolveResumeAgentStatus → idle.
    // SessionStart(resume) now preserves whatever bounce writes, so bounce is
    // authoritative; an idle worker must not become the one-time "ready".
    bounceWorker("myproject", "swift-oak");

    expect(vi.mocked(updateWorkerFields)).toHaveBeenCalledWith(
      "myproject", "swift-oak", { agentStatus: "idle" },
    );
  });

  it("reinstalls claude hooks so settings.json picks up rebuild changes", () => {
    bounceWorker("myproject", "swift-oak");

    expect(vi.mocked(getHarness)().installRuntimeConfig).toHaveBeenCalledWith(
      "/wt/swift-oak", expect.objectContaining({ path: "/repo/myproject" }),
      { rulesText: "rules" },
    );
  });

  it("prefers the pinned entry.baseBranch over re-resolving", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "swift-oak", sessionId: "sess-abc", task: "",
      branchName: "swift-oak", worktreePath: "/wt/swift-oak",
      baseBranch: "develop",
    });

    bounceWorker("myproject", "swift-oak");

    expect(vi.mocked(buildWorktreeResumeCommand)).toHaveBeenCalledWith(
      "myproject", "/repo/myproject", "swift-oak", "swift-oak", "sess-abc", "develop",
      { launchPlan: expect.objectContaining({ harness: "claude-code", role: "worker" }) },
    );
    expect(vi.mocked(resolveBaseBranch)).not.toHaveBeenCalled();
  });

  it("uses the parked-window pane id when the worker is not the active one", () => {
    vi.mocked(readDashState).mockReturnValue(makeState({
      activeWindowName: "_myproject-worker-other",
      activePaneId: "%99",
    }));
    vi.mocked(windowExists).mockReturnValue(true);
    vi.mocked(getFirstPaneId).mockReturnValue("%77");

    bounceWorker("myproject", "swift-oak");

    const respawnCall = vi.mocked(tmux).mock.calls.find(c => c[0] === "respawn-pane");
    expect(respawnCall).toContain("%77");
    expect(respawnCall).not.toContain("%99");
  });

  it("throws when the worker has no sessionId (can't resume without one)", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "swift-oak", sessionId: undefined as unknown as string,
      task: "", branchName: "swift-oak", worktreePath: "/wt/swift-oak",
    });

    expect(() => bounceWorker("myproject", "swift-oak")).toThrow(/no sessionId/);
    expect(vi.mocked(tmux)).not.toHaveBeenCalledWith(
      "respawn-pane", expect.any(String), expect.any(String),
    );
  });

  it("throws when the worker is missing from the registry", () => {
    vi.mocked(findWorkerByName).mockReturnValue(null);

    expect(() => bounceWorker("myproject", "ghost")).toThrow(/No worker 'ghost'/);
  });

  it("throws when the pane can't be located", () => {
    vi.mocked(readDashState).mockReturnValue(makeState({
      activeWindowName: "_myproject-worker-other",
    }));
    vi.mocked(windowExists).mockReturnValue(false);

    expect(() => bounceWorker("myproject", "swift-oak")).toThrow(/no live pane/);
  });

  it("dispatches a delayed continue prompt when the worker was mid-turn at bounce", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "swift-oak", sessionId: "sess-abc", task: "",
      branchName: "swift-oak", worktreePath: "/wt/swift-oak",
      agentStatus: "working",
    });

    bounceWorker("myproject", "swift-oak");

    const continueCall = vi.mocked(spawn).mock.calls.find(c =>
      Array.isArray(c[1]) && (c[1] as string[])[1]?.includes("_continue-worker"),
    );
    expect(continueCall).toBeDefined();
    const cmd = (continueCall![1] as string[])[1];
    expect(cmd).not.toMatch(/\bsleep\b/);
    expect(cmd).toContain("dashboard _continue-worker --delay-ms 6000");
    expect(cmd).toContain("'myproject'");
    expect(cmd).toContain("'swift-oak'");
  });

  it("does not dispatch a continue prompt when the worker was idle at bounce", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "swift-oak", sessionId: "sess-abc", task: "",
      branchName: "swift-oak", worktreePath: "/wt/swift-oak",
      agentStatus: "idle",
    });

    bounceWorker("myproject", "swift-oak");

    const continueCall = vi.mocked(spawn).mock.calls.find(c =>
      Array.isArray(c[1]) && (c[1] as string[])[1]?.includes("_continue-worker"),
    );
    expect(continueCall).toBeUndefined();
  });

  it("parks a mid-turn worker at the ready sentinel and dispatches a continue", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "swift-oak", sessionId: "sess-abc", task: "",
      branchName: "swift-oak", worktreePath: "/wt/swift-oak",
      agentStatus: "working",
    });

    bounceWorker("myproject", "swift-oak");

    // A worker mid-turn at bounce resolves to the "ready" cold-start sentinel,
    // which is what continueWorkerIfStuck watches to re-fire a lost re-prompt;
    // the same condition dispatches the delayed continue below.
    expect(vi.mocked(updateWorkerFields)).toHaveBeenCalledWith(
      "myproject", "swift-oak", { agentStatus: "ready" },
    );
    const continueCall = vi.mocked(spawn).mock.calls.find(c =>
      Array.isArray(c[1]) && (c[1] as string[])[1]?.includes("_continue-worker"),
    );
    expect(continueCall).toBeDefined();
  });
});

describe("bounceActiveWorker", () => {
  it("bounces the active worker pane", () => {
    vi.mocked(readDashState).mockReturnValue(makeState());
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "swift-oak", sessionId: "sess-abc", task: "",
      branchName: "swift-oak", worktreePath: "/wt/swift-oak",
    });

    bounceActiveWorker();

    expect(vi.mocked(tmux)).toHaveBeenCalledWith(
      "respawn-pane", "-k", "-c", "/wt/swift-oak", "-t", "%2",
      "sh", "-c", "claude --resume FAKE-ID",
    );
    expect(vi.mocked(tmuxDisplay)).toHaveBeenCalledWith(expect.stringContaining("Bounced"));
  });

  it("refuses when the active pane is the project shell", () => {
    vi.mocked(readDashState).mockReturnValue(makeState({
      activePaneType: "shell",
      activeWindowName: "_myproject-shell",
    }));

    bounceActiveWorker();

    expect(vi.mocked(tmux)).not.toHaveBeenCalledWith(
      "respawn-pane", expect.any(String), expect.any(String),
    );
    expect(vi.mocked(tmuxDisplay)).toHaveBeenCalledWith(
      expect.stringContaining("worker panes"),
    );
  });
});

describe("decideHold", () => {
  it("refuses when there is no entry", () => {
    expect(decideHold(undefined, "ghost")).toMatchObject({ ok: false });
    expect(decideHold(undefined, "ghost").message).toContain("No worker found");
  });

  it("refuses a worker in a pipeline lifecycle state", () => {
    for (const pr of ["reviewing", "merge-pending", "resolving", "ci-fixing", "failing"]) {
      const d = decideHold({ agentStatus: "working", prState: pr }, "w");
      expect(d.ok).toBe(false);
      expect(d.message).toContain(pr);
    }
  });

  it("allows holding a merged/done worker (agent-side, not pipeline)", () => {
    expect(decideHold({ agentStatus: "working", prState: "merged" }, "w").ok).toBe(true);
    expect(decideHold({ agentStatus: "idle", prState: "done" }, "w").ok).toBe(true);
  });

  it("refuses an exited worker and an already-held worker", () => {
    expect(decideHold({ agentStatus: "exited" }, "w").ok).toBe(false);
    const held = decideHold({ agentStatus: "paused" }, "w");
    expect(held.ok).toBe(false);
    expect(held.message).toContain("already held");
  });

  it("sends Escape only for an active turn (working/asking), not idle/ready", () => {
    expect(decideHold({ agentStatus: "working" }, "w")).toMatchObject({ ok: true, sendEscape: true });
    expect(decideHold({ agentStatus: "asking" }, "w")).toMatchObject({ ok: true, sendEscape: true });
    expect(decideHold({ agentStatus: "idle" }, "w")).toMatchObject({ ok: true, sendEscape: false });
    expect(decideHold({ agentStatus: "ready" }, "w")).toMatchObject({ ok: true, sendEscape: false });
  });
});

describe("holdWorker", () => {
  it("interrupts a working worker and marks it paused", () => {
    vi.mocked(readDashState).mockReturnValue(makeState({ activeWindowName: "_myproject-worker-swift-oak" }));
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "swift-oak", sessionId: "s", task: "", agentStatus: "working",
      worktreePath: "/wt/swift-oak",
    });

    const result = holdWorker("myproject", "swift-oak");

    expect(result.ok).toBe(true);
    expect(vi.mocked(tmux)).toHaveBeenCalledWith("send-keys", "-t", "%2", "Escape");
    expect(vi.mocked(updateWorkerFields)).toHaveBeenCalledWith(
      "myproject", "swift-oak", { agentStatus: "paused" },
    );
    expect(vi.mocked(refreshDashboard)).toHaveBeenCalled();
  });

  it("does not send Escape or mutate state for a pipeline worker", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "swift-oak", sessionId: "s", task: "", agentStatus: "working", prState: "reviewing",
    });

    const result = holdWorker("myproject", "swift-oak");

    expect(result.ok).toBe(false);
    expect(vi.mocked(tmux)).not.toHaveBeenCalledWith("send-keys", "-t", expect.any(String), "Escape");
    expect(vi.mocked(updateWorkerFields)).not.toHaveBeenCalled();
  });

  it("does not send Escape for an idle worker but still marks it paused", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "swift-oak", sessionId: "s", task: "", agentStatus: "idle",
    });

    holdWorker("myproject", "swift-oak");

    expect(vi.mocked(tmux)).not.toHaveBeenCalledWith("send-keys", "-t", expect.any(String), "Escape");
    expect(vi.mocked(updateWorkerFields)).toHaveBeenCalledWith(
      "myproject", "swift-oak", { agentStatus: "paused" },
    );
  });
});

describe("releaseWorker", () => {
  it("returns a held worker to idle", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "swift-oak", sessionId: "s", task: "", agentStatus: "paused",
    });

    const result = releaseWorker("myproject", "swift-oak");

    expect(result.ok).toBe(true);
    expect(vi.mocked(updateWorkerFields)).toHaveBeenCalledWith(
      "myproject", "swift-oak", { agentStatus: "idle" },
    );
  });

  it("is a no-op for a worker that is not held", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "swift-oak", sessionId: "s", task: "", agentStatus: "working",
    });

    const result = releaseWorker("myproject", "swift-oak");

    expect(result.message).toContain("not held");
    expect(vi.mocked(updateWorkerFields)).not.toHaveBeenCalled();
  });
});

describe("holdActiveWorker", () => {
  it("holds the focused working worker", () => {
    vi.mocked(readDashState).mockReturnValue(makeState());
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "swift-oak", sessionId: "s", task: "", agentStatus: "working",
      worktreePath: "/wt/swift-oak",
    });

    holdActiveWorker();

    expect(vi.mocked(updateWorkerFields)).toHaveBeenCalledWith(
      "myproject", "swift-oak", { agentStatus: "paused" },
    );
    expect(vi.mocked(tmuxDisplay)).toHaveBeenCalledWith(expect.stringContaining("Held"));
  });

  it("toggles a held worker back to idle (release)", () => {
    vi.mocked(readDashState).mockReturnValue(makeState());
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "swift-oak", sessionId: "s", task: "", agentStatus: "paused",
    });

    holdActiveWorker();

    expect(vi.mocked(updateWorkerFields)).toHaveBeenCalledWith(
      "myproject", "swift-oak", { agentStatus: "idle" },
    );
    expect(vi.mocked(tmuxDisplay)).toHaveBeenCalledWith(expect.stringContaining("Released"));
  });

  it("refuses when the active pane is the project shell", () => {
    vi.mocked(readDashState).mockReturnValue(makeState({
      activePaneType: "shell",
      activeWindowName: "_myproject-shell",
    }));

    holdActiveWorker();

    expect(vi.mocked(updateWorkerFields)).not.toHaveBeenCalled();
    expect(vi.mocked(tmuxDisplay)).toHaveBeenCalledWith(expect.stringContaining("worker panes"));
  });
});

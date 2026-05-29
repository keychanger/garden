import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mocks ---

vi.mock("node:crypto", () => ({
  default: { randomUUID: vi.fn(() => "fake-uuid-1234") },
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
}));

vi.mock("../src/config.js", () => ({
  getProject: vi.fn(() => ({ name: "myproject", path: "/repo/myproject" })),
  tryGetProject: vi.fn(() => ({ name: "myproject", path: "/repo/myproject" })),
  loadConfig: vi.fn(() => ({ projects: {}, plots: {} })),
  plotsMap: vi.fn(() => ({})),
  SESSIONS_DIR: "/tmp/fake-sessions",
}));

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
}));

vi.mock("../src/dashboard/tmux.js", () => ({
  tmux: vi.fn(),
  tmuxDisplay: vi.fn(),
  tmuxNewWindow: vi.fn(() => "%10"),
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

vi.mock("../src/dashboard/registry.js", () => ({
  addWorker: vi.fn(),
  removeWorker: vi.fn(),
  findWorkerByName: vi.fn(() => null),
  getAllWorkerNames: vi.fn(() => []),
  getWorkers: vi.fn(() => []),
  updateWorkerFields: vi.fn(),
}));

vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/dashboard/create.js", () => ({
  buildWorktreeBootstrapScript: vi.fn(() => "/tmp/fake-bootstrap.sh"),
  buildWorktreeResumeCommand: vi.fn(() => "claude --resume FAKE-ID"),
  buildResumeCommand: vi.fn(() => "claude --resume FAKE-ID-NW"),
  createShellWindow: vi.fn(),
  installClaudeHooks: vi.fn(),
  trellisRelativePathForEntry: vi.fn(() => undefined),
}));

vi.mock("../src/dashboard/runner.js", () => ({
  resolveGardenRunner: vi.fn(() => "garden"),
}));

vi.mock("../src/dashboard/git.js", () => ({
  worktreePath: vi.fn(() => "/home/user/.garden/worktrees/myproject/bold-ash"),
  resolveBaseBranch: vi.fn(() => "main"),
  branchExistsOnOrigin: vi.fn(() => true),
  tryPublishBranch: vi.fn(() => ({ ok: true })),
  gardenDoneTrackedInHead: vi.fn(() => false),
}));

vi.mock("../src/dashboard/alerts.js", () => ({
  addAlert: vi.fn(),
}));

vi.mock("../src/dashboard/poller.js", () => ({
  ensureProjectPoller: vi.fn(),
  killReviewWindow: vi.fn(),
  stopProjectPoller: vi.fn(),
}));

// --- Imports (after mocks) ---

import { newWorker, killPane, bounceWorker, bounceActiveWorker } from "../src/dashboard/workers.js";
import { readDashState, writeDashState, withStateLock } from "../src/dashboard/state.js";
import { parkToHidden, restoreFromHidden } from "../src/dashboard/layout.js";
import { refreshDashboard } from "../src/dashboard/header.js";
import {
  tmux, tmuxDisplay, tmuxNewWindow, setPaneLabel, setPaneVar,
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
  createShellWindow, installClaudeHooks,
} from "../src/dashboard/create.js";
import { resolveGardenRunner } from "../src/dashboard/runner.js";
import {
  worktreePath, resolveBaseBranch, branchExistsOnOrigin, tryPublishBranch,
  gardenDoneTrackedInHead,
} from "../src/dashboard/git.js";
import { addAlert } from "../src/dashboard/alerts.js";
import { ensureProjectPoller, killReviewWindow, stopProjectPoller } from "../src/dashboard/poller.js";
import { workerWindowName as workerWin, shellWindowName as shellWin, parseWorkerSuffix } from "../src/dashboard/window-names.js";
import { getProject, tryGetProject } from "../src/config.js";
import { spawn } from "node:child_process";
import fs from "node:fs";
import crypto from "node:crypto";
import type { DashboardState } from "../src/dashboard/state.js";

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
  vi.mocked(tmuxNewWindow).mockReturnValue("%10");
  vi.mocked(getFirstPaneId).mockReturnValue("%20");
  vi.mocked(listHiddenWorkerWindows).mockReturnValue([]);
  vi.mocked(getWorkers).mockReturnValue([]);
  vi.mocked(findWorkerByName).mockReturnValue(null);
  vi.mocked(getPaneSize).mockReturnValue({ width: 120, height: 50 });
  vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error("ENOENT"); });
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
    expect(vi.mocked(tmuxNewWindow)).toHaveBeenCalledWith(
      "-d", "-t", "garden-dashboard", "-n", "_myproject-worker-bold-ash",
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
      claudeStatus: "loading",
      workflow: "default",
    });
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
    expect(vi.mocked(tmuxNewWindow)).toHaveBeenCalledWith(
      "-d", "-t", "garden-dashboard", "-n", "_other-worker-bold-ash",
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

  it("rolls back the registry entry when tmuxNewWindow throws so a sandbox-blocked spawn doesn't leave a ghost", () => {
    vi.mocked(readDashState).mockReturnValue(makeState({ activeProject: "myproject" }));
    vi.mocked(tryGetProject).mockReturnValueOnce({ name: "other", path: "/repo/other" });
    vi.mocked(tmuxNewWindow).mockImplementationOnce(() => {
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
    );
    const respawnCall = vi.mocked(tmux).mock.calls.find(c => c[0] === "respawn-pane");
    expect(respawnCall).toBeDefined();
    expect(respawnCall).toEqual(expect.arrayContaining([
      "respawn-pane", "-k", "-c", "/wt/swift-oak", "-t", "%2",
      "sh", "-c", "claude --resume FAKE-ID",
    ]));
  });

  it("writes claudeStatus=idle because --resume skips SessionStart", () => {
    bounceWorker("myproject", "swift-oak");

    expect(vi.mocked(updateWorkerFields)).toHaveBeenCalledWith(
      "myproject", "swift-oak", { claudeStatus: "idle" },
    );
  });

  it("reinstalls claude hooks so settings.json picks up rebuild changes", () => {
    bounceWorker("myproject", "swift-oak");

    expect(vi.mocked(installClaudeHooks)).toHaveBeenCalledWith(
      "/wt/swift-oak", expect.objectContaining({ path: "/repo/myproject" }),
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
      claudeStatus: "working",
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
      claudeStatus: "idle",
    });

    bounceWorker("myproject", "swift-oak");

    const continueCall = vi.mocked(spawn).mock.calls.find(c =>
      Array.isArray(c[1]) && (c[1] as string[])[1]?.includes("_continue-worker"),
    );
    expect(continueCall).toBeUndefined();
  });

  it("captures wasWorking before overwriting claudeStatus to idle (call order)", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "swift-oak", sessionId: "sess-abc", task: "",
      branchName: "swift-oak", worktreePath: "/wt/swift-oak",
      claudeStatus: "working",
    });

    bounceWorker("myproject", "swift-oak");

    // updateWorkerFields(...claudeStatus: idle) is called; the dispatch must
    // still see "working" because we snapshotted entry.claudeStatus pre-write.
    expect(vi.mocked(updateWorkerFields)).toHaveBeenCalledWith(
      "myproject", "swift-oak", { claudeStatus: "idle" },
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

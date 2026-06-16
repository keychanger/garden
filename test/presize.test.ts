import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/session.js", () => ({
  DASHBOARD_SESSION: "garden-dashboard",
  dashboardExists: vi.fn(),
}));

vi.mock("../src/config.js", () => ({
  loadConfig: vi.fn(),
  tryGetProject: vi.fn(),
  getFocusedProjectNames: vi.fn(),
  SESSIONS_DIR: "/tmp/test-sessions",
  GARDEN_DIR: "/tmp/test-garden",
}));

vi.mock("../src/rules.js", () => ({
  buildRulesContext: vi.fn(),
  buildWorktreeRules: vi.fn(),
}));

vi.mock("../src/dashboard/state.js", () => ({
  readDashState: vi.fn(),
  writeDashState: vi.fn(),
  STATE_FILE: "/tmp/test-state.json",
}));

vi.mock("../src/dashboard/layout.js", () => ({
  restoreFromHidden: vi.fn(),
}));

vi.mock("../src/dashboard/hotkeys.js", () => ({
  setupKeybindings: vi.fn(),
}));

vi.mock("../src/dashboard/header.js", () => ({
  setupStatusBar: vi.fn(),
  buildStatusCommand: vi.fn(),
  updateHeaderVar: vi.fn(),
}));

vi.mock("../src/dashboard/tmux.js", () => ({
  tmux: vi.fn(),
  tmuxOutput: vi.fn(),
  tmuxSplit: vi.fn(),
  setPaneTitle: vi.fn(),
  setPaneLabel: vi.fn(),
  setPaneVar: vi.fn(),
  getFirstPaneId: vi.fn(),
  shellEscape: vi.fn((s: string) => s),
  getPaneSize: vi.fn(),
  resizeWindow: vi.fn(),
  listSessionPanes: vi.fn(() => []),
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
  validateAndHeal: vi.fn(),
}));

vi.mock("../src/dashboard/poller.js", () => ({
  startProjectPoller: vi.fn(),
  signalFifoPath: vi.fn(),
}));

vi.mock("../src/dashboard/git.js", () => ({
  installPollTriggerHook: vi.fn(),
  worktreeExists: vi.fn(),
  resolveBaseBranch: vi.fn(),
  getWorkerBaseBranch: vi.fn(() => "main"),
}));

import { presizeHiddenWindows } from "../src/dashboard/create.js";
import { getPaneSize, resizeWindow, listSessionPanes } from "../src/dashboard/tmux.js";
import type { SessionPane } from "../src/dashboard/tmux.js";
import type { DashboardState } from "../src/dashboard/state.js";

// Hidden windows are reported as a single stale-sized pane so the drift guard
// always fires a resize. The drift-skip case overrides this with matching sizes.
function panes(...names: string[]): SessionPane[] {
  return names.map((windowName, i) => ({
    windowName, paneId: `%${100 + i}`, width: 80, height: 24,
  }));
}

function makeState(overrides: Partial<DashboardState> = {}): DashboardState {
  return {
    activeProject: "garden",
    statusPaneId: "%0",
    gardenShellPaneId: "%1",
    activePaneId: "%2",
    activePaneType: "worker",
    activeWindowName: "_garden-worker-bold-ash",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("presizeHiddenWindows", () => {
  it("resizes worker and shell windows to right pane size", () => {
    vi.mocked(getPaneSize).mockReturnValue({ width: 129, height: 58 });
    vi.mocked(listSessionPanes).mockReturnValue(panes(
      "main", "_garden-worker-bold-ash", "_api-shell",
    ));

    presizeHiddenWindows(makeState());

    expect(resizeWindow).toHaveBeenCalledWith("_garden-worker-bold-ash", 129, 58);
    expect(resizeWindow).toHaveBeenCalledWith("_api-shell", 129, 58);
  });

  it("resizes garden pane windows to garden pane size", () => {
    vi.mocked(getPaneSize)
      .mockReturnValueOnce({ width: 129, height: 58 })
      .mockReturnValueOnce({ width: 60, height: 20 });
    vi.mocked(listSessionPanes).mockReturnValue(panes(
      "main", "_garden-growhouse", "_garden-root", "_garden-logs",
    ));

    presizeHiddenWindows(makeState());

    expect(resizeWindow).toHaveBeenCalledWith("_garden-growhouse", 60, 20);
    expect(resizeWindow).toHaveBeenCalledWith("_garden-root", 60, 20);
    expect(resizeWindow).toHaveBeenCalledWith("_garden-logs", 60, 20);
    expect(resizeWindow).toHaveBeenCalledTimes(3);
  });

  it("skips poller and review windows", () => {
    vi.mocked(getPaneSize).mockReturnValue({ width: 129, height: 58 });
    vi.mocked(listSessionPanes).mockReturnValue(panes(
      "main", "_garden-poller", "_api-poller", "_garden-review-bold-ash",
    ));

    presizeHiddenWindows(makeState());

    expect(resizeWindow).not.toHaveBeenCalled();
  });

  it("skips main window", () => {
    vi.mocked(getPaneSize).mockReturnValue({ width: 129, height: 58 });
    vi.mocked(listSessionPanes).mockReturnValue(panes("main"));

    presizeHiddenWindows(makeState());

    expect(resizeWindow).not.toHaveBeenCalled();
  });

  it("skips windows already at the target size (drift guard)", () => {
    vi.mocked(getPaneSize).mockReturnValue({ width: 129, height: 58 });
    vi.mocked(listSessionPanes).mockReturnValue([
      { windowName: "main", paneId: "%0", width: 129, height: 58 },
      // Already at the right-slot size — must not be re-resized (no needless SIGWINCH).
      { windowName: "_garden-worker-bold-ash", paneId: "%1", width: 129, height: 58 },
      // Drifted (stale narrow width) — must be resized to the current slot.
      { windowName: "_api-shell", paneId: "%2", width: 80, height: 24 },
    ]);

    presizeHiddenWindows(makeState());

    expect(resizeWindow).toHaveBeenCalledWith("_api-shell", 129, 58);
    expect(resizeWindow).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when both pane sizes are null", () => {
    vi.mocked(getPaneSize).mockReturnValue(null);

    presizeHiddenWindows(makeState());

    expect(listSessionPanes).not.toHaveBeenCalled();
    expect(resizeWindow).not.toHaveBeenCalled();
  });

  it("handles mixed window types correctly", () => {
    vi.mocked(getPaneSize)
      .mockReturnValueOnce({ width: 129, height: 58 })
      .mockReturnValueOnce({ width: 60, height: 20 });
    vi.mocked(listSessionPanes).mockReturnValue(panes(
      "main",
      "_garden-growhouse", "_garden-root", "_garden-logs",
      "_garden-worker-bold-ash", "_api-shell",
      "_garden-poller", "_api-review-calm-bay",
    ));

    presizeHiddenWindows(makeState());

    expect(resizeWindow).toHaveBeenCalledWith("_garden-growhouse", 60, 20);
    expect(resizeWindow).toHaveBeenCalledWith("_garden-root", 60, 20);
    expect(resizeWindow).toHaveBeenCalledWith("_garden-logs", 60, 20);
    expect(resizeWindow).toHaveBeenCalledWith("_garden-worker-bold-ash", 129, 58);
    expect(resizeWindow).toHaveBeenCalledWith("_api-shell", 129, 58);
    expect(resizeWindow).toHaveBeenCalledTimes(5);
  });

  it("skips worker resize when only garden size is available", () => {
    vi.mocked(getPaneSize)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({ width: 60, height: 20 });
    vi.mocked(listSessionPanes).mockReturnValue(panes(
      "main", "_garden-growhouse", "_garden-worker-bold-ash",
    ));

    presizeHiddenWindows(makeState());

    expect(resizeWindow).toHaveBeenCalledWith("_garden-growhouse", 60, 20);
    expect(resizeWindow).toHaveBeenCalledTimes(1);
  });
});

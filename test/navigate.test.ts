import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// --- Mocks ---

vi.mock("node:fs", () => ({
  default: {
    openSync: vi.fn(() => 3),
    closeSync: vi.fn(),
    unlinkSync: vi.fn(),
    constants: { O_CREAT: 0x100, O_EXCL: 0x200, O_WRONLY: 0x1 },
  },
}));

vi.mock("../src/config.js", () => ({
  logColorKeyForProject: vi.fn(() => null),
  loadConfig: vi.fn(() => ({
    projects: {
      garden: { path: "/repo/garden" },
      other: { path: "/repo/other" },
    },
  })),
  getProject: vi.fn((name: string) => ({ name, path: `/repo/${name}` })),
  getFocusedProjectNames: vi.fn(() => ["garden", "other"]),
  plotsMap: vi.fn(() => ({})),
  isPlotFocused: (plot: { focused?: boolean }) => plot.focused !== false,
  SESSIONS_DIR: "/tmp/fake-sessions",
  GARDEN_DIR: "/tmp/fake-garden",
}));

vi.mock("../src/dashboard/state.js", () => ({
  readDashState: vi.fn(),
  writeDashState: vi.fn(),
  withStateLock: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock("../src/dashboard/layout.js", () => ({
  parkToHidden: vi.fn(),
  restoreFromHidden: vi.fn(),
  swapToHidden: vi.fn(),
  swapDirect: vi.fn(() => true),
  gardenSwapToHidden: vi.fn(),
  gardenRestoreFromHidden: vi.fn(),
}));

vi.mock("../src/dashboard/header.js", () => ({
  refreshDashboard: vi.fn(),
  refreshDashboardCycle: vi.fn(),
  refreshDashboardPlotCycle: vi.fn(),
  setPaneProjectColor: vi.fn(),
}));

vi.mock("../src/dashboard/tmux.js", () => ({
  tmux: vi.fn(),
  tmuxDisplay: vi.fn(),
  paneExists: vi.fn(() => true),
  windowExists: vi.fn(() => false),
  getFirstPaneId: vi.fn(() => null),
  listAllWindowNames: vi.fn(() => []),
  listHiddenWorkerWindows: vi.fn(() => []),
  setPaneLabel: vi.fn(),
  setPaneVar: vi.fn(),
}));

vi.mock("../src/dashboard/registry.js", () => ({
  findWorkerByName: vi.fn(() => null),
}));

vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/dashboard/alerts.js", () => ({
  acknowledgeAlerts: vi.fn(),
}));

vi.mock("../src/dashboard/create.js", () => ({
  createShellWindow: vi.fn(),
  createLogsWindow: vi.fn(),
  createGardenRootWindow: vi.fn(),
  createGardenGrowhouseWindow: vi.fn(),
  createGardenHistoryWindow: vi.fn(),
  createGardenDiaryWindow: vi.fn(),
}));

vi.mock("../src/dashboard/runner.js", () => ({
  resolveGardenRunner: vi.fn(() => "/usr/bin/garden"),
}));

vi.mock("../src/session.js", () => ({
  DASHBOARD_SESSION: "garden-dashboard",
}));

vi.mock("../src/dashboard/window-names.js", async () => {
  const actual = await vi.importActual<typeof import("../src/dashboard/window-names.js")>("../src/dashboard/window-names.js");
  return actual;
});

// --- Imports ---

import {
  switchProject,
  focusWorker,
  focusShell,
  focusGrowhouse,
  focusRoot,
  focusLogs,
  focusHistory,
  focusDiary,
  cyclePane,
  cyclePlot,
} from "../src/dashboard/navigate.js";

import { readDashState, writeDashState } from "../src/dashboard/state.js";
import { parkToHidden, restoreFromHidden, swapToHidden, swapDirect, gardenSwapToHidden } from "../src/dashboard/layout.js";
import { refreshDashboard, setPaneProjectColor } from "../src/dashboard/header.js";
import {
  tmux, tmuxDisplay, paneExists, windowExists, getFirstPaneId,
  listAllWindowNames, listHiddenWorkerWindows,
  setPaneLabel, setPaneVar,
} from "../src/dashboard/tmux.js";
import { findWorkerByName } from "../src/dashboard/registry.js";
import { plotsMap, getFocusedProjectNames } from "../src/config.js";
import { acknowledgeAlerts } from "../src/dashboard/alerts.js";
import { createShellWindow, createLogsWindow, createGardenRootWindow, createGardenGrowhouseWindow, createGardenHistoryWindow, createGardenDiaryWindow } from "../src/dashboard/create.js";
import type { DashboardState } from "../src/dashboard/state.js";

// --- Helpers ---

function makeState(overrides: Partial<DashboardState> = {}): DashboardState {
  return {
    activeProject: "garden",
    statusPaneId: "%0",
    gardenShellPaneId: "%1",
    gardenPaneType: "growhouse",
    gardenWindowName: "_garden-growhouse",
    activePaneId: "%2",
    activePaneType: "worker",
    activeWindowName: "_garden-worker-bold-ash",
    lastActiveWorker: {},
    lastActiveProjectByPlot: {},
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(paneExists).mockReturnValue(true);
  vi.mocked(windowExists).mockReturnValue(false);
  vi.mocked(listAllWindowNames).mockReturnValue([]);
  vi.mocked(listHiddenWorkerWindows).mockReturnValue([]);
  vi.mocked(swapDirect).mockReturnValue(true);
  vi.mocked(findWorkerByName).mockReturnValue(null);
});

// =============================================================================
// switchProject
// =============================================================================

describe("switchProject", () => {
  it("displays message for out-of-bounds index (too high)", () => {
    vi.mocked(readDashState).mockReturnValue(makeState());
    switchProject("99");
    expect(tmuxDisplay).toHaveBeenCalledWith("No project at index 99");
    expect(writeDashState).not.toHaveBeenCalled();
  });

  it("displays message for out-of-bounds index (zero)", () => {
    vi.mocked(readDashState).mockReturnValue(makeState());
    switchProject("0");
    expect(tmuxDisplay).toHaveBeenCalledWith("No project at index 0");
  });

  it("displays message when already on the target project", () => {
    vi.mocked(readDashState).mockReturnValue(makeState({ activeProject: "garden" }));
    switchProject("1"); // index 1 -> "garden"
    expect(tmuxDisplay).toHaveBeenCalledWith("Already on garden");
    expect(writeDashState).not.toHaveBeenCalled();
  });

  it("records lastActiveWorker for the project being left", () => {
    const state = makeState({
      activeProject: "garden",
      activePaneType: "worker",
      activeWindowName: "_garden-worker-bold-ash",
    });
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(listAllWindowNames).mockReturnValue(["_other-shell"]);

    switchProject("2"); // switch to "other"

    expect(state.lastActiveWorker["garden"]).toBe("_garden-worker-bold-ash");
  });

  it("does not record lastActiveWorker when leaving a shell pane", () => {
    const state = makeState({
      activeProject: "garden",
      activePaneType: "shell",
      activeWindowName: "_garden-shell",
    });
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(listAllWindowNames).mockReturnValue(["_other-shell"]);

    switchProject("2");

    expect(state.lastActiveWorker["garden"]).toBeUndefined();
  });

  it("restores from parking window when it exists", () => {
    const state = makeState({ activeProject: "garden" });
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(listAllWindowNames).mockReturnValue(["_other-active"]);

    switchProject("2");

    expect(swapDirect).toHaveBeenCalledWith("_garden-worker-bold-ash", "_other-active", state);
    expect(state.activePaneType).toBe("worker");
    expect(state.activeWindowName).toBe("_other-active");
  });

  it("restores preferred last-active worker when available", () => {
    const state = makeState({
      activeProject: "garden",
      lastActiveWorker: { other: "_other-worker-calm-bay" },
    });
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(listAllWindowNames).mockReturnValue([]);
    vi.mocked(listHiddenWorkerWindows).mockReturnValue([
      "_other-worker-bold-ash",
      "_other-worker-calm-bay",
    ]);

    switchProject("2");

    expect(swapDirect).toHaveBeenCalledWith("_garden-worker-bold-ash", "_other-worker-calm-bay", state);
    expect(state.activeWindowName).toBe("_other-worker-calm-bay");
  });

  it("falls back to first worker when preferred is not found", () => {
    const state = makeState({
      activeProject: "garden",
      lastActiveWorker: { other: "_other-worker-gone" },
    });
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(listAllWindowNames).mockReturnValue([]);
    vi.mocked(listHiddenWorkerWindows).mockReturnValue([
      "_other-worker-bold-ash",
      "_other-worker-calm-bay",
    ]);

    switchProject("2");

    expect(swapDirect).toHaveBeenCalledWith("_garden-worker-bold-ash", "_other-worker-bold-ash", state);
  });

  it("restores shell when no workers exist but shell window exists", () => {
    const state = makeState({ activeProject: "garden" });
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(listAllWindowNames).mockReturnValue(["_other-shell"]);
    vi.mocked(listHiddenWorkerWindows).mockReturnValue([]);

    switchProject("2");

    expect(swapDirect).toHaveBeenCalledWith("_garden-worker-bold-ash", "_other-shell", state);
    expect(state.activePaneType).toBe("shell");
    expect(state.activeWindowName).toBe("_other-shell");
  });

  it("creates shell window when nothing exists for the target project", () => {
    const state = makeState({ activeProject: "garden" });
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(listAllWindowNames).mockReturnValue([]);
    vi.mocked(listHiddenWorkerWindows).mockReturnValue([]);

    switchProject("2");

    expect(createShellWindow).toHaveBeenCalledWith("other", "/repo/other");
    expect(swapDirect).toHaveBeenCalledWith("_garden-worker-bold-ash", "_other-shell", state);
    expect(state.activePaneType).toBe("shell");
  });

  it("writes state and refreshes dashboard after switching", () => {
    const state = makeState({ activeProject: "garden" });
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(listAllWindowNames).mockReturnValue(["_other-shell"]);

    switchProject("2");

    expect(state.activeProject).toBe("other");
    expect(writeDashState).toHaveBeenCalledWith(state);
    expect(refreshDashboard).toHaveBeenCalledWith({ state });
  });

  it("restores worker pane vars when switching to a worker pane", () => {
    const state = makeState({ activeProject: "garden", activePaneId: "%2" });
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(listAllWindowNames).mockReturnValue(["_other-active"]);
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "active",
      sessionId: "s1",
      task: "fix bug",
      agentStatus: "working",
    });

    switchProject("2");

    // After restoring from parking, activePaneType is "worker",
    // so restoreWorkerPaneVars should run. The window name "_other-active"
    // does not match worker pattern, so parseWorkerSuffix returns null.
    // This verifies the code path runs without error.
    expect(state.activeProject).toBe("other");
  });
});

// =============================================================================
// focusWorker
// =============================================================================

describe("focusWorker", () => {
  it("displays message when no project selected", () => {
    vi.mocked(readDashState).mockReturnValue(makeState({ activeProject: null }));
    focusWorker();
    expect(tmuxDisplay).toHaveBeenCalledWith("No project selected.");
    expect(writeDashState).not.toHaveBeenCalled();
  });

  it("selects existing pane when already on a worker", () => {
    vi.mocked(readDashState).mockReturnValue(
      makeState({ activePaneType: "worker", activePaneId: "%2" }),
    );
    focusWorker();
    expect(tmux).toHaveBeenCalledWith("select-pane", "-t", "%2");
    expect(writeDashState).not.toHaveBeenCalled();
  });

  it("displays message when no workers exist", () => {
    vi.mocked(readDashState).mockReturnValue(
      makeState({ activePaneType: "shell", activeWindowName: "_garden-shell" }),
    );
    vi.mocked(listHiddenWorkerWindows).mockReturnValue([]);
    focusWorker();
    expect(tmuxDisplay).toHaveBeenCalledWith("No workers. Press \u2325n to create one.");
  });

  it("swaps from shell to preferred last-active worker", () => {
    const state = makeState({
      activePaneType: "shell",
      activeWindowName: "_garden-shell",
      lastActiveWorker: { garden: "_garden-worker-calm-bay" },
    });
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(listHiddenWorkerWindows).mockReturnValue([
      "_garden-worker-bold-ash",
      "_garden-worker-calm-bay",
    ]);

    focusWorker();

    expect(swapToHidden).toHaveBeenCalledWith(
      "_garden-shell", "_garden-worker-calm-bay", state,
    );
    expect(state.activePaneType).toBe("worker");
    expect(state.activeWindowName).toBe("_garden-worker-calm-bay");
    expect(writeDashState).toHaveBeenCalledWith(state);
    expect(refreshDashboard).toHaveBeenCalledWith({ state });
  });

  it("falls back to first worker when preferred is missing", () => {
    const state = makeState({
      activePaneType: "shell",
      activeWindowName: "_garden-shell",
      lastActiveWorker: { garden: "_garden-worker-gone" },
    });
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(listHiddenWorkerWindows).mockReturnValue(["_garden-worker-bold-ash"]);

    focusWorker();

    expect(swapToHidden).toHaveBeenCalledWith(
      "_garden-shell", "_garden-worker-bold-ash", state,
    );
  });

  it("restores pane vars after swapping to worker", () => {
    const state = makeState({
      activePaneType: "shell",
      activeWindowName: "_garden-shell",
      activePaneId: "%2",
    });
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(listHiddenWorkerWindows).mockReturnValue(["_garden-worker-bold-ash"]);
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash",
      sessionId: "s1",
      task: "do stuff",
      agentStatus: "working",
    });

    focusWorker();

    expect(setPaneLabel).toHaveBeenCalledWith("%2", "bold-ash");
    expect(setPaneVar).toHaveBeenCalledWith("%2", "garden_task", "do stuff");
    // Worker panes get a wall clock in their border (gated on @garden_clock).
    expect(setPaneVar).toHaveBeenCalledWith("%2", "garden_clock", "1");
    // ...and the project's log color (gated on @garden_color).
    expect(setPaneProjectColor).toHaveBeenCalledWith("%2", "garden");
  });
});

// =============================================================================
// focusShell
// =============================================================================

describe("focusShell", () => {
  it("displays message when no project selected", () => {
    vi.mocked(readDashState).mockReturnValue(makeState({ activeProject: null }));
    focusShell();
    expect(tmuxDisplay).toHaveBeenCalledWith("No project selected.");
  });

  it("selects existing pane when already on shell", () => {
    vi.mocked(readDashState).mockReturnValue(
      makeState({ activePaneType: "shell", activePaneId: "%5" }),
    );
    focusShell();
    expect(tmux).toHaveBeenCalledWith("select-pane", "-t", "%5");
    expect(writeDashState).not.toHaveBeenCalled();
  });

  it("creates shell window if it does not exist", () => {
    const state = makeState({
      activePaneType: "worker",
      activeWindowName: "_garden-worker-bold-ash",
    });
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(windowExists).mockReturnValue(false);

    focusShell();

    expect(createShellWindow).toHaveBeenCalledWith("garden", "/repo/garden");
    expect(swapToHidden).toHaveBeenCalled();
  });

  it("skips creation when shell window already exists", () => {
    const state = makeState({
      activePaneType: "worker",
      activeWindowName: "_garden-worker-bold-ash",
    });
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(windowExists).mockReturnValue(true);

    focusShell();

    expect(createShellWindow).not.toHaveBeenCalled();
    expect(swapToHidden).toHaveBeenCalledWith(
      "_garden-worker-bold-ash", "_garden-shell", state,
    );
  });

  it("swaps and updates state after focusing shell", () => {
    const state = makeState({
      activePaneType: "worker",
      activeWindowName: "_garden-worker-bold-ash",
    });
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(windowExists).mockReturnValue(true);

    focusShell();

    expect(state.activePaneType).toBe("shell");
    expect(state.activeWindowName).toBe("_garden-shell");
    // The right-pane shell gets the wall clock too (gated on @garden_clock)
    // and the project's log color dot (gated on @garden_color).
    expect(setPaneVar).toHaveBeenCalledWith("%2", "garden_clock", "1");
    expect(setPaneProjectColor).toHaveBeenCalledWith("%2", "garden");
    expect(writeDashState).toHaveBeenCalledWith(state);
    expect(refreshDashboard).toHaveBeenCalledWith({ state });
  });
});

// =============================================================================
// switchGardenTo (via focusGrowhouse, focusRoot, focusLogs)
// =============================================================================

describe("focusGrowhouse / focusRoot / focusLogs (switchGardenTo)", () => {
  it("focusGrowhouse selects existing pane when already on growhouse view", () => {
    vi.mocked(readDashState).mockReturnValue(
      makeState({ gardenPaneType: "growhouse", gardenShellPaneId: "%1" }),
    );
    focusGrowhouse();
    expect(tmux).toHaveBeenCalledWith("select-pane", "-t", "%1");
    expect(writeDashState).not.toHaveBeenCalled();
  });

  it("focusRoot selects existing pane when already on root view", () => {
    vi.mocked(readDashState).mockReturnValue(
      makeState({ gardenPaneType: "root", gardenShellPaneId: "%1" }),
    );
    focusRoot();
    expect(tmux).toHaveBeenCalledWith("select-pane", "-t", "%1");
    expect(writeDashState).not.toHaveBeenCalled();
  });

  it("focusLogs selects existing pane when already on logs view", () => {
    vi.mocked(readDashState).mockReturnValue(
      makeState({ gardenPaneType: "logs", gardenShellPaneId: "%1" }),
    );
    focusLogs();
    expect(tmux).toHaveBeenCalledWith("select-pane", "-t", "%1");
    expect(writeDashState).not.toHaveBeenCalled();
  });

  it("focusLogs always acknowledges alerts even when already on logs", () => {
    vi.mocked(readDashState).mockReturnValue(
      makeState({ gardenPaneType: "logs", gardenShellPaneId: "%1" }),
    );
    focusLogs();
    expect(acknowledgeAlerts).toHaveBeenCalled();
  });

  it("creates growhouse window if missing and switches to it", () => {
    const state = makeState({
      gardenPaneType: "root",
      gardenWindowName: "_garden-root",
    });
    vi.mocked(readDashState).mockReturnValue(state);
    // windowExists returns false -> ensureGardenView creates the window
    vi.mocked(windowExists).mockReturnValue(false);

    focusGrowhouse();

    expect(createGardenGrowhouseWindow).toHaveBeenCalledWith("/usr/bin/garden");
    expect(gardenSwapToHidden).toHaveBeenCalledWith(
      "_garden-root", "_garden-growhouse", state,
    );
    expect(state.gardenPaneType).toBe("growhouse");
    expect(state.gardenWindowName).toBe("_garden-growhouse");
    expect(writeDashState).toHaveBeenCalledWith(state);
  });

  it("creates root window if missing when switching to root", () => {
    const state = makeState({
      gardenPaneType: "growhouse",
      gardenWindowName: "_garden-growhouse",
    });
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(windowExists).mockReturnValue(false);

    focusRoot();

    expect(createGardenRootWindow).toHaveBeenCalled();
    expect(gardenSwapToHidden).toHaveBeenCalledWith(
      "_garden-growhouse", "_garden-root", state,
    );
    expect(state.gardenPaneType).toBe("root");
  });

  it("creates logs window if missing when switching to logs", () => {
    const state = makeState({
      gardenPaneType: "growhouse",
      gardenWindowName: "_garden-growhouse",
    });
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(windowExists).mockReturnValue(false);

    focusLogs();

    expect(createLogsWindow).toHaveBeenCalled();
    expect(state.gardenPaneType).toBe("logs");
    expect(state.gardenWindowName).toBe("_garden-logs");
  });

  it("creates diary window if missing when switching to diary", () => {
    const state = makeState({
      gardenPaneType: "growhouse",
      gardenWindowName: "_garden-growhouse",
    });
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(windowExists).mockReturnValue(false);

    focusDiary();

    expect(createGardenDiaryWindow).toHaveBeenCalledWith("/usr/bin/garden");
    expect(gardenSwapToHidden).toHaveBeenCalledWith(
      "_garden-growhouse", "_garden-diary", state,
    );
    expect(state.gardenPaneType).toBe("diary");
    expect(state.gardenWindowName).toBe("_garden-diary");
  });

  it("focusDiary selects existing pane when already on diary view", () => {
    vi.mocked(readDashState).mockReturnValue(
      makeState({ gardenPaneType: "diary", gardenShellPaneId: "%1" }),
    );
    focusDiary();
    expect(tmux).toHaveBeenCalledWith("select-pane", "-t", "%1");
    expect(writeDashState).not.toHaveBeenCalled();
  });

  it("creates history window if missing when switching to history", () => {
    const state = makeState({
      gardenPaneType: "growhouse",
      gardenWindowName: "_garden-growhouse",
    });
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(windowExists).mockReturnValue(false);

    focusHistory();

    expect(createGardenHistoryWindow).toHaveBeenCalled();
    expect(state.gardenPaneType).toBe("history");
    expect(state.gardenWindowName).toBe("_garden-history");
  });

  it("swaps growhouse pane and sets label", () => {
    const state = makeState({
      gardenPaneType: "growhouse",
      gardenWindowName: "_garden-growhouse",
      gardenShellPaneId: "%1",
    });
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(windowExists).mockReturnValue(true); // window already exists

    focusRoot();

    expect(gardenSwapToHidden).toHaveBeenCalledWith(
      "_garden-growhouse", "_garden-root", state,
    );
    expect(setPaneLabel).toHaveBeenCalledWith("%1", "root");
    expect(refreshDashboard).toHaveBeenCalledWith({ state });
  });
});

// =============================================================================
// cyclePane
// =============================================================================

describe("cyclePane", () => {
  it("displays message when no project selected", () => {
    vi.mocked(readDashState).mockReturnValue(makeState({ activeProject: null }));
    cyclePane(1);
    expect(tmuxDisplay).toHaveBeenCalledWith("No project selected.");
  });

  it("displays message when no workers exist", () => {
    vi.mocked(readDashState).mockReturnValue(
      makeState({ activePaneType: "shell", activeWindowName: "_garden-shell" }),
    );
    vi.mocked(listAllWindowNames).mockReturnValue(["_garden-shell"]);
    vi.mocked(listHiddenWorkerWindows).mockReturnValue([]);

    cyclePane(1);

    expect(tmuxDisplay).toHaveBeenCalledWith("No workers to cycle to. Press \u2325n to create one.");
  });

  it("is a no-op when there is only one worker and it is current", () => {
    vi.mocked(readDashState).mockReturnValue(
      makeState({
        activePaneType: "worker",
        activeWindowName: "_garden-worker-bold-ash",
      }),
    );
    vi.mocked(listAllWindowNames).mockReturnValue(["_garden-worker-bold-ash"]);
    vi.mocked(listHiddenWorkerWindows).mockReturnValue([]);

    cyclePane(1);

    // Target === current, early return
    expect(swapDirect).not.toHaveBeenCalled();
    expect(swapToHidden).not.toHaveBeenCalled();
    expect(writeDashState).not.toHaveBeenCalled();
  });

  it("cycles forward to next worker", () => {
    const state = makeState({
      activePaneType: "worker",
      activeWindowName: "_garden-worker-aaa",
      activePaneId: "%2",
    });
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(listAllWindowNames).mockReturnValue(["_garden-worker-aaa"]);
    vi.mocked(listHiddenWorkerWindows).mockReturnValue(["_garden-worker-bbb"]);

    cyclePane(1);

    expect(swapDirect).toHaveBeenCalledWith(
      "_garden-worker-aaa", "_garden-worker-bbb", state,
    );
    expect(state.activeWindowName).toBe("_garden-worker-bbb");
    expect(state.activePaneType).toBe("worker");
    expect(state.lastActiveWorker["garden"]).toBe("_garden-worker-bbb");
    expect(writeDashState).toHaveBeenCalledWith(state);
  });

  it("cycles backward to previous worker", () => {
    const state = makeState({
      activePaneType: "worker",
      activeWindowName: "_garden-worker-bbb",
      activePaneId: "%2",
    });
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(listAllWindowNames).mockReturnValue(["_garden-worker-bbb"]);
    vi.mocked(listHiddenWorkerWindows).mockReturnValue(["_garden-worker-aaa"]);

    cyclePane(-1);

    expect(swapDirect).toHaveBeenCalledWith(
      "_garden-worker-bbb", "_garden-worker-aaa", state,
    );
    expect(state.activeWindowName).toBe("_garden-worker-aaa");
  });

  it("wraps around forward from last to first", () => {
    const state = makeState({
      activePaneType: "worker",
      activeWindowName: "_garden-worker-ccc",
      activePaneId: "%2",
    });
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(listAllWindowNames).mockReturnValue(["_garden-worker-ccc"]);
    vi.mocked(listHiddenWorkerWindows).mockReturnValue([
      "_garden-worker-aaa",
      "_garden-worker-bbb",
    ]);

    cyclePane(1);

    // Sorted: [aaa, bbb, ccc]. ccc is index 2, forward wraps to 0 -> aaa
    expect(swapDirect).toHaveBeenCalledWith(
      "_garden-worker-ccc", "_garden-worker-aaa", state,
    );
  });

  it("wraps around backward from first to last", () => {
    const state = makeState({
      activePaneType: "worker",
      activeWindowName: "_garden-worker-aaa",
      activePaneId: "%2",
    });
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(listAllWindowNames).mockReturnValue(["_garden-worker-aaa"]);
    vi.mocked(listHiddenWorkerWindows).mockReturnValue([
      "_garden-worker-bbb",
      "_garden-worker-ccc",
    ]);

    cyclePane(-1);

    // Sorted: [aaa, bbb, ccc]. aaa is index 0, backward wraps to 2 -> ccc
    expect(swapDirect).toHaveBeenCalledWith(
      "_garden-worker-aaa", "_garden-worker-ccc", state,
    );
  });

  it("cycles from shell to first worker (forward)", () => {
    const state = makeState({
      activePaneType: "shell",
      activeWindowName: "_garden-shell",
      activePaneId: "%2",
    });
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(listAllWindowNames).mockReturnValue(["_garden-shell"]);
    vi.mocked(listHiddenWorkerWindows).mockReturnValue([
      "_garden-worker-aaa",
      "_garden-worker-bbb",
    ]);

    cyclePane(1);

    // Not on a worker, so currentIdx is -1, direction 1 -> index 0
    expect(swapDirect).toHaveBeenCalledWith(
      "_garden-shell", "_garden-worker-aaa", state,
    );
  });

  it("cycles from shell to last worker (backward)", () => {
    const state = makeState({
      activePaneType: "shell",
      activeWindowName: "_garden-shell",
      activePaneId: "%2",
    });
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(listAllWindowNames).mockReturnValue(["_garden-shell"]);
    vi.mocked(listHiddenWorkerWindows).mockReturnValue([
      "_garden-worker-aaa",
      "_garden-worker-bbb",
    ]);

    cyclePane(-1);

    // Not on a worker, direction -1 -> last index
    expect(swapDirect).toHaveBeenCalledWith(
      "_garden-shell", "_garden-worker-bbb", state,
    );
  });

  it("falls back to swapToHidden when swapDirect returns false", () => {
    const state = makeState({
      activePaneType: "worker",
      activeWindowName: "_garden-worker-aaa",
      activePaneId: "%2",
    });
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(listAllWindowNames).mockReturnValue(["_garden-worker-aaa"]);
    vi.mocked(listHiddenWorkerWindows).mockReturnValue(["_garden-worker-bbb"]);
    vi.mocked(swapDirect).mockReturnValue(false);

    cyclePane(1);

    expect(swapDirect).toHaveBeenCalledWith(
      "_garden-worker-aaa", "_garden-worker-bbb", state,
    );
    expect(swapToHidden).toHaveBeenCalledWith(
      "_garden-worker-aaa", "_garden-worker-bbb", state,
    );
  });

  it("updates window names for refresh after cycle", async () => {
    const state = makeState({
      activePaneType: "worker",
      activeWindowName: "_garden-worker-aaa",
      activePaneId: "%2",
    });
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(listAllWindowNames).mockReturnValue([
      "_garden-worker-aaa",
      "_garden-worker-bbb",
    ]);
    vi.mocked(listHiddenWorkerWindows).mockReturnValue(["_garden-worker-bbb"]);

    cyclePane(1);

    // After swap, target (bbb) is renamed to park name (aaa in this case).
    // The windowNames map replaces "bbb" with "aaa".
    const { refreshDashboardCycle } = await import("../src/dashboard/header.js");
    expect(refreshDashboardCycle).toHaveBeenCalledWith({
      state,
      windowNames: expect.arrayContaining(["_garden-worker-aaa"]),
    });
  });
});

// =============================================================================
// cyclePlot
// =============================================================================

describe("cyclePlot", () => {
  it("displays message when no focused plots exist", () => {
    vi.mocked(readDashState).mockReturnValue(makeState());
    vi.mocked(plotsMap).mockReturnValue({
      hidden: { projects: [], focused: false },
    });

    cyclePlot(1);

    expect(tmuxDisplay).toHaveBeenCalledWith(
      expect.stringContaining("No focused plots"),
    );
    expect(writeDashState).not.toHaveBeenCalled();
  });

  it("displays message when only one focused plot exists", () => {
    vi.mocked(readDashState).mockReturnValue(makeState({ activePlot: "lone" }));
    vi.mocked(plotsMap).mockReturnValue({
      lone: { projects: [] },
    });

    cyclePlot(1);

    expect(tmuxDisplay).toHaveBeenCalledWith(
      expect.stringContaining("Only one focused plot"),
    );
    expect(writeDashState).not.toHaveBeenCalled();
  });

  it("cycles forward from current to next focused plot, wrapping around", () => {
    const state = makeState({ activePlot: "b", activeProject: "garden" });
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(plotsMap).mockReturnValue({
      a: { projects: ["garden"] },
      b: { projects: ["garden"] },
      c: { projects: ["garden"] },
    });
    vi.mocked(getFocusedProjectNames).mockReturnValue(["garden"]);

    cyclePlot(1);
    expect(state.activePlot).toBe("c");
    expect(writeDashState).toHaveBeenCalledWith(state);
  });

  it("cycles backward, wrapping past index 0", () => {
    const state = makeState({ activePlot: "a", activeProject: "garden" });
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(plotsMap).mockReturnValue({
      a: { projects: ["garden"] },
      b: { projects: ["garden"] },
      c: { projects: ["garden"] },
    });
    vi.mocked(getFocusedProjectNames).mockReturnValue(["garden"]);

    cyclePlot(-1);
    expect(state.activePlot).toBe("c");
  });

  it("skips unfocused plots entirely", () => {
    const state = makeState({ activePlot: "a", activeProject: "garden" });
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(plotsMap).mockReturnValue({
      a: { projects: ["garden"] },
      hidden: { projects: [], focused: false },
      c: { projects: ["garden"] },
    });
    vi.mocked(getFocusedProjectNames).mockReturnValue(["garden"]);

    cyclePlot(1);
    expect(state.activePlot).toBe("c");
  });

  it("lands on first focused plot when current activePlot is not focused", () => {
    const state = makeState({ activePlot: "hidden", activeProject: "garden" });
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(plotsMap).mockReturnValue({
      a: { projects: ["garden"] },
      b: { projects: ["garden"] },
      hidden: { projects: [], focused: false },
    });
    vi.mocked(getFocusedProjectNames).mockReturnValue(["garden"]);

    cyclePlot(1);
    expect(state.activePlot).toBe("a");
  });

  it("clamps activeProject to the new plot when current project is missing", () => {
    const state = makeState({ activePlot: "a", activeProject: "garden" });
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(plotsMap).mockReturnValue({
      a: { projects: ["garden"] },
      b: { projects: ["other"] },
    });
    vi.mocked(getFocusedProjectNames).mockReturnValue(["other"]);

    cyclePlot(1);
    expect(state.activePlot).toBe("b");
    expect(state.activeProject).toBe("other");
  });

  it("swaps the visible pane when clamping so activeWindowName matches the new project", () => {
    // Regression: without the swap, activeWindowName stayed at
    // _garden-worker-bold-ash even though activeProject became "other",
    // and renderQuickStatus attributed the garden worker to project "other".
    const state = makeState({
      activePlot: "a",
      activeProject: "garden",
      activeWindowName: "_garden-worker-bold-ash",
      activePaneType: "worker",
    });
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(plotsMap).mockReturnValue({
      a: { projects: ["garden"] },
      b: { projects: ["other"] },
    });
    vi.mocked(getFocusedProjectNames).mockReturnValue(["other"]);
    // New project has no parked worker and no hidden workers — should land on its shell.
    vi.mocked(listAllWindowNames).mockReturnValue(["_other-shell"]);
    vi.mocked(listHiddenWorkerWindows).mockReturnValue([]);

    cyclePlot(1);

    expect(state.activeProject).toBe("other");
    expect(state.activeWindowName).toBe("_other-shell");
    expect(state.activePaneType).toBe("shell");
    expect(swapDirect).toHaveBeenCalledWith("_garden-worker-bold-ash", "_other-shell", state);
    // Last worker for garden recorded so re-entry restores it.
    expect(state.lastActiveWorker.garden).toBe("_garden-worker-bold-ash");
  });

  it("keeps activeProject when it is a member of the new plot", () => {
    const state = makeState({ activePlot: "a", activeProject: "garden" });
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(plotsMap).mockReturnValue({
      a: { projects: ["garden"] },
      b: { projects: ["garden", "other"] },
    });
    vi.mocked(getFocusedProjectNames).mockReturnValue(["garden", "other"]);

    cyclePlot(1);
    expect(state.activePlot).toBe("b");
    expect(state.activeProject).toBe("garden");
  });

  it("does not swap panes when activeProject stays in the new plot", () => {
    const state = makeState({
      activePlot: "a",
      activeProject: "garden",
      activeWindowName: "_garden-worker-bold-ash",
      activePaneType: "worker",
    });
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(plotsMap).mockReturnValue({
      a: { projects: ["garden"] },
      b: { projects: ["garden", "other"] },
    });
    vi.mocked(getFocusedProjectNames).mockReturnValue(["garden", "other"]);

    cyclePlot(1);

    expect(state.activeWindowName).toBe("_garden-worker-bold-ash");
    expect(parkToHidden).not.toHaveBeenCalled();
    expect(restoreFromHidden).not.toHaveBeenCalled();
  });

  it("records the leaving plot's active project in lastActiveProjectByPlot", () => {
    const state = makeState({ activePlot: "a", activeProject: "garden" });
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(plotsMap).mockReturnValue({
      a: { projects: ["garden"] },
      b: { projects: ["other"] },
    });
    vi.mocked(getFocusedProjectNames).mockReturnValue(["other"]);

    cyclePlot(1);

    expect(state.lastActiveProjectByPlot.a).toBe("garden");
  });

  it("restores the remembered project when cycling back to a plot", () => {
    // Target plot "a" had "garden" active last; current activeProject "other"
    // is not in "a" — without memory we'd fall back to first project ("foo").
    const state = makeState({
      activePlot: "b",
      activeProject: "other",
      activeWindowName: "_other-shell",
      activePaneType: "shell",
      lastActiveProjectByPlot: { a: "garden" },
    });
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(plotsMap).mockReturnValue({
      a: { projects: ["foo", "garden"] },
      b: { projects: ["other"] },
    });
    vi.mocked(getFocusedProjectNames).mockReturnValue(["foo", "garden"]);
    vi.mocked(listAllWindowNames).mockReturnValue(["_garden-shell"]);
    vi.mocked(listHiddenWorkerWindows).mockReturnValue([]);

    cyclePlot(-1);

    expect(state.activePlot).toBe("a");
    expect(state.activeProject).toBe("garden");
  });

  it("falls back to first project when remembered project is no longer in the plot", () => {
    const state = makeState({
      activePlot: "b",
      activeProject: "other",
      lastActiveProjectByPlot: { a: "gone" },
    });
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(plotsMap).mockReturnValue({
      a: { projects: ["foo", "garden"] },
      b: { projects: ["other"] },
    });
    vi.mocked(getFocusedProjectNames).mockReturnValue(["foo", "garden"]);
    vi.mocked(listAllWindowNames).mockReturnValue(["_foo-shell"]);
    vi.mocked(listHiddenWorkerWindows).mockReturnValue([]);

    cyclePlot(-1);

    expect(state.activeProject).toBe("foo");
  });

  it("prefers remembered project even when current activeProject is also valid", () => {
    // Both plots share "garden"; current is "garden" but plot "b" remembers
    // "other" — cycling to "b" should land on the remembered "other".
    const state = makeState({
      activePlot: "a",
      activeProject: "garden",
      activeWindowName: "_garden-worker-bold-ash",
      activePaneType: "worker",
      lastActiveProjectByPlot: { b: "other" },
    });
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(plotsMap).mockReturnValue({
      a: { projects: ["garden"] },
      b: { projects: ["garden", "other"] },
    });
    vi.mocked(getFocusedProjectNames).mockReturnValue(["garden", "other"]);
    vi.mocked(listAllWindowNames).mockReturnValue(["_other-shell"]);
    vi.mocked(listHiddenWorkerWindows).mockReturnValue([]);

    cyclePlot(1);

    expect(state.activePlot).toBe("b");
    expect(state.activeProject).toBe("other");
  });
});

// =============================================================================
// diary follow-on-switch (reloadDiaryEditor)
// =============================================================================

describe("diary follows project switches", () => {
  // diary-view.sh reopens the focused project's diary whenever the editor
  // exits. When the diary editor is alive — live in the visible garden slot or
  // parked in the hidden _garden-diary window after the operator switched the
  // garden pane to another view — a project switch drives nano's save+exit
  // (^O Enter ^X) so the loop reopens on the now-focused project without losing
  // unsaved notes. See reloadDiaryEditor in navigate.ts.
  const originalEditor = process.env.EDITOR;

  function sentSaveExit(pane = "%1"): boolean {
    const expected = ["send-keys", "-t", pane, "C-o", "Enter", "C-x"];
    return vi.mocked(tmux).mock.calls.some(
      (call) => JSON.stringify(call) === JSON.stringify(expected),
    );
  }

  beforeEach(() => {
    delete process.env.EDITOR; // unset -> nano default
    vi.mocked(getFirstPaneId).mockReturnValue(null);
  });

  afterEach(() => {
    if (originalEditor === undefined) delete process.env.EDITOR;
    else process.env.EDITOR = originalEditor;
  });

  it("drives nano save+exit when switching projects with the diary pane active", () => {
    const state = makeState({
      activeProject: "garden",
      gardenPaneType: "diary",
      gardenShellPaneId: "%1",
    });
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(listAllWindowNames).mockReturnValue(["_other-shell"]);

    switchProject("2"); // switch to "other"

    expect(state.activeProject).toBe("other");
    expect(sentSaveExit()).toBe(true);
  });

  it("does not touch the editor when no diary editor is alive", () => {
    // Diary view never opened: no live pane and no parked _garden-diary window.
    const state = makeState({
      activeProject: "garden",
      gardenPaneType: "growhouse",
      gardenShellPaneId: "%1",
    });
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(getFirstPaneId).mockReturnValue(null); // no parked diary window
    vi.mocked(listAllWindowNames).mockReturnValue(["_other-shell"]);

    switchProject("2");

    expect(sentSaveExit()).toBe(false);
  });

  it("reloads a parked diary editor when switching projects from another view", () => {
    // Repro: diary opened on garden, operator switched the garden pane to logs
    // (parking the diary's nano in _garden-diary), then switched project. The
    // parked editor must reload or re-entering the diary view shows garden's
    // diary while focused on the new project.
    const state = makeState({
      activeProject: "garden",
      gardenPaneType: "logs",
      gardenShellPaneId: "%1", // visible slot holds logs, not the diary
    });
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(getFirstPaneId).mockReturnValue("%7"); // parked _garden-diary pane
    vi.mocked(listAllWindowNames).mockReturnValue(["_other-shell"]);

    switchProject("2");

    expect(state.activeProject).toBe("other");
    expect(sentSaveExit("%7")).toBe(true); // drove save+exit on the parked pane
    expect(sentSaveExit("%1")).toBe(false); // not the logs pane
  });

  it("leaves a custom $EDITOR untouched (cannot drive its save keys blindly)", () => {
    process.env.EDITOR = "vim";
    const state = makeState({
      activeProject: "garden",
      gardenPaneType: "diary",
      gardenShellPaneId: "%1",
    });
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(listAllWindowNames).mockReturnValue(["_other-shell"]);

    switchProject("2");

    expect(sentSaveExit()).toBe(false);
  });

  it("matches nano even when $EDITOR carries a path and flags", () => {
    process.env.EDITOR = "/opt/homebrew/bin/nano -w";
    const state = makeState({
      activeProject: "garden",
      gardenPaneType: "diary",
      gardenShellPaneId: "%1",
    });
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(listAllWindowNames).mockReturnValue(["_other-shell"]);

    switchProject("2");

    expect(sentSaveExit()).toBe(true);
  });

  it("reloads the diary on cyclePlot when the project changes", () => {
    const state = makeState({
      activePlot: "a",
      activeProject: "garden",
      gardenPaneType: "diary",
      gardenShellPaneId: "%1",
    });
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(plotsMap).mockReturnValue({
      a: { projects: ["garden"] },
      b: { projects: ["other"] },
    });
    vi.mocked(getFocusedProjectNames).mockReturnValue(["other"]);
    vi.mocked(listAllWindowNames).mockReturnValue(["_other-shell"]);
    vi.mocked(listHiddenWorkerWindows).mockReturnValue([]);

    cyclePlot(1);

    expect(state.activeProject).toBe("other");
    expect(sentSaveExit()).toBe(true);
  });

  it("does not reload the diary on cyclePlot when the project stays the same", () => {
    const state = makeState({
      activePlot: "a",
      activeProject: "garden",
      gardenPaneType: "diary",
      gardenShellPaneId: "%1",
    });
    vi.mocked(readDashState).mockReturnValue(state);
    vi.mocked(plotsMap).mockReturnValue({
      a: { projects: ["garden"] },
      b: { projects: ["garden", "other"] },
    });
    vi.mocked(getFocusedProjectNames).mockReturnValue(["garden", "other"]);

    cyclePlot(1);

    expect(state.activePlot).toBe("b");
    expect(state.activeProject).toBe("garden");
    expect(sentSaveExit()).toBe(false);
  });
});

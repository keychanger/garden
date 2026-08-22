import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/session.js", () => ({
  DASHBOARD_SESSION: "garden-dashboard",
}));

vi.mock("../src/dashboard/tmux.js", () => ({
  tmux: vi.fn(),
  newDashboardWindowPaned: vi.fn(),
  getFirstPaneId: vi.fn(),
  windowExists: vi.fn(() => false),
  killWindowSafe: vi.fn(),
  paneExists: vi.fn(() => true),
  getPaneSize: vi.fn(() => ({ width: 129, height: 58 })),
  resizeWindow: vi.fn(),
  listSessionPanes: vi.fn(() => []),
  renameWindowById: vi.fn(() => true),
  resizeWindowById: vi.fn(),
  killWindowById: vi.fn(() => true),
  paneRunningOnlyShell: vi.fn(() => true),
}));

vi.mock("../src/dashboard/log.js", () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { parkToHidden, restoreFromHidden, swapToHidden, swapDirect } from "../src/dashboard/layout.js";
import {
  tmux, newDashboardWindowPaned, getFirstPaneId, killWindowSafe, paneExists,
  getPaneSize, resizeWindow, listSessionPanes, renameWindowById, resizeWindowById,
  killWindowById, paneRunningOnlyShell, type SessionPane,
} from "../src/dashboard/tmux.js";
import type { DashboardState } from "../src/dashboard/state.js";

function pane(windowId: string, windowName: string, paneId: string, extra: Partial<SessionPane> = {}): SessionPane {
  return { windowId, windowName, paneId, width: 129, height: 58, panePath: "/tmp", ...extra };
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
  vi.mocked(paneExists).mockReturnValue(true);
  vi.mocked(listSessionPanes).mockReturnValue([]);
  vi.mocked(paneRunningOnlyShell).mockReturnValue(true);
  vi.mocked(renameWindowById).mockReturnValue(true);
  vi.mocked(killWindowById).mockReturnValue(true);
});

describe("parkToHidden", () => {
  it("creates hidden window and swaps pane into it", () => {
    vi.mocked(newDashboardWindowPaned).mockReturnValue("%10");
    const state = makeState();
    parkToHidden("_garden-worker-bold-ash", state);

    expect(vi.mocked(newDashboardWindowPaned)).toHaveBeenCalledWith(
      "_garden-worker-bold-ash"
    );
    expect(vi.mocked(resizeWindow)).toHaveBeenCalledWith("_garden-worker-bold-ash", 129, 58);
    expect(vi.mocked(tmux)).toHaveBeenCalledWith(
      "swap-pane", "-s", "%2", "-t", "%10"
    );
  });

  it("skips resize when getPaneSize returns null", () => {
    vi.mocked(getPaneSize).mockReturnValueOnce(null);
    vi.mocked(newDashboardWindowPaned).mockReturnValue("%10");
    const state = makeState();
    parkToHidden("_garden-worker-bold-ash", state);

    expect(vi.mocked(resizeWindow)).not.toHaveBeenCalled();
    expect(vi.mocked(tmux)).toHaveBeenCalledWith(
      "swap-pane", "-s", "%2", "-t", "%10"
    );
  });

  it("kills a stale same-named window holding a bare shell, by window id", () => {
    vi.mocked(newDashboardWindowPaned).mockReturnValue("%10");
    vi.mocked(listSessionPanes).mockReturnValue([
      pane("@7", "_garden-worker-bold-ash", "%30"),
      pane("@8", "_garden-worker-other", "%31"),
    ]);
    const state = makeState();
    parkToHidden("_garden-worker-bold-ash", state);

    expect(vi.mocked(killWindowById)).toHaveBeenCalledWith("@7");
    expect(vi.mocked(killWindowById)).not.toHaveBeenCalledWith("@8");
    expect(vi.mocked(renameWindowById)).not.toHaveBeenCalled();
  });

  it("quarantines instead of killing a stale window whose pane runs a live process", () => {
    vi.mocked(newDashboardWindowPaned).mockReturnValue("%10");
    vi.mocked(paneRunningOnlyShell).mockReturnValue(false);
    vi.mocked(listSessionPanes).mockReturnValue([
      pane("@7", "_garden-worker-bold-ash", "%30"),
    ]);
    const state = makeState();
    parkToHidden("_garden-worker-bold-ash", state);

    expect(vi.mocked(killWindowById)).not.toHaveBeenCalled();
    expect(vi.mocked(renameWindowById)).toHaveBeenCalledWith("@7", "_stray-7");
  });

  it("does not create a duplicate when a live stale window cannot be quarantined", () => {
    vi.mocked(paneRunningOnlyShell).mockReturnValue(false);
    vi.mocked(renameWindowById).mockReturnValue(false);
    vi.mocked(listSessionPanes).mockReturnValue([
      pane("@7", "_garden-worker-bold-ash", "%30"),
    ]);

    expect(() => parkToHidden("_garden-worker-bold-ash", makeState())).toThrow(
      "Could not clear stale tmux window '_garden-worker-bold-ash'",
    );
    expect(vi.mocked(newDashboardWindowPaned)).not.toHaveBeenCalled();
    expect(vi.mocked(tmux)).not.toHaveBeenCalled();
  });

  it("does not create a duplicate when a stale shell window cannot be killed", () => {
    vi.mocked(killWindowById).mockReturnValue(false);
    vi.mocked(listSessionPanes).mockReturnValue([
      pane("@7", "_garden-worker-bold-ash", "%30"),
    ]);

    expect(() => parkToHidden("_garden-worker-bold-ash", makeState())).toThrow(
      "Could not clear stale tmux window '_garden-worker-bold-ash'",
    );
    expect(vi.mocked(newDashboardWindowPaned)).not.toHaveBeenCalled();
    expect(vi.mocked(tmux)).not.toHaveBeenCalled();
  });

  it("returns null when activePaneId is missing", () => {
    const state = makeState({ activePaneId: null });
    const result = parkToHidden("_garden-worker-bold-ash", state);
    expect(result).toBeNull();
  });

  it("returns null when active pane does not exist", () => {
    vi.mocked(paneExists).mockReturnValue(false);
    const state = makeState();
    const result = parkToHidden("_garden-worker-bold-ash", state);
    expect(result).toBeNull();
  });

  it("clears activePaneType and activeWindowName on state", () => {
    vi.mocked(newDashboardWindowPaned).mockReturnValue("%10");
    const state = makeState();
    parkToHidden("_garden-worker-bold-ash", state);
    expect(state.activePaneType).toBeNull();
    expect(state.activeWindowName).toBeNull();
    expect(state.activePaneId).toBe("%10");
  });
});

describe("restoreFromHidden", () => {
  it("swaps target pane into right slot and kills exactly that window by id", () => {
    vi.mocked(listSessionPanes).mockReturnValue([
      pane("@5", "_garden-worker-calm-bay", "%20"),
      // A duplicate of the restore name — must survive: it may hold a live
      // misfiled pane, and only the consumed window may die.
      pane("@6", "_garden-worker-calm-bay", "%21"),
    ]);
    const state = makeState();
    restoreFromHidden("_garden-worker-calm-bay", state);

    expect(vi.mocked(resizeWindowById)).toHaveBeenCalledWith("@5", 129, 58);
    expect(vi.mocked(tmux)).toHaveBeenCalledWith(
      "swap-pane", "-s", "%2", "-t", "%20"
    );
    expect(vi.mocked(killWindowById)).toHaveBeenCalledWith("@5");
    expect(vi.mocked(killWindowById)).not.toHaveBeenCalledWith("@6");
    expect(vi.mocked(killWindowSafe)).not.toHaveBeenCalled();
    expect(state.activePaneId).toBe("%20");
  });

  it("is a no-op when target window has no pane", () => {
    vi.mocked(listSessionPanes).mockReturnValue([]);
    const state = makeState();
    restoreFromHidden("_garden-worker-missing", state);

    expect(vi.mocked(tmux)).not.toHaveBeenCalled();
    expect(state.activePaneId).toBe("%2");
  });

  it("is a no-op when activePaneId is null", () => {
    vi.mocked(listSessionPanes).mockReturnValue([
      pane("@5", "_garden-worker-calm-bay", "%20"),
    ]);
    const state = makeState({ activePaneId: null });
    restoreFromHidden("_garden-worker-calm-bay", state);

    expect(vi.mocked(tmux)).not.toHaveBeenCalled();
  });
});

describe("swapToHidden", () => {
  it("parks then restores in sequence", () => {
    vi.mocked(newDashboardWindowPaned).mockReturnValue("%10");
    vi.mocked(listSessionPanes).mockReturnValue([
      pane("@5", "_garden-worker-calm-bay", "%20"),
    ]);

    const state = makeState();
    swapToHidden("_garden-worker-bold-ash", "_garden-worker-calm-bay", state);

    expect(vi.mocked(newDashboardWindowPaned)).toHaveBeenCalled();
    const swapCalls = vi.mocked(tmux).mock.calls.filter(c => c[0] === "swap-pane");
    expect(swapCalls.length).toBe(2);
  });

  it("does not restore when parking failed", () => {
    vi.mocked(paneExists).mockReturnValue(false);
    vi.mocked(listSessionPanes).mockReturnValue([
      pane("@5", "_garden-worker-calm-bay", "%20"),
    ]);

    swapToHidden("_garden-worker-bold-ash", "_garden-worker-calm-bay", makeState());

    expect(vi.mocked(tmux)).not.toHaveBeenCalled();
    expect(vi.mocked(killWindowById)).not.toHaveBeenCalled();
  });
});

describe("swapDirect", () => {
  // Snapshot returned by the single listSessionPanes() fork: the active pane
  // (%2) lives in the visible main window; the restore target (%20) lives in
  // its hidden window.
  function snapshot(targetSize: Partial<SessionPane> = {}) {
    return [
      pane("@1", "main", "%2"),
      pane("@5", "_garden-worker-calm-bay", "%20", targetSize),
    ];
  }

  it("swaps panes and renames the swapped window by id", () => {
    vi.mocked(listSessionPanes).mockReturnValue(snapshot());
    const state = makeState();
    const result = swapDirect("_garden-worker-bold-ash", "_garden-worker-calm-bay", state);

    expect(result).toBe(true);
    expect(vi.mocked(tmux)).toHaveBeenCalledWith(
      "swap-pane", "-s", "%2", "-t", "%20"
    );
    expect(vi.mocked(renameWindowById)).toHaveBeenCalledWith(
      "@5", "_garden-worker-bold-ash"
    );
    expect(state.activePaneId).toBe("%20");
  });

  it("renames the exact window it swapped even when the restore name is duplicated", () => {
    vi.mocked(listSessionPanes).mockReturnValue([
      pane("@1", "main", "%2"),
      pane("@5", "_garden-worker-calm-bay", "%20"),
      pane("@9", "_garden-worker-calm-bay", "%29"),
    ]);
    const state = makeState();
    const result = swapDirect("_garden-worker-bold-ash", "_garden-worker-calm-bay", state);

    expect(result).toBe(true);
    // The pane swapped and the window renamed must be the same window — a
    // name-target rename fails outright under duplicates, which misfiled the
    // parked pane and cascaded into the duplicate-window corruption.
    expect(vi.mocked(tmux)).toHaveBeenCalledWith("swap-pane", "-s", "%2", "-t", "%20");
    expect(vi.mocked(renameWindowById)).toHaveBeenCalledWith("@5", "_garden-worker-bold-ash");
  });

  it("rolls back and requests the fallback when the post-swap rename fails", () => {
    vi.mocked(listSessionPanes).mockReturnValue(snapshot());
    vi.mocked(renameWindowById).mockReturnValue(false);
    const state = makeState();

    const result = swapDirect("_garden-worker-bold-ash", "_garden-worker-calm-bay", state);

    expect(result).toBe(false);
    expect(vi.mocked(tmux).mock.calls.filter(c => c[0] === "swap-pane")).toEqual([
      ["swap-pane", "-s", "%2", "-t", "%20"],
      ["swap-pane", "-s", "%2", "-t", "%20"],
    ]);
    expect(state.activePaneId).toBe("%2");
  });

  it("keeps state aligned with the completed swap when rename and rollback both fail", () => {
    vi.mocked(listSessionPanes).mockReturnValue(snapshot());
    vi.mocked(renameWindowById).mockReturnValue(false);
    vi.mocked(tmux)
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => { throw new Error("rollback failed"); });
    const state = makeState();

    const result = swapDirect("_garden-worker-bold-ash", "_garden-worker-calm-bay", state);

    expect(result).toBe(true);
    expect(state.activePaneId).toBe("%20");
  });

  it("resolves the whole swap from a single tmux fork (no per-question forks)", () => {
    vi.mocked(listSessionPanes).mockReturnValue(snapshot());
    const state = makeState();
    swapDirect("_garden-worker-bold-ash", "_garden-worker-calm-bay", state);

    expect(vi.mocked(listSessionPanes)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(paneExists)).not.toHaveBeenCalled();
    expect(vi.mocked(getFirstPaneId)).not.toHaveBeenCalled();
    expect(vi.mocked(getPaneSize)).not.toHaveBeenCalled();
  });

  it("skips resize when hidden pane already matches visible slot size", () => {
    vi.mocked(listSessionPanes).mockReturnValue(snapshot());
    const state = makeState();
    swapDirect("_garden-worker-bold-ash", "_garden-worker-calm-bay", state);
    expect(vi.mocked(resizeWindowById)).not.toHaveBeenCalled();
  });

  it("resizes by window id when hidden pane differs from visible slot size", () => {
    vi.mocked(listSessionPanes).mockReturnValue(snapshot({ width: 100, height: 40 }));
    const state = makeState();
    swapDirect("_garden-worker-bold-ash", "_garden-worker-calm-bay", state);
    expect(vi.mocked(resizeWindowById)).toHaveBeenCalledWith("@5", 129, 58);
  });

  it("does not create or kill any windows", () => {
    vi.mocked(listSessionPanes).mockReturnValue(snapshot());
    const state = makeState();
    swapDirect("_garden-worker-bold-ash", "_garden-worker-calm-bay", state);

    expect(vi.mocked(newDashboardWindowPaned)).not.toHaveBeenCalled();
    expect(vi.mocked(killWindowSafe)).not.toHaveBeenCalled();
    expect(vi.mocked(killWindowById)).not.toHaveBeenCalled();
  });

  it("returns false when active pane is missing", () => {
    const state = makeState({ activePaneId: null });
    const result = swapDirect("_garden-worker-bold-ash", "_garden-worker-calm-bay", state);
    expect(result).toBe(false);
    expect(vi.mocked(tmux)).not.toHaveBeenCalled();
  });

  it("returns false when the active pane is dead (absent from the snapshot)", () => {
    // %2 not present — the visible pane died between events.
    vi.mocked(listSessionPanes).mockReturnValue([
      pane("@5", "_garden-worker-calm-bay", "%20"),
    ]);
    const state = makeState();
    const result = swapDirect("_garden-worker-bold-ash", "_garden-worker-calm-bay", state);
    expect(result).toBe(false);
    expect(vi.mocked(tmux)).not.toHaveBeenCalled();
  });

  it("returns false when target window is missing", () => {
    // Only the active pane is present; the restore window has no pane.
    vi.mocked(listSessionPanes).mockReturnValue([
      pane("@1", "main", "%2"),
    ]);
    const state = makeState();
    const result = swapDirect("_garden-worker-bold-ash", "_garden-worker-calm-bay", state);
    expect(result).toBe(false);
    expect(vi.mocked(tmux)).not.toHaveBeenCalled();
  });
});

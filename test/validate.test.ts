import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/dashboard/tmux.js", () => ({
  paneExists: vi.fn(() => true),
  windowExists: vi.fn(() => true),
  getFirstPaneId: vi.fn(() => "%99"),
  listHiddenWorkerWindows: vi.fn(() => []),
  killWindowSafe: vi.fn(),
  tmuxSplit: vi.fn(() => "%50"),
  setPaneTitle: vi.fn(),
  setPaneLabel: vi.fn(),
  getPaneSize: vi.fn(() => null),
  tmux: vi.fn(),
}));

vi.mock("../src/dashboard/registry.js", () => ({
  readRegistry: vi.fn(() => ({ workers: {} })),
  writeRegistry: vi.fn(),
  updateWorkerFields: vi.fn(),
}));

vi.mock("../src/config.js", () => ({
  loadConfig: vi.fn(() => ({ projects: { garden: { path: "/tmp/garden" } } })),
  SESSIONS_DIR: "/tmp/fake-sessions",
}));

vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/dashboard/poller.js", () => ({
  startProjectPoller: vi.fn(),
  projectPollerRunning: vi.fn(() => true),
  pollerWindowName: vi.fn((p: string) => `_${p}-poller`),
  reviewWindowName: vi.fn((p: string, w: string) => `_${p}-review-${w}`),
}));

vi.mock("../src/dashboard/create.js", () => ({
  resolveGardenRunner: vi.fn(() => "garden"),
  createGardenConsoleWindow: vi.fn(),
}));

vi.mock("../src/dashboard/layout.js", () => ({
  gardenRestoreFromHidden: vi.fn(),
}));

vi.mock("../src/dashboard/header.js", () => ({
  buildStatusCommand: vi.fn(() => "echo status"),
}));

vi.mock("../src/dashboard/git.js", () => ({
  worktreeExists: vi.fn(() => true),
  removeWorktree: vi.fn(),
  pruneWorktrees: vi.fn(),
}));

import { validateAndHeal } from "../src/dashboard/validate.js";
import { paneExists, windowExists, getFirstPaneId, listHiddenWorkerWindows, tmuxSplit } from "../src/dashboard/tmux.js";
import { readRegistry, writeRegistry } from "../src/dashboard/registry.js";
import type { DashboardState } from "../src/dashboard/state.js";

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
  vi.mocked(windowExists).mockReturnValue(true);
  vi.mocked(readRegistry).mockReturnValue({ workers: {} });
});

describe("validateAndHeal", () => {
  it("passes through healthy state unchanged", () => {
    const state = makeState();
    const healed = validateAndHeal(state);
    expect(healed.activePaneId).toBe("%2");
    expect(healed.statusPaneId).toBe("%0");
    expect(healed.gardenShellPaneId).toBe("%1");
  });

  it("recreates status pane when missing and garden shell exists", () => {
    vi.mocked(paneExists).mockImplementation((id: string) => id !== "%0");
    vi.mocked(tmuxSplit).mockReturnValue("%50");
    const state = makeState();
    const healed = validateAndHeal(state);
    expect(healed.statusPaneId).toBe("%50");
    expect(vi.mocked(tmuxSplit)).toHaveBeenCalled();
  });

  it("recreates garden pane when gardenShellPaneId is stale", () => {
    vi.mocked(paneExists).mockImplementation((id: string) => id !== "%1");
    const state = makeState();
    const healed = validateAndHeal(state);
    // stale pane is nulled then recreation is attempted; tmuxSplit returns "%50"
    expect(healed.gardenShellPaneId).toBe("%50");
    expect(vi.mocked(tmuxSplit)).toHaveBeenCalled();
  });

  it("leaves gardenShellPaneId null when statusPaneId is also missing", () => {
    vi.mocked(paneExists).mockImplementation((id: string) => id !== "%0" && id !== "%1");
    const state = makeState();
    const healed = validateAndHeal(state);
    expect(healed.gardenShellPaneId).toBeNull();
  });

  it("recovers activePaneId from named window when pane is dead", () => {
    vi.mocked(paneExists).mockImplementation((id: string) => id !== "%2");
    vi.mocked(getFirstPaneId).mockReturnValue("%10");
    const state = makeState();
    const healed = validateAndHeal(state);
    expect(healed.activePaneId).toBe("%10");
  });

  it("falls back to worker window when active window is also gone", () => {
    vi.mocked(paneExists).mockImplementation((id: string) => id !== "%2");
    vi.mocked(windowExists).mockImplementation((name: string) =>
      name !== "_garden-worker-bold-ash"
    );
    vi.mocked(listHiddenWorkerWindows).mockReturnValue(["_garden-worker-calm-bay"]);
    vi.mocked(getFirstPaneId).mockReturnValue("%20");
    const state = makeState();
    const healed = validateAndHeal(state);
    expect(healed.activePaneId).toBe("%20");
    expect(healed.activeWindowName).toBe("_garden-worker-calm-bay");
    expect(healed.activePaneType).toBe("worker");
  });

  it("nulls everything when no recovery is possible", () => {
    vi.mocked(paneExists).mockImplementation((id: string) => id !== "%2");
    vi.mocked(windowExists).mockReturnValue(false);
    vi.mocked(listHiddenWorkerWindows).mockReturnValue([]);
    vi.mocked(getFirstPaneId).mockReturnValue(null);
    const state = makeState();
    const healed = validateAndHeal(state);
    expect(healed.activePaneId).toBeNull();
    expect(healed.activePaneType).toBeNull();
    expect(healed.activeWindowName).toBeNull();
  });

  it("removes registry entries for missing windows", () => {
    vi.mocked(readRegistry).mockReturnValue({
      workers: {
        garden: [
          { name: "bold-ash", sessionId: "a", task: "fix" },
          { name: "missing-one", sessionId: "b", task: "" },
        ],
      },
    });
    vi.mocked(windowExists).mockImplementation((name: string) =>
      !name.includes("missing-one")
    );
    const state = makeState();
    validateAndHeal(state);
    expect(vi.mocked(writeRegistry)).toHaveBeenCalled();
    const written = vi.mocked(writeRegistry).mock.calls[0][0];
    expect(written.workers.garden).toHaveLength(1);
    expect(written.workers.garden[0].name).toBe("bold-ash");
  });

  it("removes merged registry entries when tmux window is gone", () => {
    vi.mocked(readRegistry).mockReturnValue({
      workers: {
        garden: [
          { name: "bold-ash", sessionId: "a", task: "fix" },
          { name: "merged-one", sessionId: "c", task: "done", prState: "merged" },
        ],
      },
    });
    vi.mocked(windowExists).mockImplementation((name: string) =>
      !name.includes("merged-one")
    );
    const state = makeState();
    validateAndHeal(state);
    expect(vi.mocked(writeRegistry)).toHaveBeenCalled();
    const written = vi.mocked(writeRegistry).mock.calls[0][0];
    expect(written.workers.garden).toHaveLength(1);
    expect(written.workers.garden[0].name).toBe("bold-ash");
  });

  it("clears stale lastActiveWorker references", () => {
    vi.mocked(windowExists).mockImplementation((name: string) =>
      name !== "_garden-worker-gone"
    );
    const state = makeState({
      lastActiveWorker: { garden: "_garden-worker-gone" },
    });
    const healed = validateAndHeal(state);
    expect(healed.lastActiveWorker).not.toHaveProperty("garden");
  });

  it("keeps lastActiveWorker when window is the active window", () => {
    vi.mocked(windowExists).mockReturnValue(false);
    const state = makeState({
      activeWindowName: "_garden-worker-bold-ash",
      lastActiveWorker: { garden: "_garden-worker-bold-ash" },
    });
    const healed = validateAndHeal(state);
    expect(healed.lastActiveWorker.garden).toBe("_garden-worker-bold-ash");
  });

  it("keeps registry entries for active window even if not a hidden window", () => {
    vi.mocked(readRegistry).mockReturnValue({
      workers: {
        garden: [
          { name: "bold-ash", sessionId: "a", task: "fix" },
        ],
      },
    });
    // The active window is not in the hidden windows list (it's in the visible slot)
    // but windowExists returns false for it because it was swapped out
    vi.mocked(windowExists).mockReturnValue(false);
    const state = makeState({ activeWindowName: "_garden-worker-bold-ash" });
    validateAndHeal(state);
    // bold-ash should be kept because it matches activeWindowName
    const written = vi.mocked(writeRegistry).mock.calls[0]?.[0];
    if (written) {
      expect(written.workers.garden).toHaveLength(1);
    }
  });
});

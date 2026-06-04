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
  disablePaneInput: vi.fn(),
}));

vi.mock("../src/dashboard/registry.js", () => ({
  readRegistry: vi.fn(() => ({ workers: {} })),
  writeRegistry: vi.fn(),
  updateWorkerFields: vi.fn(),
}));

vi.mock("../src/dashboard/state.js", () => ({
  readDashState: vi.fn(() => ({
    activeProject: "garden",
    statusPaneId: "%0",
    usagePaneId: "%3",
    gardenShellPaneId: "%1",
    activePaneId: "%2",
    activePaneType: "worker",
    activeWindowName: null,
  })),
  writeDashState: vi.fn(),
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
}));

vi.mock("../src/dashboard/create.js", () => ({
  createGardenGrowhouseWindow: vi.fn(),
  USAGE_PANE_HEIGHT: 5,
}));

vi.mock("../src/dashboard/runner.js", () => ({
  resolveGardenRunner: vi.fn(() => "garden"),
}));

vi.mock("../src/dashboard/layout.js", () => ({
  gardenRestoreFromHidden: vi.fn(),
}));

vi.mock("../src/dashboard/header.js", () => ({
  buildStatusCommand: vi.fn(() => "echo status"),
  buildUsageCommand: vi.fn(() => "echo usage"),
}));

vi.mock("../src/dashboard/git.js", () => ({
  worktreeExists: vi.fn(() => true),
  removeWorktree: vi.fn(),
  pruneWorktrees: vi.fn(),
}));

vi.mock("../src/dashboard/alerts.js", () => ({
  addAlert: vi.fn(),
}));

import { validateAndHeal, sweepGhostEntries } from "../src/dashboard/validate.js";
import { readDashState } from "../src/dashboard/state.js";
import { paneExists, windowExists, getFirstPaneId, listHiddenWorkerWindows, tmuxSplit } from "../src/dashboard/tmux.js";
import { readRegistry, writeRegistry } from "../src/dashboard/registry.js";
import type { DashboardState } from "../src/dashboard/state.js";

import { setPaneTitle, setPaneLabel, disablePaneInput } from "../src/dashboard/tmux.js";

function makeState(overrides: Partial<DashboardState> = {}): DashboardState {
  return {
    activeProject: "garden",
    statusPaneId: "%0",
    usagePaneId: "%3",
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
    // Healed status pane must be input-disabled; otherwise operator keystrokes
    // echo into it after a mid-session recreate.
    expect(disablePaneInput).toHaveBeenCalledWith("%50");
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

  it("preserves registry entries for missing windows, marks them exited, and alerts", async () => {
    // The "never auto-cleanup workers" rule means a missing tmux pane must
    // not delete the entry — a transient tmux glitch would otherwise discard
    // the worker permanently along with its on-disk worktree. The pane-died
    // shape (agentStatus="exited") is what we expose; an alert tells the
    // operator to bounce or ⌥x explicitly.
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
    const { addAlert } = await import("../src/dashboard/alerts.js");
    const state = makeState();
    validateAndHeal(state);
    expect(vi.mocked(writeRegistry)).toHaveBeenCalled();
    const written = vi.mocked(writeRegistry).mock.calls[0][0];
    // Both entries persist.
    expect(written.workers.garden).toHaveLength(2);
    const missing = written.workers.garden.find(w => w.name === "missing-one");
    expect(missing?.agentStatus).toBe("exited");
    expect(vi.mocked(addAlert)).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        source: "validate",
        worker: "missing-one",
      }),
    );
  });

  it("removes a ghost entry: agentStatus=loading + no worktree + no window (failed sandboxed handoff)", async () => {
    // A handoff from a sandboxed worker that crashed at tmuxNewWindow used
    // to leave addWorker's entry stranded in agentStatus="loading" forever
    // — no worktree, no pane, just registry rot. The new rollback in
    // workers.ts catches this at the source, and validate sweeps any
    // pre-existing ghosts on reattach. "Loading + no worktree + no window"
    // is the strict ghost signature.
    const { worktreeExists } = await import("../src/dashboard/git.js");
    vi.mocked(readRegistry).mockReturnValue({
      workers: {
        garden: [
          { name: "real-one", sessionId: "a", task: "fix" },
          {
            name: "ghost-one",
            sessionId: "b",
            task: "",
            worktreePath: "/nope",
            agentStatus: "loading",
          },
        ],
      },
    });
    vi.mocked(windowExists).mockImplementation((name: string) =>
      !name.includes("ghost-one")
    );
    vi.mocked(worktreeExists).mockReturnValue(false);
    const state = makeState({ activeWindowName: null });
    validateAndHeal(state);
    expect(vi.mocked(writeRegistry)).toHaveBeenCalled();
    const written = vi.mocked(writeRegistry).mock.calls[0][0];
    // real-one survives the loading-pane sweep (it isn't loading); ghost-one is gone.
    expect(written.workers.garden.map(w => w.name)).toEqual(["real-one"]);
  });

  it("keeps a still-bootstrapping worker (loading + window exists) even if the worktree isn't on disk yet", async () => {
    // Race-protection: between tmuxNewWindow and the bootstrap script creating
    // the worktree, agentStatus is "loading" and worktreePath doesn't exist
    // on disk yet. The window does exist (tmuxNewWindow created it), so the
    // ghost sweep must NOT remove these in-flight workers.
    const { worktreeExists } = await import("../src/dashboard/git.js");
    vi.mocked(readRegistry).mockReturnValue({
      workers: {
        garden: [
          {
            name: "in-flight",
            sessionId: "a",
            task: "",
            worktreePath: "/not-yet",
            agentStatus: "loading",
          },
        ],
      },
    });
    vi.mocked(windowExists).mockReturnValue(true);
    vi.mocked(worktreeExists).mockReturnValue(false);
    const state = makeState();
    validateAndHeal(state);
    const written = vi.mocked(writeRegistry).mock.calls[0]?.[0];
    // worktreePath got nulled but the entry remains.
    expect(written?.workers.garden).toHaveLength(1);
    expect(written?.workers.garden[0].name).toBe("in-flight");
  });

  it("does not re-mark or re-alert an already-exited worker on subsequent reattach", async () => {
    // An alert on every reattach would spam the badge — the registry change
    // should be one-shot (entry already exited → skip).
    vi.mocked(readRegistry).mockReturnValue({
      workers: {
        garden: [
          { name: "merged-one", sessionId: "c", task: "done", prState: "merged", agentStatus: "exited" },
        ],
      },
    });
    vi.mocked(windowExists).mockImplementation((name: string) =>
      !name.includes("merged-one")
    );
    const { addAlert } = await import("../src/dashboard/alerts.js");
    const state = makeState();
    validateAndHeal(state);
    // No registry write triggered by the missing-window check, no fresh alert.
    expect(vi.mocked(addAlert)).not.toHaveBeenCalled();
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

  it("passes through healthy usage pane unchanged", () => {
    const state = makeState({ usagePaneId: "%3" });
    const healed = validateAndHeal(state);
    expect(healed.usagePaneId).toBe("%3");
  });

  it("nulls stale usagePaneId when pane is gone", () => {
    vi.mocked(paneExists).mockImplementation((id: string) => id !== "%3");
    const state = makeState({ usagePaneId: "%3" });
    const healed = validateAndHeal(state);
    expect(healed.usagePaneId).toBe("%50");
  });

  it("recreates usage pane when missing and status pane exists", () => {
    vi.mocked(tmuxSplit).mockReturnValue("%60");
    const state = makeState({ usagePaneId: null, statusPaneId: "%0" });
    const healed = validateAndHeal(state);
    expect(healed.usagePaneId).toBe("%60");
    expect(setPaneTitle).toHaveBeenCalledWith("%60", "garden");
    expect(setPaneLabel).toHaveBeenCalledWith("%60", "#[fg=green,bold]garden#[default] 🌱");
    expect(disablePaneInput).toHaveBeenCalledWith("%60");
  });

  it("leaves usagePaneId null when status pane is also gone and cannot be recreated", () => {
    vi.mocked(paneExists).mockReturnValue(false);
    const state = makeState({ usagePaneId: null, statusPaneId: "%0", gardenShellPaneId: "%1" });
    const healed = validateAndHeal(state);
    expect(healed.statusPaneId).toBeNull();
    expect(healed.usagePaneId).toBeNull();
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

describe("sweepGhostEntries", () => {
  // The mid-session sweep that runs on every poller poke. validateAndHeal does
  // the same work at attach time; this lighter sweep catches ghosts that show
  // up after attach (e.g. a fan-out handoff where some bootstraps failed)
  // without waiting for a dashboard restart.
  it("removes a mid-session ghost across projects", async () => {
    const { worktreeExists } = await import("../src/dashboard/git.js");
    vi.mocked(readRegistry).mockReturnValue({
      workers: {
        wolf: [
          {
            name: "grave-tall-loon",
            sessionId: "a",
            task: "",
            agentStatus: "loading",
          },
          { name: "hale-rich-mere", sessionId: "b", task: "real" },
        ],
        garden: [
          { name: "meek-shrewd-vow", sessionId: "c", task: "real" },
        ],
      },
    });
    vi.mocked(windowExists).mockImplementation((name: string) =>
      !name.includes("grave-tall-loon")
    );
    vi.mocked(worktreeExists).mockReturnValue(false);
    vi.mocked(readDashState).mockReturnValue({
      ...makeState({ activeWindowName: null }),
    });

    const changed = sweepGhostEntries();
    expect(changed).toBe(true);
    const written = vi.mocked(writeRegistry).mock.calls[0][0];
    expect(written.workers.wolf.map(w => w.name)).toEqual(["hale-rich-mere"]);
    expect(written.workers.garden.map(w => w.name)).toEqual(["meek-shrewd-vow"]);
  });

  it("returns false and does not write when no ghosts present", () => {
    vi.mocked(readRegistry).mockReturnValue({
      workers: {
        garden: [{ name: "meek-shrewd-vow", sessionId: "a", task: "real" }],
      },
    });
    vi.mocked(windowExists).mockReturnValue(true);
    const changed = sweepGhostEntries();
    expect(changed).toBe(false);
    expect(vi.mocked(writeRegistry)).not.toHaveBeenCalled();
  });
});

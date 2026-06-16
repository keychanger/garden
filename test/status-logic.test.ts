import { describe, it, expect, vi, beforeEach } from "vitest";
import { captureConsoleLog } from "./helpers.js";

// The new status system is registry-driven: agentStatus and prState are
// the only inputs to the renderer. There is no pgrep, no marker file, no
// pane-title parsing. These tests exercise the combine function and the
// rendering of each state.

vi.mock("../src/dashboard/tmux.js", () => ({
  getPaneLabel: vi.fn(),
  getFirstPaneId: vi.fn(),
  listHiddenWorkerWindows: vi.fn(() => []),
}));

vi.mock("../src/dashboard/state.js", () => ({
  readDashState: vi.fn(() => ({
    activeProject: null,
    statusPaneId: null,
    gardenShellPaneId: null,
    activePaneId: null,
    activePaneType: null,
    activeWindowName: null,
  })),
}));

vi.mock("../src/dashboard/registry.js", () => ({
  getWorkers: vi.fn(() => []),
}));

vi.mock("../src/session.js", () => ({
  dashboardExists: vi.fn(() => true),
  DASHBOARD_SESSION: "garden-dashboard",
}));

vi.mock("../src/config.js", () => {
  const loadConfig = vi.fn(() => ({
    projects: { garden: { path: "/tmp/garden" } },
  }));
  return {
    loadConfig,
    getFocusedProjectNames: vi.fn((config) => {
      const cfg = config ?? loadConfig();
      return Object.keys(cfg.projects).filter(
        (name: string) => cfg.projects[name].focused !== false
      );
    }),
    tryGetProject: vi.fn((name: string) => {
      const cfg = loadConfig();
      const p = cfg.projects[name];
      return p ? { ...p, name } : null;
    }),
    SESSIONS_DIR: "/tmp/fake-sessions",
  };
});

vi.mock("../src/dashboard/git.js", () => ({
  currentBranch: vi.fn(() => null),
}));

vi.mock("../src/diary.js", () => ({
  diaryHasContent: vi.fn(() => false),
}));

vi.mock("../src/output.js", () => ({
  output: vi.fn(),
  isTTY: true,
}));

import { status, renderQuickStatus, resolveWorkerStatus, _resetStatusBranchCacheForTest } from "../src/commands/status.js";
import { currentBranch } from "../src/dashboard/git.js";
import { diaryHasContent } from "../src/diary.js";
import { readDashState } from "../src/dashboard/state.js";
import { getWorkers } from "../src/dashboard/registry.js";
import { dashboardExists } from "../src/session.js";
import { loadConfig } from "../src/config.js";
import { listHiddenWorkerWindows } from "../src/dashboard/tmux.js";

beforeEach(() => {
  vi.clearAllMocks();
  _resetStatusBranchCacheForTest();
  vi.mocked(loadConfig).mockReturnValue({
    projects: { garden: { path: "/tmp/garden" } },
  });
  vi.mocked(dashboardExists).mockReturnValue(true);
  vi.mocked(readDashState).mockReturnValue({
    activeProject: "garden",
    statusPaneId: "%0",
    gardenShellPaneId: "%1",
    activePaneId: "%2",
    activePaneType: "worker",
    activeWindowName: "_garden-worker-bold-ash",
  });
});

describe("resolveWorkerStatus", () => {
  it("returns agentStatus when no prState is set", () => {
    expect(resolveWorkerStatus({ agentStatus: "loading" })).toBe("loading");
    expect(resolveWorkerStatus({ agentStatus: "ready" })).toBe("ready");
    expect(resolveWorkerStatus({ agentStatus: "working" })).toBe("working");
    expect(resolveWorkerStatus({ agentStatus: "asking" })).toBe("asking");
    expect(resolveWorkerStatus({ agentStatus: "idle" })).toBe("idle");
    expect(resolveWorkerStatus({ agentStatus: "exited" })).toBe("exited");
  });

  it("returns 'ready' when neither field is set", () => {
    expect(resolveWorkerStatus({})).toBe("ready");
    expect(resolveWorkerStatus(undefined)).toBe("ready");
  });

  it("lifecycle prState takes priority over agentStatus", () => {
    expect(resolveWorkerStatus({ agentStatus: "working", prState: "reviewing" })).toBe("reviewing");
    expect(resolveWorkerStatus({ agentStatus: "idle", prState: "merge-pending" })).toBe("merge-pending");
    expect(resolveWorkerStatus({ agentStatus: "working", prState: "failing" })).toBe("failing");
    expect(resolveWorkerStatus({ agentStatus: "idle", prState: "merged" })).toBe("merged");
  });

  it("prState='working' is not displayed (agentStatus shows through)", () => {
    // prState='working' means "no in-flight lifecycle state". The display
    // should reflect what Claude is doing, not the placeholder.
    expect(resolveWorkerStatus({ agentStatus: "working", prState: "working" })).toBe("working");
    expect(resolveWorkerStatus({ agentStatus: "idle", prState: "working" })).toBe("idle");
  });
});

describe("worker deduplication", () => {
  it("active worker appearing in hidden windows list shows up exactly once", async () => {
    vi.mocked(listHiddenWorkerWindows).mockReturnValue(["_garden-worker-bold-ash"]);
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "fixing auth", agentStatus: "idle" },
    ]);

    const lines = await captureConsoleLog(() => status([]));
    const occurrences = lines.filter(l => l.includes("bold-ash")).length;
    expect(occurrences).toBe(1);
  });
});

describe("status display", () => {
  it("shows loading from registry", async () => {
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "", agentStatus: "loading" },
    ]);
    const lines = await captureConsoleLog(() => status([]));
    expect(lines.some(l => l.includes("loading"))).toBe(true);
  });

  it("shows ready from registry", async () => {
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "", agentStatus: "ready" },
    ]);
    const lines = await captureConsoleLog(() => status([]));
    expect(lines.some(l => l.includes("ready"))).toBe(true);
  });

  it("shows working from registry", async () => {
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "fixing auth", agentStatus: "working" },
    ]);
    const lines = await captureConsoleLog(() => status([]));
    expect(lines.some(l => l.includes("working"))).toBe(true);
  });

  it("shows idle from registry", async () => {
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "fixing auth", agentStatus: "idle" },
    ]);
    const lines = await captureConsoleLog(() => status([]));
    expect(lines.some(l => l.includes("idle"))).toBe(true);
  });

  it("shows asking from registry and wraps the row in bold-yellow", async () => {
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "awaiting plan approval", agentStatus: "asking" },
    ]);
    const lines = await captureConsoleLog(() => status([]));
    const askingLine = lines.find(l => l.includes("asking") && l.includes("bold-ash"));
    expect(askingLine).toBeDefined();
    expect(askingLine).toMatch(/\x1b\[1;33m/);
  });

  it("shows exited from registry", async () => {
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "", agentStatus: "exited" },
    ]);
    const lines = await captureConsoleLog(() => status([]));
    expect(lines.some(l => l.includes("exited"))).toBe(true);
  });
});

describe("lifecycle state display (prState takes priority)", () => {
  it("shows reviewing when prState=reviewing, even if agentStatus=working", async () => {
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "", agentStatus: "working", prState: "reviewing" },
    ]);
    const lines = await captureConsoleLog(() => status([]));
    expect(lines.some(l => l.includes("reviewing"))).toBe(true);
    expect(lines.some(l => l.includes("working"))).toBe(false);
  });

  it("shows merging when prState=merge-pending", async () => {
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "", agentStatus: "idle", prState: "merge-pending" },
    ]);
    const lines = await captureConsoleLog(() => status([]));
    expect(lines.some(l => l.includes("merging"))).toBe(true);
  });

  it("shows failing without count and wraps the row in bold-red", async () => {
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "", agentStatus: "idle", prState: "failing", failCount: 3 },
    ]);
    const lines = await captureConsoleLog(() => status([]));
    const failingLine = lines.find(l => l.includes("failing") && l.includes("bold-ash"));
    expect(failingLine).toBeDefined();
    expect(failingLine).toMatch(/\x1b\[1;31m/);
  });

  it("shows merged from prState as a neutral row (transient post-merge beat, not green)", async () => {
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "", agentStatus: "idle", prState: "merged" },
    ]);
    const lines = await captureConsoleLog(() => status([]));
    const mergedLine = lines.find(l => l.includes("merged") && l.includes("bold-ash"));
    expect(mergedLine).toBeDefined();
    // Transient merged is not actionable — must not be wrapped in bold-green.
    expect(mergedLine).not.toMatch(/\x1b\[1;32m/);
  });

  it("shows done from prState and wraps the row in bold-green", async () => {
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "", agentStatus: "idle", prState: "done" },
    ]);
    const lines = await captureConsoleLog(() => status([]));
    const doneLine = lines.find(l => l.includes("done") && l.includes("bold-ash"));
    expect(doneLine).toBeDefined();
    expect(doneLine).toMatch(/\x1b\[1;32m/);
  });
});

describe("renderQuickStatus", () => {
  const state = {
    activeProject: "garden",
    statusPaneId: "%0",
    gardenShellPaneId: "%1",
    activePaneId: "%2",
    activePaneType: "worker" as const,
    activeWindowName: "_garden-worker-bold-ash",
  };

  it("renders working from registry", () => {
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "fixing the build", agentStatus: "working" },
    ]);
    const result = renderQuickStatus(state);
    expect(result).toContain("bold-ash");
    expect(result).toContain("working");
  });

  it("marks a project that has diary content with a dimmed pencil glyph", () => {
    vi.mocked(diaryHasContent).mockReturnValue(true);
    vi.mocked(getWorkers).mockReturnValue([]);
    const result = renderQuickStatus(state);
    // Grey-wrapped pencil (U+270E) on the project header row.
    expect(result).toContain("\x1b[90m✎\x1b[0m");
    expect(vi.mocked(diaryHasContent)).toHaveBeenCalledWith("garden");
  });

  it("omits the diary glyph when the diary is empty", () => {
    vi.mocked(diaryHasContent).mockReturnValue(false);
    vi.mocked(getWorkers).mockReturnValue([]);
    const result = renderQuickStatus(state);
    expect(result).not.toContain("✎");
  });

  it("caches the project branch across re-bakes within the TTL (one rev-parse per project)", () => {
    vi.mocked(currentBranch).mockReturnValue("main");
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "", agentStatus: "working" },
    ]);
    renderQuickStatus(state);
    renderQuickStatus(state);
    // Two bakes, one focused project: currentBranch is forked once; the second
    // bake hits the TTL cache instead of re-running git rev-parse.
    expect(vi.mocked(currentBranch)).toHaveBeenCalledTimes(1);
  });

  it("renders loading from registry", () => {
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "", agentStatus: "loading" },
    ]);
    const result = renderQuickStatus(state);
    expect(result).toContain("loading");
  });

  it("renders idle when agentStatus=idle and no lifecycle state", () => {
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "fixing auth", agentStatus: "idle" },
    ]);
    const result = renderQuickStatus(state);
    expect(result).toContain("idle");
  });

  it("renders asking rows wrapped in bold-yellow ANSI", () => {
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "awaiting plan approval", agentStatus: "asking" },
    ]);
    const result = renderQuickStatus(state);
    expect(result).toContain("asking");
    // Whole row wrapped in bold-yellow; reset precedes the line-clear escape.
    expect(result).toMatch(/\x1b\[1;33m[^\n]*bold-ash[^\n]*\x1b\[0m/);
  });

  it("does not wrap non-asking rows in bold-yellow", () => {
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "fixing auth", agentStatus: "idle" },
    ]);
    const result = renderQuickStatus(state);
    // bold-yellow is asking-only; an idle row must not carry it
    expect(result).not.toMatch(/\x1b\[1;33m[^\n]*bold-ash/);
  });

  it("renders failing rows wrapped in bold-red ANSI", () => {
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "", agentStatus: "idle", prState: "failing" },
    ]);
    const result = renderQuickStatus(state);
    expect(result).toContain("failing");
    expect(result).toMatch(/\x1b\[1;31m[^\n]*bold-ash[^\n]*\x1b\[0m/);
  });

  it("does not wrap non-failing rows in bold-red", () => {
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "fixing auth", agentStatus: "idle" },
    ]);
    const result = renderQuickStatus(state);
    expect(result).not.toMatch(/\x1b\[1;31m[^\n]*bold-ash/);
  });

  it("renders done rows wrapped in bold-green ANSI", () => {
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "", agentStatus: "idle", prState: "done" },
    ]);
    const result = renderQuickStatus(state);
    expect(result).toContain("done");
    expect(result).toMatch(/\x1b\[1;32m[^\n]*bold-ash[^\n]*\x1b\[0m/);
  });

  it("does NOT render transient merged rows in bold-green (only done is the green signal)", () => {
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "", agentStatus: "idle", prState: "merged" },
    ]);
    const result = renderQuickStatus(state);
    expect(result).toContain("merged");
    expect(result).not.toMatch(/\x1b\[1;32m[^\n]*bold-ash/);
  });

  it("does not wrap non-done rows in bold-green", () => {
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "fixing auth", agentStatus: "idle" },
    ]);
    const result = renderQuickStatus(state);
    expect(result).not.toMatch(/\x1b\[1;32m[^\n]*bold-ash/);
  });

  it("renders reviewing even if agentStatus is working", () => {
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "", agentStatus: "working", prState: "reviewing" },
    ]);
    const result = renderQuickStatus(state);
    expect(result).toContain("reviewing");
  });

  it("excludes merged workers whose tmux window is gone", () => {
    vi.mocked(getWorkers).mockReturnValue([
      { name: "old-elm", sessionId: "abc", task: "", prState: "merged" },
    ]);
    const result = renderQuickStatus(state);
    expect(result).not.toContain("old-elm");
  });

  it("returns 'No projects added.' for empty config", () => {
    vi.mocked(loadConfig).mockReturnValue({ projects: {} });
    const result = renderQuickStatus(state);
    expect(result).toContain("No projects added.");
  });

  it("renders '(no workers)' for project with no workers", () => {
    vi.mocked(getWorkers).mockReturnValue([]);
    vi.mocked(listHiddenWorkerWindows).mockReturnValue([]);
    const noWorkerState = {
      ...state,
      activePaneType: "shell" as const,
      activeWindowName: "_garden-shell",
    };
    const result = renderQuickStatus(noWorkerState);
    expect(result).toContain("(no workers)");
  });

  it("marks active project with arrow marker", () => {
    vi.mocked(getWorkers).mockReturnValue([]);
    const result = renderQuickStatus(state);
    expect(result).toContain("\u25C4"); // left-pointing triangle
  });

  it("appends clear-to-end-of-line escape to every line", () => {
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "", agentStatus: "idle" },
    ]);
    const result = renderQuickStatus(state);
    const lines = result.split("\n");
    for (const line of lines) {
      expect(line).toMatch(/\x1b\[K$/);
    }
  });

  it("renders multiple projects", () => {
    vi.mocked(loadConfig).mockReturnValue({
      projects: { alpha: { path: "/alpha" }, beta: { path: "/beta" } },
    });
    vi.mocked(getWorkers).mockReturnValue([]);
    const result = renderQuickStatus({
      ...state,
      activeProject: "alpha",
    });
    expect(result).toContain("alpha");
    expect(result).toContain("beta");
  });

});

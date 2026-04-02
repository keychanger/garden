import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/dashboard/tmux.js", () => ({
  getPanePid: vi.fn(),
  getPaneTitle: vi.fn(),
  getPaneLabel: vi.fn(),
  getPaneVar: vi.fn(() => null),
  getFirstPaneId: vi.fn(),
  getClaudeChildPid: vi.fn(),
  hasChildProcesses: vi.fn(),
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
    SESSIONS_DIR: "/tmp/fake-sessions",
  };
});

vi.mock("../src/output.js", () => ({
  output: vi.fn(),
  isTTY: true,
}));

import { status, renderQuickStatus } from "../src/commands/status.js";
import { readDashState } from "../src/dashboard/state.js";
import { getWorkers } from "../src/dashboard/registry.js";
import { dashboardExists } from "../src/session.js";
import { loadConfig } from "../src/config.js";
import {
  getPanePid, getPaneTitle, getPaneLabel, getFirstPaneId,
  getClaudeChildPid, hasChildProcesses, listHiddenWorkerWindows,
} from "../src/dashboard/tmux.js";

beforeEach(() => {
  vi.clearAllMocks();
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

describe("worker deduplication", () => {
  it("active worker appearing in hidden windows list shows up exactly once", async () => {
    vi.mocked(getPaneLabel).mockReturnValue("bold-ash");
    vi.mocked(getPanePid).mockReturnValue("123");
    vi.mocked(getClaudeChildPid).mockReturnValue("456");
    vi.mocked(hasChildProcesses).mockReturnValue(false);
    vi.mocked(getPaneTitle).mockReturnValue(null);
    vi.mocked(listHiddenWorkerWindows).mockReturnValue(["_garden-worker-bold-ash"]);
    vi.mocked(getWorkers).mockReturnValue([]);

    const lines: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => lines.push(msg);
    try {
      await status([]);
    } finally {
      console.log = origLog;
    }

    const workerLines = lines.filter(l => l.includes("bold-ash"));
    expect(workerLines).toHaveLength(1);
  });

  it("hidden workers for active project are listed when not active pane", async () => {
    vi.mocked(readDashState).mockReturnValue({
      activeProject: "garden",
      statusPaneId: "%0",
      gardenShellPaneId: "%1",
      activePaneId: "%2",
      activePaneType: "shell",
      activeWindowName: "_garden-shell",
    });
    vi.mocked(listHiddenWorkerWindows).mockReturnValue([
      "_garden-worker-bold-ash",
      "_garden-worker-calm-bay",
    ]);
    vi.mocked(getFirstPaneId).mockImplementation((target: string) => {
      if (target.includes("bold-ash")) return "%10";
      if (target.includes("calm-bay")) return "%11";
      return null;
    });
    vi.mocked(getPaneLabel).mockImplementation((id: string) => {
      if (id === "%10") return "bold-ash";
      if (id === "%11") return "calm-bay";
      return null;
    });
    vi.mocked(getPanePid).mockReturnValue("123");
    vi.mocked(getClaudeChildPid).mockReturnValue("456");
    vi.mocked(hasChildProcesses).mockReturnValue(false);
    vi.mocked(getPaneTitle).mockReturnValue(null);
    vi.mocked(getWorkers).mockReturnValue([]);

    const lines: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => lines.push(msg);
    try {
      await status([]);
    } finally {
      console.log = origLog;
    }

    const workerLines = lines.filter(l => l.includes("bold-ash") || l.includes("calm-bay"));
    expect(workerLines).toHaveLength(2);
  });
});

describe("worker status detection", () => {
  it("shows exited when no PID", async () => {
    vi.mocked(getPaneLabel).mockReturnValue("bold-ash");
    vi.mocked(getPanePid).mockReturnValue(null);
    vi.mocked(listHiddenWorkerWindows).mockReturnValue([]);
    vi.mocked(getWorkers).mockReturnValue([]);

    const lines: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => lines.push(msg);
    try {
      await status([]);
    } finally {
      console.log = origLog;
    }

    expect(lines.some(l => l.includes("exited"))).toBe(true);
  });

  it("shows loading when shell has children but no claude yet", async () => {
    vi.mocked(getPaneLabel).mockReturnValue("bold-ash");
    vi.mocked(getPanePid).mockReturnValue("123");
    vi.mocked(getClaudeChildPid).mockReturnValue(null);
    vi.mocked(hasChildProcesses).mockReturnValue(true);
    vi.mocked(listHiddenWorkerWindows).mockReturnValue([]);
    vi.mocked(getWorkers).mockReturnValue([]);

    const lines: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => lines.push(msg);
    try {
      await status([]);
    } finally {
      console.log = origLog;
    }

    expect(lines.some(l => l.includes("loading"))).toBe(true);
  });

  it("shows ready when claude is running but no children and no task", async () => {
    vi.mocked(getPaneLabel).mockReturnValue("bold-ash");
    vi.mocked(getPanePid).mockReturnValue("123");
    vi.mocked(getClaudeChildPid).mockReturnValue("456");
    vi.mocked(hasChildProcesses).mockReturnValue(false);
    vi.mocked(getPaneTitle).mockReturnValue(null);
    vi.mocked(listHiddenWorkerWindows).mockReturnValue([]);
    vi.mocked(getWorkers).mockReturnValue([]);

    const lines: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => lines.push(msg);
    try {
      await status([]);
    } finally {
      console.log = origLog;
    }

    expect(lines.some(l => l.includes("ready"))).toBe(true);
  });

  it("shows idle when claude is running but no children and has task", async () => {
    vi.mocked(getPaneLabel).mockReturnValue("bold-ash");
    vi.mocked(getPanePid).mockReturnValue("123");
    vi.mocked(getClaudeChildPid).mockReturnValue("456");
    vi.mocked(hasChildProcesses).mockReturnValue(false);
    vi.mocked(getPaneTitle).mockReturnValue(null);
    vi.mocked(listHiddenWorkerWindows).mockReturnValue([]);
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "fixing auth" },
    ]);

    const lines: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => lines.push(msg);
    try {
      await status([]);
    } finally {
      console.log = origLog;
    }

    expect(lines.some(l => l.includes("idle"))).toBe(true);
  });

  it("shows working when claude has child processes", async () => {
    vi.mocked(getPaneLabel).mockReturnValue("bold-ash");
    vi.mocked(getPanePid).mockReturnValue("123");
    vi.mocked(getClaudeChildPid).mockReturnValue("456");
    vi.mocked(hasChildProcesses).mockReturnValue(true);
    vi.mocked(getPaneTitle).mockReturnValue("fixing the build");
    vi.mocked(listHiddenWorkerWindows).mockReturnValue([]);
    vi.mocked(getWorkers).mockReturnValue([]);

    const lines: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => lines.push(msg);
    try {
      await status([]);
    } finally {
      console.log = origLog;
    }

    expect(lines.some(l => l.includes("working"))).toBe(true);
  });
});

describe("registry task fallback", () => {
  it("falls back to registry task when pane title is null", async () => {
    vi.mocked(getPaneLabel).mockReturnValue("bold-ash");
    vi.mocked(getPanePid).mockReturnValue("123");
    vi.mocked(getClaudeChildPid).mockReturnValue("456");
    vi.mocked(hasChildProcesses).mockReturnValue(false);
    vi.mocked(getPaneTitle).mockReturnValue(null);
    vi.mocked(listHiddenWorkerWindows).mockReturnValue([]);
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "fixing auth" },
    ]);

    const lines: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => lines.push(msg);
    try {
      await status([]);
    } finally {
      console.log = origLog;
    }

    expect(lines.some(l => l.includes("fixing auth"))).toBe(true);
  });

  it("shows ready when registry task is empty string", async () => {
    vi.mocked(getPaneLabel).mockReturnValue("bold-ash");
    vi.mocked(getPanePid).mockReturnValue("123");
    vi.mocked(getClaudeChildPid).mockReturnValue("456");
    vi.mocked(hasChildProcesses).mockReturnValue(false);
    vi.mocked(getPaneTitle).mockReturnValue(null);
    vi.mocked(listHiddenWorkerWindows).mockReturnValue([]);
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "" },
    ]);

    const lines: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => lines.push(msg);
    try {
      await status([]);
    } finally {
      console.log = origLog;
    }

    expect(lines.some(l => l.includes("ready"))).toBe(true);
  });
});

describe("registry lifecycle states", () => {
  it("shows reviewing status from registry", async () => {
    vi.mocked(getPaneLabel).mockReturnValue("bold-ash");
    vi.mocked(getPanePid).mockReturnValue("123");
    vi.mocked(getClaudeChildPid).mockReturnValue("456");
    vi.mocked(hasChildProcesses).mockReturnValue(false);
    vi.mocked(getPaneTitle).mockReturnValue(null);
    vi.mocked(listHiddenWorkerWindows).mockReturnValue([]);
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "", prState: "reviewing" },
    ]);

    const lines: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => lines.push(msg);
    try {
      await status([]);
    } finally {
      console.log = origLog;
    }

    expect(lines.some(l => l.includes("reviewing"))).toBe(true);
  });

  it("shows failing status with count from registry", async () => {
    vi.mocked(getPaneLabel).mockReturnValue("bold-ash");
    vi.mocked(getPanePid).mockReturnValue("123");
    vi.mocked(getClaudeChildPid).mockReturnValue("456");
    vi.mocked(hasChildProcesses).mockReturnValue(false);
    vi.mocked(getPaneTitle).mockReturnValue(null);
    vi.mocked(listHiddenWorkerWindows).mockReturnValue([]);
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "", prState: "failing", failCount: 3 },
    ]);

    const lines: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => lines.push(msg);
    try {
      await status([]);
    } finally {
      console.log = origLog;
    }

    expect(lines.some(l => l.includes("failing (x3)"))).toBe(true);
  });

  it("shows merged status with count from registry", async () => {
    vi.mocked(getPaneLabel).mockReturnValue("bold-ash");
    vi.mocked(getPanePid).mockReturnValue("123");
    vi.mocked(getClaudeChildPid).mockReturnValue("456");
    vi.mocked(hasChildProcesses).mockReturnValue(false);
    vi.mocked(getPaneTitle).mockReturnValue(null);
    vi.mocked(listHiddenWorkerWindows).mockReturnValue([]);
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "", prState: "merged", mergeCount: 5 },
    ]);

    const lines: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => lines.push(msg);
    try {
      await status([]);
    } finally {
      console.log = origLog;
    }

    expect(lines.some(l => l.includes("merged (x5)"))).toBe(true);
  });

  it("shows plain status when count is 1", async () => {
    vi.mocked(getPaneLabel).mockReturnValue("bold-ash");
    vi.mocked(getPanePid).mockReturnValue("123");
    vi.mocked(getClaudeChildPid).mockReturnValue("456");
    vi.mocked(hasChildProcesses).mockReturnValue(false);
    vi.mocked(getPaneTitle).mockReturnValue(null);
    vi.mocked(listHiddenWorkerWindows).mockReturnValue([]);
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "", prState: "merged", mergeCount: 1 },
    ]);

    const lines: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => lines.push(msg);
    try {
      await status([]);
    } finally {
      console.log = origLog;
    }

    const workerLine = lines.find(l => l.includes("bold-ash"))!;
    expect(workerLine).toContain("merged");
    expect(workerLine).not.toContain("(x");
  });
});

describe("focus indicator", () => {
  it("shows filled circle for active worker and empty for inactive", async () => {
    vi.mocked(getPaneLabel).mockImplementation((id: string) => {
      if (id === "%2") return "bold-ash";
      if (id === "%10") return "calm-bay";
      return null;
    });
    vi.mocked(getPanePid).mockReturnValue("123");
    vi.mocked(getClaudeChildPid).mockReturnValue("456");
    vi.mocked(hasChildProcesses).mockReturnValue(false);
    vi.mocked(getPaneTitle).mockReturnValue(null);
    vi.mocked(listHiddenWorkerWindows).mockReturnValue(["_garden-worker-calm-bay"]);
    vi.mocked(getFirstPaneId).mockImplementation((target: string) => {
      if (target.includes("calm-bay")) return "%10";
      return null;
    });
    vi.mocked(getWorkers).mockReturnValue([]);

    const lines: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => lines.push(msg);
    try {
      await status([]);
    } finally {
      console.log = origLog;
    }

    const activeLine = lines.find(l => l.includes("bold-ash"))!;
    const inactiveLine = lines.find(l => l.includes("calm-bay"))!;
    expect(activeLine).toMatch(/●/);
    expect(inactiveLine).toMatch(/○/);
  });
});

describe("no dashboard", () => {
  it("shows no workers when dashboard does not exist", async () => {
    vi.mocked(dashboardExists).mockReturnValue(false);

    const lines: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => lines.push(msg);
    try {
      await status([]);
    } finally {
      console.log = origLog;
    }

    expect(lines.some(l => l.includes("(no workers)"))).toBe(true);
  });
});

describe("renderQuickStatus", () => {
  it("returns no-projects message when config is empty", () => {
    vi.mocked(loadConfig).mockReturnValue({ projects: {} });
    const state = {
      activeProject: null,
      statusPaneId: null,
      gardenShellPaneId: null,
      activePaneId: null,
      activePaneType: null,
      activeWindowName: null,
    };
    expect(renderQuickStatus(state)).toBe("No projects added.");
  });

  it("shows active worker from state with registry status", () => {
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "fixing auth", prState: "reviewing" },
    ]);
    vi.mocked(listHiddenWorkerWindows).mockReturnValue([]);

    const state = {
      activeProject: "garden",
      statusPaneId: "%0",
      gardenShellPaneId: "%1",
      activePaneId: "%2",
      activePaneType: "worker" as const,
      activeWindowName: "_garden-worker-bold-ash",
    };

    const result = renderQuickStatus(state);
    expect(result).toContain("bold-ash");
    expect(result).toContain("reviewing");
    expect(result).toContain("fixing auth");
    expect(result).toMatch(/●/); // active indicator
  });

  it("shows hidden workers as inactive", () => {
    vi.mocked(getWorkers).mockReturnValue([]);
    vi.mocked(listHiddenWorkerWindows).mockReturnValue(["_garden-worker-calm-bay"]);

    const state = {
      activeProject: "garden",
      statusPaneId: "%0",
      gardenShellPaneId: "%1",
      activePaneId: "%2",
      activePaneType: "shell" as const,
      activeWindowName: "_garden-shell",
    };

    const result = renderQuickStatus(state);
    expect(result).toContain("calm-bay");
    expect(result).toMatch(/○/); // inactive indicator
  });

  it("resolves status to idle when task exists but no lifecycle prState", () => {
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "fixing auth" },
    ]);
    vi.mocked(listHiddenWorkerWindows).mockReturnValue([]);

    const state = {
      activeProject: "garden",
      statusPaneId: "%0",
      gardenShellPaneId: "%1",
      activePaneId: "%2",
      activePaneType: "worker" as const,
      activeWindowName: "_garden-worker-bold-ash",
    };

    const result = renderQuickStatus(state);
    expect(result).toContain("idle");
  });

  it("resolves status to ready when no task and no prState", () => {
    vi.mocked(getWorkers).mockReturnValue([]);
    vi.mocked(listHiddenWorkerWindows).mockReturnValue([]);

    const state = {
      activeProject: "garden",
      statusPaneId: "%0",
      gardenShellPaneId: "%1",
      activePaneId: "%2",
      activePaneType: "worker" as const,
      activeWindowName: "_garden-worker-bold-ash",
    };

    const result = renderQuickStatus(state);
    expect(result).toContain("ready");
  });

  it("uses provided windowNames instead of querying tmux", () => {
    vi.mocked(getWorkers).mockReturnValue([]);
    vi.mocked(listHiddenWorkerWindows).mockImplementation((_proj, names) => {
      // Should receive our passed-in names
      if (names) return names.filter(n => n.includes("-worker-"));
      return [];
    });

    const state = {
      activeProject: "garden",
      statusPaneId: "%0",
      gardenShellPaneId: "%1",
      activePaneId: "%2",
      activePaneType: "shell" as const,
      activeWindowName: "_garden-shell",
    };

    const result = renderQuickStatus(state, ["_garden-worker-swift-oak", "_garden-shell"]);
    expect(result).toContain("swift-oak");
  });

  it("includes merged registry-only workers", () => {
    vi.mocked(getWorkers).mockReturnValue([
      { name: "old-elm", sessionId: "xyz", task: "", prState: "merged", mergeCount: 2 },
    ]);
    vi.mocked(listHiddenWorkerWindows).mockReturnValue([]);

    const state = {
      activeProject: "garden",
      statusPaneId: "%0",
      gardenShellPaneId: "%1",
      activePaneId: "%2",
      activePaneType: "shell" as const,
      activeWindowName: "_garden-shell",
    };

    const result = renderQuickStatus(state);
    expect(result).toContain("old-elm");
    expect(result).toContain("merged (x2)");
  });
});

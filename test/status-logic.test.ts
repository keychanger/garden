import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/dashboard/tmux.js", () => ({
  getPanePid: vi.fn(),
  getPaneTitle: vi.fn(),
  getPaneLabel: vi.fn(),
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

vi.mock("../src/dashboard/merge-queue.js", () => ({
  getProjectQueue: vi.fn(() => []),
}));

vi.mock("../src/session.js", () => ({
  dashboardExists: vi.fn(() => true),
  DASHBOARD_SESSION: "garden-dashboard",
}));

vi.mock("../src/config.js", () => ({
  loadConfig: vi.fn(() => ({
    projects: { garden: { path: "/tmp/garden" } },
  })),
  SESSIONS_DIR: "/tmp/fake-sessions",
}));

vi.mock("../src/output.js", () => ({
  output: vi.fn(),
  isTTY: true,
}));

import { status } from "../src/commands/status.js";
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

  it("shows waiting when claude is running but no children", async () => {
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

    expect(lines.some(l => l.includes("waiting"))).toBe(true);
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

  it("shows no task when registry task is empty string", async () => {
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

    expect(lines.some(l => l.includes("(no task)"))).toBe(true);
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

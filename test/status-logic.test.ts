import { describe, it, expect, vi, beforeEach } from "vitest";

// The new status system is registry-driven: claudeStatus and prState are
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
    SESSIONS_DIR: "/tmp/fake-sessions",
  };
});

vi.mock("../src/output.js", () => ({
  output: vi.fn(),
  isTTY: true,
}));

import { status, renderQuickStatus, resolveWorkerStatus } from "../src/commands/status.js";
import { readDashState } from "../src/dashboard/state.js";
import { getWorkers } from "../src/dashboard/registry.js";
import { dashboardExists } from "../src/session.js";
import { loadConfig } from "../src/config.js";
import { listHiddenWorkerWindows } from "../src/dashboard/tmux.js";

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

describe("resolveWorkerStatus", () => {
  it("returns claudeStatus when no prState is set", () => {
    expect(resolveWorkerStatus({ claudeStatus: "loading" })).toBe("loading");
    expect(resolveWorkerStatus({ claudeStatus: "ready" })).toBe("ready");
    expect(resolveWorkerStatus({ claudeStatus: "working" })).toBe("working");
    expect(resolveWorkerStatus({ claudeStatus: "idle" })).toBe("idle");
    expect(resolveWorkerStatus({ claudeStatus: "exited" })).toBe("exited");
  });

  it("returns 'ready' when neither field is set", () => {
    expect(resolveWorkerStatus({})).toBe("ready");
    expect(resolveWorkerStatus(undefined)).toBe("ready");
  });

  it("lifecycle prState takes priority over claudeStatus", () => {
    expect(resolveWorkerStatus({ claudeStatus: "working", prState: "reviewing" })).toBe("reviewing");
    expect(resolveWorkerStatus({ claudeStatus: "idle", prState: "merge-pending" })).toBe("merge-pending");
    expect(resolveWorkerStatus({ claudeStatus: "working", prState: "failing" })).toBe("failing");
    expect(resolveWorkerStatus({ claudeStatus: "idle", prState: "merged" })).toBe("merged");
  });

  it("prState='working' is not displayed (claudeStatus shows through)", () => {
    // prState='working' means "no in-flight lifecycle state". The display
    // should reflect what Claude is doing, not the placeholder.
    expect(resolveWorkerStatus({ claudeStatus: "working", prState: "working" })).toBe("working");
    expect(resolveWorkerStatus({ claudeStatus: "idle", prState: "working" })).toBe("idle");
  });
});

describe("worker deduplication", () => {
  it("active worker appearing in hidden windows list shows up exactly once", async () => {
    vi.mocked(listHiddenWorkerWindows).mockReturnValue(["_garden-worker-bold-ash"]);
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "fixing auth", claudeStatus: "idle" },
    ]);

    const lines: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => lines.push(msg);
    try {
      await status([]);
    } finally {
      console.log = origLog;
    }

    const occurrences = lines.filter(l => l.includes("bold-ash")).length;
    expect(occurrences).toBe(1);
  });
});

describe("status display", () => {
  it("shows loading from registry", async () => {
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "", claudeStatus: "loading" },
    ]);
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => lines.push(msg);
    try { await status([]); } finally { console.log = origLog; }
    expect(lines.some(l => l.includes("loading"))).toBe(true);
  });

  it("shows ready from registry", async () => {
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "", claudeStatus: "ready" },
    ]);
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => lines.push(msg);
    try { await status([]); } finally { console.log = origLog; }
    expect(lines.some(l => l.includes("ready"))).toBe(true);
  });

  it("shows working from registry", async () => {
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "fixing auth", claudeStatus: "working" },
    ]);
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => lines.push(msg);
    try { await status([]); } finally { console.log = origLog; }
    expect(lines.some(l => l.includes("working"))).toBe(true);
  });

  it("shows idle from registry", async () => {
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "fixing auth", claudeStatus: "idle" },
    ]);
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => lines.push(msg);
    try { await status([]); } finally { console.log = origLog; }
    expect(lines.some(l => l.includes("idle"))).toBe(true);
  });

  it("shows exited from registry", async () => {
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "", claudeStatus: "exited" },
    ]);
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => lines.push(msg);
    try { await status([]); } finally { console.log = origLog; }
    expect(lines.some(l => l.includes("exited"))).toBe(true);
  });
});

describe("lifecycle state display (prState takes priority)", () => {
  it("shows reviewing when prState=reviewing, even if claudeStatus=working", async () => {
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "", claudeStatus: "working", prState: "reviewing" },
    ]);
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => lines.push(msg);
    try { await status([]); } finally { console.log = origLog; }
    expect(lines.some(l => l.includes("reviewing"))).toBe(true);
    expect(lines.some(l => l.includes("working"))).toBe(false);
  });

  it("shows merging when prState=merge-pending", async () => {
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "", claudeStatus: "idle", prState: "merge-pending" },
    ]);
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => lines.push(msg);
    try { await status([]); } finally { console.log = origLog; }
    expect(lines.some(l => l.includes("merging"))).toBe(true);
  });

  it("shows failing without count", async () => {
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "", claudeStatus: "idle", prState: "failing", failCount: 3 },
    ]);
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => lines.push(msg);
    try { await status([]); } finally { console.log = origLog; }
    expect(lines.some(l => l.includes("failing"))).toBe(true);
  });

  it("shows merged from prState", async () => {
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "", claudeStatus: "idle", prState: "merged" },
    ]);
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => lines.push(msg);
    try { await status([]); } finally { console.log = origLog; }
    expect(lines.some(l => l.includes("merged"))).toBe(true);
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
      { name: "bold-ash", sessionId: "abc", task: "fixing the build", claudeStatus: "working" },
    ]);
    const result = renderQuickStatus(state);
    expect(result).toContain("bold-ash");
    expect(result).toContain("working");
  });

  it("renders loading from registry", () => {
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "", claudeStatus: "loading" },
    ]);
    const result = renderQuickStatus(state);
    expect(result).toContain("loading");
  });

  it("renders idle when claudeStatus=idle and no lifecycle state", () => {
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "fixing auth", claudeStatus: "idle" },
    ]);
    const result = renderQuickStatus(state);
    expect(result).toContain("idle");
  });

  it("renders reviewing even if claudeStatus is working", () => {
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "", claudeStatus: "working", prState: "reviewing" },
    ]);
    const result = renderQuickStatus(state);
    expect(result).toContain("reviewing");
  });

  it("includes merged registry-only workers (window already gone)", () => {
    vi.mocked(getWorkers).mockReturnValue([
      { name: "old-elm", sessionId: "abc", task: "", prState: "merged" },
    ]);
    const result = renderQuickStatus(state);
    expect(result).toContain("old-elm");
    expect(result).toContain("merged");
  });
});

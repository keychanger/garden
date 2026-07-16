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
  // Stub ordering to the prior alphabetical behavior so these render tests
  // stay order-stable; the real comparator + staleness are unit-tested in
  // registry.test.ts.
  compareWorkerFreshness: (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name),
  isWorkerStale: () => false,
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
    getAutoContinueConfig: vi.fn(() => ({ enabled: true, usageThreshold: 95, resumeAfterReset: false })),
    projectUsageGateExempt: vi.fn(() => false),
    SESSIONS_DIR: "/tmp/fake-sessions",
  };
});

vi.mock("../src/dashboard/git.js", () => ({
  currentBranch: vi.fn(() => null),
  currentBranchFast: vi.fn(() => null),
  branchExistsOnOrigin: vi.fn(() => true),
}));

vi.mock("../src/dashboard/alerts.js", () => ({
  unreadAlertCountsByProject: vi.fn(() => new Map<string, number>()),
}));

vi.mock("../src/diary.js", () => ({
  diaryHasContent: vi.fn(() => false),
}));

vi.mock("../src/output.js", () => ({
  output: vi.fn(),
  isTTY: true,
}));

import { status, renderQuickStatus, resolveWorkerStatus, dimRow, truncateToVisibleWidth, visibleWidth, formatTimeInState, formatGateSuffix, _resetStatusBranchCacheForTest } from "../src/commands/status.js";
import { getAutoContinueConfig, projectUsageGateExempt } from "../src/config.js";
import { currentBranchFast, branchExistsOnOrigin } from "../src/dashboard/git.js";
import { unreadAlertCountsByProject } from "../src/dashboard/alerts.js";
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
  vi.mocked(projectUsageGateExempt).mockReturnValue(false);
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
    expect(resolveWorkerStatus({ agentStatus: "paused" })).toBe("paused");
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
    // A pipeline state still wins even over an operator-set paused agentStatus.
    expect(resolveWorkerStatus({ agentStatus: "paused", prState: "reviewing" })).toBe("reviewing");
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

  it("shows paused from registry and wraps the row in bold-cyan", async () => {
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "held by operator", agentStatus: "paused" },
    ]);
    const lines = await captureConsoleLog(() => status([]));
    const pausedLine = lines.find(l => l.includes("paused") && l.includes("bold-ash"));
    expect(pausedLine).toBeDefined();
    expect(pausedLine).toMatch(/\x1b\[1;36m/);
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

describe("render parity (status() TTY vs renderQuickStatus() baked)", () => {
  // The anti-drift guard for the one-renderer refactor: both paths build rows
  // through the same collectSegments/renderWorkerRow/renderProjectHeader, so a
  // fixed fleet must render byte-identical bodies. The baked path appends a
  // clear-to-EOL (\x1b[K) to every line and (with a paneWidth) width-caps; the
  // TTY path does neither. Strip the \x1b[K and pass no paneWidth, and the two
  // must match line-for-line — header (crew badge included) and worker rows.
  it("both paths emit identical header and worker-row bodies", async () => {
    const parityState = {
      activeProject: "garden",
      statusPaneId: "%0",
      gardenShellPaneId: "%1",
      activePaneId: "%2",
      activePaneType: "worker" as const,
      activeWindowName: "_garden-worker-bold-ash",
    };
    vi.mocked(readDashState).mockReturnValue(parityState);
    vi.mocked(listHiddenWorkerWindows).mockReturnValue([
      "_garden-worker-bold-ash",
      "_garden-worker-calm-fen",
    ]);
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "a", task: "fix auth", agentStatus: "working" },
      { name: "calm-fen", sessionId: "b", task: "review pass", prState: "reviewing" },
    ]);

    const ttyLines = await captureConsoleLog(() => status([]));
    const bakedLines = renderQuickStatus(parityState)
      .split("\n")
      .map(l => l.replace(/\x1b\[K$/, ""));

    expect(bakedLines).toEqual(ttyLines);
  });

  it("shows the default all-claude crew badge on the focused project (operator: always visible when highlighted)", async () => {
    // The focused project's crew is always shown now, including the default
    // all-claude — the badge rides only the highlighted header, so it reads as
    // context for the project you're in, not list-wide noise.
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "a", task: "x", agentStatus: "idle" },
    ]);
    const lines = await captureConsoleLog(() => status([]));
    expect(lines.join("\n")).toContain("\x1b[90mall-claude\x1b[0m");
  });

  it("garden status (CLI) shows a non-default crew badge, matching the dashboard pane", async () => {
    // The Phase 1 drift fix: the CLI header renders the crew badge the baked
    // pane always did. Asserted with a non-default crew for a distinct value.
    vi.mocked(loadConfig).mockReturnValue({
      projects: { garden: { path: "/tmp/garden", harness: "codex" } },
    });
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "a", task: "x", agentStatus: "idle", harness: "codex" },
    ]);
    const lines = await captureConsoleLog(() => status([]));
    expect(lines.join("\n")).toContain("\x1b[90mcodex-claude\x1b[0m");
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

  it("bakes a time-invariant working row so a busy fleet stays byte-stable across bakes", () => {
    // The load-bearing half of the cross-process repaint dedup (writeQuickStatus'
    // on-disk byte-compare): a working row's spinner is baked as a FIXED frame
    // and animated locally by the pane, so two bakes seconds apart are
    // byte-identical and the write + SIGUSR1 can be skipped. The prior
    // Date.now()-derived frame advanced every ~2s and churned the rendered
    // bytes, defeating the dedup for any fleet with a live worker.
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "fixing the build", agentStatus: "working" },
    ]);
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const first = renderQuickStatus(state);
    nowSpy.mockReturnValue(1_000_000 + 5_000); // 5s later: a Date.now()-derived frame would have advanced
    const second = renderQuickStatus(state);
    nowSpy.mockRestore();
    expect(second).toBe(first);
  });

  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
  // The rendered worker name comes from the focused window suffix (collectWorkers),
  // so a long name is produced via the active window, not a registry entry.
  const longName = "a-really-long-worker-name-that-would-wrap-the-status-pane";
  const longState = { ...state, activeWindowName: `_garden-worker-${longName}` };

  it("hard-caps every row to the pane width when paneWidth is given", () => {
    vi.mocked(getWorkers).mockReturnValue([
      { name: longName, sessionId: "abc", task: "and a long activity too ".repeat(4), agentStatus: "working" },
    ]);
    const width = 40;
    const result = renderQuickStatus(longState, undefined, undefined, undefined, width);
    for (const line of result.split("\n")) {
      expect(stripAnsi(line).length).toBeLessThanOrEqual(width - 2);
    }
  });

  it("leaves rows uncapped when paneWidth is omitted (height-only callers)", () => {
    vi.mocked(getWorkers).mockReturnValue([
      { name: longName, sessionId: "abc", task: "", agentStatus: "working" },
    ]);
    const result = renderQuickStatus(longState);
    const longest = Math.max(...result.split("\n").map(l => stripAnsi(l).length));
    expect(longest).toBeGreaterThan(40);
  });

  it("appends a yellow time-in-state suffix to a long-running reviewing row", () => {
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "", prState: "reviewing",
        lastStateChangeAt: Date.now() - 12 * 60_000 },
    ]);
    const result = renderQuickStatus(state);
    expect(result).toContain("reviewing");
    // 12m is past the 10m soft expectation for reviewing -> yellow.
    expect(result).toMatch(/\x1b\[33m12m\x1b\[0m/);
  });

  it("omits the time-in-state suffix for a working row", () => {
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "building", agentStatus: "working",
        lastStateChangeAt: Date.now() - 30 * 60_000 },
    ]);
    const result = renderQuickStatus(state);
    // working is not a time-tracked state — no minute/hour suffix.
    expect(result).not.toMatch(/\d+[mhd]\x1b\[0m/);
  });

  it("flags a merged row 'gate closed' when auto-continue is disabled", () => {
    vi.mocked(getAutoContinueConfig).mockReturnValue({ enabled: false, usageThreshold: 95, resumeAfterReset: false });
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "", prState: "merged" },
    ]);
    const result = renderQuickStatus(state);
    expect(result).toContain("gate closed");
  });

  it("does not flag a merged row when the gate is open", () => {
    vi.mocked(getAutoContinueConfig).mockReturnValue({ enabled: true, usageThreshold: 95, resumeAfterReset: false });
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "", prState: "merged" },
    ]);
    const result = renderQuickStatus(state);
    expect(result).not.toContain("gate closed");
  });

  it("does not flag a usage-exempt project's merged row on a usage pause", () => {
    // Usage-triggered closure (pausedUntil set): a project on a separate token
    // pool auto-continues anyway, so its row must not claim "gate closed".
    vi.mocked(getAutoContinueConfig).mockReturnValue({
      enabled: false, usageThreshold: 95, resumeAfterReset: false,
      pausedUntil: "2099-01-01T00:00:00Z", pausedReason: "5h at 99%",
    });
    vi.mocked(projectUsageGateExempt).mockReturnValue(true);
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "", prState: "merged" },
    ]);
    const result = renderQuickStatus(state);
    expect(result).not.toContain("gate closed");
  });

  it("still flags a usage-exempt project's merged row on an explicit auto off", () => {
    // Manual `garden auto off` (no pausedUntil) blocks every project.
    vi.mocked(getAutoContinueConfig).mockReturnValue({ enabled: false, usageThreshold: 95, resumeAfterReset: false });
    vi.mocked(projectUsageGateExempt).mockReturnValue(true);
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "", prState: "merged" },
    ]);
    const result = renderQuickStatus(state);
    expect(result).toContain("gate closed");
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
    vi.mocked(currentBranchFast).mockReturnValue("main");
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "", agentStatus: "working" },
    ]);
    renderQuickStatus(state);
    renderQuickStatus(state);
    // Two bakes, one focused project: the branch is resolved once; the second
    // bake hits the TTL cache instead of re-reading .git/HEAD.
    expect(vi.mocked(currentBranchFast)).toHaveBeenCalledTimes(1);
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

  it("renders paused rows wrapped in bold-cyan ANSI", () => {
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "held by operator", agentStatus: "paused" },
    ]);
    const result = renderQuickStatus(state);
    expect(result).toContain("paused");
    expect(result).toMatch(/\x1b\[1;36m[^\n]*bold-ash[^\n]*\x1b\[0m/);
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

  it("renders a trellis vine's bracket in the activity slot and drops its activity", () => {
    vi.mocked(getWorkers).mockReturnValue([
      {
        name: "bold-ash",
        sessionId: "abc",
        task: "implementing the auth rewrite per the trellis",
        agentStatus: "working",
        workflow: "trellis",
        trellis: {
          name: "auth-rewrite",
          iteration: 4,
          maxIterations: 30,
          lastVerdict: "DRIFT",
          lastDrift: ["a", "b", "c"],
        },
      },
    ]);
    const result = renderQuickStatus(state);
    // The bracket renders, and the live activity is dropped (redundant with
    // the trellis name) so the row can't blow its width and wrap in the pane.
    expect(result).toContain("[trellis: auth-rewrite | 4/30 | 3 drift]");
    expect(result).not.toContain("implementing the auth rewrite");
    // The bracket sits in the activity slot — two spaces ahead of "[" — so its
    // "[" lines up with the activity column on sibling rows.
    expect(result).toContain("  [trellis: auth-rewrite");
  });

  it("keeps the live activity on a default-workflow row (bracket drop is trellis-only)", () => {
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "rewiring the poller", agentStatus: "working" },
    ]);
    const result = renderQuickStatus(state);
    expect(result).toContain("rewiring the poller");
  });

});

describe("branch hint", () => {
  const YELLOW = "\x1b[33m";
  const GREY = "\x1b[90m";
  const RESET = "\x1b[0m";
  const state = {
    activeProject: "garden",
    statusPaneId: "%0",
    gardenShellPaneId: "%1",
    activePaneId: "%2",
    activePaneType: "worker" as const,
    activeWindowName: "_garden-worker-bold-ash",
  };

  const lineFor = (result: string, name: string): string =>
    result.split("\n").find(l => l.includes(name)) ?? "";

  it("flags a worker whose pinned base diverges from the checkout in yellow", () => {
    vi.mocked(currentBranchFast).mockReturnValue("main");
    vi.mocked(listHiddenWorkerWindows).mockReturnValue([]);
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "", agentStatus: "working", baseBranch: "feature-x" },
    ]);
    const result = renderQuickStatus(state);
    expect(lineFor(result, "bold-ash")).toContain(`${YELLOW}→ feature-x${RESET}`);
  });

  it("omits the hint when a lone worker's base matches the checkout", () => {
    vi.mocked(currentBranchFast).mockReturnValue("main");
    vi.mocked(listHiddenWorkerWindows).mockReturnValue([]);
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "", agentStatus: "working", baseBranch: "main" },
    ]);
    const result = renderQuickStatus(state);
    expect(result).not.toContain("→");
  });

  it("shows every worker's base when any one diverges — diverging yellow, matching grey", () => {
    vi.mocked(currentBranchFast).mockReturnValue("main");
    // calm-bay is also surfaced via a hidden window so two workers render under
    // the one project; the comparator mock orders them alphabetically.
    vi.mocked(listHiddenWorkerWindows).mockReturnValue(["_garden-worker-calm-bay"]);
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "abc", task: "", agentStatus: "working", baseBranch: "main" },
      { name: "calm-bay", sessionId: "def", task: "", agentStatus: "working", baseBranch: "feature-x" },
    ]);
    const result = renderQuickStatus(state);
    // The off-base worker keeps the yellow warning.
    expect(lineFor(result, "calm-bay")).toContain(`${YELLOW}→ feature-x${RESET}`);
    // The on-base worker now shows its base too, but in grey so it doesn't read
    // as a warning — answering "what does this one target?" unambiguously.
    expect(lineFor(result, "bold-ash")).toContain(`${GREY}→ main${RESET}`);
  });
});

// Phase 2: with an explicit baseBranch config key, the row uses per-worker
// override semantics (grey = deliberate override, yellow = base gone from
// origin) with NO project-wide sibling toggle, and the header carries a grey
// ⋅base token. Configured via the cachedConfig arg to renderQuickStatus.
describe("explicit baseBranch (configured project)", () => {
  const YELLOW = "\x1b[33m";
  const GREY = "\x1b[90m";
  const RESET = "\x1b[0m";
  const state = {
    activeProject: "garden",
    statusPaneId: "%0",
    gardenShellPaneId: "%1",
    activePaneId: "%2",
    activePaneType: "worker" as const,
    activeWindowName: "_garden-worker-bold-ash",
  };
  const cfg = { projects: { garden: { path: "/tmp/garden", baseBranch: "v2-api" } } };
  const lineFor = (result: string, name: string): string =>
    result.split("\n").find(l => l.includes(name)) ?? "";

  beforeEach(() => {
    vi.mocked(branchExistsOnOrigin).mockReturnValue(true);
  });

  it("shows no hint when the worker base matches the configured base", () => {
    vi.mocked(listHiddenWorkerWindows).mockReturnValue([]);
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "a", task: "", agentStatus: "working", baseBranch: "v2-api" },
    ]);
    const result = renderQuickStatus(state, undefined, cfg);
    expect(lineFor(result, "bold-ash")).not.toContain("→");
  });

  it("marks a per-worker override grey (not the yellow checkout warning)", () => {
    vi.mocked(listHiddenWorkerWindows).mockReturnValue([]);
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "a", task: "", agentStatus: "working", baseBranch: "main" },
    ]);
    const result = renderQuickStatus(state, undefined, cfg);
    expect(lineFor(result, "bold-ash")).toContain(`${GREY}→ main${RESET}`);
  });

  it("marks a base missing from origin yellow (a genuine merge-will-fail fault)", () => {
    vi.mocked(branchExistsOnOrigin).mockImplementation((_p, b) => b !== "gone");
    vi.mocked(listHiddenWorkerWindows).mockReturnValue([]);
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "a", task: "", agentStatus: "working", baseBranch: "gone" },
    ]);
    const result = renderQuickStatus(state, undefined, cfg);
    expect(lineFor(result, "bold-ash")).toContain(`${YELLOW}→ gone${RESET}`);
  });

  it("renders a grey ⋅base token on the project header", () => {
    vi.mocked(listHiddenWorkerWindows).mockReturnValue([]);
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "a", task: "", agentStatus: "working", baseBranch: "v2-api" },
    ]);
    const result = renderQuickStatus(state, undefined, cfg);
    expect(lineFor(result, "garden")).toContain(`${GREY}⋅v2-api${RESET}`);
  });

  it("does NOT toggle siblings on: a matching sibling stays hint-free when another diverges", () => {
    vi.mocked(listHiddenWorkerWindows).mockReturnValue(["_garden-worker-calm-bay"]);
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "a", task: "", agentStatus: "working", baseBranch: "v2-api" },
      { name: "calm-bay", sessionId: "b", task: "", agentStatus: "working", baseBranch: "main" },
    ]);
    const result = renderQuickStatus(state, undefined, cfg);
    // The diverging worker shows a grey override...
    expect(lineFor(result, "calm-bay")).toContain(`${GREY}→ main${RESET}`);
    // ...but the matching sibling shows NOTHING (the legacy sibling-toggle is
    // gone on configured projects — each row depends only on its own base).
    expect(lineFor(result, "bold-ash")).not.toContain("→");
  });
});

// Phase 3: the identity-vs-status grammar. Grey override-only badges
// (member/model), grow N/M parity, the elapsed folded into the state cell,
// truncation priority, and the ⚠n header token.
describe("identity badges + grammar (Phase 3)", () => {
  const GREY = "\x1b[90m";
  const RESET = "\x1b[0m";
  const state = {
    activeProject: "garden",
    statusPaneId: "%0",
    gardenShellPaneId: "%1",
    activePaneId: "%2",
    activePaneType: "worker" as const,
    activeWindowName: "_garden-worker-bold-ash",
  };
  const lineFor = (result: string, name: string): string =>
    result.split("\n").find(l => l.includes(name)) ?? "";

  beforeEach(() => {
    vi.mocked(listHiddenWorkerWindows).mockReturnValue([]);
  });

  it("badges a worker whose member (harness) differs from the project default", () => {
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "a", task: "x", agentStatus: "idle", harness: "codex" },
    ]);
    expect(lineFor(renderQuickStatus(state), "bold-ash")).toContain(`${GREY}codex${RESET}`);
  });

  it("badges a worker's per-worker crew, superseding the build-member badge", () => {
    // A --crew all-codex worker on a default (all-claude) project: the crew name
    // shows (it encodes the reviewer), and the standalone member badge does not.
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "a", task: "x", agentStatus: "idle", harness: "codex", crew: "all-codex" },
    ]);
    const line = lineFor(renderQuickStatus(state), "bold-ash");
    expect(line).toContain(`${GREY}all-codex${RESET}`);      // crew badge shown
    expect(line).not.toContain(`${GREY}codex${RESET}`);      // member badge suppressed
  });

  it("shows a per-worker crew badge even when the build harness matches the project (reviewer-only override)", () => {
    // ⌥i reviewer→codex on a claude worker: entry.crew=claude-codex, harness stays claude.
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "a", task: "x", agentStatus: "idle", crew: "claude-codex" },
    ]);
    expect(lineFor(renderQuickStatus(state), "bold-ash")).toContain(`${GREY}claude-codex${RESET}`);
  });

  it("shows the crew badge only on the FOCUSED project's header", () => {
    const cfg = { projects: {
      garden: { path: "/tmp/garden", harness: "codex" },   // active project, non-default crew
      other: { path: "/tmp/other", harness: "codex" },     // inactive project, non-default crew
    } };
    vi.mocked(getWorkers).mockReturnValue([]);
    const result = renderQuickStatus(state, undefined, cfg);   // state.activeProject === "garden"
    const header = (name: string) => result.split("\n").find(l => l.includes(name) && l.includes(".")) ?? "";
    expect(header("garden")).toContain("codex-claude");    // focused → shown
    expect(header("other")).not.toContain("codex-claude"); // not focused → hidden
  });

  it("omits any identity badge for a plain default worker (default is invisible)", () => {
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "a", task: "x", agentStatus: "idle" },
    ]);
    // No grey identity token anywhere on the row (no base/member/model badge).
    expect(lineFor(renderQuickStatus(state), "bold-ash")).not.toContain(GREY);
  });

  it("badges a pinned worker model, and a trellis vine's workerModel", () => {
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "a", task: "x", agentStatus: "idle", model: "sonnet" },
    ]);
    expect(lineFor(renderQuickStatus(state), "bold-ash")).toContain(`${GREY}sonnet${RESET}`);

    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "a", task: "x", agentStatus: "idle", workflow: "trellis",
        trellis: { name: "auth", iteration: 2, maxIterations: 30, workerModel: "opus" } },
    ]);
    expect(lineFor(renderQuickStatus(state), "bold-ash")).toContain(`${GREY}opus${RESET}`);
  });

  it("rides the model AFTER the detail and does not dead-space a model-less sibling", () => {
    // calm-bay renders alongside via a hidden window, so two workers share the
    // one project (and thus the one badge column).
    vi.mocked(listHiddenWorkerWindows).mockReturnValue(["_garden-worker-calm-bay"]);
    const workers = [
      { name: "bold-ash", sessionId: "a", task: "wiring the auth flow", agentStatus: "working" as const },
      { name: "calm-bay", sessionId: "b", task: "serving quant data", agentStatus: "working" as const },
    ];
    // Baseline: neither worker pins a model.
    vi.mocked(getWorkers).mockReturnValue(workers);
    const baseSibling = lineFor(renderQuickStatus(state), "calm-bay");

    // Pin a long model id on bold-ash — the worst case for the old leading
    // badge column, which would have widened by ~len("claude-opus-4-8")+2.
    vi.mocked(getWorkers).mockReturnValue([
      { ...workers[0], model: "claude-opus-4-8" },
      workers[1],
    ]);
    const result = renderQuickStatus(state);
    const pinned = lineFor(result, "bold-ash");
    const sibling = lineFor(result, "calm-bay");

    // The model is a trailing tag: it renders AFTER the detail text, not before.
    expect(pinned.indexOf("claude-opus-4-8")).toBeGreaterThan(pinned.indexOf("wiring the auth flow"));
    // The model-less sibling's row is byte-identical with or without the pin —
    // a long model id no longer inflates the shared badge column and pushes
    // every model-less description to the right.
    expect(sibling).toBe(baseSibling);
  });

  it("renders grow N/M in the detail column (parity with the trellis counter)", () => {
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "a", task: "polishing", agentStatus: "working",
        workflow: "grow", grow: { seed: "harden", iteration: 2, maxIterations: 5 } },
    ]);
    const line = lineFor(renderQuickStatus(state), "bold-ash");
    expect(line).toContain("grow 2/5");
    // The counter replaces the live activity, just as the trellis bracket does.
    expect(line).not.toContain("polishing");
  });

  it("folds the elapsed time into the state cell (reviewing 12m, adjacent)", () => {
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "a", task: "x", prState: "reviewing",
        lastStateChangeAt: Date.now() - 12 * 60_000 },
    ]);
    // "reviewing" immediately followed by the elapsed suffix — one cell, one fact.
    expect(lineFor(renderQuickStatus(state), "bold-ash")).toMatch(/reviewing \x1b\[33m12m\x1b\[0m/);
  });

  it("renders a yellow ⚠n unread-alert count on the project header, cleared when zero", () => {
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "a", task: "x", agentStatus: "idle" },
    ]);
    vi.mocked(unreadAlertCountsByProject).mockReturnValue(new Map([["garden", 2]]));
    expect(lineFor(renderQuickStatus(state), "garden")).toContain("\x1b[33m⚠2\x1b[0m");

    vi.mocked(unreadAlertCountsByProject).mockReturnValue(new Map());
    expect(lineFor(renderQuickStatus(state), "garden")).not.toContain("⚠");
  });

  it("truncates detail first and keeps the flags (gate closed) on a narrow pane", () => {
    vi.mocked(getAutoContinueConfig).mockReturnValue({ enabled: false, usageThreshold: 95, resumeAfterReset: false });
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "a", task: "a-very-long-activity-string-that-cannot-fit", prState: "merged" },
    ]);
    const line = lineFor(renderQuickStatus(state, undefined, undefined, undefined, 60), "bold-ash");
    // The status-class flag survives at the end of the row...
    expect(line).toContain("gate closed");
    // ...while the elastic detail is truncated (the full string does not fit).
    expect(line).not.toContain("a-very-long-activity-string-that-cannot-fit");
  });

  it("drops the badge cluster before the core on a narrow pane", () => {
    vi.mocked(getWorkers).mockReturnValue([
      { name: "bold-ash", sessionId: "a", task: "short", agentStatus: "idle", harness: "codex", model: "sonnet" },
    ]);
    // Wide: the badges render.
    expect(lineFor(renderQuickStatus(state, undefined, undefined, undefined, 200), "bold-ash"))
      .toContain(`${GREY}codex${RESET}`);
    // Narrow: badges drop as a unit, but the name and state (the core) survive.
    const line = lineFor(renderQuickStatus(state, undefined, undefined, undefined, 40), "bold-ash");
    expect(line).toContain("bold-ash");
    expect(line).toContain("idle");
    expect(line).not.toContain("codex");
  });
});

describe("visibleWidth", () => {
  it("ignores CSI escape sequences (colored text measures by its glyphs)", () => {
    expect(visibleWidth("\x1b[90mhi\x1b[0m")).toBe(2);
    expect(visibleWidth("reviewing \x1b[33m12m\x1b[0m")).toBe(13);
  });
  it("counts plain glyphs", () => {
    expect(visibleWidth("bold-ash")).toBe(8);
  });
});

describe("dimRow", () => {
  const FAINT = "\x1b[2m";
  const RESET = "\x1b[0m";

  it("wraps a plain line in faint and a trailing reset", () => {
    expect(dimRow("hello")).toBe(`${FAINT}hello${RESET}`);
  });

  it("re-arms faint after an inner reset so the whole row stays dimmed", () => {
    // A row with an embedded colored segment (the base-divergence hint) whose
    // own reset would otherwise cancel the faint attribute and half-brighten
    // the rest of the line.
    const line = `worker  \x1b[33m→ main${RESET}`;
    const dimmed = dimRow(line);
    expect(dimmed).toContain(`${RESET}${FAINT}`);          // faint re-armed after the inner reset
    expect(dimmed.startsWith(FAINT)).toBe(true);
    expect(dimmed.endsWith(RESET)).toBe(true);
    expect(dimmed).toBe(`${FAINT}worker  \x1b[33m→ main${RESET}${FAINT}${RESET}`);
  });
});

describe("truncateToVisibleWidth", () => {
  const visible = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").length;

  it("leaves a plain string within width untouched", () => {
    expect(truncateToVisibleWidth("hello", 10)).toBe("hello");
  });

  it("truncates a plain string to the visible width", () => {
    expect(truncateToVisibleWidth("hello world", 5)).toBe("hello");
  });

  it("does not count CSI escapes toward the width, and preserves them", () => {
    // 5 visible chars wrapped in color — fits within width 5, unchanged.
    const s = "\x1b[36mhello\x1b[0m";
    expect(truncateToVisibleWidth(s, 5)).toBe(s);
    expect(visible(truncateToVisibleWidth(s, 5))).toBe(5);
  });

  it("closes a color cut mid-run with a reset so it does not bleed", () => {
    const out = truncateToVisibleWidth("\x1b[31mredtext", 3);
    expect(out).toBe("\x1b[31mred\x1b[0m");
  });

  it("adds no reset when truncating a string that had no escapes", () => {
    expect(truncateToVisibleWidth("plaintext", 4)).toBe("plai");
  });

  it("caps a dimRow-wrapped line to the visible width and stays balanced", () => {
    const row = dimRow("worker  \x1b[33m→ main\x1b[0m");
    const out = truncateToVisibleWidth(row, 4);
    expect(visible(out)).toBe(4);      // "work"
    expect(out.endsWith("\x1b[0m")).toBe(true);
  });

  it("returns only escapes (or empty) at width 0", () => {
    expect(visible(truncateToVisibleWidth("\x1b[31mabc", 0))).toBe(0);
  });

  it("counts wide glyphs (emoji, CJK) as two columns so they never wrap", () => {
    // Each 🚀 renders two columns; width 4 fits exactly two, and the third is
    // dropped before it can push the row past the cap.
    expect(truncateToVisibleWidth("🚀🚀🚀 go", 4)).toBe("🚀🚀");
    expect(truncateToVisibleWidth("中文字", 4)).toBe("中文");
  });

  it("treats combining marks as zero width", () => {
    // "e" + combining acute (U+0301) is one column, so it plus "f" fits width 2.
    expect(truncateToVisibleWidth("e" + String.fromCodePoint(0x301) + "fg", 2)).toBe("e" + String.fromCodePoint(0x301) + "f");
  });
});

describe("formatTimeInState", () => {
  const NOW = 1_700_000_000_000;
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");

  it("returns empty for states that are not time-tracked", () => {
    // working/idle/ready/loading/exited/merged/done never carry the suffix.
    for (const st of ["working", "idle", "ready", "loading", "exited", "merged", "done"] as const) {
      expect(formatTimeInState(st, NOW - 30 * 60_000, NOW)).toBe("");
    }
  });

  it("returns empty when the timestamp is missing", () => {
    expect(formatTimeInState("reviewing", undefined, NOW)).toBe("");
  });

  it("suppresses the suffix under a minute (no 0m)", () => {
    expect(formatTimeInState("reviewing", NOW - 59_000, NOW)).toBe("");
  });

  it("shows minutes as a dim grey suffix under the soft threshold", () => {
    const out = formatTimeInState("reviewing", NOW - 5 * 60_000, NOW);
    expect(stripAnsi(out)).toBe(" 5m");
    expect(out).toContain("\x1b[90m");   // grey
    expect(out).not.toContain("\x1b[33m"); // not yellow
  });

  it("escalates to yellow once a pipeline state passes its soft expectation", () => {
    const out = formatTimeInState("reviewing", NOW - 12 * 60_000, NOW);
    expect(stripAnsi(out)).toBe(" 12m");
    expect(out).toContain("\x1b[33m");   // yellow
  });

  it("keeps blocked states (asking/failing) dim — the row color already carries urgency", () => {
    // 3h in — well past any pipeline threshold — but asking/failing never escalate.
    for (const st of ["asking", "failing"] as const) {
      const out = formatTimeInState(st, NOW - 3 * 60 * 60_000, NOW);
      expect(stripAnsi(out)).toBe(" 3h");
      expect(out).toContain("\x1b[90m");
      expect(out).not.toContain("\x1b[33m");
    }
  });

  it("humanizes hours and days", () => {
    expect(stripAnsi(formatTimeInState("reviewing", NOW - 2 * 60 * 60_000, NOW))).toBe(" 2h");
    expect(stripAnsi(formatTimeInState("failing", NOW - 3 * 24 * 60 * 60_000, NOW))).toBe(" 3d");
  });

  it("ends in a reset so it stays ANSI-clean at the end of a row", () => {
    expect(formatTimeInState("merge-pending", NOW - 5 * 60_000, NOW).endsWith("\x1b[0m")).toBe(true);
  });
});

describe("formatGateSuffix", () => {
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");

  it("flags a merged row when the gate is closed", () => {
    const out = formatGateSuffix("merged", true);
    expect(stripAnsi(out)).toBe(" gate closed");
    expect(out).toContain("\x1b[33m");        // yellow — operator-actionable
    expect(out.endsWith("\x1b[0m")).toBe(true);
  });

  it("is empty for a merged row when the gate is open", () => {
    expect(formatGateSuffix("merged", false)).toBe("");
  });

  it("is empty for non-merged states even when the gate is closed", () => {
    for (const st of ["working", "reviewing", "done", "failing", "asking"] as const) {
      expect(formatGateSuffix(st, true)).toBe("");
    }
  });
});

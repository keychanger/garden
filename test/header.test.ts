import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — declared before the module under test is imported
// ---------------------------------------------------------------------------

vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn(() => false),
    statSync: vi.fn(() => ({ isFIFO: () => false })),
    openSync: vi.fn(() => 3),
    writeSync: vi.fn(),
    closeSync: vi.fn(),
    unlinkSync: vi.fn(),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(() => "{}"),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    constants: { O_CREAT: 0, O_EXCL: 0, O_WRONLY: 0 },
  },
}));

vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => ""),
  execFileSync: vi.fn(() => "0"),
}));

vi.mock("../src/config.js", () => ({
  tryGetProject: vi.fn(() => ({ path: "/repo/garden" })),
  loadConfig: vi.fn(() => ({
    projects: { garden: { path: "/repo/garden" }, other: { path: "/repo/other" } },
    // 5+ projects in the largest plot so the derived floor hits the 5-project
    // cap (slice(0, 5)). With an empty registry, bodySum = 5 and N = 5,
    // so floorLines = 2*5 + 5 + 1 = 16.
    plots: {
      all: { projects: ["garden", "other", "p3", "p4", "p5"] },
      imp: { projects: ["garden"] },
    },
  })),
  SESSIONS_DIR: "/tmp/fake-sessions",
  plotsMap: vi.fn((cfg: { plots?: Record<string, unknown> }) => cfg.plots ?? {}),
  isPlotFocused: vi.fn((plot: { focused?: boolean }) => plot.focused !== false),
}));

vi.mock("../src/session.js", () => ({
  DASHBOARD_SESSION: "garden-dashboard",
}));

vi.mock("../src/dashboard/tmux.js", () => ({
  tmux: vi.fn(),
  tmuxOutput: vi.fn(() => ""),
  getFirstPaneId: vi.fn(() => null),
  getPaneTitle: vi.fn(() => null),
  getPanePid: vi.fn(() => null),
  getPaneSize: vi.fn(() => null),
  windowExists: vi.fn(() => false),
  setPaneVar: vi.fn(),
  listAllWindowNames: vi.fn(() => []),
}));

vi.mock("../src/dashboard/state.js", () => ({
  readDashState: vi.fn(() => ({
    activeProject: "garden",
    statusPaneId: null,
    gardenShellPaneId: null,
    activePaneId: null,
    activePaneType: null,
    activeWindowName: null,
  })),
}));

vi.mock("../src/dashboard/registry.js", () => ({
  readRegistry: vi.fn(() => ({ workers: {} })),
  getWorkers: vi.fn(() => []),
  findWorkerByName: vi.fn(() => undefined),
  updateWorkerFields: vi.fn(),
  batchUpdateWorkerFields: vi.fn(),
}));

vi.mock("../src/dashboard/git.js", () => ({
  resolveBaseBranch: vi.fn(() => "main"),
  getWorkerBaseBranch: vi.fn((entry: { baseBranch?: string }) => entry.baseBranch ?? "main"),
  currentBranch: vi.fn(() => "main"),
}));

vi.mock("../src/dashboard/poller.js", () => ({
  triggerProjectPoll: vi.fn(),
  signalFifoPath: vi.fn(() => "/tmp/fake-sessions/garden-poll-signal"),
}));

vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/version.js", () => ({
  GARDEN_VERSION: "abc1234",
}));

vi.mock("../src/commands/status.js", () => ({
  renderQuickStatus: vi.fn(() => "line1\nline2\nline3"),
  resolveWorkerStatus: vi.fn(() => "idle"),
}));

vi.mock("../src/dashboard/usage.js", () => ({
  maybeRefreshUsage: vi.fn(),
  renderUsagePane: vi.fn(() => "u1\nu2\nu3"),
}));

vi.mock("../src/dashboard/create.js", () => ({
  resolveGardenRunner: vi.fn(() => "/usr/local/bin/garden"),
}));

vi.mock("../src/dashboard/window-names.js", () => ({
  workerWindowName: (project: string, worker: string) => `_${project}-worker-${worker}`,
  parseWorkerWindow: (name: string) => {
    const m = name.match(/^_(.+)-worker-(.+)$/);
    return m ? { project: m[1], worker: m[2] } : null;
  },
}));

// ---------------------------------------------------------------------------
// Imports — after mocks
// ---------------------------------------------------------------------------

import {
  setupStatusBar,
  updateHeaderVar,
  handlePaneDied,
  buildStatusCommand,
  buildUsageCommand,
  refreshStatusPane,
  refreshUsagePane,
  refreshDashboard,
  installInputGuard,
} from "../src/dashboard/header.js";

import { tmux, getPanePid, getPaneSize, getPaneTitle, setPaneVar } from "../src/dashboard/tmux.js";
import { readDashState, type DashboardState } from "../src/dashboard/state.js";
import { findWorkerByName, updateWorkerFields, readRegistry, batchUpdateWorkerFields } from "../src/dashboard/registry.js";
import { currentBranch } from "../src/dashboard/git.js";
import { renderQuickStatus, resolveWorkerStatus } from "../src/commands/status.js";
import { isPlotFocused, loadConfig } from "../src/config.js";
import { log } from "../src/dashboard/log.js";
import fs from "node:fs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeState(overrides: Partial<DashboardState> = {}): DashboardState {
  return {
    activeProject: "garden",
    statusPaneId: null,
    usagePaneId: null,
    gardenShellPaneId: null,
    activePaneId: null,
    activePaneType: null,
    activeWindowName: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  // Re-apply default mock return values after resetAllMocks clears them
  vi.mocked(readDashState).mockReturnValue(makeState());
  vi.mocked(readRegistry).mockReturnValue({ workers: {} });
  vi.mocked(findWorkerByName).mockReturnValue(undefined);
  vi.mocked(getPanePid).mockReturnValue(null);
  vi.mocked(getPaneSize).mockReturnValue(null);
  vi.mocked(getPaneTitle).mockReturnValue(null);
  vi.mocked(renderQuickStatus).mockReturnValue("line1\nline2\nline3");
  vi.mocked(currentBranch).mockReturnValue("main");
});

// ===========================================================================
// buildStatusCommand
// ===========================================================================

describe("buildStatusCommand", () => {
  it("returns a shell script string", () => {
    const cmd = buildStatusCommand("/usr/local/bin/garden");
    expect(typeof cmd).toBe("string");
    expect(cmd.length).toBeGreaterThan(0);
  });

  it("contains the gardenRunner path in the status subprocess call", () => {
    const cmd = buildStatusCommand("/usr/local/bin/garden");
    expect(cmd).toContain("/usr/local/bin/garden");
    expect(cmd).toContain("GARDEN_PRETTY=1");
    expect(cmd).toContain("status");
  });

  it("sets up SIGUSR1 trap for event-driven refresh", () => {
    const cmd = buildStatusCommand("garden");
    expect(cmd).toContain("trap");
    expect(cmd).toContain("USR1");
  });

  it("contains spinner animation logic with braille characters", () => {
    const cmd = buildStatusCommand("garden");
    // Should contain at least one braille spinner frame
    expect(cmd).toContain("\u280B");
    expect(cmd).toContain("sleep 0.12");
  });

  it("animates via a per-line partial repaint so static lines don't flicker every frame", () => {
    const cmd = buildStatusCommand("garden");
    // awk emits cursor-positioned updates for spinner lines only — no full-pane redraw per frame.
    expect(cmd).toMatch(/awk .* gsub\(b, f\); printf "\\033\[%d;1H%s"/);
    // Pipe form, not here-string: `awk <<<"$cur"` raced with the USR1 trap and wedged the loop.
    expect(cmd).toContain(`printf '%s\\n' "$cur" | awk`);
  });

  it("keeps the SIGUSR1 trap narrow (only re-reads $sf, not $pst)", () => {
    const cmd = buildStatusCommand("garden");
    // Extract the trap action body (between the first quote after `trap '` and the matching `'`).
    const m = cmd.match(/trap '([^']*)' USR1/);
    expect(m).not.toBeNull();
    const body = m![1];
    expect(body).toContain(`cat "$sf"`);
    // pt_tpl reload must NOT live inside the trap — extra $(cat) in the handler
    // stacks SIGCHLDs on the inner loop's `wait` and wedges signal delivery.
    expect(body).not.toContain("pt_tpl=");
    expect(body).not.toContain(`cat "$pst"`);
  });

  it("contains the idle sleep with long timeout", () => {
    const cmd = buildStatusCommand("garden");
    expect(cmd).toContain("sleep 86400");
  });

  it("kills backgrounded sleeps after wait so SIGUSR1 doesn't leak them", () => {
    const cmd = buildStatusCommand("garden");
    // Trailing `wait $_sp` reaps the killed sleep synchronously; without it
    // bash emits an async "sh: line N: PID Terminated: 15 ..." job notice.
    expect(cmd).toMatch(/sleep 0\.12 & _sp=\$!; wait \$_sp 2>\/dev\/null; kill \$_sp 2>\/dev\/null; wait \$_sp 2>\/dev\/null;/);
    expect(cmd).toMatch(/sleep 86400 & _sp=\$!; wait \$_sp 2>\/dev\/null; kill \$_sp 2>\/dev\/null; wait \$_sp 2>\/dev\/null;/);
  });

  it("references the pre-baked status file path", () => {
    const cmd = buildStatusCommand("garden");
    // STATUS_RENDERED_FILE = SESSIONS_DIR/status.rendered
    expect(cmd).toContain("status.rendered");
  });

  it("contains the while-true loop structure", () => {
    const cmd = buildStatusCommand("garden");
    expect(cmd).toContain("while true; do");
    expect(cmd).toContain("done");
  });

  it("animates the plot strip at pane level so the pane-scoped @garden_name set by setPaneVar isn't shadowed", () => {
    const cmd = buildStatusCommand("garden");
    // Session-level set would be shadowed by the pane-level @garden_name set
    // in updateHeaderVar. Must use -p -t "$TMUX_PANE" to update the same scope.
    expect(cmd).toMatch(/tmux set-option -p -t "\$TMUX_PANE" @garden_name/);
    expect(cmd).not.toMatch(/tmux set-option -t 'garden-dashboard' @garden_name/);
  });
});

// ===========================================================================
// setupStatusBar
// ===========================================================================

describe("setupStatusBar", () => {
  it("calls tmux set-option for mouse, status-left, status-right, etc.", () => {
    setupStatusBar("/usr/local/bin/garden");

    const calls = vi.mocked(tmux).mock.calls;
    // Should set mouse on
    expect(calls).toContainEqual(["set-option", "-t", "garden-dashboard", "mouse", "on"]);
    // Should set status-left format
    expect(calls).toContainEqual(["set-option", "-t", "garden-dashboard", "status-left", "#{@garden_left}"]);
    // Should set status-right format
    expect(calls).toContainEqual(["set-option", "-t", "garden-dashboard", "status-right", "#{@garden_right}"]);
    // Should set pane-border-status
    expect(calls).toContainEqual(expect.arrayContaining(["set-option", "-t", "garden-dashboard:main", "pane-border-status", "top"]));
  });

  it("sets status-interval to 30 seconds", () => {
    setupStatusBar("garden");
    const calls = vi.mocked(tmux).mock.calls;
    expect(calls).toContainEqual(["set-option", "-t", "garden-dashboard", "status-interval", "30"]);
  });

  it("swallows errors from individual set-option calls", () => {
    vi.mocked(tmux).mockImplementation(() => { throw new Error("fail"); });
    expect(() => setupStatusBar("garden")).not.toThrow();
  });
});

// ===========================================================================
// installInputGuard
// ===========================================================================

describe("installInputGuard", () => {
  it("sets pane-focus-in hook matching both status and usage pane ids", () => {
    installInputGuard(makeState({ statusPaneId: "%7", usagePaneId: "%3" }));

    const calls = vi.mocked(tmux).mock.calls;
    const hookCall = calls.find(c => c[0] === "set-hook" && c[3] === "pane-focus-in");
    expect(hookCall).toBeDefined();
    expect(hookCall![4]).toContain("%7");
    expect(hookCall![4]).toContain("%3");
    expect(hookCall![4]).toContain("select-pane -R");
  });

  it("is a no-op when statusPaneId is null", () => {
    installInputGuard(makeState({ statusPaneId: null, usagePaneId: "%3" }));
    expect(tmux).not.toHaveBeenCalled();
  });

  it("is a no-op when usagePaneId is null", () => {
    installInputGuard(makeState({ statusPaneId: "%7", usagePaneId: null }));
    expect(tmux).not.toHaveBeenCalled();
  });

  it("swallows errors from set-hook (older tmux without hook support)", () => {
    vi.mocked(tmux).mockImplementation(() => { throw new Error("unknown hook"); });
    expect(() => installInputGuard(makeState({ statusPaneId: "%7", usagePaneId: "%3" }))).not.toThrow();
  });
});

// ===========================================================================
// updateHeaderVar
// ===========================================================================

describe("updateHeaderVar", () => {
  it("sets @garden_left with active project name and branch", () => {
    vi.mocked(currentBranch).mockReturnValue("feature-x");
    updateHeaderVar();

    const calls = vi.mocked(tmux).mock.calls;
    const leftCall = calls.find(c => c[0] === "set-option" && c[3] === "@garden_left");
    expect(leftCall).toBeDefined();
    expect(leftCall![4]).toContain("garden");
    expect(leftCall![4]).toContain("feature-x");
    expect(leftCall![4]).toContain("#[bold]");
  });

  it("sets @garden_right with version string", () => {
    updateHeaderVar();

    const calls = vi.mocked(tmux).mock.calls;
    const rightCall = calls.find(c => c[0] === "set-option" && c[3] === "@garden_right");
    expect(rightCall).toBeDefined();
    expect(rightCall![4]).toContain("abc1234");
    expect(rightCall![4]).toContain("garden");
  });

  it("shows 'no projects' when activeProject is null", () => {
    vi.mocked(readDashState).mockReturnValue(makeState({ activeProject: null }));
    updateHeaderVar();

    const calls = vi.mocked(tmux).mock.calls;
    const leftCall = calls.find(c => c[0] === "set-option" && c[3] === "@garden_left");
    expect(leftCall).toBeDefined();
    expect(leftCall![4]).toContain("no projects");
  });

  it("uses opts.state when provided instead of reading state", () => {
    const customState = makeState({ activeProject: "other" });
    updateHeaderVar({ state: customState });

    // Should not have called readDashState since we passed state directly
    // (readDashState is called in the default path; when we pass state, it skips that)
    const calls = vi.mocked(tmux).mock.calls;
    const leftCall = calls.find(c => c[0] === "set-option" && c[3] === "@garden_left");
    expect(leftCall![4]).toContain("other");
  });

  it("calls refresh-client -S after setting vars", () => {
    updateHeaderVar();
    const calls = vi.mocked(tmux).mock.calls;
    expect(calls).toContainEqual(["refresh-client", "-S"]);
  });

  it("swallows error when session is gone", () => {
    vi.mocked(tmux).mockImplementation(() => { throw new Error("no session"); });
    expect(() => updateHeaderVar()).not.toThrow();
  });

  it("sets @garden_name on the status pane to a plot strip marking the active plot with a filled circle", () => {
    updateHeaderVar({ state: makeState({ statusPaneId: "%0", activePlot: "imp" }) });
    const nameCalls = vi.mocked(setPaneVar).mock.calls.filter(c => c[0] === "%0" && c[1] === "garden_name");
    expect(nameCalls).toHaveLength(1);
    const strip = nameCalls[0][2];
    // Active plot is filled + bold; others empty + dim.
    expect(strip).toContain("#[bold]● imp#[default]");
    expect(strip).toContain("#[fg=colour244]○ all#[default]");
  });

  it("sets @garden_name on the status pane with all circles empty when no plot is active", () => {
    updateHeaderVar({ state: makeState({ statusPaneId: "%0", activePlot: null }) });
    const nameCalls = vi.mocked(setPaneVar).mock.calls.filter(c => c[0] === "%0" && c[1] === "garden_name");
    expect(nameCalls).toHaveLength(1);
    const strip = nameCalls[0][2];
    expect(strip).toContain("#[fg=colour244]○ all#[default]");
    expect(strip).toContain("#[fg=colour244]○ imp#[default]");
    expect(strip).not.toContain("#[bold]●");
  });

  it("clears @garden_plot on the status pane (plot strip lives in @garden_name now)", () => {
    updateHeaderVar({ state: makeState({ statusPaneId: "%0", activePlot: "imp" }) });
    expect(setPaneVar).toHaveBeenCalledWith("%0", "garden_plot", "");
  });

  it("does not touch @garden_name or @garden_plot when statusPaneId is null", () => {
    updateHeaderVar({ state: makeState({ statusPaneId: null, activePlot: "imp" }) });
    expect(setPaneVar).not.toHaveBeenCalled();
  });

  it("excludes unfocused plots from the strip", () => {
    vi.mocked(loadConfig).mockReturnValue({
      projects: { garden: { path: "/repo/garden" }, other: { path: "/repo/other" } },
      plots: {
        all: { projects: ["garden", "other"] },
        imp: { projects: ["garden"], focused: false },
      },
    } as unknown as ReturnType<typeof loadConfig>);
    vi.mocked(isPlotFocused).mockImplementation((plot: { focused?: boolean }) => plot.focused !== false);

    updateHeaderVar({ state: makeState({ statusPaneId: "%0", activePlot: "all" }) });
    const nameCalls = vi.mocked(setPaneVar).mock.calls.filter(c => c[0] === "%0" && c[1] === "garden_name");
    const strip = nameCalls[0][2];
    expect(strip).toContain("all");
    expect(strip).not.toContain("imp");
  });

  it("renders a red ✖ icon when any worker in the plot is failing", () => {
    vi.mocked(readRegistry).mockReturnValue({
      workers: { garden: [{ name: "w1", sessionId: "s", task: "", prState: "failing" }] },
    } as never);
    vi.mocked(resolveWorkerStatus).mockImplementation((e: { prState?: string } | undefined) => {
      return (e?.prState ?? "idle") as never;
    });

    updateHeaderVar({ state: makeState({ statusPaneId: "%0", activePlot: "imp" }) });
    const strip = vi.mocked(setPaneVar).mock.calls.find(c => c[1] === "garden_name")?.[2] ?? "";
    expect(strip).toContain("#[fg=red,bold]● ✖ imp#[default]");
  });

  it("renders a yellow ⚑ icon when any worker in the plot is asking", () => {
    vi.mocked(readRegistry).mockReturnValue({
      workers: { garden: [{ name: "w1", sessionId: "s", task: "", claudeStatus: "asking" }] },
    } as never);
    vi.mocked(resolveWorkerStatus).mockReturnValue("asking" as never);

    updateHeaderVar({ state: makeState({ statusPaneId: "%0", activePlot: "imp" }) });
    const strip = vi.mocked(setPaneVar).mock.calls.find(c => c[1] === "garden_name")?.[2] ?? "";
    expect(strip).toContain("#[fg=yellow,bold]● ⚑ imp#[default]");
  });

  it("renders a green ✓ icon only when a worker has merged (not for merge-pending)", () => {
    vi.mocked(readRegistry).mockReturnValue({
      workers: { garden: [{ name: "w1", sessionId: "s", task: "", prState: "merged" }] },
    } as never);
    vi.mocked(resolveWorkerStatus).mockReturnValue("merged" as never);

    updateHeaderVar({ state: makeState({ statusPaneId: "%0", activePlot: "imp" }) });
    const strip = vi.mocked(setPaneVar).mock.calls.find(c => c[1] === "garden_name")?.[2] ?? "";
    expect(strip).toContain("#[fg=green,bold]● ✓ imp#[default]");
  });

  it("renders a spinner frame when a worker is working, and writes the template with a sentinel", () => {
    vi.mocked(readRegistry).mockReturnValue({
      workers: { garden: [{ name: "w1", sessionId: "s", task: "", claudeStatus: "working" }] },
    } as never);
    vi.mocked(resolveWorkerStatus).mockReturnValue("working" as never);

    const writeFileSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {});
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation(() => {});

    updateHeaderVar({ state: makeState({ statusPaneId: "%0", activePlot: "imp" }) });

    const strip = vi.mocked(setPaneVar).mock.calls.find(c => c[1] === "garden_name")?.[2] ?? "";
    // The display carries a current braille frame (not the sentinel).
    expect(strip).toMatch(/#\[bold\]● [⠀-⣿] imp#\[default\]/);

    // The template written to disk carries the sentinel instead of the frame.
    const writeCall = writeFileSpy.mock.calls.find(c => String(c[0]).includes("plot-strip.template."));
    expect(writeCall).toBeDefined();
    expect(String(writeCall![1])).toContain("__GSP__");
    expect(renameSpy).toHaveBeenCalled();

    writeFileSpy.mockRestore();
    renameSpy.mockRestore();
  });

  it("prioritizes failing > asking > merged > working > idle across workers in a plot", () => {
    vi.mocked(readRegistry).mockReturnValue({
      workers: { garden: [
        { name: "w1", sessionId: "s", task: "", claudeStatus: "working" },
        { name: "w2", sessionId: "s", task: "", claudeStatus: "asking" },
        { name: "w3", sessionId: "s", task: "", prState: "failing" },
      ]},
    } as never);
    vi.mocked(resolveWorkerStatus).mockImplementation((e: { prState?: string; claudeStatus?: string } | undefined) => {
      return (e?.prState ?? e?.claudeStatus ?? "idle") as never;
    });

    updateHeaderVar({ state: makeState({ statusPaneId: "%0", activePlot: "imp" }) });
    const strip = vi.mocked(setPaneVar).mock.calls.find(c => c[1] === "garden_name")?.[2] ?? "";
    expect(strip).toContain("✖");
    expect(strip).not.toContain("⚑");
    expect(strip).not.toContain("✓");
  });

  it("sets status-pane border vars before the refresh-client -S so the border repaints immediately", () => {
    updateHeaderVar({ state: makeState({ statusPaneId: "%0", activePlot: "imp" }) });

    // setPaneVar writes pane-scoped @garden_name via the tmux mock too.
    // Interleave its call order with tmux's to find the refresh-client -S index.
    const setPaneVarMock = vi.mocked(setPaneVar);
    const nameCallIdx = setPaneVarMock.mock.invocationCallOrder[
      setPaneVarMock.mock.calls.findIndex(c => c[1] === "garden_name")
    ];
    const tmuxMock = vi.mocked(tmux);
    const refreshIdx = tmuxMock.mock.invocationCallOrder[
      tmuxMock.mock.calls.findIndex(c => c[0] === "refresh-client" && c[1] === "-S")
    ];
    expect(nameCallIdx).toBeDefined();
    expect(refreshIdx).toBeDefined();
    expect(nameCallIdx).toBeLessThan(refreshIdx);
  });
});

// ===========================================================================
// handlePaneDied
// ===========================================================================

describe("handlePaneDied", () => {
  it("is a no-op when windowName is undefined", () => {
    handlePaneDied(undefined);
    expect(updateWorkerFields).not.toHaveBeenCalled();
  });

  it("is a no-op when windowName is empty string", () => {
    handlePaneDied("");
    expect(updateWorkerFields).not.toHaveBeenCalled();
  });

  it("is a no-op when windowName does not match worker pattern", () => {
    handlePaneDied("_garden-shell");
    expect(updateWorkerFields).not.toHaveBeenCalled();
  });

  it("is a no-op when registry entry is missing for worker", () => {
    vi.mocked(findWorkerByName).mockReturnValue(undefined);
    handlePaneDied("_garden-worker-bold-ash");
    expect(updateWorkerFields).not.toHaveBeenCalled();
  });

  it("sets claudeStatus to exited and flags mid-turn interruption when worker was working", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash",
      sessionId: "test",
      task: "",
      claudeStatus: "working",
    });
    handlePaneDied("_garden-worker-bold-ash");

    expect(updateWorkerFields).toHaveBeenCalledWith(
      "garden", "bold-ash",
      { claudeStatus: "exited", interruptedWhileWorking: true },
    );
  });

  it("does not set the interruption flag when the worker was idle at exit", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash",
      sessionId: "test",
      task: "",
      claudeStatus: "idle",
    });
    handlePaneDied("_garden-worker-bold-ash");

    expect(updateWorkerFields).toHaveBeenCalledWith(
      "garden", "bold-ash",
      { claudeStatus: "exited" },
    );
  });

  it("logs the pane-died event", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash",
      sessionId: "test",
      task: "",
      claudeStatus: "working",
    });
    handlePaneDied("_garden-worker-bold-ash");

    expect(log.info).toHaveBeenCalledWith(
      "hook", "pane-died \u2192 exited",
      expect.objectContaining({
        worker: "bold-ash",
        data: {
          project: "garden",
          windowName: "_garden-worker-bold-ash",
          interrupted: true,
        },
      }),
    );
  });

  it("swallows updateWorkerFields errors gracefully", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash",
      sessionId: "test",
      task: "",
      claudeStatus: "idle",
    });
    vi.mocked(updateWorkerFields).mockImplementation(() => { throw new Error("lock fail"); });
    expect(() => handlePaneDied("_garden-worker-bold-ash")).not.toThrow();
  });
});

// ===========================================================================
// refreshWorkerTasks (called indirectly via refreshDashboard)
// ===========================================================================

describe("refreshWorkerTasks (via refreshDashboard)", () => {
  it("calls batchUpdateWorkerFields when task has changed", () => {
    vi.mocked(readRegistry).mockReturnValue({
      workers: {
        garden: [
          { name: "bold-ash", sessionId: "s1", task: "old task", claudeStatus: "working" },
        ],
      },
    });
    // findWorkerPaneId uses readDashState and windowExists
    vi.mocked(readDashState).mockReturnValue(makeState({
      activeProject: "garden",
      activePaneId: "%5",
      activeWindowName: "_garden-worker-bold-ash",
    }));

    vi.mocked(getPaneTitle).mockReturnValue("new task");

    refreshDashboard();

    expect(batchUpdateWorkerFields).toHaveBeenCalledWith([
      { project: "garden", workerName: "bold-ash", fields: { task: "new task" } },
    ]);
  });

  it("skips update when task is unchanged", () => {
    vi.mocked(readRegistry).mockReturnValue({
      workers: {
        garden: [
          { name: "bold-ash", sessionId: "s1", task: "same task", claudeStatus: "working" },
        ],
      },
    });
    vi.mocked(readDashState).mockReturnValue(makeState({
      activeProject: "garden",
      activePaneId: "%5",
      activeWindowName: "_garden-worker-bold-ash",
    }));

    vi.mocked(getPaneTitle).mockReturnValue("same task");

    refreshDashboard();

    expect(batchUpdateWorkerFields).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// writeQuickStatus (called indirectly via refreshDashboard)
// ===========================================================================

describe("writeQuickStatus (via refreshDashboard)", () => {
  it("writes rendered status to temp file then renames atomically", () => {
    vi.mocked(renderQuickStatus).mockReturnValue("rendered\nstatus");
    refreshDashboard();

    // Should write to a tmp file first
    const writeCalls = vi.mocked(fs.writeFileSync).mock.calls;
    expect(writeCalls.length).toBeGreaterThanOrEqual(1);
    const tmpPath = writeCalls[0][0] as string;
    expect(tmpPath).toContain("status.rendered.");
    expect(tmpPath).toContain(".tmp");

    // Should rename tmp to final path
    const renameCalls = vi.mocked(fs.renameSync).mock.calls;
    expect(renameCalls.length).toBeGreaterThanOrEqual(1);
    expect(renameCalls[0][0]).toBe(tmpPath);
    expect((renameCalls[0][1] as string)).toContain("status.rendered");
    expect((renameCalls[0][1] as string)).not.toContain(".tmp");
  });

  it("resizes status pane when statusPaneId is set and height differs", () => {
    vi.mocked(readDashState).mockReturnValue(makeState({ statusPaneId: "%0" }));
    vi.mocked(renderQuickStatus).mockReturnValue("line1\nline2\nline3\nline4");
    vi.mocked(getPaneSize).mockReturnValue({ width: 120, height: 3 });

    refreshDashboard();

    // 4 lines -> Math.max(16, 4) + 1 = 17
    expect(tmux).toHaveBeenCalledWith("resize-pane", "-t", "%0", "-y", "17");
  });

  it("skips resize when current height already matches", () => {
    vi.mocked(readDashState).mockReturnValue(makeState({ statusPaneId: "%0" }));
    vi.mocked(renderQuickStatus).mockReturnValue("line1\nline2\nline3\nline4");
    // height 17 = Math.max(16, 4) + 1
    vi.mocked(getPaneSize).mockReturnValue({ width: 120, height: 17 });

    refreshDashboard();

    expect(tmux).not.toHaveBeenCalledWith("resize-pane", "-t", "%0", "-y", "17");
  });

  it("uses minimum height of 16 lines + 1 for pane border (5-project floor)", () => {
    vi.mocked(readDashState).mockReturnValue(makeState({ statusPaneId: "%0" }));
    vi.mocked(renderQuickStatus).mockReturnValue("x"); // 1 line
    vi.mocked(getPaneSize).mockReturnValue(null); // unknown size triggers resize

    refreshDashboard();

    // Math.max(16, 1) + 1 = 17
    expect(tmux).toHaveBeenCalledWith("resize-pane", "-t", "%0", "-y", "17");
  });

  it("floor grows with worker counts so a busy project doesn't cause a shrink on plot switch", () => {
    vi.mocked(readDashState).mockReturnValue(makeState({ statusPaneId: "%0" }));
    vi.mocked(renderQuickStatus).mockReturnValue("x"); // 1 line — well under the floor
    vi.mocked(getPaneSize).mockReturnValue(null);
    // Plot "all" has 5 projects; "garden" has 4 workers, others 0.
    // bodySum = 4 + 1 + 1 + 1 + 1 = 8; N = 5; floor = 2*5 + 8 + 1 = 19.
    vi.mocked(readRegistry).mockReturnValue({
      workers: {
        garden: [
          { name: "w1", sessionId: "s", task: "" },
          { name: "w2", sessionId: "s", task: "" },
          { name: "w3", sessionId: "s", task: "" },
          { name: "w4", sessionId: "s", task: "" },
        ],
      },
    } as never);

    refreshDashboard();

    // Math.max(19, 1) + 1 = 20
    expect(tmux).toHaveBeenCalledWith("resize-pane", "-t", "%0", "-y", "20");
  });

  it("grows past the floor when the rendered content is taller than 16 lines", () => {
    vi.mocked(readDashState).mockReturnValue(makeState({ statusPaneId: "%0" }));
    // 20 rendered lines — exceeds the 16-line floor
    vi.mocked(renderQuickStatus).mockReturnValue(Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n"));
    vi.mocked(getPaneSize).mockReturnValue({ width: 120, height: 5 });

    refreshDashboard();

    // Math.max(16, 20) + 1 = 21
    expect(tmux).toHaveBeenCalledWith("resize-pane", "-t", "%0", "-y", "21");
  });

  it("flushes a tmux client refresh after a resize so SIGWINCH delivers before SIGUSR1", () => {
    vi.mocked(readDashState).mockReturnValue(makeState({ statusPaneId: "%0" }));
    vi.mocked(renderQuickStatus).mockReturnValue("l1\nl2\nl3\nl4");
    vi.mocked(getPaneSize).mockReturnValue({ width: 120, height: 3 });

    refreshDashboard();

    const calls = vi.mocked(tmux).mock.calls;
    const resizeIdx = calls.findIndex(c => c[0] === "resize-pane");
    const refreshIdx = calls.findIndex((c, i) =>
      i > resizeIdx && c[0] === "refresh-client" && c[1] === "-S",
    );
    expect(resizeIdx).toBeGreaterThanOrEqual(0);
    expect(refreshIdx).toBeGreaterThan(resizeIdx);
  });

  it("does not flush refresh-client from writeQuickStatus when the height is unchanged", () => {
    vi.mocked(readDashState).mockReturnValue(makeState({ statusPaneId: "%0" }));
    vi.mocked(renderQuickStatus).mockReturnValue("l1\nl2\nl3\nl4");
    // height already matches Math.max(16,4)+1 = 17, so no resize
    vi.mocked(getPaneSize).mockReturnValue({ width: 120, height: 17 });

    refreshDashboard();

    // updateHeaderVar (called unconditionally by refreshDashboard) ends with
    // its own refresh-client -S, so one refresh call is expected. The
    // writeQuickStatus flush must not add a second one on this no-resize path.
    const refreshCalls = vi.mocked(tmux).mock.calls.filter(
      c => c[0] === "refresh-client" && c[1] === "-S",
    );
    expect(refreshCalls).toHaveLength(1);
  });

  it("signals the pane before shrinking so old content doesn't briefly show in the smaller pane", () => {
    vi.mocked(readDashState).mockReturnValue(makeState({ statusPaneId: "%0" }));
    // new rendered is shorter than current pane height
    vi.mocked(renderQuickStatus).mockReturnValue("l1\nl2");
    vi.mocked(getPaneSize).mockReturnValue({ width: 120, height: 20 });
    vi.mocked(getPanePid).mockReturnValue("999");

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    refreshDashboard();

    const killOrder = killSpy.mock.invocationCallOrder[0];
    const tmuxCalls = vi.mocked(tmux).mock.calls;
    const tmuxOrders = vi.mocked(tmux).mock.invocationCallOrder;
    const resizeOrder = tmuxOrders[tmuxCalls.findIndex(c => c[0] === "resize-pane" && c[1] === "-t" && c[2] === "%0")];
    expect(killOrder).toBeDefined();
    expect(resizeOrder).toBeDefined();
    // SIGUSR1 must fire BEFORE resize on shrink
    expect(killOrder).toBeLessThan(resizeOrder);
    killSpy.mockRestore();
  });

  it("grows the pane before signaling so new content doesn't scroll its top off", () => {
    vi.mocked(readDashState).mockReturnValue(makeState({ statusPaneId: "%0" }));
    // new rendered is taller than current pane height
    vi.mocked(renderQuickStatus).mockReturnValue("l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10");
    vi.mocked(getPaneSize).mockReturnValue({ width: 120, height: 5 });
    vi.mocked(getPanePid).mockReturnValue("999");

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    refreshDashboard();

    const killOrder = killSpy.mock.invocationCallOrder[0];
    const tmuxCalls = vi.mocked(tmux).mock.calls;
    const tmuxOrders = vi.mocked(tmux).mock.invocationCallOrder;
    const resizeOrder = tmuxOrders[tmuxCalls.findIndex(c => c[0] === "resize-pane" && c[1] === "-t" && c[2] === "%0")];
    // resize must happen BEFORE SIGUSR1 on grow
    expect(resizeOrder).toBeLessThan(killOrder);
    killSpy.mockRestore();
  });
});

// ===========================================================================
// refreshStatusPane
// ===========================================================================

describe("buildUsageCommand", () => {
  it("returns a shell script string", () => {
    const cmd = buildUsageCommand("/usr/local/bin/garden");
    expect(typeof cmd).toBe("string");
    expect(cmd.length).toBeGreaterThan(0);
  });

  it("sets up SIGUSR1 trap for event-driven refresh", () => {
    const cmd = buildUsageCommand("garden");
    expect(cmd).toContain("trap");
    expect(cmd).toContain("USR1");
  });

  it("references the pre-baked usage file path", () => {
    const cmd = buildUsageCommand("garden");
    expect(cmd).toContain("usage.rendered");
  });

  it("has no spinner animation (usage has no active state to animate)", () => {
    const cmd = buildUsageCommand("garden");
    expect(cmd).not.toContain("sleep 0.08");
  });

  it("sleeps long on idle (pure event-driven wake)", () => {
    const cmd = buildUsageCommand("garden");
    expect(cmd).toContain("sleep 86400");
  });

  it("kills the backgrounded sleep after wait so SIGUSR1 doesn't leak it", () => {
    const cmd = buildUsageCommand("garden");
    // Trailing `wait $_sp` reaps the killed sleep synchronously; without it
    // bash emits an async "sh: line N: PID Terminated: 15 ..." job notice.
    expect(cmd).toMatch(/sleep 86400 & _sp=\$!; wait \$_sp 2>\/dev\/null; kill \$_sp 2>\/dev\/null; wait \$_sp 2>\/dev\/null;/);
  });
});

describe("refreshUsagePane", () => {
  it("sends SIGUSR1 to the usage pane process", () => {
    vi.mocked(readDashState).mockReturnValue(makeState({ usagePaneId: "%3" }));
    vi.mocked(getPanePid).mockReturnValue("54321");

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    refreshUsagePane();

    expect(getPanePid).toHaveBeenCalledWith("%3");
    expect(killSpy).toHaveBeenCalledWith(54321, "SIGUSR1");
    killSpy.mockRestore();
  });

  it("is a no-op when usagePaneId is null", () => {
    vi.mocked(readDashState).mockReturnValue(makeState({ usagePaneId: null }));

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    refreshUsagePane();

    expect(getPanePid).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();
    killSpy.mockRestore();
  });

  it("swallows error when process.kill fails", () => {
    vi.mocked(readDashState).mockReturnValue(makeState({ usagePaneId: "%3" }));
    vi.mocked(getPanePid).mockReturnValue("54321");
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => { throw new Error("No such process"); });
    expect(() => refreshUsagePane()).not.toThrow();
    killSpy.mockRestore();
  });
});

describe("writeUsageRendered (via refreshDashboard)", () => {
  it("writes rendered usage to temp file then renames atomically", () => {
    refreshDashboard();

    const writeCalls = vi.mocked(fs.writeFileSync).mock.calls;
    const tmpUsagePath = writeCalls.find(c => String(c[0]).includes("usage.rendered."));
    expect(tmpUsagePath).toBeDefined();
    expect(String(tmpUsagePath![0])).toContain(".tmp");

    const renameCalls = vi.mocked(fs.renameSync).mock.calls;
    const usageRename = renameCalls.find(c => String(c[1]).endsWith("usage.rendered"));
    expect(usageRename).toBeDefined();
  });

  it("resizes usage pane when height differs", () => {
    vi.mocked(readDashState).mockReturnValue(makeState({ usagePaneId: "%3" }));
    vi.mocked(getPaneSize).mockReturnValue({ width: 120, height: 2 });

    refreshDashboard();

    // renderUsagePane mock returns "u1\nu2\nu3" (3 lines) → 3+1 = 4
    expect(tmux).toHaveBeenCalledWith("resize-pane", "-t", "%3", "-y", "4");
  });

  it("skips usage resize when current height already matches", () => {
    vi.mocked(readDashState).mockReturnValue(makeState({ usagePaneId: "%3" }));
    vi.mocked(getPaneSize).mockReturnValue({ width: 120, height: 4 });

    refreshDashboard();

    expect(tmux).not.toHaveBeenCalledWith("resize-pane", "-t", "%3", "-y", "4");
  });
});

describe("refreshStatusPane", () => {
  it("sends SIGUSR1 to the status pane process", () => {
    vi.mocked(readDashState).mockReturnValue(makeState({ statusPaneId: "%0" }));
    vi.mocked(getPanePid).mockReturnValue("12345");

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    refreshStatusPane();

    expect(getPanePid).toHaveBeenCalledWith("%0");
    expect(killSpy).toHaveBeenCalledWith(12345, "SIGUSR1");
    killSpy.mockRestore();
  });

  it("is a no-op when statusPaneId is null", () => {
    vi.mocked(readDashState).mockReturnValue(makeState({ statusPaneId: null }));

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    refreshStatusPane();

    expect(getPanePid).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();
    killSpy.mockRestore();
  });

  it("swallows error when process.kill fails", () => {
    vi.mocked(readDashState).mockReturnValue(makeState({ statusPaneId: "%0" }));
    vi.mocked(getPanePid).mockReturnValue("12345");

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => { throw new Error("No such process"); });
    expect(() => refreshStatusPane()).not.toThrow();
    killSpy.mockRestore();
  });

  it("uses opts.state when provided", () => {
    const customState = makeState({ statusPaneId: "%9" });
    vi.mocked(getPanePid).mockReturnValue("99999");

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    refreshStatusPane({ state: customState });

    expect(getPanePid).toHaveBeenCalledWith("%9");
    expect(killSpy).toHaveBeenCalledWith(99999, "SIGUSR1");
    killSpy.mockRestore();
  });
});

// ===========================================================================
// refreshDashboard
// ===========================================================================

describe("refreshDashboard", () => {
  it("calls updateHeaderVar, refreshWorkerTasks, writeQuickStatus, and refreshStatusPane", () => {
    // Default mocks are fine — just verify the key side effects happen
    refreshDashboard();

    // updateHeaderVar sets tmux vars
    const calls = vi.mocked(tmux).mock.calls;
    const hasLeftVar = calls.some(c => c[0] === "set-option" && c[3] === "@garden_left");
    expect(hasLeftVar).toBe(true);

    // writeQuickStatus calls renderQuickStatus
    expect(renderQuickStatus).toHaveBeenCalled();

    // writeQuickStatus writes file
    expect(fs.writeFileSync).toHaveBeenCalled();
  });

  it("passes opts through to sub-functions", () => {
    const customState = makeState({ activeProject: "other", statusPaneId: "%7" });
    vi.mocked(getPanePid).mockReturnValue("55555");

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    refreshDashboard({ state: customState });

    // updateHeaderVar should use the custom state's activeProject
    const calls = vi.mocked(tmux).mock.calls;
    const leftCall = calls.find(c => c[0] === "set-option" && c[3] === "@garden_left");
    expect(leftCall![4]).toContain("other");

    // refreshStatusPane should use the custom state's statusPaneId
    expect(getPanePid).toHaveBeenCalledWith("%7");
    expect(killSpy).toHaveBeenCalledWith(55555, "SIGUSR1");
    killSpy.mockRestore();
  });
});

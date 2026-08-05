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
  logColorKeyForProject: vi.fn(() => null),
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
  tmuxBatch: vi.fn(),
  tmuxOutput: vi.fn(() => ""),
  getFirstPaneId: vi.fn(() => null),
  getPaneTitle: vi.fn(() => null),
  getPanePid: vi.fn(() => null),
  getPaneSize: vi.fn(() => null),
  windowExists: vi.fn(() => false),
  setPaneVar: vi.fn(),
  listAllWindowNames: vi.fn(() => []),
  // refreshWorkerTasks now reads pane titles via one batched list-panes call.
  // Default: empty list (no panes), so refreshWorkerTasks is a no-op.
  listSessionPaneTitles: vi.fn(() => []),
  // cleanPaneTitle is called by refreshWorkerTasks on each rawTitle. Mirror
  // the real implementation: strip leading non-alnum, reject "Claude Code" /
  // hostname, return null otherwise.
  cleanPaneTitle: vi.fn((raw: string | null | undefined) => {
    if (!raw) return null;
    const cleaned = raw.replace(/^[^a-zA-Z0-9]+/, "").trim();
    if (!cleaned || cleaned === "Claude Code") return null;
    return cleaned;
  }),
  shellEscape: (s: string) => /^[a-zA-Z0-9_./:=-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`,
  tmuxDoubleQuote: (s: string) => `"${s.replace(/[\\$"`]/g, "\\$&")}"`,
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
  removeWorker: vi.fn(),
}));

vi.mock("../src/dashboard/git.js", () => ({
  resolveBaseBranch: vi.fn(() => "main"),
  getWorkerBaseBranch: vi.fn((entry: { baseBranch?: string }) => entry.baseBranch ?? "main"),
  currentBranch: vi.fn(() => "main"),
  currentBranchFast: vi.fn(() => "main"),
  worktreeExists: vi.fn(() => true),
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

vi.mock("../src/dashboard/runner.js", () => ({
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
  handleTitleChanged,
  buildStatusCommand,
  buildUsageCommand,
  buildHistoryCommand,
  refreshStatusPane,
  refreshUsagePane,
  refreshDashboard,
  refreshStatusElapsed,
  installInputGuard,
  setPaneProjectColor,
  repinStatusPaneHeight,
  repinUsagePaneHeight,
  rebakePanesOnResize,
  _resetHeaderCachesForTest,
} from "../src/dashboard/header.js";

import { tmux, tmuxBatch, getPanePid, getPaneSize, getPaneTitle, setPaneVar, listSessionPaneTitles } from "../src/dashboard/tmux.js";
import { readDashState, type DashboardState } from "../src/dashboard/state.js";
import { findWorkerByName, updateWorkerFields, readRegistry, batchUpdateWorkerFields, removeWorker } from "../src/dashboard/registry.js";
import { currentBranchFast, worktreeExists } from "../src/dashboard/git.js";
import { renderQuickStatus, resolveWorkerStatus } from "../src/commands/status.js";
import { renderUsagePane } from "../src/dashboard/usage.js";
import { isPlotFocused, loadConfig, logColorKeyForProject } from "../src/config.js";
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
  vi.mocked(currentBranchFast).mockReturnValue("main");
  // Module-level write caches (writePlotStripTemplate, writeQuickStatus,
  // writeUsageRendered, setBarVars) persist across test cases within the same
  // module instance. Each test that asserts "the write happened" needs a clean
  // slate.
  _resetHeaderCachesForTest();
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

  it("reads the pre-baked status file from $sf instead of forking `garden status`", () => {
    const cmd = buildStatusCommand("/usr/local/bin/garden");
    // The per-tick `garden status` shell-out was replaced by a `cat $sf` of
    // the file written atomically by writeQuickStatus(). Each fork was a
    // 50-150ms Node cold-start; reading the pre-baked file is constant-time.
    expect(cmd).not.toContain("GARDEN_PRETTY=1");
    expect(cmd).not.toMatch(/\bgarden status\b/);
    expect(cmd).toContain('cur=$(cat "$sf"');
  });

  it("still threads gardenRunner to the diag auto-detector dispatch", () => {
    // The diag auto-detector (snapshot capture for the duplicate-row bug)
    // calls `${gardenRunner} dashboard _diag-alert <snap>` on detection.
    // Phase 2 dropped the per-tick `garden status` invocation but kept the
    // parameter — the diag plumbing (transient; remove with all other
    // diag-* code) still needs it.
    const cmd = buildStatusCommand("/usr/local/bin/garden");
    expect(cmd).toContain("/usr/local/bin/garden dashboard _diag-alert");
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

  it("reloads the plot-strip template per frame using the fork-free $(<file) builtin", () => {
    const cmd = buildStatusCommand("garden");
    // Per-frame reload is required so a plot change picked up via writePlotStripTemplate
    // takes effect within ~120ms — without this, the cached template clobbers the
    // JS-set @garden_name back to the previous plot until the next USR1 tick.
    expect(cmd).toContain(`_ptn=$(<"$pst")`);
    // Must NOT use $(cat ...) here — that fork stacks SIGCHLDs on the inner loop's
    // wait, the same wedge that motivated narrowing the SIGUSR1 trap above.
    expect(cmd).not.toMatch(/_ptn=\$\(cat "\$pst"/);
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

  it("renders a right-aligned wall clock gated on @garden_clock in the pane-border-format", () => {
    setupStatusBar("garden");
    const fmt = vi.mocked(tmux).mock.calls.find(
      c => c[0] === "set-option" && c[3] === "pane-border-format",
    )?.[4];
    expect(fmt).toBeDefined();
    // Clock segment: only on panes with @garden_clock set, pushed to the right
    // edge, time supplied by tmux strftime.
    expect(fmt).toContain("#{?@garden_clock,");
    expect(fmt).toContain("#[align=right]");
    expect(fmt).toContain("%H:%M");
    // Bold green to mirror the `garden` title.
    expect(fmt).toContain("#[fg=green]");
    expect(fmt).toContain("#[bold]");
    // Regression guard: the style MUST be comma-free. A comma inside the
    // #{?@garden_clock,...} conditional is read as the true/false separator
    // and silently blanks the clock — so #[fg=green,bold] must never appear.
    const clockSeg = fmt!.slice(fmt!.indexOf("#{?@garden_clock,"));
    expect(clockSeg).not.toContain("#[fg=green,bold]");
  });

  it("renders a project-color dot gated on @garden_color in the pane-border-format", () => {
    setupStatusBar("garden");
    const fmt = vi.mocked(tmux).mock.calls.find(
      c => c[0] === "set-option" && c[3] === "pane-border-format",
    )?.[4];
    expect(fmt).toBeDefined();
    // Dot segment: only on panes with @garden_color set (worker/shell panes,
    // via setPaneProjectColor); the nested var supplies the tmux color and the
    // style resets before the pane label so the label stays default-colored.
    expect(fmt).toContain("#{?@garden_color,#[fg=#{@garden_color}]●#[default] ,}");
  });

  describe("setPaneProjectColor", () => {
    it("sets @garden_color to the project's tmux color", () => {
      vi.mocked(logColorKeyForProject).mockReturnValueOnce("cyan");
      setPaneProjectColor("%5", "myproject");
      // cyan = 256-color index 39
      expect(setPaneVar).toHaveBeenCalledWith("%5", "garden_color", "colour39");
    });

    it("leaves @garden_color unset when the project has no log color", () => {
      vi.mocked(logColorKeyForProject).mockReturnValueOnce(null);
      setPaneProjectColor("%5", "myproject");
      expect(setPaneVar).not.toHaveBeenCalledWith("%5", "garden_color", expect.anything());
    });
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
    vi.mocked(currentBranchFast).mockReturnValue("feature-x");
    updateHeaderVar();

    const calls = vi.mocked(tmuxBatch).mock.calls.flat();
    const leftCall = calls.find(c => c[0] === "set-option" && c[3] === "@garden_left");
    expect(leftCall).toBeDefined();
    expect(leftCall![4]).toContain("garden");
    expect(leftCall![4]).toContain("feature-x");
    expect(leftCall![4]).toContain("#[bold]");
  });

  it("sets @garden_right with version string", () => {
    updateHeaderVar();

    const calls = vi.mocked(tmuxBatch).mock.calls.flat();
    const rightCall = calls.find(c => c[0] === "set-option" && c[3] === "@garden_right");
    expect(rightCall).toBeDefined();
    expect(rightCall![4]).toContain("abc1234");
    expect(rightCall![4]).toContain("garden");
  });

  it("shows 'no projects' when activeProject is null", () => {
    vi.mocked(readDashState).mockReturnValue(makeState({ activeProject: null }));
    updateHeaderVar();

    const calls = vi.mocked(tmuxBatch).mock.calls.flat();
    const leftCall = calls.find(c => c[0] === "set-option" && c[3] === "@garden_left");
    expect(leftCall).toBeDefined();
    expect(leftCall![4]).toContain("no projects");
  });

  it("uses opts.state when provided instead of reading state", () => {
    const customState = makeState({ activeProject: "other" });
    updateHeaderVar({ state: customState });

    // Should not have called readDashState since we passed state directly
    // (readDashState is called in the default path; when we pass state, it skips that)
    const calls = vi.mocked(tmuxBatch).mock.calls.flat();
    const leftCall = calls.find(c => c[0] === "set-option" && c[3] === "@garden_left");
    expect(leftCall![4]).toContain("other");
  });

  it("calls refresh-client -S after setting vars", () => {
    updateHeaderVar();
    const groups = vi.mocked(tmuxBatch).mock.calls.flat();
    expect(groups).toContainEqual(["refresh-client", "-S"]);
  });

  it("swallows error when session is gone", () => {
    vi.mocked(tmuxBatch).mockImplementation(() => { throw new Error("no session"); });
    expect(() => updateHeaderVar()).not.toThrow();
  });

  it("sets @garden_name on the status pane to a plot strip marking the active plot with a filled circle", () => {
    updateHeaderVar({ state: makeState({ statusPaneId: "%0", activePlot: "imp" }) });
    const nameCalls = vi.mocked(setPaneVar).mock.calls.filter(c => c[0] === "%0" && c[1] === "garden_name");
    expect(nameCalls).toHaveLength(1);
    const strip = nameCalls[0][2];
    // Active plot is filled + bold; others empty + dim.
    expect(strip).toContain("#[fg=default,bold]● imp#[default]");
    expect(strip).toContain("#[fg=colour244]○ all#[default]");
  });

  it("sets @garden_name on the status pane with all circles empty when no plot is active", () => {
    updateHeaderVar({ state: makeState({ statusPaneId: "%0", activePlot: null }) });
    const nameCalls = vi.mocked(setPaneVar).mock.calls.filter(c => c[0] === "%0" && c[1] === "garden_name");
    expect(nameCalls).toHaveLength(1);
    const strip = nameCalls[0][2];
    expect(strip).toContain("#[fg=colour244]○ all#[default]");
    expect(strip).toContain("#[fg=colour244]○ imp#[default]");
    expect(strip).not.toContain("●");
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

  it("renders a red spinner when a failing worker in the plot is working", () => {
    vi.mocked(readRegistry).mockReturnValue({
      workers: { garden: [{ name: "w1", sessionId: "s", task: "", prState: "failing", agentStatus: "working" }] },
    } as never);
    vi.mocked(resolveWorkerStatus).mockImplementation((e: { prState?: string } | undefined) => {
      return (e?.prState ?? "idle") as never;
    });

    updateHeaderVar({ state: makeState({ statusPaneId: "%0", activePlot: "imp" }) });
    const strip = vi.mocked(setPaneVar).mock.calls.find(c => c[1] === "garden_name")?.[2] ?? "";
    expect(strip).toMatch(/#\[fg=red,bold\]● [⠀-⣿] imp#\[default\]/);
    expect(strip).not.toContain("✖");
  });

  it("keeps the failing ✖ static when the failing worker is idle and a sibling is working", () => {
    // The spinner tracks the FAILING worker, not the plot's general activity.
    vi.mocked(readRegistry).mockReturnValue({
      workers: { garden: [
        { name: "w1", sessionId: "s", task: "", prState: "failing", agentStatus: "idle" },
        { name: "w2", sessionId: "s", task: "", agentStatus: "working" },
      ]},
    } as never);
    vi.mocked(resolveWorkerStatus).mockImplementation((e: { prState?: string; agentStatus?: string } | undefined) => {
      return (e?.prState ?? e?.agentStatus ?? "idle") as never;
    });

    updateHeaderVar({ state: makeState({ statusPaneId: "%0", activePlot: "imp" }) });
    const strip = vi.mocked(setPaneVar).mock.calls.find(c => c[1] === "garden_name")?.[2] ?? "";
    expect(strip).toContain("#[fg=red,bold]● ✖ imp#[default]");
  });

  it("prefers the failing spinner when a later worker in the plot is failing and working", () => {
    vi.mocked(readRegistry).mockReturnValue({
      workers: { garden: [
        { name: "w1", sessionId: "s", task: "", prState: "failing", agentStatus: "idle" },
        { name: "w2", sessionId: "s", task: "", prState: "failing", agentStatus: "working" },
      ]},
    } as never);
    vi.mocked(resolveWorkerStatus).mockImplementation((e: { prState?: string; agentStatus?: string } | undefined) => {
      return (e?.prState ?? e?.agentStatus ?? "idle") as never;
    });

    updateHeaderVar({ state: makeState({ statusPaneId: "%0", activePlot: "imp" }) });
    const strip = vi.mocked(setPaneVar).mock.calls.find(c => c[1] === "garden_name")?.[2] ?? "";
    expect(strip).toMatch(/#\[fg=red,bold\]● [⠀-⣿] imp#\[default\]/);
  });

  it("renders a yellow ⚑ icon when any worker in the plot is asking", () => {
    vi.mocked(readRegistry).mockReturnValue({
      workers: { garden: [{ name: "w1", sessionId: "s", task: "", agentStatus: "asking" }] },
    } as never);
    vi.mocked(resolveWorkerStatus).mockReturnValue("asking" as never);

    updateHeaderVar({ state: makeState({ statusPaneId: "%0", activePlot: "imp" }) });
    const strip = vi.mocked(setPaneVar).mock.calls.find(c => c[1] === "garden_name")?.[2] ?? "";
    expect(strip).toContain("#[fg=yellow,bold]● ⚑ imp#[default]");
  });

  it("renders a green ✓ icon only when a worker is done (not for merged or merge-pending)", () => {
    vi.mocked(readRegistry).mockReturnValue({
      workers: { garden: [{ name: "w1", sessionId: "s", task: "", prState: "done" }] },
    } as never);
    vi.mocked(resolveWorkerStatus).mockReturnValue("done" as never);

    updateHeaderVar({ state: makeState({ statusPaneId: "%0", activePlot: "imp" }) });
    const strip = vi.mocked(setPaneVar).mock.calls.find(c => c[1] === "garden_name")?.[2] ?? "";
    expect(strip).toContain("#[fg=green,bold]● ✓ imp#[default]");
  });

  it("renders the working spinner (not green ✓) when a worker is in transient merged", () => {
    vi.mocked(readRegistry).mockReturnValue({
      workers: { garden: [{ name: "w1", sessionId: "s", task: "", prState: "merged" }] },
    } as never);
    vi.mocked(resolveWorkerStatus).mockReturnValue("merged" as never);

    updateHeaderVar({ state: makeState({ statusPaneId: "%0", activePlot: "imp" }) });
    const strip = vi.mocked(setPaneVar).mock.calls.find(c => c[1] === "garden_name")?.[2] ?? "";
    expect(strip).not.toContain("✓");
    expect(strip).toMatch(/[⠀-⣿]/);
  });

  it("renders a spinner frame when a worker is working, and writes the template with a sentinel", () => {
    vi.mocked(readRegistry).mockReturnValue({
      workers: { garden: [{ name: "w1", sessionId: "s", task: "", agentStatus: "working" }] },
    } as never);
    vi.mocked(resolveWorkerStatus).mockReturnValue("working" as never);

    const writeFileSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {});
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation(() => {});

    updateHeaderVar({ state: makeState({ statusPaneId: "%0", activePlot: "imp" }) });

    const strip = vi.mocked(setPaneVar).mock.calls.find(c => c[1] === "garden_name")?.[2] ?? "";
    // The display carries a current braille frame (not the sentinel).
    expect(strip).toMatch(/#\[fg=default,bold\]● [⠀-⣿] imp#\[default\]/);

    // The template written to disk carries the sentinel instead of the frame.
    const writeCall = writeFileSpy.mock.calls.find(c => String(c[0]).includes("plot-strip.template."));
    expect(writeCall).toBeDefined();
    expect(String(writeCall![1])).toContain("__GSP__");
    expect(renameSpy).toHaveBeenCalled();

    writeFileSpy.mockRestore();
    renameSpy.mockRestore();
  });

  it("renders the spinner in flat grey on a non-active plot, inside the segment's own color run", () => {
    vi.mocked(readRegistry).mockReturnValue({
      workers: { garden: [{ name: "w1", sessionId: "s", task: "", agentStatus: "working" }] },
    } as never);
    vi.mocked(resolveWorkerStatus).mockReturnValue("working" as never);

    updateHeaderVar({ state: makeState({ statusPaneId: "%0", activePlot: "imp" }) });
    const strip = vi.mocked(setPaneVar).mock.calls.find(c => c[1] === "garden_name")?.[2] ?? "";
    // "all" is not the active plot: circle, spinner and name share one grey run.
    // The spinner must NOT sit in a bare #[default] gap — see formatPlotSegment.
    expect(strip).toMatch(/#\[fg=colour244\]○ [⠀-⣿] all#\[default\]/);
  });

  // Regression guard for the green-spinner bug: the strip is drawn as the status
  // pane's pane-border-format, where a glyph with no explicit fg resolves against
  // tmux's pane-active-border-style (default fg=green) whenever that pane is
  // active. Every visible glyph must therefore live inside an explicit #[fg=…]
  // run, never after a bare #[default].
  it("leaves no glyph colorless in any plot state", () => {
    for (const status of ["working", "failing", "asking", "done", "idle"]) {
      vi.mocked(readRegistry).mockReturnValue({
        workers: { garden: [{ name: "w1", sessionId: "s", task: "", agentStatus: status }] },
      } as never);
      vi.mocked(resolveWorkerStatus).mockReturnValue(status as never);

      for (const activePlot of ["imp", null]) {
        vi.mocked(setPaneVar).mockClear();
        updateHeaderVar({ state: makeState({ statusPaneId: "%0", activePlot }) });
        const strip = vi.mocked(setPaneVar).mock.calls.find(c => c[1] === "garden_name")?.[2] ?? "";
        // Text after a #[default] and before the next #[…] is unstyled; only the
        // two-space separator between segments is allowed to land there.
        for (const gap of strip.split("#[default]").slice(1)) {
          const unstyled = gap.split("#[")[0];
          expect(unstyled.trim(), `unstyled glyph in ${status}/${activePlot} strip: ${strip}`).toBe("");
        }
      }
    }
  });

  it("prioritizes failing > asking > merged > working > idle across workers in a plot", () => {
    vi.mocked(readRegistry).mockReturnValue({
      workers: { garden: [
        { name: "w1", sessionId: "s", task: "", agentStatus: "working" },
        { name: "w2", sessionId: "s", task: "", agentStatus: "asking" },
        { name: "w3", sessionId: "s", task: "", prState: "failing" },
      ]},
    } as never);
    vi.mocked(resolveWorkerStatus).mockImplementation((e: { prState?: string; agentStatus?: string } | undefined) => {
      return (e?.prState ?? e?.agentStatus ?? "idle") as never;
    });

    updateHeaderVar({ state: makeState({ statusPaneId: "%0", activePlot: "imp" }) });
    const strip = vi.mocked(setPaneVar).mock.calls.find(c => c[1] === "garden_name")?.[2] ?? "";
    expect(strip).toContain("✖");
    expect(strip).not.toContain("⚑");
    expect(strip).not.toContain("✓");
  });

  it("sets status-pane border vars before the refresh-client -S so the border repaints immediately", () => {
    updateHeaderVar({ state: makeState({ statusPaneId: "%0", activePlot: "imp" }) });

    // setPaneVar writes pane-scoped @garden_name; setBarVars' refresh-client -S
    // rides in the batched tmuxBatch call. The border var must be set before the
    // batch (which flushes the client) so the border repaints immediately.
    const setPaneVarMock = vi.mocked(setPaneVar);
    const nameCallIdx = setPaneVarMock.mock.invocationCallOrder[
      setPaneVarMock.mock.calls.findIndex(c => c[1] === "garden_name")
    ];
    const batchMock = vi.mocked(tmuxBatch);
    const refreshIdx = batchMock.mock.invocationCallOrder[
      batchMock.mock.calls.findIndex(gs => gs.some(g => g[0] === "refresh-client" && g[1] === "-S"))
    ];
    expect(nameCallIdx).toBeDefined();
    expect(refreshIdx).toBeDefined();
    expect(nameCallIdx).toBeLessThan(refreshIdx);
  });

  it("writes the plot-strip template before setting @garden_name so a racing animation tick reads the new template", () => {
    const writeFileSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {});
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation(() => {});

    updateHeaderVar({ state: makeState({ statusPaneId: "%0", activePlot: "imp" }) });

    const renameIdx = renameSpy.mock.invocationCallOrder[
      renameSpy.mock.calls.findIndex(c => String(c[1]).endsWith("plot-strip.template"))
    ];
    const setPaneVarMock = vi.mocked(setPaneVar);
    const nameCallIdx = setPaneVarMock.mock.invocationCallOrder[
      setPaneVarMock.mock.calls.findIndex(c => c[1] === "garden_name")
    ];
    expect(renameIdx).toBeDefined();
    expect(nameCallIdx).toBeDefined();
    // Template rename (atomic publish of the new strip) must complete before
    // setPaneVar publishes the JS-side @garden_name. Otherwise a bash frame
    // racing between the two writes reads the old template and clobbers the
    // new strip back to the previous plot.
    expect(renameIdx).toBeLessThan(nameCallIdx);

    writeFileSpy.mockRestore();
    renameSpy.mockRestore();
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

  it("sets agentStatus to exited and flags mid-turn interruption when worker was working", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash",
      sessionId: "test",
      task: "",
      agentStatus: "working",
    });
    handlePaneDied("_garden-worker-bold-ash");

    expect(updateWorkerFields).toHaveBeenCalledWith(
      "garden", "bold-ash",
      { agentStatus: "exited", interruptedWhileWorking: true },
    );
  });

  it("does not set the interruption flag when the worker was idle at exit", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash",
      sessionId: "test",
      task: "",
      agentStatus: "idle",
    });
    handlePaneDied("_garden-worker-bold-ash");

    expect(updateWorkerFields).toHaveBeenCalledWith(
      "garden", "bold-ash",
      { agentStatus: "exited" },
    );
  });

  it("logs the pane-died event", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash",
      sessionId: "test",
      task: "",
      agentStatus: "working",
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
      agentStatus: "idle",
    });
    vi.mocked(updateWorkerFields).mockImplementation(() => { throw new Error("lock fail"); });
    expect(() => handlePaneDied("_garden-worker-bold-ash")).not.toThrow();
  });

  // Regression: a worker whose bootstrap aborted before reaching Claude
  // Code (agentStatus="loading", no worktree on disk) would otherwise be
  // marked "exited" here and persist forever — the ghost sweep filters on
  // agentStatus="loading" so the "exited" relabel takes the entry out of
  // its reach. We remove the entry outright in this narrow case.
  it("removes the registry entry when pane dies during bootstrap (loading + no worktree)", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash",
      sessionId: "test",
      task: "",
      agentStatus: "loading",
      worktreePath: "/wt/garden/bold-ash",
    });
    vi.mocked(worktreeExists).mockReturnValue(false);

    handlePaneDied("_garden-worker-bold-ash");

    expect(removeWorker).toHaveBeenCalledWith("garden", "bold-ash");
    expect(updateWorkerFields).not.toHaveBeenCalled();
  });

  it("does NOT remove the entry when worktree exists, even if agentStatus is loading", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash",
      sessionId: "test",
      task: "",
      agentStatus: "loading",
      worktreePath: "/wt/garden/bold-ash",
    });
    vi.mocked(worktreeExists).mockReturnValue(true);

    handlePaneDied("_garden-worker-bold-ash");

    expect(removeWorker).not.toHaveBeenCalled();
    expect(updateWorkerFields).toHaveBeenCalledWith(
      "garden", "bold-ash",
      { agentStatus: "exited" },
    );
  });
});

// ===========================================================================
// handleTitleChanged
// ===========================================================================

describe("handleTitleChanged", () => {
  it("writes the pane title as the task for a claude-code worker", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash",
      sessionId: "s1",
      task: "old task",
      agentStatus: "working",
    });
    vi.mocked(getPaneTitle).mockReturnValue("new task");

    handleTitleChanged("_garden-worker-bold-ash", "%5");

    expect(updateWorkerFields).toHaveBeenCalledWith(
      "garden", "bold-ash", { task: "new task" },
    );
  });

  // Regression: Codex's default terminal title renders `project-name`, which
  // falls back to the worktree basename — the worker's own name. Writing it
  // here stomped the transcript-derived summary readActivity had just set,
  // which is exactly what the operator saw: a good summary replaced by
  // "coy-stout-elk". A harness that reads its own activity owns the task.
  it("ignores the pane title for a harness that reads its own activity", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "rust-free-brink",
      sessionId: "s2",
      task: "Auditing the poller's merge path",
      agentStatus: "working",
      harness: "codex",
    });
    vi.mocked(getPaneTitle).mockReturnValue("rust-free-brink");

    handleTitleChanged("_garden-worker-rust-free-brink", "%7");

    expect(updateWorkerFields).not.toHaveBeenCalled();
    expect(setPaneVar).not.toHaveBeenCalled();
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
          { name: "bold-ash", sessionId: "s1", task: "old task", agentStatus: "working" },
        ],
      },
    });
    vi.mocked(readDashState).mockReturnValue(makeState({
      activeProject: "garden",
      activePaneId: "%5",
      activeWindowName: "_garden-worker-bold-ash",
    }));
    // refreshWorkerTasks now reads pane titles via one batched list-panes
    // call. The active-window match short-circuits to byPaneId lookup, so
    // include the active pane id with its current title.
    vi.mocked(listSessionPaneTitles).mockReturnValue([
      { windowName: "main", paneId: "%5", rawTitle: "new task" },
    ]);

    refreshDashboard();

    expect(batchUpdateWorkerFields).toHaveBeenCalledWith([
      { project: "garden", workerName: "bold-ash", fields: { task: "new task" } },
    ]);
  });

  it("skips update when task is unchanged", () => {
    vi.mocked(readRegistry).mockReturnValue({
      workers: {
        garden: [
          { name: "bold-ash", sessionId: "s1", task: "same task", agentStatus: "working" },
        ],
      },
    });
    vi.mocked(readDashState).mockReturnValue(makeState({
      activeProject: "garden",
      activePaneId: "%5",
      activeWindowName: "_garden-worker-bold-ash",
    }));
    vi.mocked(listSessionPaneTitles).mockReturnValue([
      { windowName: "main", paneId: "%5", rawTitle: "same task" },
    ]);

    refreshDashboard();

    expect(batchUpdateWorkerFields).not.toHaveBeenCalled();
    // Border synchronization is independent of the registry write. The hook
    // commonly updates entry.task before this refresh, and harness-owned
    // activity has no pane-title event that can update the border instead.
    expect(setPaneVar).toHaveBeenCalledWith("%5", "garden_task", "same task");
  });

  it("falls back to byWindow lookup when worker pane is parked (not active)", () => {
    vi.mocked(readRegistry).mockReturnValue({
      workers: {
        garden: [
          { name: "calm-elm", sessionId: "s2", task: "old", agentStatus: "idle" },
        ],
      },
    });
    // Worker is NOT in the active right slot; its logical hidden window
    // holds the parked pane.
    vi.mocked(readDashState).mockReturnValue(makeState({
      activeWindowName: "_garden-worker-bold-ash", // a different worker
      activePaneId: "%9",
    }));
    vi.mocked(listSessionPaneTitles).mockReturnValue([
      { windowName: "_garden-worker-bold-ash", paneId: "%9", rawTitle: "bold's title" },
      { windowName: "_garden-worker-calm-elm", paneId: "%12", rawTitle: "calm's new title" },
    ]);

    refreshDashboard();

    expect(batchUpdateWorkerFields).toHaveBeenCalledWith([
      { project: "garden", workerName: "calm-elm", fields: { task: "calm's new title" } },
    ]);
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

  // refreshStatusElapsed is the watchdog's 60s re-bake hook: it re-renders the
  // status pane so time-in-state suffixes advance, and must re-read state itself
  // (no opts) since the watchdog runs in its own process.
  it("refreshStatusElapsed re-bakes the status file from freshly-read state", () => {
    vi.mocked(readDashState).mockReturnValue(makeState({ statusPaneId: "%0" }));
    vi.mocked(renderQuickStatus).mockReturnValue("reviewing 12m");

    refreshStatusElapsed();

    const renameCalls = vi.mocked(fs.renameSync).mock.calls;
    expect(renameCalls.length).toBeGreaterThanOrEqual(1);
    expect(renameCalls[0][1] as string).toContain("status.rendered");
  });

  it("refreshStatusElapsed suppresses the write when content is unchanged", () => {
    vi.mocked(readDashState).mockReturnValue(makeState({ statusPaneId: "%0" }));
    vi.mocked(renderQuickStatus).mockReturnValue("reviewing 12m");

    refreshStatusElapsed();       // first bake writes
    vi.mocked(fs.renameSync).mockClear();
    refreshStatusElapsed();       // identical content -> deduped, no write

    expect(vi.mocked(fs.renameSync).mock.calls.length).toBe(0);
  });

  it("suppresses the write and SIGUSR1 when the on-disk file already matches, even with a cold in-process cache", () => {
    // A fresh hook/hotkey process has an empty lastWritten* cache, so the
    // in-process dedup can't fire. The cross-process file-compare must still
    // skip the write + the signal when status.rendered already holds this exact
    // content — the common case under the hook firehose.
    vi.mocked(readDashState).mockReturnValue(makeState({ statusPaneId: "%0" }));
    vi.mocked(renderQuickStatus).mockReturnValue("reviewing 12m");
    vi.mocked(getPanePid).mockReturnValue("999"); // a signal WOULD fire if not skipped
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    vi.mocked(fs.readFileSync).mockImplementation(
      ((p: unknown) => (String(p).includes("status.rendered") ? "reviewing 12m" : "{}")) as never,
    );
    _resetHeaderCachesForTest(); // cold in-process cache, like a fresh hook process

    refreshStatusElapsed();

    const statusRenames = vi.mocked(fs.renameSync).mock.calls
      .filter(c => String(c[1]).includes("status.rendered"));
    expect(statusRenames.length).toBe(0);
    expect(killSpy).not.toHaveBeenCalled();
    killSpy.mockRestore();
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

    // updateHeaderVar's refresh-client -S now rides in setBarVars' batched
    // tmuxBatch call, so the only way a bare tmux refresh-client -S appears is
    // writeQuickStatus's resize flush — which must NOT fire on this no-resize path.
    const refreshCalls = vi.mocked(tmux).mock.calls.filter(
      c => c[0] === "refresh-client" && c[1] === "-S",
    );
    expect(refreshCalls).toHaveLength(0);
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
// repinStatusPaneHeight (the _client-resized reconciliation)
// ===========================================================================

describe("repinStatusPaneHeight", () => {
  // The status pane height drifts on a terminal resize (tmux redistributes the
  // left column proportionally), but writeQuickStatus only re-pins it past its
  // byte-identical dedup — so a resize that changes no rendered content is no
  // longer self-healed by the next same-state hook. _client-resized calls this
  // to reconcile the height on the resize event itself.
  const twentyLines = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");
  const mockStatusFile = (content: string) =>
    vi.mocked(fs.readFileSync).mockImplementation(
      ((p: unknown) => (String(p).includes("status.rendered") ? content : "{}")) as never,
    );

  it("resizes the status pane to its content-derived height and repaints via SIGUSR1 (never refresh-client)", () => {
    mockStatusFile(twentyLines); // 20 content lines exceed the 16-line floor
    vi.mocked(getPaneSize).mockReturnValue({ width: 120, height: 5 });
    vi.mocked(getPanePid).mockReturnValue("999");
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    repinStatusPaneHeight(makeState({ statusPaneId: "%0" }));

    // Math.max(16, 20) + 1 = 21.
    expect(tmux).toHaveBeenCalledWith("resize-pane", "-t", "%0", "-y", "21");
    expect(killSpy).toHaveBeenCalledWith(999, "SIGUSR1");
    // Copy-mode safety: the resize path must never fork a full client refresh.
    expect(vi.mocked(tmux).mock.calls.some(c => c[0] === "refresh-client")).toBe(false);
    killSpy.mockRestore();
  });

  it("is a no-op when the pane height already matches the content", () => {
    mockStatusFile(twentyLines);
    vi.mocked(getPaneSize).mockReturnValue({ width: 120, height: 21 }); // already the target
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    repinStatusPaneHeight(makeState({ statusPaneId: "%0" }));

    expect(vi.mocked(tmux).mock.calls.some(c => c[0] === "resize-pane")).toBe(false);
    expect(killSpy).not.toHaveBeenCalled();
    killSpy.mockRestore();
  });

  it("is a no-op when statusPaneId is null", () => {
    repinStatusPaneHeight(makeState({ statusPaneId: null }));
    expect(tmux).not.toHaveBeenCalled();
  });

  it("swallows a missing rendered file (first resize of a session)", () => {
    vi.mocked(fs.readFileSync).mockImplementation((() => { throw new Error("ENOENT"); }) as never);
    expect(() => repinStatusPaneHeight(makeState({ statusPaneId: "%0" }))).not.toThrow();
    expect(vi.mocked(tmux).mock.calls.some(c => c[0] === "resize-pane")).toBe(false);
  });
});

// ===========================================================================
// repinUsagePaneHeight + rebakePanesOnResize (the _client-resized content re-bake)
// ===========================================================================

describe("repinUsagePaneHeight", () => {
  const mockUsageFile = (content: string) =>
    vi.mocked(fs.readFileSync).mockImplementation(
      ((p: unknown) => {
        if (String(p).includes("usage.rendered")) return content;
        return "{}";
      }) as never,
    );

  it("pins the pane to the rendered file's line count + 1", () => {
    mockUsageFile("u1\nu2\nu3\nu4\nu5\nu6"); // 6 lines -> height 7
    vi.mocked(getPaneSize).mockReturnValue({ width: 120, height: 5 });

    repinUsagePaneHeight(makeState({ usagePaneId: "%2" }), 5);

    expect(tmux).toHaveBeenCalledWith("resize-pane", "-t", "%2", "-y", "7");
  });

  it("falls back to the provided default height when no rendered file exists", () => {
    vi.mocked(fs.readFileSync).mockImplementation((() => { throw new Error("ENOENT"); }) as never);
    vi.mocked(getPaneSize).mockReturnValue({ width: 120, height: 3 });

    repinUsagePaneHeight(makeState({ usagePaneId: "%2" }), 5);

    expect(tmux).toHaveBeenCalledWith("resize-pane", "-t", "%2", "-y", "5");
  });

  it("is a no-op when the height already matches the content", () => {
    mockUsageFile("u1\nu2\nu3"); // 3 lines -> height 4
    vi.mocked(getPaneSize).mockReturnValue({ width: 120, height: 4 });

    repinUsagePaneHeight(makeState({ usagePaneId: "%2" }), 5);

    expect(vi.mocked(tmux).mock.calls.some(c => c[0] === "resize-pane")).toBe(false);
  });

  it("is a no-op when usagePaneId is null", () => {
    repinUsagePaneHeight(makeState({ usagePaneId: null }), 5);
    expect(tmux).not.toHaveBeenCalled();
  });
});

describe("rebakePanesOnResize", () => {
  // The pre-baked pane content is width-shaped, so the resize handler must
  // re-render it at the fresh widths — not just re-pin heights. Before this
  // existed, resized panes stayed baked for the old width until the next
  // event-driven refresh (an idle fleet: until the next worker was created).

  it("busts the width TTL cache so the status render sees the post-resize width", () => {
    vi.mocked(readDashState).mockReturnValue(makeState({ statusPaneId: "%0" }));
    vi.mocked(getPaneSize).mockReturnValue({ width: 120, height: 10 });
    refreshDashboard(); // primes the TTL cache at width 120

    vi.mocked(getPaneSize).mockReturnValue({ width: 40, height: 10 });
    rebakePanesOnResize(makeState({ statusPaneId: "%0" }), 5);

    // Within the 1s TTL a plain refresh would still see 120 (asserted in the
    // width-threading suite); the resize re-bake must read the width fresh.
    expect(vi.mocked(renderQuickStatus).mock.calls.at(-1)?.[4]).toBe(40);
  });

  it("re-renders the usage pane at the fresh pane width", () => {
    vi.mocked(renderUsagePane).mockReturnValue("u1\nu2\nu3");
    vi.mocked(getPaneSize).mockReturnValue({ width: 90, height: 5 });

    rebakePanesOnResize(makeState({ usagePaneId: "%2" }), 5);

    expect(vi.mocked(renderUsagePane).mock.calls.at(-1)?.[1]).toBe(90);
  });

  it("never forks refresh-client or clear-history (copy-mode safety)", () => {
    vi.mocked(renderUsagePane).mockReturnValue("u1\nu2\nu3");
    vi.mocked(getPaneSize).mockReturnValue({ width: 100, height: 5 });
    vi.mocked(getPanePid).mockReturnValue("999");
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    rebakePanesOnResize(makeState({ statusPaneId: "%0", usagePaneId: "%2" }), 5);

    // The re-bake resized panes (content height != current height) ...
    expect(vi.mocked(tmux).mock.calls.some(c => c[0] === "resize-pane")).toBe(true);
    // ... yet stayed on the SIGUSR1-only path.
    expect(vi.mocked(tmux).mock.calls.some(c => c[0] === "refresh-client")).toBe(false);
    expect(vi.mocked(tmux).mock.calls.some(c => c[0] === "clear-history")).toBe(false);
    killSpy.mockRestore();
  });
});

// ===========================================================================
// status pane width threading (writeQuickStatus -> renderQuickStatus)
// ===========================================================================

describe("status pane width threading (via refreshDashboard)", () => {
  // The 5th arg to renderQuickStatus (index 4) is the raw pane width that
  // writeQuickStatus resolves via the cachedStatusPaneWidth TTL cache. It is the
  // hard-cap input that keeps status rows from wrapping onto a second terminal
  // line (which desyncs the in-place repaint). renderQuickStatus is mocked here,
  // so these assertions guard the header-side wiring/cache — the capping math
  // itself lives in status-logic.test.ts.
  const lastWidthArg = () => vi.mocked(renderQuickStatus).mock.calls.at(-1)?.[4];

  it("threads the status pane width from getPaneSize into renderQuickStatus", () => {
    vi.mocked(readDashState).mockReturnValue(makeState({ statusPaneId: "%0" }));
    vi.mocked(getPaneSize).mockReturnValue({ width: 120, height: 10 });

    refreshDashboard();

    // A regression that dropped the arg, passed the height, or forgot to read
    // the pane size would surface here as undefined / the wrong number.
    expect(lastWidthArg()).toBe(120);
  });

  it("passes an undefined width when there is no status pane", () => {
    vi.mocked(readDashState).mockReturnValue(makeState({ statusPaneId: null }));

    refreshDashboard();

    expect(lastWidthArg()).toBeUndefined();
  });

  it("reuses the cached width within the TTL for the same pane (no re-fork per refresh)", () => {
    vi.mocked(readDashState).mockReturnValue(makeState({ statusPaneId: "%0" }));
    vi.mocked(getPaneSize).mockReturnValue({ width: 120, height: 10 });
    refreshDashboard();

    // The pane width changes underneath, but within the 1s TTL and the same
    // pane id the cache is a hit — renderQuickStatus still sees the first width,
    // so no per-refresh tmux size fork happens.
    vi.mocked(getPaneSize).mockReturnValue({ width: 40, height: 10 });
    refreshDashboard();

    expect(lastWidthArg()).toBe(120);
  });

  it("re-reads the width when the status pane id changes (cache invalidated)", () => {
    vi.mocked(readDashState).mockReturnValue(makeState({ statusPaneId: "%0" }));
    vi.mocked(getPaneSize).mockReturnValue({ width: 120, height: 10 });
    refreshDashboard();

    // A different pane id is a cache miss, so the width is read fresh.
    vi.mocked(readDashState).mockReturnValue(makeState({ statusPaneId: "%1" }));
    vi.mocked(getPaneSize).mockReturnValue({ width: 40, height: 10 });
    refreshDashboard();

    expect(lastWidthArg()).toBe(40);
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

describe("buildHistoryCommand", () => {
  it("returns a shell script string", () => {
    const cmd = buildHistoryCommand("garden");
    expect(typeof cmd).toBe("string");
    expect(cmd.length).toBeGreaterThan(0);
  });

  it("sets up a SIGUSR1 trap for event-driven refresh", () => {
    const cmd = buildHistoryCommand("garden");
    expect(cmd).toContain("trap");
    expect(cmd).toContain("USR1");
  });

  it("references the pre-baked history file path", () => {
    const cmd = buildHistoryCommand("garden");
    expect(cmd).toContain("history.rendered");
  });

  it("fully clears screen and scrollback on every repaint", () => {
    // Unlike the usage pane, each render clears scrollback (\\033[2J\\033[3J)
    // so a shorter new line never leaves a longer prior line's tail on screen.
    const cmd = buildHistoryCommand("garden");
    expect(cmd).toContain(String.raw`render() { _t=$(cat "$cf" 2>/dev/null); printf '\033[H\033[2J\033[3J%s' "$_t"; }`);
  });

  it("sleeps long on idle (pure event-driven wake)", () => {
    const cmd = buildHistoryCommand("garden");
    expect(cmd).toContain("sleep 86400");
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

    // updateHeaderVar sets tmux vars (batched via tmuxBatch)
    const groups = vi.mocked(tmuxBatch).mock.calls.flat();
    const hasLeftVar = groups.some(g => g[0] === "set-option" && g[3] === "@garden_left");
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
    const groups = vi.mocked(tmuxBatch).mock.calls.flat();
    const leftCall = groups.find(g => g[0] === "set-option" && g[3] === "@garden_left");
    expect(leftCall![4]).toContain("other");

    // refreshStatusPane should use the custom state's statusPaneId
    expect(getPanePid).toHaveBeenCalledWith("%7");
    expect(killSpy).toHaveBeenCalledWith(55555, "SIGUSR1");
    killSpy.mockRestore();
  });

  it("skips writeQuickStatus / writeUsageRendered atomic writes when rendered content is unchanged", () => {
    vi.mocked(readDashState).mockReturnValue(makeState({ statusPaneId: "%5", usagePaneId: "%6" }));
    vi.mocked(renderQuickStatus).mockReturnValue("steady-state status");

    refreshDashboard();
    const firstWriteCount = vi.mocked(fs.writeFileSync).mock.calls.length;
    expect(firstWriteCount).toBeGreaterThan(0);

    vi.mocked(fs.writeFileSync).mockClear();
    // Same content, same state — every write should short-circuit.
    refreshDashboard();
    expect(vi.mocked(fs.writeFileSync).mock.calls.length).toBe(0);
  });

  it("re-writes when rendered content changes", () => {
    vi.mocked(readDashState).mockReturnValue(makeState({ statusPaneId: "%5" }));
    vi.mocked(renderQuickStatus).mockReturnValue("first content");
    refreshDashboard();

    vi.mocked(fs.writeFileSync).mockClear();
    vi.mocked(renderQuickStatus).mockReturnValue("second content");
    refreshDashboard();
    // Status file is re-written; the cache invalidates on the new value.
    const statusWrites = vi.mocked(fs.writeFileSync).mock.calls.filter(
      c => String(c[0]).includes("status.rendered"),
    );
    expect(statusWrites.length).toBeGreaterThan(0);
  });

  it("skips setBarVars tmux subprocesses when left/right both unchanged", () => {
    const setBarBatches = () => vi.mocked(tmuxBatch).mock.calls.filter(
      gs => gs.some(g => g[0] === "set-option" && g[3] === "@garden_left"),
    ).length;

    refreshDashboard();
    expect(setBarBatches()).toBeGreaterThan(0);

    vi.mocked(tmuxBatch).mockClear();
    // Same active project / plot → same left+right → entire setBarVars block
    // (its one batched tmuxBatch client) skipped.
    refreshDashboard();
    expect(setBarBatches()).toBe(0);
  });

  it("does not sweep per-window set-option calls on refresh (suppression is now at window creation)", () => {
    // Window-name suppression moved to window-creation time (newDashboardWindow),
    // so a refresh must never fork per-window window-status-format set-options —
    // that per-refresh sweep, cold in every fresh hook process, was the cost this
    // removed.
    refreshDashboard({ windowNames: ["main", "_garden-worker-bold-ash", "_garden-shell"] });
    const sweepCalls = vi.mocked(tmux).mock.calls.filter(
      c => c[0] === "set-option" && c[3] === "window-status-format",
    ).length;
    expect(sweepCalls).toBe(0);
  });
});

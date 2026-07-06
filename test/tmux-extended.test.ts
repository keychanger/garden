import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

const mockExecFileSync = vi.fn();

vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

vi.mock("node:os", () => ({
  default: { hostname: () => "my-macbook.local" },
}));

vi.mock("../src/session.js", () => ({
  DASHBOARD_SESSION: "garden-dashboard",
}));

vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/dashboard/window-names.js", () => ({
  workerWindowPrefix: (project: string) => `_${project}-worker-`,
}));

// ---------------------------------------------------------------------------
// Imports — after mocks
// ---------------------------------------------------------------------------

import {
  tmux,
  tmuxOutput,
  tmuxSplit,
  tmuxNewWindow,
  newDashboardWindow,
  newDashboardWindowPaned,
  getActivePaneId,
  tmuxDisplay,
  setPaneTitle,
  setPaneLabel,
  setPaneVar,
  getFirstPaneId,
  paneExists,
  windowExists,
  windowIndices,
  dedupeWindows,
  killWindowsByName,
  renameWindow,
  getPaneSize,
  resizeWindow,
  killWindowSafe,
  getPanePid,
  paneRunningOnlyShell,
  getPaneLabel,
  getPaneTitle,
  listAllWindowNames,
  listHiddenWorkerWindows,
  listSessionPaneTitles,
  cleanPaneTitle,
  stripControlSequences,
  pasteAndSubmit,
  __setTmuxExecAllowedForTests,
} from "../src/dashboard/tmux.js";

import { log } from "../src/dashboard/log.js";

// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // This suite mocks execFileSync to assert the exec wrappers' argv, so re-enable
  // real exec (which the test runner disables by default to keep tests off any
  // live tmux server — see __setTmuxExecAllowedForTests in tmux.ts).
  __setTmuxExecAllowedForTests(true);
});

afterEach(() => {
  __setTmuxExecAllowedForTests(false);
});

// ===========================================================================
// Test-isolation guard — regression for the badge-flash bug
// ===========================================================================

describe("tmux exec disabled under the runner", () => {
  it("no mutating helper shells out when exec is disallowed", () => {
    // Reproduces the fix for the live-dashboard badge flash: a test running on
    // a machine with a live `garden-dashboard` session must not let
    // refreshAlertBadge's `tmux set-option @garden_right` reach the real server.
    // The guard covers every mutating helper — tmux() and pasteAndSubmit() plus
    // the window/pane creators tmuxSplit() and tmuxNewWindow(), which would
    // otherwise spawn real windows in the operator's dashboard.
    __setTmuxExecAllowedForTests(false);
    tmux("set-option", "-t", "garden-dashboard", "@garden_right", "#[bg=red] ⚠ 1 alert — ⌥l to clear ");
    pasteAndSubmit("%1", "phantom keystrokes");
    expect(tmuxSplit("-v", "-t", "garden-dashboard")).toBe("");
    expect(tmuxNewWindow("-d", "-t", "garden-dashboard", "-n", "phantom")).toBe("");
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it("default under VITEST is disallowed (the guard is on unless a test opts in)", () => {
    // beforeEach opts this suite back in; clear that to observe the default.
    __setTmuxExecAllowedForTests(false);
    tmux("kill-server");
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// getPaneTitle
// ===========================================================================

describe("getPaneTitle", () => {
  it("returns cleaned title, stripping leading non-alphanumeric noise", () => {
    mockExecFileSync.mockReturnValue("✱ Refactoring auth module\n");
    const result = getPaneTitle("%5");
    expect(result).toBe("Refactoring auth module");
  });

  it("strips emoji prefix and whitespace", () => {
    mockExecFileSync.mockReturnValue("⠋ Building tests\n");
    const result = getPaneTitle("%5");
    expect(result).toBe("Building tests");
  });

  it("returns null for 'Claude Code' placeholder", () => {
    mockExecFileSync.mockReturnValue("Claude Code\n");
    expect(getPaneTitle("%5")).toBeNull();
  });

  it("returns null when cleaned result equals hostname", () => {
    mockExecFileSync.mockReturnValue("my-macbook.local\n");
    expect(getPaneTitle("%5")).toBeNull();
  });

  it("returns null for empty string output", () => {
    mockExecFileSync.mockReturnValue("\n");
    expect(getPaneTitle("%5")).toBeNull();
  });

  it("returns null for string that is only non-alphanumeric noise", () => {
    mockExecFileSync.mockReturnValue("✱ \n");
    expect(getPaneTitle("%5")).toBeNull();
  });

  it("returns null when tmux command throws", () => {
    mockExecFileSync.mockImplementation(() => { throw new Error("pane gone"); });
    expect(getPaneTitle("%5")).toBeNull();
  });

  it("returns a simple alphanumeric title as-is", () => {
    mockExecFileSync.mockReturnValue("Writing unit tests\n");
    expect(getPaneTitle("%5")).toBe("Writing unit tests");
  });
});

// ===========================================================================
// listHiddenWorkerWindows
// ===========================================================================

describe("listHiddenWorkerWindows", () => {
  it("filters windows matching project worker prefix", () => {
    const names = [
      "_garden-worker-bold-ash",
      "_garden-worker-calm-elm",
      "_garden-shell",
      "_other-worker-foo",
      "main",
    ];
    const result = listHiddenWorkerWindows("garden", names);
    expect(result).toEqual([
      "_garden-worker-bold-ash",
      "_garden-worker-calm-elm",
    ]);
  });

  it("returns empty array when no workers match", () => {
    const names = ["_other-worker-x", "main", "_garden-shell"];
    expect(listHiddenWorkerWindows("garden", names)).toEqual([]);
  });

  it("returns empty array for empty window list", () => {
    expect(listHiddenWorkerWindows("garden", [])).toEqual([]);
  });

  it("falls back to listAllWindowNames when windowNames not provided", () => {
    // listAllWindowNames calls tmuxOutput internally
    mockExecFileSync.mockReturnValue("_myproj-worker-w1\n_myproj-shell\nmain\n");
    const result = listHiddenWorkerWindows("myproj");
    expect(result).toEqual(["_myproj-worker-w1"]);
  });
});

// ===========================================================================
// getPaneSize
// ===========================================================================

describe("getPaneSize", () => {
  it("parses width and height from tmux output", () => {
    mockExecFileSync.mockReturnValue("120 40\n");
    const size = getPaneSize("%3");
    expect(size).toEqual({ width: 120, height: 40 });
  });

  it("returns null for bad format (too many parts)", () => {
    mockExecFileSync.mockReturnValue("120 40 extra\n");
    expect(getPaneSize("%3")).toBeNull();
  });

  it("returns null for bad format (single value)", () => {
    mockExecFileSync.mockReturnValue("120\n");
    expect(getPaneSize("%3")).toBeNull();
  });

  it("returns null when tmux command throws", () => {
    mockExecFileSync.mockImplementation(() => { throw new Error("no pane"); });
    expect(getPaneSize("%3")).toBeNull();
  });
});

// ===========================================================================
// paneExists
// ===========================================================================

describe("paneExists", () => {
  it("returns true when tmux returns matching pane id", () => {
    mockExecFileSync.mockReturnValue("%5\n");
    expect(paneExists("%5")).toBe(true);
  });

  it("returns false when tmux returns different pane id", () => {
    mockExecFileSync.mockReturnValue("%99\n");
    expect(paneExists("%5")).toBe(false);
  });

  it("returns false when tmux throws", () => {
    mockExecFileSync.mockImplementation(() => { throw new Error("bad pane"); });
    expect(paneExists("%5")).toBe(false);
  });
});

// ===========================================================================
// windowExists
// ===========================================================================

describe("windowExists", () => {
  it("returns true when a window with the name is listed", () => {
    mockExecFileSync.mockReturnValue("13 _garden-poller\n22 _sharona-poller\n");
    expect(windowExists("_sharona-poller")).toBe(true);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "tmux",
      ["list-windows", "-t", "garden-dashboard", "-F", "#{window_index} #{window_name}"],
      expect.anything(),
    );
  });

  it("returns true even when the name is duplicated (the runaway-loop fix)", () => {
    // A name-targeted probe errored on the ambiguous target and reported the
    // poller dead; membership stays true so the watchdog stops respawning.
    mockExecFileSync.mockReturnValue("18 _wolf-poller\n34 _wolf-poller\n66 _wolf-poller\n");
    expect(windowExists("_wolf-poller")).toBe(true);
  });

  it("returns false when no window carries the name", () => {
    mockExecFileSync.mockReturnValue("13 _garden-poller\n");
    expect(windowExists("_wolf-poller")).toBe(false);
  });

  it("returns false when tmux throws", () => {
    mockExecFileSync.mockImplementation(() => { throw new Error("no session"); });
    expect(windowExists("_garden-poller")).toBe(false);
  });
});

describe("windowIndices / dedupeWindows / killWindowsByName", () => {
  it("windowIndices returns every index matching the exact name", () => {
    mockExecFileSync.mockReturnValue(
      "13 _garden-poller\n18 _wolf-poller\n34 _wolf-poller\n66 _wolf-poller\n19 _garden-usage-poller\n",
    );
    expect(windowIndices("_wolf-poller")).toEqual([18, 34, 66]);
    // Must not match a name that merely shares a prefix.
    expect(windowIndices("_garden-poller")).toEqual([13]);
  });

  it("dedupeWindows keeps the lowest index and kills the rest by index", () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "list-windows") return "66 _wolf-poller\n18 _wolf-poller\n34 _wolf-poller\n";
      return ""; // kill-window
    });
    expect(dedupeWindows("_wolf-poller")).toBe(2);
    const kills = mockExecFileSync.mock.calls.filter((c) => c[1][0] === "kill-window");
    expect(kills.map((c) => c[1])).toEqual([
      ["kill-window", "-t", "garden-dashboard:34"],
      ["kill-window", "-t", "garden-dashboard:66"],
    ]);
  });

  it("dedupeWindows is a no-op for a single window", () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) =>
      args[0] === "list-windows" ? "13 _garden-poller\n" : "");
    expect(dedupeWindows("_garden-poller")).toBe(0);
    expect(mockExecFileSync.mock.calls.filter((c) => c[1][0] === "kill-window")).toHaveLength(0);
  });

  it("killWindowsByName kills every matching window by index", () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) =>
      args[0] === "list-windows" ? "18 _wolf-poller\n34 _wolf-poller\n" : "");
    expect(killWindowsByName("_wolf-poller")).toBe(2);
    const kills = mockExecFileSync.mock.calls.filter((c) => c[1][0] === "kill-window");
    expect(kills).toHaveLength(2);
  });
});

// ===========================================================================
// tmux / tmuxOutput / tmuxSplit / tmuxNewWindow (basic delegation)
// ===========================================================================

describe("tmux", () => {
  it("calls execFileSync with stdio ignore", () => {
    mockExecFileSync.mockReturnValue(undefined);
    tmux("set-option", "-t", "garden-dashboard", "mouse", "on");
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "tmux",
      ["set-option", "-t", "garden-dashboard", "mouse", "on"],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
  });
});

describe("tmuxOutput", () => {
  it("returns trimmed string from execFileSync", () => {
    mockExecFileSync.mockReturnValue("  hello  \n");
    expect(tmuxOutput("display-message", "-p", "test")).toBe("hello");
  });
});

describe("tmuxSplit", () => {
  it("prepends split-window args and returns pane id", () => {
    mockExecFileSync.mockReturnValue("%10\n");
    const result = tmuxSplit("-v", "-t", "garden-dashboard");
    expect(result).toBe("%10");
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "tmux",
      ["split-window", "-P", "-F", "#{pane_id}", "-v", "-t", "garden-dashboard"],
      expect.anything(),
    );
  });
});

describe("tmuxNewWindow", () => {
  it("prepends new-window args and returns pane id", () => {
    mockExecFileSync.mockReturnValue("%20\n");
    const result = tmuxNewWindow("-d", "-t", "garden-dashboard", "-n", "test");
    expect(result).toBe("%20");
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "tmux",
      ["new-window", "-P", "-F", "#{pane_id}", "-d", "-t", "garden-dashboard", "-n", "test"],
      expect.anything(),
    );
  });
});

describe("newDashboardWindow / newDashboardWindowPaned", () => {
  it("newDashboardWindow batches creation + name suppression into one client invocation", () => {
    newDashboardWindow("_garden-worker-1", "-c", "/tmp/wt", "bash", "-c", "run");
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "tmux",
      [
        "new-window", "-d", "-t", "garden-dashboard", "-n", "_garden-worker-1",
        "-c", "/tmp/wt", "bash", "-c", "run",
        ";", "set-option", "-t", "garden-dashboard:_garden-worker-1", "window-status-format", "",
        ";", "set-option", "-t", "garden-dashboard:_garden-worker-1", "window-status-current-format", "",
      ],
      expect.anything(),
    );
  });

  it("newDashboardWindowPaned suppresses the name and returns the pane id", () => {
    mockExecFileSync.mockReturnValue("%7\n");
    const paneId = newDashboardWindowPaned("_garden-poller");
    expect(paneId).toBe("%7");
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "tmux",
      [
        "new-window", "-P", "-F", "#{pane_id}", "-d", "-t", "garden-dashboard", "-n", "_garden-poller",
        ";", "set-option", "-t", "garden-dashboard:_garden-poller", "window-status-format", "",
        ";", "set-option", "-t", "garden-dashboard:_garden-poller", "window-status-current-format", "",
      ],
      expect.anything(),
    );
  });
});

// ===========================================================================
// getActivePaneId
// ===========================================================================

describe("getActivePaneId", () => {
  it("returns pane id on success", () => {
    mockExecFileSync.mockReturnValue("%3\n");
    expect(getActivePaneId()).toBe("%3");
  });

  it("returns null on failure", () => {
    mockExecFileSync.mockImplementation(() => { throw new Error("no session"); });
    expect(getActivePaneId()).toBeNull();
  });
});

// ===========================================================================
// tmuxDisplay — fire-and-forget with log on failure
// ===========================================================================

describe("tmuxDisplay", () => {
  it("calls tmux display-message", () => {
    mockExecFileSync.mockReturnValue(undefined);
    tmuxDisplay("Hello world");
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "tmux",
      ["display-message", "-t", "garden-dashboard", "Hello world"],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
  });

  it("logs debug on failure", () => {
    mockExecFileSync.mockImplementation(() => { throw new Error("fail"); });
    tmuxDisplay("msg");
    expect(log.debug).toHaveBeenCalledWith("tmux", "tmuxDisplay failed");
  });
});

// ===========================================================================
// setPaneTitle — fire-and-forget with log on failure
// ===========================================================================

describe("setPaneTitle", () => {
  it("calls select-pane with title", () => {
    mockExecFileSync.mockReturnValue(undefined);
    setPaneTitle("%5", "My Title");
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "tmux",
      ["select-pane", "-t", "%5", "-T", "My Title"],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
  });

  it("logs debug on failure", () => {
    mockExecFileSync.mockImplementation(() => { throw new Error("fail"); });
    setPaneTitle("%5", "Title");
    expect(log.debug).toHaveBeenCalledWith("tmux", "setPaneTitle failed", { data: { paneId: "%5" } });
  });
});

// ===========================================================================
// setPaneLabel — fire-and-forget with log on failure
// ===========================================================================

describe("setPaneLabel", () => {
  it("sets @garden_name pane option", () => {
    mockExecFileSync.mockReturnValue(undefined);
    setPaneLabel("%5", "bold-ash");
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "tmux",
      ["set-option", "-p", "-t", "%5", "@garden_name", "bold-ash"],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
  });

  it("logs debug on failure", () => {
    mockExecFileSync.mockImplementation(() => { throw new Error("fail"); });
    setPaneLabel("%5", "label");
    expect(log.debug).toHaveBeenCalledWith("tmux", "setPaneLabel failed", { data: { paneId: "%5" } });
  });
});

// ===========================================================================
// setPaneVar — fire-and-forget with log on failure
// ===========================================================================

describe("setPaneVar", () => {
  it("sets a custom @-prefixed pane option", () => {
    mockExecFileSync.mockReturnValue(undefined);
    setPaneVar("%5", "garden_task", "building");
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "tmux",
      ["set-option", "-p", "-t", "%5", "@garden_task", "building"],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
  });

  it("logs debug on failure", () => {
    mockExecFileSync.mockImplementation(() => { throw new Error("fail"); });
    setPaneVar("%5", "garden_task", "x");
    expect(log.debug).toHaveBeenCalledWith("tmux", "setPaneVar failed", { data: { paneId: "%5", name: "garden_task" } });
  });
});

// ===========================================================================
// getFirstPaneId
// ===========================================================================

describe("getFirstPaneId", () => {
  it("returns first pane id from list-panes output", () => {
    mockExecFileSync.mockReturnValue("%1\n%2\n%3\n");
    expect(getFirstPaneId("garden-dashboard:main")).toBe("%1");
  });

  it("returns null when list-panes returns empty", () => {
    mockExecFileSync.mockReturnValue("\n");
    expect(getFirstPaneId("garden-dashboard:main")).toBeNull();
  });

  it("returns null on failure", () => {
    mockExecFileSync.mockImplementation(() => { throw new Error("no target"); });
    expect(getFirstPaneId("garden-dashboard:main")).toBeNull();
  });
});

// ===========================================================================
// renameWindow — fire-and-forget with log on failure
// ===========================================================================

describe("renameWindow", () => {
  it("calls tmux rename-window with session-qualified targets", () => {
    mockExecFileSync.mockReturnValue(undefined);
    renameWindow("old-name", "new-name");
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "tmux",
      ["rename-window", "-t", "garden-dashboard:old-name", "new-name"],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
  });

  it("logs debug on failure", () => {
    mockExecFileSync.mockImplementation(() => { throw new Error("fail"); });
    renameWindow("old", "new");
    expect(log.debug).toHaveBeenCalledWith("tmux", "renameWindow failed", { data: { oldName: "old", newName: "new" } });
  });
});

// ===========================================================================
// resizeWindow — silent on failure
// ===========================================================================

describe("resizeWindow", () => {
  it("calls tmux resize-window with correct args", () => {
    mockExecFileSync.mockReturnValue(undefined);
    resizeWindow("_garden-worker-bold-ash", 120, 40);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "tmux",
      ["resize-window", "-t", "garden-dashboard:_garden-worker-bold-ash", "-x", "120", "-y", "40"],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
  });

  it("swallows error when window does not exist", () => {
    mockExecFileSync.mockImplementation(() => { throw new Error("no window"); });
    expect(() => resizeWindow("missing", 100, 50)).not.toThrow();
  });
});

// ===========================================================================
// killWindowSafe — silent on failure
// ===========================================================================

describe("killWindowSafe", () => {
  it("kills the matching window by index", () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) =>
      args[0] === "list-windows" ? "1 main\n2 _garden-worker-bold-ash\n" : "");
    killWindowSafe("_garden-worker-bold-ash");
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "tmux",
      ["kill-window", "-t", "garden-dashboard:2"],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
  });

  // Regression: stopProjectPoller relies on killWindowSafe to remove a
  // project's poller. A name-targeted kill is ambiguous (kills nothing) once
  // duplicates exist, so a duplicate pair would persist across restarts.
  // Killing every matching index removes all copies, self-healing the pair.
  it("kills every window when the name is duplicated", () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) =>
      args[0] === "list-windows" ? "5 _wolf-poller\n6 _wolf-poller\n7 _wolf-poller\n" : "");
    killWindowSafe("_wolf-poller");
    const killCalls = mockExecFileSync.mock.calls.filter(
      (c) => Array.isArray(c[1]) && (c[1] as string[])[0] === "kill-window",
    );
    expect(killCalls.map((c) => (c[1] as string[])[2])).toEqual([
      "garden-dashboard:5", "garden-dashboard:6", "garden-dashboard:7",
    ]);
  });

  it("does nothing when no window matches", () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) =>
      args[0] === "list-windows" ? "1 main\n" : "");
    killWindowSafe("missing");
    const killCalls = mockExecFileSync.mock.calls.filter(
      (c) => Array.isArray(c[1]) && (c[1] as string[])[0] === "kill-window",
    );
    expect(killCalls).toHaveLength(0);
  });

  it("swallows error silently", () => {
    mockExecFileSync.mockImplementation(() => { throw new Error("no server"); });
    expect(() => killWindowSafe("missing")).not.toThrow();
  });
});

// ===========================================================================
// getPanePid
// ===========================================================================

describe("getPanePid", () => {
  it("returns pid string on success", () => {
    mockExecFileSync.mockReturnValue("12345\n");
    expect(getPanePid("%5")).toBe("12345");
  });

  it("returns null on failure", () => {
    mockExecFileSync.mockImplementation(() => { throw new Error("fail"); });
    expect(getPanePid("%5")).toBeNull();
  });
});

// ===========================================================================
// paneRunningOnlyShell — negative pane-liveness probe (tty → ps comm=)
// ===========================================================================

describe("paneRunningOnlyShell", () => {
  // Wire pane_tty (via tmuxOutput → execFileSync "tmux") and the `ps -t` comm
  // listing (execFileSync "ps") through the single mocked execFileSync. Dispatch
  // on the binary so each test controls the two probes independently.
  function wire(tty: string, ps: string | (() => never)): void {
    mockExecFileSync.mockImplementation((cmd: string) => {
      if (cmd === "tmux") return `${tty}\n`;
      if (cmd === "ps") return typeof ps === "function" ? ps() : ps;
      return "";
    });
  }

  it("returns true when every process on the tty is a login shell (agent exited)", () => {
    // A clean Claude exit exec-replaces its node process with the login shell,
    // which macOS `comm=` renders with a leading dash and a path.
    wire("/dev/ttys003", "/bin/-zsh\n");
    expect(paneRunningOnlyShell("%9")).toBe(true);
  });

  it("recognizes multiple bare shells (bash + zsh, no path) as all-shells", () => {
    wire("/dev/ttys003", "-zsh\nbash\n");
    expect(paneRunningOnlyShell("%9")).toBe(true);
  });

  it("returns false when the agent process (node) is still on the tty — the never-wrongly-flag invariant", () => {
    // A LIVE worker always carries `node` (claude, or an npm install) alongside
    // the shell wrapper, so it is never all-shells and auto-continue is never
    // wrongly blocked.
    wire("/dev/ttys003", "node\n-zsh\n");
    expect(paneRunningOnlyShell("%9")).toBe(false);
  });

  it("returns false when a non-shell foreground process is present", () => {
    wire("/dev/ttys003", "vim\n-zsh\n");
    expect(paneRunningOnlyShell("%9")).toBe(false);
  });

  it("fails open (false) when the tty probe throws", () => {
    mockExecFileSync.mockImplementation((cmd: string) => {
      if (cmd === "tmux") throw new Error("no such pane");
      return "";
    });
    expect(paneRunningOnlyShell("%9")).toBe(false);
  });

  it("fails open (false) when ps throws", () => {
    wire("/dev/ttys003", () => { throw new Error("ps failed"); });
    expect(paneRunningOnlyShell("%9")).toBe(false);
  });

  it("fails open (false) on empty ps output", () => {
    wire("/dev/ttys003", "\n");
    expect(paneRunningOnlyShell("%9")).toBe(false);
  });

  it("fails open (false) when pane_tty is blank", () => {
    wire("", "-zsh\n");
    expect(paneRunningOnlyShell("%9")).toBe(false);
    // The ps probe is never reached once the tty resolves empty.
    expect(mockExecFileSync).not.toHaveBeenCalledWith("ps", expect.anything(), expect.anything());
  });
});

// ===========================================================================
// getPaneLabel
// ===========================================================================

describe("getPaneLabel", () => {
  it("returns label string on success", () => {
    mockExecFileSync.mockReturnValue("bold-ash\n");
    expect(getPaneLabel("%5")).toBe("bold-ash");
  });

  it("returns null for empty label", () => {
    mockExecFileSync.mockReturnValue("\n");
    expect(getPaneLabel("%5")).toBeNull();
  });

  it("returns null on failure", () => {
    mockExecFileSync.mockImplementation(() => { throw new Error("fail"); });
    expect(getPaneLabel("%5")).toBeNull();
  });
});

// ===========================================================================
// listAllWindowNames
// ===========================================================================

// ===========================================================================
// pasteAndSubmit — buffer-based delivery path
// ===========================================================================

describe("pasteAndSubmit", () => {
  // pasteAndSubmit returns synchronously after load-buffer + paste-buffer;
  // two Enter keystrokes fire on setTimeouts at 300ms and 1500ms (the second
  // is the cold-respawn safety net for an Enter absorbed into the paste burst).
  // Use fake timers so tests can advance to the Enters without real wallclock
  // waits, and so tests that don't care about Enter aren't tripped by a stray
  // timer.
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads message via stdin into a tmux buffer, never via argv", () => {
    const calls: { argv: string[]; opts: Record<string, unknown> }[] = [];
    mockExecFileSync.mockImplementation((_cmd: string, argv: string[], opts: Record<string, unknown>) => {
      calls.push({ argv, opts });
      return undefined;
    });

    // 60KB message — far over the silent-fail threshold from the wild-dull-beech
    // incident (~14KB). With send-keys -l the message would land in argv;
    // load-buffer reads from stdin so argv stays bounded.
    const message = "x".repeat(60_000);
    pasteAndSubmit("%42", message);

    const loadBufferCall = calls.find(c => c.argv[0] === "load-buffer");
    expect(loadBufferCall).toBeDefined();
    expect(loadBufferCall!.argv).toEqual(["load-buffer", "-b", expect.stringMatching(/^garden-paste-/), "-"]);
    // Critical regression assertion: the message goes through stdin,
    // not as a positional argv entry.
    expect(loadBufferCall!.opts.input).toBe(message);
    expect(loadBufferCall!.argv).not.toContain(message);

    // load-buffer name must match paste-buffer name (and -d flag deletes
    // the buffer after paste so it doesn't accumulate).
    const pasteCall = calls.find(c => c.argv[0] === "paste-buffer");
    expect(pasteCall).toBeDefined();
    const bufferName = loadBufferCall!.argv[2];
    expect(pasteCall!.argv).toEqual(["paste-buffer", "-d", "-b", bufferName, "-t", "%42"]);

    // Before the 300ms gap elapses, Enter has NOT been sent. The function
    // returns immediately after the paste so the caller's stack doesn't
    // block on a synchronous sleep.
    expect(calls.find(c => c.argv[0] === "send-keys")).toBeUndefined();

    // After the 300ms paste-detection gap, the first Enter fires.
    vi.advanceTimersByTime(300);
    const enterCalls = () => calls.filter(c => c.argv[0] === "send-keys" && c.argv.includes("Enter"));
    expect(enterCalls()).toHaveLength(1);
    expect(enterCalls()[0].argv).toEqual(["send-keys", "-t", "%42", "Enter"]);

    // A confirming Enter fires at 1500ms — the cold-respawn safety net. If the
    // first Enter was absorbed into the paste burst (status hook reported the
    // pane ready before its TUI bound paste-detection), this one submits the
    // buffered prompt once the TUI has settled.
    vi.advanceTimersByTime(1200);
    expect(enterCalls()).toHaveLength(2);
    expect(enterCalls()[1].argv).toEqual(["send-keys", "-t", "%42", "Enter"]);
  });

  it("uses unique buffer names so concurrent sends do not collide", () => {
    const bufferNames: string[] = [];
    mockExecFileSync.mockImplementation((_cmd: string, argv: string[]) => {
      if (argv[0] === "load-buffer") bufferNames.push(argv[2]);
      return undefined;
    });

    pasteAndSubmit("%1", "msg-1");
    pasteAndSubmit("%2", "msg-2");

    expect(bufferNames.length).toBe(2);
    expect(bufferNames[0]).not.toBe(bufferNames[1]);
  });

  it("surfaces tmux stderr when load-buffer fails", () => {
    mockExecFileSync.mockImplementation((_cmd: string, argv: string[]) => {
      if (argv[0] === "load-buffer") {
        const err = new Error("Command failed") as Error & { stderr?: Buffer };
        err.stderr = Buffer.from("no server running");
        throw err;
      }
      return undefined;
    });
    expect(() => pasteAndSubmit("%5", "hi")).toThrow(/load-buffer failed: no server running/);
  });

  it("deletes the buffer when paste-buffer fails so buffers do not leak", () => {
    const argvSeen: string[][] = [];
    mockExecFileSync.mockImplementation((_cmd: string, argv: string[]) => {
      argvSeen.push(argv);
      if (argv[0] === "paste-buffer") {
        throw new Error("pane gone");
      }
      return undefined;
    });
    expect(() => pasteAndSubmit("%5", "hi")).toThrow(/paste-buffer failed/);
    const deleteCall = argvSeen.find(a => a[0] === "delete-buffer");
    expect(deleteCall).toBeDefined();
  });

  it("swallows send-keys failure when the pane is gone by the time Enter fires", () => {
    const argvSeen: string[][] = [];
    mockExecFileSync.mockImplementation((_cmd: string, argv: string[]) => {
      argvSeen.push(argv);
      if (argv[0] === "send-keys") throw new Error("pane gone");
      return undefined;
    });

    // load-buffer + paste-buffer succeed; pasteAndSubmit returns cleanly.
    expect(() => pasteAndSubmit("%5", "hi")).not.toThrow();
    // Advancing past the 300ms gap fires the deferred Enter, which throws
    // internally — it must be swallowed (the pane may have been killed
    // between paste and Enter; caller doesn't wait for confirmation).
    expect(() => vi.advanceTimersByTime(300)).not.toThrow();
    expect(argvSeen.find(a => a[0] === "send-keys")).toBeDefined();
  });
});

describe("listAllWindowNames", () => {
  it("returns array of window names", () => {
    mockExecFileSync.mockReturnValue("main\n_garden-worker-bold-ash\n_garden-shell\n");
    const result = listAllWindowNames();
    expect(result).toEqual(["main", "_garden-worker-bold-ash", "_garden-shell"]);
  });

  it("returns empty array on failure", () => {
    mockExecFileSync.mockImplementation(() => { throw new Error("no session"); });
    expect(listAllWindowNames()).toEqual([]);
  });

  it("filters empty strings from output", () => {
    mockExecFileSync.mockReturnValue("main\n\n_garden-shell\n\n");
    expect(listAllWindowNames()).toEqual(["main", "_garden-shell"]);
  });
});

// ===========================================================================
// cleanPaneTitle / listSessionPaneTitles — batched pane-title enumeration
// ===========================================================================

describe("cleanPaneTitle", () => {
  it("strips Claude's leading non-alphanumeric prefix and trims whitespace", () => {
    expect(cleanPaneTitle("✱ Refactoring auth module ")).toBe("Refactoring auth module");
    expect(cleanPaneTitle("⠋ Building tests")).toBe("Building tests");
  });

  it("returns null for null/undefined/empty input", () => {
    expect(cleanPaneTitle(null)).toBeNull();
    expect(cleanPaneTitle(undefined)).toBeNull();
    expect(cleanPaneTitle("")).toBeNull();
  });

  it("returns null for the Claude Code placeholder and pure-noise titles", () => {
    expect(cleanPaneTitle("Claude Code")).toBeNull();
    expect(cleanPaneTitle("✱ ")).toBeNull();
  });

  it("returns null when the cleaned title equals the system hostname", () => {
    expect(cleanPaneTitle("my-macbook.local")).toBeNull();
  });

  it("strips embedded terminal escape sequences", () => {
    // A title carrying a cursor-move / color escape must not reach the pane raw.
    expect(cleanPaneTitle("Building \x1b[2Jtests\x1b[0m")).toBe("Building tests");
    expect(cleanPaneTitle("\x1b]0;evil title\x07real")).toBe("real");
  });
  it("returns alphanumeric titles as-is", () => {
    expect(cleanPaneTitle("Writing unit tests")).toBe("Writing unit tests");
  });
});

describe("stripControlSequences", () => {
  it("removes CSI, OSC, and C0/C1 control chars but keeps tab/newline", () => {
    expect(stripControlSequences("a\x1b[31mred\x1b[0mb")).toBe("aredb");
    expect(stripControlSequences("t\x1b]0;title\x07x")).toBe("tx");
    expect(stripControlSequences("keep\ttab\nnewline")).toBe("keep\ttab\nnewline");
    expect(stripControlSequences("bell\x07del\x7f")).toBe("belldel");
    expect(stripControlSequences("plain text")).toBe("plain text");
  });

  it("strips carriage return (cursor-to-column-0) while keeping tab and newline", () => {
    // \r repositions the cursor to column 0 and overwrites the rendered line —
    // the exact vector this function exists to defeat — so it must not survive.
    expect(stripControlSequences("a\rb")).toBe("ab");
    expect(stripControlSequences("done\r\nnext")).toBe("done\nnext");
  });

  it("strips private-param CSI (hide cursor / alternate screen takeover)", () => {
    expect(stripControlSequences("a\x1b[?25lb")).toBe("ab");
    expect(stripControlSequences("a\x1b[?1049hb")).toBe("ab");
  });

  it("strips OSC terminated by ST and left unterminated to end-of-string", () => {
    expect(stripControlSequences("a\x1b]8;;https://x\x1b\\b")).toBe("ab"); // ST terminator
    expect(stripControlSequences("safe\x1b]0;evil")).toBe("safe");        // unterminated
  });

  it("strips a bare Fe escape and an 8-bit C1 control introducer", () => {
    expect(stripControlSequences("a\x1bMb")).toBe("ab"); // reverse index (Fe escape)
    expect(stripControlSequences("a\x9bb")).toBe("ab");  // C1 CSI introducer
  });
});

describe("listSessionPaneTitles", () => {
  it("parses tab-separated window/pane/title triples", () => {
    mockExecFileSync.mockReturnValue(
      "main\t%0\tinitial pane\n"
      + "_garden-worker-bold-ash\t%5\t✱ Fixing the leak\n"
      + "_garden-shell\t%9\tzsh\n",
    );
    expect(listSessionPaneTitles()).toEqual([
      { windowName: "main", paneId: "%0", rawTitle: "initial pane" },
      { windowName: "_garden-worker-bold-ash", paneId: "%5", rawTitle: "✱ Fixing the leak" },
      { windowName: "_garden-shell", paneId: "%9", rawTitle: "zsh" },
    ]);
  });

  it("rejoins tail tokens past the third one (defensive against tabs in titles)", () => {
    mockExecFileSync.mockReturnValue("main\t%0\ttitle\twith\ttabs\n");
    const result = listSessionPaneTitles();
    expect(result).toHaveLength(1);
    expect(result[0].rawTitle).toBe("title\twith\ttabs");
  });

  it("skips lines with fewer than three fields", () => {
    mockExecFileSync.mockReturnValue("main\t%0\nshorty\n_garden-shell\t%9\tok\n");
    expect(listSessionPaneTitles()).toEqual([
      { windowName: "_garden-shell", paneId: "%9", rawTitle: "ok" },
    ]);
  });

  it("returns empty array when tmux throws (no session)", () => {
    mockExecFileSync.mockImplementation(() => { throw new Error("no server"); });
    expect(listSessionPaneTitles()).toEqual([]);
  });
});

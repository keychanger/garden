import { describe, it, expect, vi, beforeEach } from "vitest";

const execFileSyncMock = vi.fn();
vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
}));

vi.mock("../src/dashboard/tmux.js", () => ({
  tmux: vi.fn(),
  shellEscape: (s: string) => /^[a-zA-Z0-9_./:=-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`,
  tmuxDoubleQuote: (s: string) => `"${s.replace(/[\\$"`]/g, "\\$&")}"`,
}));

import { setupKeybindings, tmuxKeyName } from "../src/dashboard/hotkeys.js";
import { DASHBOARD_HOTKEYS } from "../src/dashboard/keybindings.js";

beforeEach(() => {
  vi.clearAllMocks();
  execFileSyncMock.mockReturnValue("");
});

describe("setupKeybindings", () => {
  it("never passes a bare ';' as its own argv to tmux bind-key", () => {
    // Tmux's command parser treats argv[i] === ";" as a top-level command
    // separator, splitting one execFileSync into multiple tmux commands.
    // When that happened in the copy-mode bind-key call, the second command
    // (`run-shell <guarded>`) fired immediately at setup time — once per
    // keybinding per copy-mode table — dispatching every dashboard hotkey
    // (including _workflow-picker) every time setupKeybindings ran. The
    // user-visible bug was a picker popup and chaotic pane state after
    // each garden post-merge rebuild.
    setupKeybindings("/path/to/garden");
    for (const call of execFileSyncMock.mock.calls) {
      const argv = call[1] as string[];
      if (!Array.isArray(argv)) continue;
      expect(argv).not.toContain(";");
    }
  });

  it("unbinds the retired M-c key from the root and copy-mode tables", () => {
    // ⌥c was the old conversation/history binding (now ⌥h). tmux bindings are
    // server-global, so without an explicit unbind the stale M-c lingers and
    // fires the removed `_focus-conversation` command (exit 1).
    setupKeybindings("/path/to/garden");
    const unbinds = execFileSyncMock.mock.calls
      .map(call => call[1] as string[])
      .filter(argv => Array.isArray(argv) && argv[0] === "unbind-key" && argv.at(-1) === "M-c");
    const tables = unbinds.map(argv => (argv[1] === "-n" ? "root" : argv[2]));
    expect(tables).toContain("root");
    expect(tables).toContain("copy-mode");
    expect(tables).toContain("copy-mode-vi");
  });

  it("no longer binds M-c to anything", () => {
    setupKeybindings("/path/to/garden");
    const mcBinds = execFileSyncMock.mock.calls
      .map(call => call[1] as string[])
      .filter(argv => Array.isArray(argv) && argv[0] === "bind-key" && argv.includes("M-c"));
    expect(mcBinds.length).toBe(0);
  });

  it("binds copy-mode M-N as a single command body so the picker only fires on keypress", () => {
    setupKeybindings("/path/to/garden");
    const copyModeBinds = execFileSyncMock.mock.calls.filter((call) => {
      const argv = call[1] as string[];
      return Array.isArray(argv)
        && argv[0] === "bind-key"
        && argv[1] === "-T"
        && (argv[2] === "copy-mode" || argv[2] === "copy-mode-vi")
        && argv[3] === "M-N";
    });
    expect(copyModeBinds.length).toBe(2);
    for (const call of copyModeBinds) {
      const argv = call[1] as string[];
      // After the key, bind-key should receive exactly one body argv.
      expect(argv.length).toBe(5);
      const body = argv[4];
      expect(body).toContain("send-keys -X cancel");
      expect(body).toContain("run-shell -b");
      // M-N now opens the workflow picker (default / trellis / grow).
      // The trellis picker is reachable via the (t) row, not the top-level
      // hotkey. See trellis-picker.ts buildWorkflowPickerPlan.
      expect(body).toContain("_workflow-picker");
      expect(body).not.toContain("_trellis-picker");
    }
  });

  it("registers the workflow picker on the root M-N table (no copy-mode side-firing)", () => {
    setupKeybindings("/path/to/garden");
    const rootBind = execFileSyncMock.mock.calls.find((call) => {
      const argv = call[1] as string[];
      return Array.isArray(argv)
        && argv[0] === "bind-key"
        && argv[1] === "-n"
        && argv[2] === "M-N";
    });
    expect(rootBind).toBeDefined();
    const argv = rootBind![1] as string[];
    expect(argv).toContain("run-shell");
    expect(argv.join(" ")).toContain("_workflow-picker");
    expect(argv.join(" ")).not.toContain("_trellis-picker");
  });

  it("backgrounds root hotkey handlers with run-shell -b so keystroke bursts don't queue", () => {
    // Without -b, run-shell blocks tmux's command queue until the handler
    // process exits (node start + full repaint), so a burst of nav keystrokes
    // serialized one-behind-another. The -b must sit immediately after
    // run-shell (it is a run-shell flag, not part of the shell command).
    setupKeybindings("/path/to/garden");
    const rootBinds = execFileSyncMock.mock.calls
      .map(call => call[1] as string[])
      .filter(argv =>
        Array.isArray(argv) && argv[0] === "bind-key" && argv[1] === "-n" && argv[2]?.startsWith("M-"));
    expect(rootBinds.length).toBeGreaterThan(0);
    for (const argv of rootBinds) {
      const runShellIdx = argv.indexOf("run-shell");
      expect(runShellIdx).toBeGreaterThanOrEqual(0);
      expect(argv[runShellIdx + 1]).toBe("-b");
    }
  });

  it("rebinds mouse selection to copy without cancelling copy-mode", () => {
    // tmux's default MouseDragEnd / Double / TripleClick bindings end in
    // copy-pipe-and-cancel, which exits copy-mode on mouse release and snaps a
    // scrolled-up pane back to the live screen — the operator loses their scroll
    // position the moment they finish highlighting text. The fix rebinds all
    // three selection-ending events to copy-pipe-no-clear in both copy-mode
    // tables so the copy still happens but the scroll offset is preserved.
    setupKeybindings("/path/to/garden");
    for (const table of ["copy-mode", "copy-mode-vi"]) {
      for (const event of ["MouseDragEnd1Pane", "DoubleClick1Pane", "TripleClick1Pane"]) {
        const bind = execFileSyncMock.mock.calls.find((call) => {
          const argv = call[1] as string[];
          return Array.isArray(argv)
            && argv[0] === "bind-key"
            && argv[1] === "-T"
            && argv[2] === table
            && argv[3] === event;
        });
        expect(bind, `${table} ${event} should be bound`).toBeDefined();
        const argv = bind![1] as string[];
        // The bound command body is a single trailing argv string (a bare ";"
        // argv would be a top-level command separator).
        expect(argv.length).toBe(5);
        const body = argv[4];
        expect(body).toContain("copy-pipe-no-clear");
        expect(body).not.toContain("and-cancel");
      }
    }
  });

  it("clears the selection on a plain click so the lingering highlight can be dismissed", () => {
    // copy-pipe-no-clear leaves the selection highlighted after a drag. Without
    // clearing it on a plain click, the highlight lingers with no way to dismiss
    // it by clicking elsewhere. MouseDown1Pane fires before MouseDrag1Pane's
    // begin-selection, so this stays compatible with starting a fresh drag.
    setupKeybindings("/path/to/garden");
    for (const table of ["copy-mode", "copy-mode-vi"]) {
      const bind = execFileSyncMock.mock.calls.find((call) => {
        const argv = call[1] as string[];
        return Array.isArray(argv)
          && argv[0] === "bind-key"
          && argv[1] === "-T"
          && argv[2] === table
          && argv[3] === "MouseDown1Pane";
      });
      expect(bind, `${table} MouseDown1Pane should be bound`).toBeDefined();
      const argv = bind![1] as string[];
      expect(argv.length).toBe(5);
      const body = argv[4];
      expect(body).toContain("select-pane");
      expect(body).toContain("clear-selection");
    }
  });

  it("binds M-d to the diary view on the root table", () => {
    setupKeybindings("/path/to/garden");
    const rootBind = execFileSyncMock.mock.calls.find((call) => {
      const argv = call[1] as string[];
      return Array.isArray(argv)
        && argv[0] === "bind-key"
        && argv[1] === "-n"
        && argv[2] === "M-d";
    });
    expect(rootBind).toBeDefined();
    const argv = rootBind![1] as string[];
    expect(argv).toContain("run-shell");
    expect(argv.join(" ")).toContain("_focus-diary");
  });

  it("binds every DASHBOARD_HOTKEYS entry on the root table with its command", () => {
    // The refactor's anti-drift guarantee has two sides: keybindings.test.ts
    // proves the table drives `garden keys` (docs), and this proves the same
    // table drives the tmux bindings. Without it, a future edit to the bind loop
    // (a stray filter, a dropped category) could unbind a documented key with no
    // failing test.
    setupKeybindings("/path/to/garden");
    const rootBinds = execFileSyncMock.mock.calls
      .map(call => call[1] as string[])
      .filter(argv =>
        Array.isArray(argv) && argv[0] === "bind-key" && argv[1] === "-n" && argv[2]?.startsWith("M-"));
    for (const b of DASHBOARD_HOTKEYS) {
      // The bind target escapes tmux-special keys (`;` → `\;`), so mirror the
      // code's transform rather than the raw table key.
      const bind = rootBinds.find(argv => argv[2] === `M-${tmuxKeyName(b.key)}`);
      expect(bind, `⌥${b.key} should be bound on the root table`).toBeDefined();
      // The guarded run-shell body carries the dashboard subcommand, or the
      // literal command when the row is `raw`.
      const body = bind!.join(" ");
      expect(body).toContain(b.raw ? b.command : `dashboard ${b.command}`);
    }
  });
});

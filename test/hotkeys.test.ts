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

import { setupKeybindings } from "../src/dashboard/hotkeys.js";

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
      expect(body).toContain("run-shell");
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
});

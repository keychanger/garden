// The pane-title-changed hook is a session hook, which tmux 3.7c runs only for
// the panes of the session's current window (`main`); each run cold-starts the CLI,
// so installTitleChangedHook filters in tmux first. This installs the real hook
// on an isolated server, changes titles the way agents do (an OSC 2 escape
// from the pane's own process), and checks which panes reached the runner, and
// that the nested run-shell still expands the window name and pane id of the
// pane whose title changed. A control run with the filter removed shows what
// tmux itself delivers, so the filtered run's single line is the filter's work.
import { describe, it, expect, vi } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

vi.mock("../../src/dashboard/tmux.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/dashboard/tmux.js")>(),
  tmux: vi.fn(),
}));

import { tmux, shellEscape } from "../../src/dashboard/tmux.js";
import { installTitleChangedHook } from "../../src/dashboard/create.js";

// An OS sandbox denies the tmux server socket; skip rather than hard-fail there.
// See menu-dispatch.real.test.ts, including why the socket file is unlinked.
function tmuxServerAvailable(): boolean {
  const probeSock = `garden-title-probe-${process.pid}`;
  const probe = spawnSync("tmux", ["-L", probeSock, "new-session", "-d", "-x", "80", "-y", "24"], { encoding: "utf8" });
  const ok = spawnSync("tmux", ["-L", probeSock, "list-sessions"], { encoding: "utf8" }).status === 0;
  spawnSync("tmux", ["-L", probeSock, "kill-server"], { encoding: "utf8" });
  const dir = process.env.TMUX_TMPDIR || "/tmp";
  fs.rmSync(path.join(dir, `tmux-${process.getuid?.() ?? 0}`, probeSock), { force: true });
  return probe.status === 0 && ok;
}

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

describe.skipIf(!tmuxServerAvailable())("pane-title-changed hook filter (real tmux server)", () => {
  it("runs the CLI only for the right slot of main", () => {
    // Short: the socket path must fit the 104-byte AF_UNIX limit.
    const dir = fs.mkdtempSync(path.join("/tmp", "gt-"));
    const socket = path.join(dir, "s");
    const log = path.join(dir, "fired");
    const t = (...args: string[]) => spawnSync("tmux", ["-S", socket, "-f", "/dev/null", ...args], { encoding: "utf8" });
    const paneOf = (...args: string[]) => {
      const r = t(...args, "-P", "-F", "#{pane_id}", "sleep 60");
      expect(r.status, r.stderr).toBe(0);
      return r.stdout.trim();
    };
    try {
      expect(t("new-session", "-d", "-s", "garden-dashboard", "-n", "main", "-x", "200", "-y", "50", "sleep 60").status).toBe(0);
      const left = t("display-message", "-p", "-t", "garden-dashboard:main.0", "#{pane_id}").stdout.trim();
      const right = paneOf("split-window", "-h", "-d", "-t", "garden-dashboard:main");
      const worker = paneOf("new-window", "-d", "-n", "_proj-worker-bold-ash", "-t", "garden-dashboard:");
      const view = paneOf("new-window", "-d", "-n", "_garden-logs", "-t", "garden-dashboard:");

      // Stand-in for the CLI: records the window name and pane id it was given.
      fs.writeFileSync(path.join(dir, "runner.sh"), `printf '%s %s\\n' "$3" "$4" >> ${shellEscape(log)}\n`);
      installTitleChangedHook(`/bin/sh ${shellEscape(path.join(dir, "runner.sh"))}`);
      const hook = vi.mocked(tmux).mock.calls.find(c => c[0] === "set-hook" && c[3] === "pane-title-changed");
      expect(hook).toBeDefined();
      const set = t(...hook!);
      expect(set.status, set.stderr).toBe(0);

      const retitleAll = (round: string) => {
        for (const [pane, title] of [[left, "left"], [right, "right"], [worker, "worker"], [view, "view"]]) {
          const r = t("respawn-pane", "-k", "-t", pane, `printf '\\033]2;${round}-${title}\\033\\\\'; sleep 60`);
          expect(r.status, r.stderr).toBe(0);
        }
      };
      const read = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
      const settle = (lines: number) => {
        for (let waited = 0; read().length < lines && waited < 5000; waited += 50) pause(50);
        pause(500); // let an event that slipped through land, so it is seen
      };

      retitleAll("filtered");
      settle(1);
      expect(read()).toEqual([`main ${right}`]);

      // Control: the same hook without the filter. tmux delivers the left pane
      // too (3.7c delivers exactly main's two panes; CI's older tmux may also
      // deliver the parked windows), so the filter is what dropped it above.
      fs.rmSync(log, { force: true });
      const unfiltered = /^if-shell -F "(?:[^"\\]|\\.)*" "((?:[^"\\]|\\.)*)"$/.exec(hook![4]);
      expect(unfiltered).not.toBeNull();
      const control = t("set-hook", "-t", "garden-dashboard", "pane-title-changed", unfiltered![1].replace(/\\(.)/g, "$1"));
      expect(control.status, control.stderr).toBe(0);
      retitleAll("control");
      settle(2);
      expect(read()).toEqual(expect.arrayContaining([`main ${left}`, `main ${right}`]));
    } finally {
      t("kill-server");
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

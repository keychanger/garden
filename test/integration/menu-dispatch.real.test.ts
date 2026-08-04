// Regression for the crew-picker dispatch bug: a tmux display-menu (or key
// binding) runs each item's command through tmux's COMMAND parser, not the
// shell. A bare `<node> <cli.js> dashboard _crew-set …` therefore fails with
// "unknown command: <node>" and the crew silently never changes. menuRunShell
// wraps it in `run-shell` so tmux hands the whole string to /bin/sh.
//
// This exercises the real tmux command parser — the layer a string assertion
// on the generated command cannot reach (which is why the original bug shipped
// under a green unit test).
import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { menuRunShell } from "../../src/dashboard/tmux.js";

const SOCK = `garden-menu-dispatch-${process.pid}`;
const tmux = (...args: string[]) => spawnSync("tmux", ["-L", SOCK, ...args], { encoding: "utf8" });

// `tmux kill-server` stops the server but does NOT unlink its AF_UNIX socket,
// and the name is pid-stamped so every run picks a fresh one. Left alone that
// is one dead socket file per test run, forever: 511 had accumulated in
// /tmp/tmux-501 on the operator's workstation (393 from the dispatch server,
// 118 from the availability probe below) before anyone noticed. Removing the
// file is the only way to reclaim it — tmux has no flag that does it.
function killServerAndUnlinkSocket(sock: string): void {
  spawnSync("tmux", ["-L", sock, "kill-server"], { encoding: "utf8" });
  const dir = process.env.TMUX_TMPDIR || "/tmp";
  fs.rmSync(path.join(dir, `tmux-${process.getuid?.() ?? 0}`, sock), { force: true });
}

// A tmux server needs to bind an AF_UNIX socket, which an OS sandbox (garden's
// workers and reviewers run `garden checks` inside one) denies at the syscall
// level — new-session fails with "error creating <socket> (Operation not
// permitted)". There is no server-less way to exercise tmux's real command
// parser, so skip this test when a server can't start rather than hard-fail the
// whole check run; CI and any unsandboxed shell still run it.
function tmuxServerAvailable(): boolean {
  const probeSock = `garden-menu-probe-${process.pid}`;
  const probe = spawnSync("tmux", ["-L", probeSock, "new-session", "-d", "-x", "80", "-y", "24"], { encoding: "utf8" });
  const ok = spawnSync("tmux", ["-L", probeSock, "list-sessions"], { encoding: "utf8" }).status === 0;
  killServerAndUnlinkSocket(probeSock);
  return probe.status === 0 && ok;
}

afterAll(() => { killServerAndUnlinkSocket(SOCK); });

describe.skipIf(!tmuxServerAvailable())("tmux menu command dispatch (real tmux)", () => {
  it("rejects a bare command (the bug) but runs a menuRunShell-wrapped one", () => {
    tmux("new-session", "-d", "-x", "80", "-y", "24");

    // Bare: tmux parses the first token as a command name -> unknown command.
    // /bin/echo exists everywhere; the point is it is not a tmux command.
    const bare = tmux("/bin/echo", "hi");
    expect(`${bare.stderr}${bare.stdout}`.toLowerCase()).toContain("unknown command");

    // Wrapped: tmux's `run-shell` hands the command to the shell. Prove it
    // actually executes by writing a marker. run-shell (no -b) is synchronous.
    const marker = path.join(os.tmpdir(), `garden-menu-marker-${process.pid}-${Date.now()}`);
    const wrapped = menuRunShell(`printf ok > ${marker}`);
    expect(wrapped.startsWith("run-shell ")).toBe(true);
    // Pass the wrapped command as tmux argv (run-shell + its single arg), which
    // is how tmux's parser resolves the quoted string a menu item stores.
    tmux("run-shell", `printf ok > ${marker}`);

    let wrote = false;
    for (let i = 0; i < 20 && !wrote; i++) {
      try { wrote = fs.readFileSync(marker, "utf8") === "ok"; } catch { /* not yet */ }
      if (!wrote) spawnSync("sleep", ["0.05"]);
    }
    fs.rmSync(marker, { force: true });
    expect(wrote).toBe(true);
  });
});

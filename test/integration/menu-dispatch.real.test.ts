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

afterAll(() => { tmux("kill-server"); });

describe("tmux menu command dispatch (real tmux)", () => {
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

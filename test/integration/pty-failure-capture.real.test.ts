import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { defaultRunner, probeThrowawayServer } from "../../src/dashboard/pty-failure-capture.js";

// An OS sandbox denies the tmux server socket; skip rather than hard-fail there.
// See menu-dispatch.real.test.ts, including why the socket file is unlinked.
const socketDir = path.join(process.env.TMUX_TMPDIR || "/tmp", `tmux-${process.getuid?.() ?? 0}`);

function tmuxServerAvailable(): boolean {
  const probeSock = `garden-capture-probe-${process.pid}`;
  const probe = spawnSync("tmux", ["-L", probeSock, "new-session", "-d"], { encoding: "utf8" });
  const ok = spawnSync("tmux", ["-L", probeSock, "list-sessions"], { encoding: "utf8" }).status === 0;
  spawnSync("tmux", ["-L", probeSock, "kill-server"], { encoding: "utf8" });
  fs.rmSync(path.join(socketDir, probeSock), { force: true });
  return probe.status === 0 && ok;
}

describe.skipIf(!tmuxServerAvailable())("throwaway tmux server probe (real tmux)", () => {
  it("creates and respawns a pane on its own server, then removes the server and its socket", () => {
    expect(probeThrowawayServer(defaultRunner)).toBe("new-session ok; respawn-pane ok");
    const sock = `garden-probe-${process.pid}`;
    expect(spawnSync("tmux", ["-L", sock, "list-sessions"], { encoding: "utf8" }).status).not.toBe(0);
    expect(fs.existsSync(path.join(socketDir, sock))).toBe(false);
  });
});

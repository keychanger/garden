import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { defaultRunner, describeRun, probeThrowawayServer } from "../../src/dashboard/pty-failure-capture.js";

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
  // A short parent keeps the probe's socket under the unix-socket path limit,
  // which the throwaway HOME the suite runs under would exceed.
  let parent: string;
  beforeEach(() => {
    parent = fs.mkdtempSync("/tmp/gp-");
  });
  afterEach(() => {
    fs.rmSync(parent, { recursive: true, force: true });
  });

  it("creates and respawns a pane on its own server, then removes the server and its socket", () => {
    expect(probeThrowawayServer(defaultRunner, parent)).toBe("new-session ok; respawn-pane ok");
    expect(fs.readdirSync(parent)).toEqual([]);
  });

  // Every worker sandbox can write TMUX_TMPDIR, and tmux follows a link at a
  // socket name there to whichever server the link names.
  it("never reaches a server through a link planted under TMUX_TMPDIR", () => {
    const tmuxTmp = fs.mkdtempSync("/tmp/gv-");
    const env: NodeJS.ProcessEnv = { ...process.env, TMUX_TMPDIR: tmuxTmp };
    delete env.TMUX;
    try {
      const victim = spawnSync("tmux", ["-f", "/dev/null", "new-session", "-d", "-s", "victim", "exec sleep 60"], { env });
      expect(victim.status).toBe(0);
      const victimDir = path.join(tmuxTmp, `tmux-${process.getuid?.() ?? 0}`);
      fs.symlinkSync(path.join(victimDir, "default"), path.join(victimDir, `garden-probe-${process.pid}`));
      vi.stubEnv("TMUX_TMPDIR", tmuxTmp);
      probeThrowawayServer(defaultRunner, parent);
      expect(spawnSync("tmux", ["has-session", "-t", "victim"], { env }).status).toBe(0);
    } finally {
      vi.unstubAllEnvs();
      spawnSync("tmux", ["kill-server"], { env });
      fs.rmSync(tmuxTmp, { recursive: true, force: true });
    }
  });
});

// The capture runs synchronously on the spawn path, so a probe past its
// deadline is killed outright, as the census's commands are: one that ignores
// SIGTERM would otherwise hold the failing spawn until it exits on its own.
describe("probe deadline (real process)", () => {
  it("kills a probe that outlives its deadline even when it ignores SIGTERM", () => {
    const started = Date.now();
    const result = defaultRunner("sh", ["-c", "trap '' TERM; i=0; while [ $i -lt 20 ]; do sleep 1; i=$((i+1)); done"]);
    expect(describeRun(result)).toBe("no result: timed out after 5s");
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);
});

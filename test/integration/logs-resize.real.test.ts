// `garden logs --follow` wraps every row, and sizes every date rule, to the
// pane width at the moment it prints. A pane that narrows afterward (terminal
// resize, column split change) held lines wider than itself, so the terminal
// re-wrapped each date rule's tail onto a line of its own. The follow loop now
// redraws its backlog on resize; this drives a real tmux pane through a resize
// and reads back what it holds, scrollback included.
import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SOCK = `garden-logs-resize-${process.pid}`;
const tmux = (...args: string[]) => spawnSync("tmux", ["-L", SOCK, ...args], { encoding: "utf8" });

// kill-server leaves the socket file behind; see menu-dispatch.real.test.ts.
function killServerAndUnlinkSocket(sock: string): void {
  spawnSync("tmux", ["-L", sock, "kill-server"], { encoding: "utf8" });
  const dir = process.env.TMUX_TMPDIR || "/tmp";
  fs.rmSync(path.join(dir, `tmux-${process.getuid?.() ?? 0}`, sock), { force: true });
}

// An OS sandbox denies the tmux server socket; skip rather than hard-fail there.
function tmuxServerAvailable(): boolean {
  const probeSock = `garden-logs-resize-probe-${process.pid}`;
  const probe = spawnSync("tmux", ["-L", probeSock, "new-session", "-d", "-x", "80", "-y", "24"], { encoding: "utf8" });
  const ok = spawnSync("tmux", ["-L", probeSock, "list-sessions"], { encoding: "utf8" }).status === 0;
  killServerAndUnlinkSocket(probeSock);
  return probe.status === 0 && ok;
}

afterAll(() => { killServerAndUnlinkSocket(SOCK); });

// -J rejoins wrapped lines, so a rule printed wider than the pane reads back at
// its printed width rather than as a pane-width head plus a wrapped tail.
function ruleLines(): string[] {
  const captured = tmux("capture-pane", "-p", "-J", "-S", "-").stdout;
  return captured.split("\n").filter((line) => line.startsWith("── "));
}

function waitFor(predicate: () => boolean): boolean {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return true;
    spawnSync("sleep", ["0.05"]);
  }
  return predicate();
}

describe.skipIf(!tmuxServerAvailable())("garden logs --follow on resize (real tmux)", () => {
  it("redraws date rules at the narrower width and drops the stale copies", () => {
    const cliPath = path.resolve(process.cwd(), "dist/cli.js");
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "garden-logs-resize-")));
    try {
      expect(spawnSync("node", [cliPath, "init"], { env: { ...process.env, HOME: home } }).status).toBe(0);
      const entries = [
        { ts: new Date(2026, 8, 28, 12).toISOString(), level: "info", src: "poller", msg: "first day" },
        { ts: new Date(2026, 8, 29, 12).toISOString(), level: "info", src: "poller", msg: "second day" },
      ];
      fs.writeFileSync(
        path.join(home, ".garden", "sessions", "dashboard.log"),
        entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
      );

      tmux("new-session", "-d", "-x", "100", "-y", "20",
        `env HOME='${home}' GARDEN_PRETTY=1 node '${cliPath}' logs --follow`);
      expect(waitFor(() => ruleLines().length === 2)).toBe(true);
      expect(ruleLines().every((line) => line.length === 100)).toBe(true);

      tmux("resize-window", "-x", "50");
      expect(waitFor(() => {
        const rules = ruleLines();
        return rules.length === 2 && rules.every((line) => line.length === 50);
      })).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

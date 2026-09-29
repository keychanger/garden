// `garden logs --follow` wraps every row, and sizes every date rule, to the
// pane width at the moment it prints. A pane that narrows afterward (terminal
// resize, column split change) held lines wider than itself, so the terminal
// re-wrapped each date rule's tail onto a line of its own. The pretty follow
// loop now redraws its backlog on resize; this drives a real tmux pane through
// a resize and reads back what it holds, scrollback included.
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

const cliPath = path.resolve(process.cwd(), "dist/cli.js");

// A garden home whose log spans two days, so a pretty render carries two rules.
function seedHome(): string {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "garden-logs-resize-")));
  expect(spawnSync("node", [cliPath, "init"], { env: { ...process.env, HOME: home } }).status).toBe(0);
  const entries = [
    { ts: new Date(2026, 8, 28, 12).toISOString(), level: "info", src: "poller", msg: "first day" },
    { ts: new Date(2026, 8, 29, 12).toISOString(), level: "info", src: "poller", msg: "second day" },
  ];
  fs.writeFileSync(
    path.join(home, ".garden", "sessions", "dashboard.log"),
    entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
  return home;
}

const CLEAR_SCREEN_AND_SCROLLBACK = "\x1b[H\x1b[2J\x1b[3J";

// Runs the follow loop with the resize raised inside the process: the width
// starts at 100, drops to 50 once the backlog has printed, and the process
// then ends itself. Returns everything it wrote.
function followThroughResize(home: string, mode: "--pretty" | "--raw"): string {
  const preload = path.join(home, "resize.mjs");
  fs.writeFileSync(preload, [
    "const write = process.stdout.write.bind(process.stdout);",
    "let armed = false;",
    "process.stdout.columns = 100;",
    "process.stdout.write = (...args) => {",
    "  if (!armed) {",
    "    armed = true;",
    "    setTimeout(() => { process.stdout.columns = 50; process.stdout.emit('resize'); }, 100);",
    "    setTimeout(() => process.kill(process.pid, 'SIGTERM'), 1000);",
    "  }",
    "  return write(...args);",
    "};",
  ].join("\n"));
  return spawnSync("node", ["--import", preload, cliPath, "logs", "--follow", mode], {
    env: { ...process.env, HOME: home, GARDEN_PRETTY: "1" },
    encoding: "utf8",
    timeout: 20_000,
  }).stdout;
}

function ruleWidths(output: string): number[] {
  // eslint-disable-next-line no-control-regex
  const plain = output.replace(/\x1b\[[0-9;]*m/g, "");
  return plain.split("\n").filter((line) => line.startsWith("── ")).map((line) => line.length);
}

// A pane cannot show that raw mode was left alone, since a redraw reprints the
// same rows; the output stream can. These also run where tmux cannot.
describe("garden logs --follow on resize (output stream)", () => {
  it("clears and redraws the pretty backlog at the new width", () => {
    const home = seedHome();
    try {
      const [before, after, ...rest] = followThroughResize(home, "--pretty").split(CLEAR_SCREEN_AND_SCROLLBACK);
      expect(rest).toEqual([]);
      expect(ruleWidths(before)).toEqual([100, 100]);
      expect(ruleWidths(after)).toEqual([50, 50]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("leaves a raw backlog and its scrollback alone", () => {
    const home = seedHome();
    try {
      const output = followThroughResize(home, "--raw");
      expect(output).not.toContain(CLEAR_SCREEN_AND_SCROLLBACK);
      expect(output.split("first day")).toHaveLength(2);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!tmuxServerAvailable())("garden logs --follow on resize (real tmux)", () => {
  it("redraws date rules at the narrower width and drops the stale copies", () => {
    const home = seedHome();
    try {
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

import { describe, it, expect, vi } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

vi.mock("../../src/dashboard/tmux.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/dashboard/tmux.js")>(),
  tmux: vi.fn(),
}));

import { tmux } from "../../src/dashboard/tmux.js";
import { setupStatusBar } from "../../src/dashboard/header.js";
import { statusBarStyle } from "../../src/dashboard/alerts.js";

// An OS sandbox denies the tmux server socket; skip rather than hard-fail there.
// See menu-dispatch.real.test.ts, including why the socket file is unlinked.
function tmuxServerAvailable(): boolean {
  const probeSock = `garden-focus-probe-${process.pid}`;
  const probe = spawnSync("tmux", ["-L", probeSock, "new-session", "-d", "-x", "80", "-y", "24"], { encoding: "utf8" });
  const ok = spawnSync("tmux", ["-L", probeSock, "list-sessions"], { encoding: "utf8" }).status === 0;
  spawnSync("tmux", ["-L", probeSock, "kill-server"], { encoding: "utf8" });
  const dir = process.env.TMUX_TMPDIR || "/tmp";
  fs.rmSync(path.join(dir, `tmux-${process.getuid?.() ?? 0}`, probeSock), { force: true });
  return probe.status === 0 && ok;
}

const available = spawnSync("python3", ["--version"], { encoding: "utf8" }).error === undefined
  && tmuxServerAvailable();

describe.skipIf(!available)("status bar focus (real tmux client)", () => {
  it("repaints on focus changes and restores the current build color without a timer", () => {
    setupStatusBar("garden");
    const result = spawnSync("python3", [
      path.resolve("test/integration/fixtures/status-focus.py"),
      JSON.stringify(vi.mocked(tmux).mock.calls),
      JSON.stringify([0, 4, null].map(behind => statusBarStyle(behind))),
    ], { encoding: "utf8", timeout: 20_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr + result.stdout).toBe(0);
  });
});

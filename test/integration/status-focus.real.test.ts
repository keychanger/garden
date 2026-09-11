import { describe, it, expect, vi } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";

vi.mock("../../src/dashboard/tmux.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/dashboard/tmux.js")>(),
  tmux: vi.fn(),
}));

import { tmux } from "../../src/dashboard/tmux.js";
import { setupStatusBar } from "../../src/dashboard/header.js";
import { statusBarStyle } from "../../src/dashboard/alerts.js";

const available = ["tmux", "python3"].every(command =>
  spawnSync(command, ["--version"], { encoding: "utf8" }).error === undefined,
);

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

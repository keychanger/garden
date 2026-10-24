import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import { dashboardReach } from "../src/session.js";

// What execFileSync throws when tmux runs and exits non-zero with stderr piped.
function tmuxFails(stderr: string): void {
  vi.mocked(execFileSync).mockImplementation(() => {
    throw Object.assign(new Error("Command failed: tmux has-session"), {
      status: 1,
      stderr: Buffer.from(`${stderr}\n`),
    });
  });
}

beforeEach(() => {
  vi.mocked(execFileSync).mockReset();
});

describe("dashboardReach", () => {
  it("reports present when has-session succeeds", () => {
    vi.mocked(execFileSync).mockReturnValue(Buffer.from(""));
    expect(dashboardReach()).toEqual({ state: "present" });
    expect(execFileSync).toHaveBeenCalledWith(
      "tmux", ["has-session", "-t", "garden-dashboard"], expect.anything(),
    );
  });

  it.each([
    ["the server has no such session", "can't find session: garden-dashboard"],
    ["a stale socket with no server", "no server running on /private/tmp/tmux-501/default"],
    ["no socket file", "error connecting to /private/tmp/tmux-501/default (No such file or directory)"],
  ])("reports absent when tmux says so: %s", (_label, stderr) => {
    tmuxFails(stderr);
    expect(dashboardReach()).toEqual({ state: "absent" });
  });

  it("reports absent when there is no tmux binary", () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw Object.assign(new Error("spawnSync tmux ENOENT"), { code: "ENOENT" });
    });
    expect(dashboardReach()).toEqual({ state: "absent" });
  });

  // An agent sandbox denies the socket. Every pane and window probe then fails
  // exactly as it does with nothing running, so this must not read as absent.
  it("reports unreachable, with tmux's words, when the socket is denied", () => {
    tmuxFails("error connecting to /private/tmp/tmux-501/default (Operation not permitted)");
    expect(dashboardReach()).toEqual({
      state: "unreachable",
      detail: "error connecting to /private/tmp/tmux-501/default (Operation not permitted)",
    });
  });

  it("reports unreachable for a failure tmux did not explain", () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw Object.assign(new Error("spawnSync tmux EACCES"), { code: "EACCES" });
    });
    expect(dashboardReach()).toEqual({ state: "unreachable", detail: "Error: spawnSync tmux EACCES" });
  });
});

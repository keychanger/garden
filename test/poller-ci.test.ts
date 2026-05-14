import { describe, it, expect, vi, beforeEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => ""),
  spawnSync: vi.fn(() => ({ status: 0, stdout: "[]", stderr: "" })),
}));

vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { getGitHubRepoSlug, checkCiStatus } from "../src/dashboard/poller-ci.js";

beforeEach(() => {
  vi.resetAllMocks();
});

describe("getGitHubRepoSlug", () => {
  it("parses SSH remote URL", () => {
    vi.mocked(execFileSync).mockReturnValueOnce(
      "git@github.com:Leading-Tone/wolf.git\n" as unknown as Buffer,
    );
    expect(getGitHubRepoSlug("/repo")).toBe("Leading-Tone/wolf");
  });

  it("parses HTTPS remote URL", () => {
    vi.mocked(execFileSync).mockReturnValueOnce(
      "https://github.com/Leading-Tone/wolf.git\n" as unknown as Buffer,
    );
    expect(getGitHubRepoSlug("/repo")).toBe("Leading-Tone/wolf");
  });

  it("strips trailing slash on HTTPS URLs without .git", () => {
    vi.mocked(execFileSync).mockReturnValueOnce(
      "https://github.com/owner/repo/\n" as unknown as Buffer,
    );
    expect(getGitHubRepoSlug("/repo")).toBe("owner/repo");
  });

  it("returns null for non-github remotes", () => {
    vi.mocked(execFileSync).mockReturnValueOnce(
      "git@gitlab.com:owner/repo.git\n" as unknown as Buffer,
    );
    expect(getGitHubRepoSlug("/repo")).toBeNull();
  });

  it("returns null when git fails", () => {
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw new Error("not a git repo");
    });
    expect(getGitHubRepoSlug("/repo")).toBeNull();
  });
});

describe("checkCiStatus", () => {
  it("returns success when every completed run conclude success/skipped/neutral", () => {
    vi.mocked(spawnSync).mockReturnValueOnce({
      status: 0,
      pid: 1, output: [], signal: null, stderr: "",
      stdout: JSON.stringify([
        { name: "lint", status: "completed", conclusion: "success" },
        { name: "test", status: "completed", conclusion: "skipped" },
        { name: "schema", status: "completed", conclusion: "neutral" },
      ]),
    });
    expect(checkCiStatus("owner/repo", "deadbeef").kind).toBe("success");
  });

  it("returns pending when any run is not completed", () => {
    vi.mocked(spawnSync).mockReturnValueOnce({
      status: 0,
      pid: 1, output: [], signal: null, stderr: "",
      stdout: JSON.stringify([
        { name: "lint", status: "completed", conclusion: "success" },
        { name: "test", status: "in_progress", conclusion: null },
      ]),
    });
    const result = checkCiStatus("owner/repo", "deadbeef");
    expect(result.kind).toBe("pending");
    if (result.kind === "pending") {
      expect(result.pending).toEqual(["test"]);
    }
  });

  it("returns failed when any run concludes non-success", () => {
    vi.mocked(spawnSync).mockReturnValueOnce({
      status: 0,
      pid: 1, output: [], signal: null, stderr: "",
      stdout: JSON.stringify([
        { name: "lint", status: "completed", conclusion: "success" },
        { name: "test", status: "completed", conclusion: "failure", html_url: "https://github.com/x/y/runs/1" },
        { name: "schema", status: "completed", conclusion: "timed_out" },
      ]),
    });
    const result = checkCiStatus("owner/repo", "deadbeef");
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.failed.map(f => f.name)).toEqual(["test", "schema"]);
      expect(result.failed[0].htmlUrl).toBe("https://github.com/x/y/runs/1");
    }
  });

  it("prefers failed over pending when both exist", () => {
    vi.mocked(spawnSync).mockReturnValueOnce({
      status: 0,
      pid: 1, output: [], signal: null, stderr: "",
      stdout: JSON.stringify([
        { name: "lint", status: "completed", conclusion: "failure" },
        { name: "test", status: "queued", conclusion: null },
      ]),
    });
    expect(checkCiStatus("owner/repo", "deadbeef").kind).toBe("failed");
  });

  it("returns no-ci when the commit has zero check-runs", () => {
    vi.mocked(spawnSync).mockReturnValueOnce({
      status: 0,
      pid: 1, output: [], signal: null, stderr: "",
      stdout: "[]",
    });
    expect(checkCiStatus("owner/repo", "deadbeef").kind).toBe("no-ci");
  });

  it("returns unavailable when gh is not installed (ENOENT)", () => {
    const err = new Error("spawn gh ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    vi.mocked(spawnSync).mockReturnValueOnce({
      status: null,
      pid: 0, output: [], signal: null, stderr: "", stdout: "",
      error: err,
    });
    const result = checkCiStatus("owner/repo", "deadbeef");
    expect(result.kind).toBe("unavailable");
    if (result.kind === "unavailable") {
      expect(result.reason).toBe("gh-not-installed");
    }
  });

  it("returns unavailable on gh non-zero exit", () => {
    vi.mocked(spawnSync).mockReturnValueOnce({
      status: 1,
      pid: 1, output: [], signal: null,
      stdout: "", stderr: "HTTP 404: Not Found",
    });
    const result = checkCiStatus("owner/repo", "deadbeef");
    expect(result.kind).toBe("unavailable");
    if (result.kind === "unavailable") {
      expect(result.reason).toContain("gh-exit-1");
      expect(result.reason).toContain("HTTP 404");
    }
  });

  it("flattens paginated multi-line JSON arrays", () => {
    vi.mocked(spawnSync).mockReturnValueOnce({
      status: 0,
      pid: 1, output: [], signal: null, stderr: "",
      stdout: [
        JSON.stringify([{ name: "a", status: "completed", conclusion: "success" }]),
        JSON.stringify([{ name: "b", status: "completed", conclusion: "success" }]),
      ].join("\n"),
    });
    expect(checkCiStatus("owner/repo", "deadbeef").kind).toBe("success");
  });
});

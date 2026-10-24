import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => ""),
  spawnSync: vi.fn(() => ({ status: 0, stdout: "[]", stderr: "" })),
}));

vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { getGitHubRepoSlug, checkCiStatus, projectDefinesCi, workflowRunsOnPush } from "../src/dashboard/poller-ci.js";

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

  it("distinguishes an unpublished commit from an unavailable CI service", () => {
    vi.mocked(spawnSync).mockReturnValueOnce({
      status: 1, pid: 1, output: [], signal: null, stdout: "",
      stderr: "gh: No commit found for SHA: 230c308 (HTTP 422)",
    });
    expect(checkCiStatus("owner/repo", "230c308")).toEqual({ kind: "missing-commit" });
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

  // Only a failure that can clear on its own may hold a CI project's merge;
  // bad credentials and a 404 still pass through at once.
  it.each([
    ["gh: Server Error (HTTP 500)", true],
    ["HTTP 502: Bad Gateway (https://api.github.com/repos/o/r/commits/x/check-runs)", true],
    ["gh: API rate limit exceeded for user ID 1. (HTTP 403)", true],
    ["gh: Too Many Requests (HTTP 429)", true],
    ["error connecting to api.github.com\ncheck your internet connection", true],
    ["gh: Bad credentials (HTTP 401)", false],
    ["gh: Not Found (HTTP 404)", false],
  ])("marks gh failure %j transient: %s", (stderr, transient) => {
    vi.mocked(spawnSync).mockReturnValueOnce({ status: 1, pid: 1, output: [], signal: null, stdout: "", stderr });
    expect(checkCiStatus("owner/repo", "deadbeef")).toMatchObject({ kind: "unavailable", transient });
  });

  it("marks a gh call killed by its timeout transient", () => {
    const err = new Error("spawnSync gh ETIMEDOUT") as NodeJS.ErrnoException;
    err.code = "ETIMEDOUT";
    vi.mocked(spawnSync).mockReturnValueOnce({
      status: null, pid: 1, output: [], signal: "SIGTERM", stdout: "", stderr: "", error: err,
    });
    expect(checkCiStatus("owner/repo", "deadbeef")).toMatchObject({ kind: "unavailable", transient: true });
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

describe("projectDefinesCi", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-ci-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("detects a .yml workflow", () => {
    fs.mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".github", "workflows", "test.yml"), "on: push\n");
    expect(projectDefinesCi(dir, "bold-ash")).toBe(true);
  });

  it("detects a .yaml workflow", () => {
    fs.mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".github", "workflows", "test.yaml"), "on: push\n");
    expect(projectDefinesCi(dir, "bold-ash")).toBe(true);
  });

  it("is false with no .github directory at all", () => {
    expect(projectDefinesCi(dir, "bold-ash")).toBe(false);
  });

  it("is false when the workflows directory holds no yaml", () => {
    // A README-only workflows dir is not CI — this is the case that must keep
    // passing straight through rather than eating the 3-minute grace window.
    fs.mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".github", "workflows", "README.md"), "notes\n");
    expect(projectDefinesCi(dir, "bold-ash")).toBe(false);
  });

  it("is false on an unreadable path rather than throwing", () => {
    expect(projectDefinesCi(path.join(dir, "does-not-exist"), "bold-ash")).toBe(false);
  });

  // app-playground's only workflow deploys main. Worker SHAs never get its
  // check-runs, so counting it held every merge for the full grace window.
  it("is false when no workflow runs on a push to the worker's branch", () => {
    const workflows = path.join(dir, ".github", "workflows");
    fs.mkdirSync(workflows, { recursive: true });
    fs.writeFileSync(path.join(workflows, "deploy-web.yml"),
      "on:\n  push:\n    branches: [main]\n  workflow_dispatch:\n");
    fs.writeFileSync(path.join(workflows, "review.yml"), "on: pull_request\n");
    expect(projectDefinesCi(dir, "bold-ash")).toBe(false);

    fs.writeFileSync(path.join(workflows, "test.yml"), "on:\n  push:\n    branches: ['**']\n");
    expect(projectDefinesCi(dir, "bold-ash")).toBe(true);
  });

  it("counts a symlinked workflow without following it", () => {
    const workflows = path.join(dir, ".github", "workflows");
    fs.mkdirSync(workflows, { recursive: true });
    fs.writeFileSync(path.join(dir, "elsewhere.yml"), "on: workflow_dispatch\n");
    fs.symlinkSync(path.join(dir, "elsewhere.yml"), path.join(workflows, "ci.yml"));
    expect(projectDefinesCi(dir, "bold-ash")).toBe(true);
  });
});

describe("workflowRunsOnPush", () => {
  it.each([
    ["on: push", true],
    ["on: [pull_request, push]", true],
    ["on: [pull_request, workflow_dispatch]", false],
    ["on:\n  push:\n  schedule:\n    - cron: '0 0 * * *'", true],
    ["on:\n  push:\n    paths: ['src/**']", true],
    ["on:\n  push:\n    branches: ['*-ash']", true],
    ["on:\n  push:\n    branches: ['release/**']", false],
    ["on:\n  push:\n    branches: ['**', '!bold-ash']", false],
    ["on:\n  push:\n    branches-ignore: [main]", true],
    ["on:\n  push:\n    branches-ignore: ['bold-*']", false],
    ["on:\n  push:\n    tags: ['v*']", false],
    // Unreadable answers yes: the cost is a grace window, not an ungated merge.
    ["on: [push", true],
    ["name: no triggers", true],
    ["on:\n  push:\n    branches: ['[unclosed']", true],
  ])("%j -> %s", (source, expected) => {
    expect(workflowRunsOnPush(`${source}\n`, "bold-ash")).toBe(expected);
  });
});

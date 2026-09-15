import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { launchHeadlessAgent } from "../src/dashboard/headless-agent.js";
import { resolveHeadlessLaunchPlan } from "../src/dashboard/launch-plan.js";
import { newDashboardWindow } from "../src/dashboard/tmux.js";

vi.mock("../src/dashboard/tmux.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/dashboard/tmux.js")>(),
  newDashboardWindow: vi.fn(),
  windowExists: vi.fn(() => false),
}));

let root: string;
let cwd: string;
let settingsPath: string;

beforeEach(() => {
  vi.clearAllMocks();
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "garden-headless-runtime-")));
  cwd = path.join(root, "worker");
  fs.mkdirSync(cwd);
  execFileSync("git", ["init", "-q", cwd]);
  execFileSync("git", ["-C", cwd, "remote", "add", "origin", "git@example.org:team/project.git"]);
  settingsPath = path.join(cwd, ".claude", "settings.json");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function options(harness = "claude-code", role: "reviewer" | "resolver" | "ciFix" = "reviewer") {
  return {
    cwd,
    project: {
      path: cwd,
      sandboxDomains: ["packages.example.org"],
      sandboxWriteRoots: [path.join(root, "cache")],
      sandboxDenyCredentials: true,
    },
    windowName: "_project-review-worker",
    prompt: "Review and fix this branch.",
    promptFile: path.join(root, "prompt.txt"),
    resultFile: path.join(root, "result.txt"),
    launchPlan: resolveHeadlessLaunchPlan({ harness, role, envPrefix: "" }),
    envVars: { GARDEN_REVIEWER: "1" },
    signalFifo: path.join(root, "signal"),
  };
}

describe("headless runtime repair", () => {
  it.each(["reviewer", "resolver", "ciFix"] as const)(
    "restores missing Claude sandbox settings before launching a %s in a Codex worktree",
    role => {
      fs.mkdirSync(path.join(cwd, ".codex"));
      fs.writeFileSync(path.join(cwd, "AGENTS.md"), "Worker instructions\n");
      vi.mocked(newDashboardWindow).mockImplementationOnce(() => {
        const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
        expect(settings.sandbox.enabled).toBe(true);
        expect(settings.sandbox.autoAllowBashIfSandboxed).toBe(true);
        expect(settings.sandbox.filesystem.allowWrite).toEqual(expect.arrayContaining([
          cwd, path.join(root, "cache"),
        ]));
        expect(settings.sandbox.filesystem.denyRead.length).toBeGreaterThan(0);
        expect(settings.sandbox.network.allowedDomains).toEqual(expect.arrayContaining([
          "example.org", "packages.example.org",
        ]));
        expect(fs.statSync(settingsPath).mode & 0o777).toBe(0o444);
        expect(fs.readFileSync(path.join(cwd, "AGENTS.md"), "utf-8")).toBe("Worker instructions\n");
      });

      launchHeadlessAgent(options("claude-code", role));

      expect(newDashboardWindow).toHaveBeenCalledOnce();
      expect(vi.mocked(newDashboardWindow).mock.calls[0][5]).toContain("--permission-mode acceptEdits");
    },
  );

  it("preserves an existing worker's Claude runtime settings", () => {
    fs.mkdirSync(path.dirname(settingsPath));
    const existing = '{"sandbox":{"enabled":true},"permissions":{"deny":["Bash(custom:*)"]}}\n';
    fs.writeFileSync(settingsPath, existing);

    launchHeadlessAgent(options());

    expect(fs.readFileSync(settingsPath, "utf-8")).toBe(existing);
    expect(newDashboardWindow).toHaveBeenCalledOnce();
  });

  it("leaves Codex headless launches independent of Claude runtime settings", () => {
    launchHeadlessAgent(options("codex"));

    expect(fs.existsSync(settingsPath)).toBe(false);
    expect(newDashboardWindow).toHaveBeenCalledOnce();
  });

  it("does not launch when missing settings cannot be installed", () => {
    fs.writeFileSync(path.dirname(settingsPath), "not a directory");

    expect(() => launchHeadlessAgent(options())).toThrow();
    expect(newDashboardWindow).not.toHaveBeenCalled();
  });
});

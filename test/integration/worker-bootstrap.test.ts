import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { useGitTmpHome } from "./helpers.js";

const env = useGitTmpHome();

const PROJECT = "myproject";
const WORKER = "swift-oak";

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

let projectPath: string;
let originPath: string;
let worktreePath: string;

beforeEach(() => {
  originPath = path.join(env.home, "origin.git");
  spawnSync("git", ["init", "--bare", "-b", "main", originPath], { stdio: "ignore" });

  projectPath = path.join(env.home, "projects", PROJECT);
  fs.mkdirSync(projectPath, { recursive: true });
  spawnSync("git", ["init", "-b", "main", projectPath], { stdio: "ignore" });
  git(projectPath, "config", "user.email", "test@garden.local");
  git(projectPath, "config", "user.name", "garden-test");
  git(projectPath, "remote", "add", "origin", originPath);
  fs.writeFileSync(path.join(projectPath, "README.md"), "# proj\n");
  git(projectPath, "add", ".");
  git(projectPath, "commit", "-m", "init");
  git(projectPath, "push", "-u", "origin", "main");

  worktreePath = path.join(env.home, ".garden", "worktrees", PROJECT, WORKER);
});

describe("worker bootstrap (real fs + real git)", () => {
  it("createWorktree produces a worktree with the requested branch", async () => {
    const { createWorktree, worktreeExists, currentBranch } =
      await import("../../src/dashboard/git.js");
    createWorktree(projectPath, worktreePath, WORKER);
    expect(worktreeExists(worktreePath)).toBe(true);
    expect(currentBranch(worktreePath)).toBe(WORKER);
    expect(fs.existsSync(path.join(worktreePath, "README.md"))).toBe(true);
  });

  it("installRuntimeConfig writes settings.json with hooks for every Claude Code event", async () => {
    const { createWorktree } = await import("../../src/dashboard/git.js");
    const { claudeCodeAdapter } = await import("../../src/dashboard/harness/claude-code.js");

    createWorktree(projectPath, worktreePath, WORKER);
    claudeCodeAdapter.installRuntimeConfig(worktreePath, { path: projectPath });

    const settingsPath = path.join(worktreePath, ".claude", "settings.json");
    expect(fs.existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));

    expect(settings.hooks).toBeDefined();
    expect(settings.hooks.SessionStart).toBeDefined();
    expect(settings.hooks.UserPromptSubmit).toBeDefined();
    expect(settings.hooks.Stop).toBeDefined();
    expect(settings.hooks.PreToolUse).toBeDefined();
    expect(settings.hooks.PostToolUse).toBeDefined();
    expect(settings.hooks.PermissionRequest).toBeDefined();
  });

  it("settings.json has permissions.defaultMode auto and the documented allowlist", async () => {
    const { createWorktree } = await import("../../src/dashboard/git.js");
    const { claudeCodeAdapter } = await import("../../src/dashboard/harness/claude-code.js");

    createWorktree(projectPath, worktreePath, WORKER);
    claudeCodeAdapter.installRuntimeConfig(worktreePath, { path: projectPath });

    const settings = JSON.parse(fs.readFileSync(
      path.join(worktreePath, ".claude", "settings.json"), "utf-8"));
    expect(settings.permissions.defaultMode).toBe("auto");
    expect(settings.permissions.allow).toContain("Bash(tmux:*)");
    expect(settings.permissions.allow).toContain("Bash(echo:*)");
    expect(settings.permissions.allow).toContain("Bash(head:*)");
    expect(settings.permissions.allow).toContain("Bash(tail:*)");
  });

  it("settings.json sandbox config includes worktree allowWrite and Anthropic domain", async () => {
    const { createWorktree } = await import("../../src/dashboard/git.js");
    const { claudeCodeAdapter } = await import("../../src/dashboard/harness/claude-code.js");

    createWorktree(projectPath, worktreePath, WORKER);
    claudeCodeAdapter.installRuntimeConfig(worktreePath, { path: projectPath });

    const settings = JSON.parse(fs.readFileSync(
      path.join(worktreePath, ".claude", "settings.json"), "utf-8"));
    expect(settings.sandbox.filesystem.allowWrite).toContain(worktreePath);
    expect(settings.sandbox.network.allowedDomains).toContain("api.anthropic.com");
  });

  it("installs the done skill at .claude/skills/done/SKILL.md", async () => {
    const { createWorktree } = await import("../../src/dashboard/git.js");
    const { claudeCodeAdapter } = await import("../../src/dashboard/harness/claude-code.js");

    createWorktree(projectPath, worktreePath, WORKER);
    claudeCodeAdapter.installRuntimeConfig(worktreePath, { path: projectPath });

    const skillPath = path.join(worktreePath, ".claude", "skills", "done", "SKILL.md");
    expect(fs.existsSync(skillPath)).toBe(true);
    const body = fs.readFileSync(skillPath, "utf-8");
    expect(body).toContain(".garden-done");
  });

  it("worker registry round-trips a worker entry that points at the real worktree", async () => {
    const { createWorktree } = await import("../../src/dashboard/git.js");
    const { addWorker, getWorkers } = await import("../../src/dashboard/registry.js");

    createWorktree(projectPath, worktreePath, WORKER);

    addWorker(PROJECT, {
      name: WORKER,
      sessionId: "sess-1",
      task: "bootstrap test",
      worktreePath,
      branchName: WORKER,
      baseBranch: "main",
    });

    const workers = getWorkers(PROJECT);
    expect(workers).toHaveLength(1);
    expect(workers[0].worktreePath).toBe(worktreePath);
    expect(workers[0].branchName).toBe(WORKER);

    const file = path.join(env.sessionsDir, "dashboard.registry.json");
    expect(fs.existsSync(file)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(file, "utf-8"));
    expect(onDisk.workers[PROJECT][0].name).toBe(WORKER);
  });

  it("removeWorktree cleans up the directory and prunes the worktree from the project repo", async () => {
    const { createWorktree, removeWorktree, worktreeExists } =
      await import("../../src/dashboard/git.js");

    createWorktree(projectPath, worktreePath, WORKER);
    expect(worktreeExists(worktreePath)).toBe(true);
    removeWorktree(projectPath, worktreePath);
    expect(worktreeExists(worktreePath)).toBe(false);
    const wtList = git(projectPath, "worktree", "list");
    expect(wtList).not.toContain(worktreePath);
  });
});

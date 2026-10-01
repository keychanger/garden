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

  it("codex worker bootstrap installs the codex runtime + launches codex; claude bootstrap does neither", async () => {
    const { buildWorktreeBootstrapScript } = await import("../../src/dashboard/create.js");
    const codex = fs.readFileSync(
      buildWorktreeBootstrapScript(PROJECT, projectPath, WORKER, WORKER, "sid", worktreePath, "main", { harness: "codex" }),
      "utf-8",
    );
    // The additive codex branch: the runtime subcommand runs after worktree
    // setup, and the launch is the codex dialect (sandbox + hook-trust bypass).
    expect(codex).toContain("_install-worker-runtime");
    expect(codex).toContain("codex --dangerously-bypass-hook-trust");
    expect(codex).toContain("-s workspace-write");

    const claude = fs.readFileSync(
      buildWorktreeBootstrapScript(PROJECT, projectPath, WORKER, WORKER, "sid", worktreePath, "main"),
      "utf-8",
    );
    // Byte-for-byte the existing dialect: no codex install, launches claude.
    expect(claude).not.toContain("_install-worker-runtime");
    expect(claude).toContain("claude --rc");
  });

  // Garden's settings file for the worktree (outside it, under ~/.garden/control).
  async function readGardenSettings() {
    const { claudeSettingsPath } = await import("../../src/dashboard/headless-paths.js");
    return JSON.parse(fs.readFileSync(claudeSettingsPath(worktreePath), "utf-8"));
  }

  it("installRuntimeConfig writes garden's settings file with hooks for every Claude Code event", async () => {
    const { createWorktree } = await import("../../src/dashboard/git.js");
    const { claudeCodeAdapter } = await import("../../src/dashboard/harness/claude-code.js");

    createWorktree(projectPath, worktreePath, WORKER);
    claudeCodeAdapter.installRuntimeConfig(worktreePath, { path: projectPath });

    expect(fs.existsSync(path.join(worktreePath, ".claude", "settings.json"))).toBe(false);
    const settings = await readGardenSettings();

    expect(settings.hooks).toBeDefined();
    expect(settings.hooks.SessionStart).toBeDefined();
    expect(settings.hooks.UserPromptSubmit).toBeDefined();
    expect(settings.hooks.Stop).toBeDefined();
    expect(settings.hooks.PreToolUse).toBeDefined();
    expect(settings.hooks.PostToolUse).toBeDefined();
    expect(settings.hooks.PermissionRequest).toBeDefined();

    // The firehose PostToolUse hook carries the NODE_COMPILE_CACHE prefix so
    // each cold-started hook process reuses the bundle's cached bytecode.
    const postCmd = settings.hooks.PostToolUse[0].hooks[0].command;
    expect(postCmd).toContain("NODE_COMPILE_CACHE=");
    expect(postCmd).toContain(".cache/garden/node-compile");
    expect(postCmd).toMatch(/posttooluse$/);
  });

  it("garden's settings have the documented allowlist and no project-level defaultMode", async () => {
    const { createWorktree } = await import("../../src/dashboard/git.js");
    const { claudeCodeAdapter } = await import("../../src/dashboard/harness/claude-code.js");

    createWorktree(projectPath, worktreePath, WORKER);
    claudeCodeAdapter.installRuntimeConfig(worktreePath, { path: projectPath });

    const settings = await readGardenSettings();
    expect(settings.permissions.defaultMode).toBeUndefined();
    expect(settings.permissions.allow).toContain("Bash(tmux:*)");
    expect(settings.permissions.allow).toContain("Bash(echo:*)");
    expect(settings.permissions.allow).toContain("Bash(head:*)");
    expect(settings.permissions.allow).toContain("Bash(tail:*)");
  });

  it("garden's settings sandbox config includes worktree allowWrite and Anthropic domain", async () => {
    const { createWorktree } = await import("../../src/dashboard/git.js");
    const { claudeCodeAdapter } = await import("../../src/dashboard/harness/claude-code.js");

    createWorktree(projectPath, worktreePath, WORKER);
    claudeCodeAdapter.installRuntimeConfig(worktreePath, { path: projectPath });

    const settings = await readGardenSettings();
    expect(settings.sandbox.filesystem.allowWrite).toContain(worktreePath);
    expect(settings.sandbox.network.allowedDomains).toContain("api.anthropic.com");
  });

  describe("a repo that commits its own .claude/settings.json", () => {
    const repoSettings = JSON.stringify({ permissions: { allow: ["Bash(make:*)"] } }, null, 2) + "\n";
    // What earlier garden builds wrote into the worktree.
    const oldGardenSettings = JSON.stringify({
      hooks: { SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "NODE_COMPILE_CACHE=/c /usr/bin/node /g/dist/hook.js sessionstart" }] }] },
    });

    function commitRepoSettings() {
      fs.mkdirSync(path.join(projectPath, ".claude"), { recursive: true });
      fs.writeFileSync(path.join(projectPath, ".claude", "settings.json"), repoSettings);
      git(projectPath, "add", ".claude/settings.json");
      git(projectPath, "commit", "-m", "share claude settings");
      git(projectPath, "push", "origin", "main");
    }

    it("leaves the repo's file untouched, so the worktree stays clean for the review gate", async () => {
      commitRepoSettings();
      const { createWorktree } = await import("../../src/dashboard/git.js");
      const { claudeCodeAdapter } = await import("../../src/dashboard/harness/claude-code.js");

      createWorktree(projectPath, worktreePath, WORKER);
      claudeCodeAdapter.installRuntimeConfig(worktreePath, { path: projectPath }, { beforeLaunch: true });

      expect(git(worktreePath, "status", "--porcelain")).toBe("");
      expect(fs.readFileSync(path.join(worktreePath, ".claude", "settings.json"), "utf-8")).toBe(repoSettings);
      expect((await readGardenSettings()).hooks.SessionStart).toBeDefined();
    });

    it("restores the repo's file that an earlier build overwrote, even behind skip-worktree", async () => {
      commitRepoSettings();
      const { createWorktree } = await import("../../src/dashboard/git.js");
      const { claudeCodeAdapter } = await import("../../src/dashboard/harness/claude-code.js");
      createWorktree(projectPath, worktreePath, WORKER);
      const file = path.join(worktreePath, ".claude", "settings.json");
      fs.writeFileSync(file, oldGardenSettings);
      fs.chmodSync(file, 0o444);
      git(worktreePath, "update-index", "--skip-worktree", ".claude/settings.json");

      claudeCodeAdapter.installRuntimeConfig(worktreePath, { path: projectPath }, { beforeLaunch: true });

      expect(fs.readFileSync(file, "utf-8")).toBe(repoSettings);
      expect(git(worktreePath, "ls-files", "-v", ".claude/settings.json")).toBe("H .claude/settings.json");
      expect(git(worktreePath, "status", "--porcelain")).toBe("");
    });
  });

  it("retires an earlier build's untracked settings only when a launch follows", async () => {
    const { createWorktree } = await import("../../src/dashboard/git.js");
    const { claudeCodeAdapter } = await import("../../src/dashboard/harness/claude-code.js");
    createWorktree(projectPath, worktreePath, WORKER);
    const file = path.join(worktreePath, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "'/n/node' '/g/dist/cli.js' dashboard _claude-hook sessionstart" }] }] },
    }));

    // A refresh with no launch: a live worker from that build still reads it.
    claudeCodeAdapter.installRuntimeConfig(worktreePath, { path: projectPath });
    expect(fs.existsSync(file)).toBe(true);

    // Launched with --settings, Claude would load both copies and fire every hook twice.
    claudeCodeAdapter.installRuntimeConfig(worktreePath, { path: projectPath }, { beforeLaunch: true });
    expect(fs.existsSync(file)).toBe(false);
  });

  it("never removes an untracked settings file garden did not write", async () => {
    const { createWorktree } = await import("../../src/dashboard/git.js");
    const { claudeCodeAdapter } = await import("../../src/dashboard/harness/claude-code.js");
    createWorktree(projectPath, worktreePath, WORKER);
    const file = path.join(worktreePath, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const own = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }] } });
    fs.writeFileSync(file, own);

    claudeCodeAdapter.installRuntimeConfig(worktreePath, { path: projectPath }, { beforeLaunch: true });

    expect(fs.readFileSync(file, "utf-8")).toBe(own);
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

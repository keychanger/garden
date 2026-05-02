import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import yaml from "js-yaml";
import { useGitTmpHome } from "./helpers.js";

// handleClaudeHook spawns tmux and refresh subprocesses as side effects of
// the registry update we actually care about. Mock the side-effect modules
// (tmux pane reads, refresh, usage refresh, poller poke) so the test runs
// in a CI environment without a live tmux server. The data layer (registry,
// state, config) stays on real fs — that's what we're testing.
vi.mock("../../src/dashboard/tmux.js", () => ({
  tmux: vi.fn(),
  tmuxOutput: vi.fn(() => ""),
  getPanePid: vi.fn(() => null),
  getPaneTitle: vi.fn(() => null),
  getFirstPaneId: vi.fn(() => null),
  windowExists: vi.fn(() => false),
  setPaneVar: vi.fn(),
  getPaneSize: vi.fn(() => null),
  listAllWindowNames: vi.fn(() => []),
  listHiddenWorkerWindows: vi.fn(() => []),
}));
vi.mock("../../src/dashboard/usage.js", () => ({
  maybeRefreshUsage: vi.fn(),
  renderUsagePane: vi.fn(() => ""),
}));
vi.mock("../../src/dashboard/poller.js", () => ({
  triggerProjectPoll: vi.fn(),
  signalFifoPath: vi.fn(() => "/tmp/fake-fifo"),
}));
vi.mock("../../src/dashboard/create.js", () => ({
  resolveGardenRunner: vi.fn(() => "garden"),
}));
vi.mock("../../src/commands/status.js", () => ({
  renderQuickStatus: vi.fn(() => ""),
  resolveWorkerStatus: vi.fn(() => "idle"),
}));

const env = useGitTmpHome();

const PROJECT = "myproject";
const WORKER = "bold-ash";
let originPath: string;
let projectPath: string;
let worktreePath: string;
let originalCwd: string;

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function readRegistryFile(): { workers: Record<string, unknown[]> } {
  const file = path.join(env.sessionsDir, "dashboard.registry.json");
  if (!fs.existsSync(file)) return { workers: {} };
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

function seedRegistry(claudeStatus: string, extra: Record<string, unknown> = {}) {
  const file = path.join(env.sessionsDir, "dashboard.registry.json");
  const reg = {
    workers: {
      [PROJECT]: [{
        name: WORKER,
        sessionId: "session-id-1",
        task: "do the thing",
        worktreePath,
        branchName: WORKER,
        baseBranch: "main",
        claudeStatus,
        ...extra,
      }],
    },
  };
  fs.writeFileSync(file, JSON.stringify(reg));
}

function seedConfig() {
  const file = path.join(env.gardenDir, "config.yml");
  fs.writeFileSync(file, yaml.dump({
    projects: { [PROJECT]: { path: projectPath } },
    plots: { all: { projects: [PROJECT] } },
    activePlot: "all",
  }));
}

beforeEach(() => {
  originalCwd = process.cwd();
  // Reviewer env var leaks in when these tests run inside `garden review`.
  // Clear it so handleClaudeHook treats the test process as a worker, not a
  // reviewer. Tests that exercise the reviewer-skip path set it explicitly.
  delete process.env.GARDEN_REVIEWER;

  // Origin remote and project checkout so routeStopHookEnd's rev-list works.
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

  // Worker worktree at the path workerFromCwd expects.
  worktreePath = path.join(env.home, ".garden", "worktrees", PROJECT, WORKER);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  git(projectPath, "worktree", "add", worktreePath, "-b", WORKER);

  seedConfig();
});

afterEach(() => {
  process.chdir(originalCwd);
});

describe("handleClaudeHook (real fs + real git)", () => {
  it("notification with claudeStatus=working flips to asking", async () => {
    seedRegistry("working");
    process.chdir(worktreePath);
    const { handleClaudeHook } = await import("../../src/dashboard/header.js");
    handleClaudeHook("notification");
    const reg = readRegistryFile();
    const w = reg.workers[PROJECT][0] as { claudeStatus: string };
    expect(w.claudeStatus).toBe("asking");
  });

  it("notification with claudeStatus=idle self-heals to asking", async () => {
    seedRegistry("idle");
    process.chdir(worktreePath);
    const { handleClaudeHook } = await import("../../src/dashboard/header.js");
    handleClaudeHook("notification");
    const w = readRegistryFile().workers[PROJECT][0] as { claudeStatus: string };
    expect(w.claudeStatus).toBe("asking");
  });

  it("notification with claudeStatus=ready does NOT flip (not in working/idle set)", async () => {
    seedRegistry("ready");
    process.chdir(worktreePath);
    const { handleClaudeHook } = await import("../../src/dashboard/header.js");
    handleClaudeHook("notification");
    const w = readRegistryFile().workers[PROJECT][0] as { claudeStatus: string };
    expect(w.claudeStatus).toBe("ready");
  });

  it("notification with claudeStatus=asking stays asking (not in working/idle set)", async () => {
    seedRegistry("asking");
    process.chdir(worktreePath);
    const { handleClaudeHook } = await import("../../src/dashboard/header.js");
    handleClaudeHook("notification");
    const w = readRegistryFile().workers[PROJECT][0] as { claudeStatus: string };
    expect(w.claudeStatus).toBe("asking");
  });

  it("pretooluse and posttooluse have OPPOSITE effects on the same starting state", async () => {
    seedRegistry("working");
    process.chdir(worktreePath);
    const { handleClaudeHook } = await import("../../src/dashboard/header.js");

    handleClaudeHook("pretooluse");
    expect((readRegistryFile().workers[PROJECT][0] as { claudeStatus: string }).claudeStatus).toBe("asking");

    handleClaudeHook("posttooluse");
    expect((readRegistryFile().workers[PROJECT][0] as { claudeStatus: string }).claudeStatus).toBe("working");
  });

  it("posttooluse with idle self-heals to working", async () => {
    seedRegistry("idle");
    process.chdir(worktreePath);
    const { handleClaudeHook } = await import("../../src/dashboard/header.js");
    handleClaudeHook("posttooluse");
    const w = readRegistryFile().workers[PROJECT][0] as { claudeStatus: string };
    expect(w.claudeStatus).toBe("working");
  });

  it("posttooluse with ready does NOT flip", async () => {
    seedRegistry("ready");
    process.chdir(worktreePath);
    const { handleClaudeHook } = await import("../../src/dashboard/header.js");
    handleClaudeHook("posttooluse");
    const w = readRegistryFile().workers[PROJECT][0] as { claudeStatus: string };
    expect(w.claudeStatus).toBe("ready");
  });

  it("prompt sets working and clears merged prState", async () => {
    seedRegistry("idle", { prState: "merged" });
    process.chdir(worktreePath);
    const { handleClaudeHook } = await import("../../src/dashboard/header.js");
    handleClaudeHook("prompt");
    const w = readRegistryFile().workers[PROJECT][0] as { claudeStatus: string; prState?: string };
    expect(w.claudeStatus).toBe("working");
    expect(w.prState).toBeUndefined();
  });

  it("prompt does not clear non-merged prState", async () => {
    seedRegistry("idle", { prState: "failing" });
    process.chdir(worktreePath);
    const { handleClaudeHook } = await import("../../src/dashboard/header.js");
    handleClaudeHook("prompt");
    const w = readRegistryFile().workers[PROJECT][0] as { prState?: string };
    expect(w.prState).toBe("failing");
  });

  it("stop sets claudeStatus to idle when no commits are ahead", async () => {
    seedRegistry("working");
    process.chdir(worktreePath);
    const { handleClaudeHook } = await import("../../src/dashboard/header.js");
    handleClaudeHook("stop");
    const w = readRegistryFile().workers[PROJECT][0] as { claudeStatus: string; pendingReviewAt?: number };
    expect(w.claudeStatus).toBe("idle");
    expect(w.pendingReviewAt).toBeUndefined();
  });

  it("stop with commits ahead of base sets pendingReviewAt", async () => {
    seedRegistry("working");
    fs.writeFileSync(path.join(worktreePath, "ahead.txt"), "x\n");
    git(worktreePath, "add", "ahead.txt");
    git(worktreePath, "commit", "-m", "ahead");
    process.chdir(worktreePath);
    const { handleClaudeHook } = await import("../../src/dashboard/header.js");
    handleClaudeHook("stop");
    const w = readRegistryFile().workers[PROJECT][0] as { claudeStatus: string; pendingReviewAt?: number };
    expect(w.claudeStatus).toBe("idle");
    expect(typeof w.pendingReviewAt).toBe("number");
  });

  it("sessionstart sets ready when no source", async () => {
    seedRegistry("idle");
    process.chdir(worktreePath);
    const { handleClaudeHook } = await import("../../src/dashboard/header.js");
    handleClaudeHook("sessionstart");
    const w = readRegistryFile().workers[PROJECT][0] as { claudeStatus: string };
    expect(w.claudeStatus).toBe("ready");
  });

  it("ignores hook when cwd is outside any worktree", async () => {
    seedRegistry("working");
    process.chdir(env.home);
    const { handleClaudeHook } = await import("../../src/dashboard/header.js");
    handleClaudeHook("notification");
    const w = readRegistryFile().workers[PROJECT][0] as { claudeStatus: string };
    expect(w.claudeStatus).toBe("working");
  });

  it("ignores hook when GARDEN_REVIEWER=1 (reviewer hooks must not write registry)", async () => {
    seedRegistry("working");
    process.chdir(worktreePath);
    process.env.GARDEN_REVIEWER = "1";
    try {
      const { handleClaudeHook } = await import("../../src/dashboard/header.js");
      handleClaudeHook("notification");
      const w = readRegistryFile().workers[PROJECT][0] as { claudeStatus: string };
      expect(w.claudeStatus).toBe("working");
    } finally {
      delete process.env.GARDEN_REVIEWER;
    }
  });

  it("unknown event is a no-op", async () => {
    seedRegistry("working");
    process.chdir(worktreePath);
    const { handleClaudeHook } = await import("../../src/dashboard/header.js");
    handleClaudeHook("totally-not-an-event");
    const w = readRegistryFile().workers[PROJECT][0] as { claudeStatus: string };
    expect(w.claudeStatus).toBe("working");
  });
});

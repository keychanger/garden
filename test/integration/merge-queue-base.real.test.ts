// The merge queue's rebase decides which commits reach the base branch beside
// the reviewed ones, so it replays onto the base tip origin reports.
// refs/remotes/origin/<base> is in the shared git dir every worker sandbox can
// write, and mergeToBase's fast-forward check passes a forged base committed on
// top of origin's real tip: the rebase put the forged commits beneath the
// reviewed ones and the queue pushed them to the base.
//
// Drives poll() through merge-pending on real git, with tmux and the dashboard
// refresh mocked. The forgery lands right after the queue's own fetch of the
// base, through a hook on runGit, which is the window a worker's background
// process races in production.
import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { useGitTmpHome } from "./helpers.js";

// Runs after each git command garden's helpers issue.
const afterGit = vi.hoisted(() => ({ hook: undefined as undefined | ((args: readonly string[]) => void) }));
vi.mock("../../src/dashboard/git-exec.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/dashboard/git-exec.js")>();
  return {
    ...actual,
    runGit: (...call: Parameters<typeof actual.runGit>) => {
      const out = actual.runGit(...call);
      afterGit.hook?.(call[1]);
      return out;
    },
  };
});

const env = useGitTmpHome();

const PROJECT = "myproject";
const WORKER = "swift-oak";

vi.mock("../../src/dashboard/tmux.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/dashboard/tmux.js")>(
    "../../src/dashboard/tmux.js",
  );
  return {
    ...actual,
    tmux: vi.fn(),
    tmuxOutput: vi.fn(() => ""),
    windowExists: vi.fn(() => false),
    killWindowSafe: vi.fn(),
    getFirstPaneId: vi.fn(() => null),
    getPaneSize: vi.fn(() => null),
    setPaneVar: vi.fn(),
    listAllWindowNames: vi.fn(() => []),
  };
});

vi.mock("../../src/dashboard/header.js", () => ({
  refreshDashboard: vi.fn(),
  setupStatusBar: vi.fn(),
}));

vi.mock("../../src/dashboard/hotkeys.js", () => ({
  setupKeybindings: vi.fn(),
}));

vi.mock("../../src/dashboard/validate.js", () => ({
  healStatusPane: vi.fn(),
}));

vi.mock("../../src/dashboard/usage-poller.js", () => ({
  startUsagePoller: vi.fn(),
  stopUsagePoller: vi.fn(),
}));

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

let projectPath: string;
let originPath: string;
let worktreePath: string;

beforeEach(() => {
  vi.clearAllMocks();
  afterGit.hook = undefined;

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
  fs.writeFileSync(
    path.join(env.home, ".garden", "config.yml"),
    `projects:\n  ${PROJECT}:\n    path: ${projectPath}\n    logColor: red\n`,
  );
});

// A worker whose reviewed commit is pushed and cleared to merge.
async function mergePendingWorker(): Promise<string> {
  const { createWorktree } = await import("../../src/dashboard/git.js");
  createWorktree(projectPath, worktreePath, WORKER);
  fs.writeFileSync(path.join(worktreePath, "feature.txt"), "reviewed\n");
  git(worktreePath, "add", "feature.txt");
  git(worktreePath, "commit", "-m", "reviewed feature");
  git(worktreePath, "push", "origin", WORKER);
  const reviewed = git(worktreePath, "rev-parse", "HEAD");
  const { addWorker } = await import("../../src/dashboard/registry.js");
  addWorker(PROJECT, {
    name: WORKER,
    sessionId: "session-id-1",
    task: "",
    branchName: WORKER,
    baseBranch: "main",
    worktreePath,
    workflow: "default",
    prState: "merge-pending",
    agentStatus: "idle",
    mergePendingAt: new Date(Date.now() - 1000).toISOString(),
    mergeReadySha: reviewed,
  });
  return reviewed;
}

// A commit origin never received, built on top of origin's current main, the
// shape that passes mergeToBase's fast-forward check.
function smuggledOnTopOfOrigin(): string {
  const tip = git(originPath, "rev-parse", "main");
  git(projectPath, "checkout", "-q", "--detach", tip);
  fs.writeFileSync(path.join(projectPath, "smuggled.txt"), "never reviewed\n");
  git(projectPath, "add", "smuggled.txt");
  git(projectPath, "commit", "-q", "-m", "smuggled");
  const smuggled = git(projectPath, "rev-parse", "HEAD");
  git(projectPath, "checkout", "-q", "main");
  return smuggled;
}

// Point the shared tracking ref at `smuggled` the moment the queue's own fetch
// of the base returns, as a worker's background loop would.
function forgeBaseAfterFetch(smuggled: string): void {
  let forged = false;
  afterGit.hook = (args) => {
    if (forged || args[0] !== "fetch" || !args.includes("refs/heads/main")) return;
    forged = true;
    git(projectPath, "update-ref", "refs/remotes/origin/main", smuggled);
  };
}

describe("merge queue rebase target (real git)", () => {
  it("pushes only the reviewed commit when the tracking ref is forged after the fetch", async () => {
    const reviewed = await mergePendingWorker();
    forgeBaseAfterFetch(smuggledOnTopOfOrigin());

    const { poll } = await import("../../src/dashboard/poller.js");
    poll(PROJECT);

    const { findWorkerByName } = await import("../../src/dashboard/registry.js");
    expect(findWorkerByName(PROJECT, WORKER)?.prState).toBe("merged");
    expect(git(originPath, "rev-parse", "main")).toBe(reviewed);
    expect(git(originPath, "ls-tree", "--name-only", "main").split("\n")).not.toContain("smuggled.txt");
  });

  it("replays onto the tip origin moved to, not onto a forged one built on it", async () => {
    await mergePendingWorker();
    // A sibling merge moved origin's main on, so the queue really rebases.
    fs.writeFileSync(path.join(projectPath, "sibling.txt"), "merged first\n");
    git(projectPath, "add", "sibling.txt");
    git(projectPath, "commit", "-q", "-m", "sibling");
    git(projectPath, "push", "-q", "origin", "main");
    forgeBaseAfterFetch(smuggledOnTopOfOrigin());

    const { poll } = await import("../../src/dashboard/poller.js");
    poll(PROJECT);

    const { findWorkerByName } = await import("../../src/dashboard/registry.js");
    expect(findWorkerByName(PROJECT, WORKER)?.prState).toBe("merged");
    const onMain = git(originPath, "ls-tree", "--name-only", "main").split("\n");
    expect(onMain).toEqual(expect.arrayContaining(["feature.txt", "sibling.txt"]));
    expect(onMain).not.toContain("smuggled.txt");
  });
});

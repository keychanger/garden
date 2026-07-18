// Integration test for the botanist workflow's skip-review merge on real fs/git.
// Drives a botanist through the full publish → merge path: publishBotanistArtifact
// moves the drafted artifact to a tracked docs/ path, commits it, and marks the
// worker done; poll() then routes working → merge-pending → merged/done with NO
// reviewer window ever opened. Also verifies the writeable-path guard parks a
// code-committing botanist in `failing`.
//
// Tmux and dashboard refresh are mocked (no real panes); the merge itself runs
// real git against a bare origin.
import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { useGitTmpHome } from "./helpers.js";

const env = useGitTmpHome();

const PROJECT = "myproject";
const WORKER = "calm-fern";

vi.mock("../../src/dashboard/tmux.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/dashboard/tmux.js")>(
    "../../src/dashboard/tmux.js",
  );
  return {
    ...actual,
    tmux: vi.fn(),
    newDashboardWindow: vi.fn(),
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
vi.mock("../../src/dashboard/hotkeys.js", () => ({ setupKeybindings: vi.fn() }));
vi.mock("../../src/dashboard/validate.js", () => ({ healStatusPane: vi.fn() }));
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

  const configPath = path.join(env.home, ".garden", "config.yml");
  fs.writeFileSync(
    configPath,
    `projects:\n  ${PROJECT}:\n    path: ${projectPath}\n    logColor: red\n`,
  );
});

async function plantBotanist(fields: Record<string, unknown> = {}): Promise<void> {
  const { addWorker } = await import("../../src/dashboard/registry.js");
  addWorker(PROJECT, {
    name: WORKER,
    sessionId: "botanist-session",
    task: "",
    branchName: WORKER,
    baseBranch: "main",
    worktreePath,
    workflow: "botanist",
    prState: "working",
    agentStatus: "idle",
    ...fields,
  });
}

// Create the worktree and commit a file at `relPath`, then push the branch.
async function commitInWorktree(relPath: string, contents: string): Promise<void> {
  const { createWorktree } = await import("../../src/dashboard/git.js");
  createWorktree(projectPath, worktreePath, WORKER);
  const abs = path.join(worktreePath, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents);
  git(worktreePath, "add", relPath);
  git(worktreePath, "commit", "-m", `add ${relPath}`);
  git(worktreePath, "push", "origin", WORKER);
}

describe("botanist workflow — skip-review merge on real fs/git", () => {
  it("publishes an artifact and merges it with NO reviewer, finalizing to done", async () => {
    const { createWorktree } = await import("../../src/dashboard/git.js");
    const { publishBotanistArtifact, BOTANIST_ARTIFACT_REL } =
      await import("../../src/dashboard/botanist-publish.js");
    const { poll } = await import("../../src/dashboard/poller.js");
    const { findWorkerByName } = await import("../../src/dashboard/registry.js");
    const { newDashboardWindow } = await import("../../src/dashboard/tmux.js");

    await plantBotanist({ pendingReviewAt: Date.now() });
    createWorktree(projectPath, worktreePath, WORKER);

    // Draft the artifact, then publish it via the real handler (move → docs/,
    // commit, write .garden-done).
    fs.mkdirSync(path.join(worktreePath, ".garden", "botanist"), { recursive: true });
    fs.writeFileSync(path.join(worktreePath, BOTANIST_ARTIFACT_REL), "# Design\n\nApproved.\n");
    const result = publishBotanistArtifact(worktreePath, "docs/future/design.md");
    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(worktreePath, "docs/future/design.md"))).toBe(true);
    expect(fs.existsSync(path.join(worktreePath, ".garden-done"))).toBe(true);
    git(worktreePath, "push", "origin", WORKER);

    // First poll: skip-review routes working → merge-pending (no reviewer).
    poll(PROJECT);
    expect(findWorkerByName(PROJECT, WORKER)?.prState).toBe("merge-pending");

    // Drive the merge to completion.
    for (let i = 0; i < 4; i++) poll(PROJECT);

    const entry = findWorkerByName(PROJECT, WORKER);
    expect(["merged", "done"]).toContain(entry?.prState);

    // No reviewer window was ever opened.
    const reviewWindowOpened = vi.mocked(newDashboardWindow).mock.calls.some(
      c => typeof c[0] === "string" && c[0].includes("review"),
    );
    expect(reviewWindowOpened).toBe(false);

    // The artifact actually landed on origin/main.
    const mainFiles = git(projectPath, "ls-tree", "-r", "--name-only", "origin/main");
    expect(mainFiles).toContain("docs/future/design.md");
  });

  it("parks a botanist that committed code (outside docs/) in failing with botanist-scope", async () => {
    const { poll } = await import("../../src/dashboard/poller.js");
    const { findWorkerByName } = await import("../../src/dashboard/registry.js");
    const { newDashboardWindow } = await import("../../src/dashboard/tmux.js");

    await plantBotanist({ pendingReviewAt: Date.now() });
    await commitInWorktree("src-sneaky.ts", "// a botanist that drifted into building\n");

    poll(PROJECT);

    const entry = findWorkerByName(PROJECT, WORKER);
    expect(entry?.prState).toBe("failing");
    expect(entry?.failingReason).toBe("botanist-scope");

    // It did not merge and no reviewer ran.
    const reviewWindowOpened = vi.mocked(newDashboardWindow).mock.calls.some(
      c => typeof c[0] === "string" && c[0].includes("review"),
    );
    expect(reviewWindowOpened).toBe(false);
    const mainFiles = git(projectPath, "ls-tree", "-r", "--name-only", "origin/main");
    expect(mainFiles).not.toContain("src-sneaky.ts");
  });
});

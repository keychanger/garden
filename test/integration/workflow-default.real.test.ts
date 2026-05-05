// Integration test for the default workflow's full state machine. Drives a
// worker through working → reviewing → merge-pending → merged on real
// fs/git, asserting every transition. Validates that the registry-routed
// dispatcher (Phase 3 of WORKFLOWS.md) reaches the same handlers and
// produces the same lifecycle as the pre-refactor switch-on-prState
// dispatch.
//
// Tmux and dashboard refresh are mocked. The reviewer subprocess is not
// actually spawned — we simulate its exit by writing the result file and
// flipping windowExists to false before the next poll cycle.
import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { useGitTmpHome } from "./helpers.js";

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
let configPath: string;

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

  configPath = path.join(env.home, ".garden", "config.yml");
  fs.writeFileSync(
    configPath,
    `projects:\n  ${PROJECT}:\n    path: ${projectPath}\n    logColor: red\n`,
  );
});

async function makeWorker(fields: Record<string, unknown>): Promise<void> {
  const { addWorker } = await import("../../src/dashboard/registry.js");
  addWorker(PROJECT, {
    name: WORKER,
    sessionId: "session-id-1",
    task: "",
    branchName: WORKER,
    baseBranch: "main",
    worktreePath,
    workflow: "default",
    ...fields,
  });
}

describe("default workflow — full state machine drive (real fs/git)", () => {
  it("walks working → reviewing → merge-pending → merged via the registry-routed dispatcher", async () => {
    const { createWorktree } = await import("../../src/dashboard/git.js");
    createWorktree(projectPath, worktreePath, WORKER);

    // Worker creates a feature commit and pushes.
    fs.writeFileSync(path.join(worktreePath, "feature.txt"), "feature\n");
    git(worktreePath, "add", "feature.txt");
    git(worktreePath, "commit", "-m", "feature");
    git(worktreePath, "push", "origin", WORKER);

    const headSha = git(worktreePath, "rev-parse", "HEAD");

    // Stop hook (in production) would set pendingReviewAt; we stage that
    // explicitly here so handleWorking enters launchReview on the first poll.
    await makeWorker({
      prState: "working",
      claudeStatus: "idle",
      pendingReviewAt: Date.now(),
    });

    // --- Transition 1: working → reviewing ---
    const { poll } = await import("../../src/dashboard/poller.js");
    poll(PROJECT);

    const { findWorkerByName } = await import("../../src/dashboard/registry.js");
    let entry = findWorkerByName(PROJECT, WORKER);
    expect(entry?.prState).toBe("reviewing");
    expect(entry?.reviewWindowName).toBe(`_${PROJECT}-review-${WORKER}`);

    // The reviewer was "launched" — windowExists returned true on launch
    // (via the default mock), tmux new-window was called. Now simulate the
    // reviewer exiting cleanly: write a CLEAN verdict file in the location
    // the readReviewResult helper expects.
    const { reviewResultPath } = await import("../../src/dashboard/poller-review.js");
    const resultFile = reviewResultPath(PROJECT, WORKER);
    fs.mkdirSync(path.dirname(resultFile), { recursive: true });
    fs.writeFileSync(resultFile, "Looks great, no issues.\nCLEAN\n");

    // windowExists must now return false so handleReviewing sees the
    // reviewer as exited.
    const { windowExists } = await import("../../src/dashboard/tmux.js");
    vi.mocked(windowExists).mockReturnValue(false);

    // --- Transition 2: reviewing → merge-pending ---
    poll(PROJECT);

    entry = findWorkerByName(PROJECT, WORKER);
    expect(entry?.prState).toBe("merge-pending");
    expect(entry?.lastReviewBody).toContain("Looks great");

    // --- Transition 3: merge-pending → merged ---
    poll(PROJECT);

    entry = findWorkerByName(PROJECT, WORKER);
    expect(entry?.prState).toBe("merged");

    // origin/main now carries the worker's commit (fast-forward via refspec push).
    const originMainSha = git(originPath, "rev-parse", "main");
    expect(originMainSha).toBe(headSha);
  });

  it("legacy workers (workflow field absent) are dispatched through default", async () => {
    // Pre-refactor registry entries have no workflow field. The dispatcher
    // reads `entry.workflow ?? "default"`, so they walk the same lifecycle
    // as freshly-created workers without any migration.
    const { createWorktree } = await import("../../src/dashboard/git.js");
    createWorktree(projectPath, worktreePath, WORKER);

    fs.writeFileSync(path.join(worktreePath, "feature.txt"), "feature\n");
    git(worktreePath, "add", "feature.txt");
    git(worktreePath, "commit", "-m", "feature");
    git(worktreePath, "push", "origin", WORKER);

    // Note: explicitly omits workflow.
    const { addWorker } = await import("../../src/dashboard/registry.js");
    addWorker(PROJECT, {
      name: WORKER,
      sessionId: "legacy-session",
      task: "",
      branchName: WORKER,
      baseBranch: "main",
      worktreePath,
      prState: "working",
      claudeStatus: "idle",
      pendingReviewAt: Date.now(),
    });

    const { poll } = await import("../../src/dashboard/poller.js");
    poll(PROJECT);

    const { findWorkerByName } = await import("../../src/dashboard/registry.js");
    const entry = findWorkerByName(PROJECT, WORKER);
    expect(entry?.prState).toBe("reviewing");
    // workflow field still absent — the dispatcher didn't add it; it just
    // defaulted at lookup time. Future writes by newWorker stamp it; legacy
    // entries continue to read with `?? "default"` until they go through
    // a write that sets it explicitly.
    expect(entry?.workflow).toBeUndefined();
  });
});

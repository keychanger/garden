// Integration tests for the poller's failure paths. Real fs, real git,
// real registry/state. Tmux + dashboard refresh are mocked because we
// don't want to actually spawn tmux windows or refresh a status pane;
// we control the "did the reviewer window exit" signal via the
// windowExists mock.
//
// The closest happy-path counterpart in the unit tier is test/poller.test.ts,
// which mocks git/registry/state too. These tests cover the three failure
// modes that strand workers in production but are only verified at the
// unit tier today: resolver budget exhausted, reviewer exited with no
// verdict, and merge succeeded but local fast-forward failed.

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

  // Real bare origin so push/fetch/ls-remote work.
  originPath = path.join(env.home, "origin.git");
  spawnSync("git", ["init", "--bare", "-b", "main", originPath], { stdio: "ignore" });

  // Main project checkout — what the operator works in directly.
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

  // Garden config — the poller reads this to find the project path.
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
    ...fields,
  });
}

async function readAlertsForWorker(): Promise<string[]> {
  const { readAlerts } = await import("../../src/dashboard/alerts.js");
  return readAlerts().alerts
    .filter(a => a.worker === WORKER)
    .map(a => a.message);
}

describe("poller failure modes (real fs/git, mocked tmux/dashboard)", () => {
  describe("resolver budget exhausted", () => {
    it("escalates to failing with an alert listing unmerged files when budget is hit", async () => {
      // Set up: worker has merged changes; main has advanced with a conflicting
      // change. handleMergePending will rebase and hit a conflict.
      const { createWorktree } = await import("../../src/dashboard/git.js");
      createWorktree(projectPath, worktreePath, WORKER);

      // Worker commit modifying shared.txt.
      fs.writeFileSync(path.join(worktreePath, "shared.txt"), "branch version\n");
      git(worktreePath, "add", "shared.txt");
      git(worktreePath, "commit", "-m", "branch change");
      git(worktreePath, "push", "origin", WORKER);

      // Main advances with a conflicting change to shared.txt.
      fs.writeFileSync(path.join(projectPath, "shared.txt"), "main version\n");
      git(projectPath, "add", "shared.txt");
      git(projectPath, "commit", "-m", "main change");
      git(projectPath, "push", "origin", "main");

      // Worker is in merge-pending and has already exhausted its retry budget.
      // launchResolver is called from handleMergePending on conflict; the
      // budget check at the top sends control to escalateResolveBudget, which
      // raises the alert and transitions to failing.
      await makeWorker({
        prState: "merge-pending",
        mergePendingAt: new Date().toISOString(),
        resolveAttempts: 2, // RESOLVE_BUDGET, so the next launch escalates
      });

      const { poll } = await import("../../src/dashboard/poller.js");
      poll(PROJECT);

      const { findWorkerByName } = await import("../../src/dashboard/registry.js");
      const entry = findWorkerByName(PROJECT, WORKER);
      expect(entry?.prState).toBe("failing");
      expect(entry?.failCount).toBe(1);

      const messages = await readAlertsForWorker();
      const escalation = messages.find(m => m.includes("resolver could not fix"));
      expect(escalation).toBeDefined();
      // handleMergePending aborts the rebase before calling launchResolver,
      // so by the time escalateResolveBudget runs there are no unmerged paths
      // to report — the message gracefully falls back to that explanation.
      expect(escalation).toContain("after 2 attempts");
      expect(escalation).toContain("rebase was aborted between runs");
    });
  });

  describe("reviewer exits with no verdict file", () => {
    it("transitions to failing when the reviewer window is gone and no result was written", async () => {
      const { createWorktree } = await import("../../src/dashboard/git.js");
      createWorktree(projectPath, worktreePath, WORKER);

      // Worker has commits past origin/main so handleReviewing's worker-pushed
      // detection doesn't fire (it would if remoteSha != lastSeenSha).
      fs.writeFileSync(path.join(worktreePath, "feature.txt"), "feature\n");
      git(worktreePath, "add", "feature.txt");
      git(worktreePath, "commit", "-m", "feature");
      git(worktreePath, "push", "origin", WORKER);

      const headSha = git(worktreePath, "rev-parse", "HEAD");

      // Worker is in "reviewing" with a window that no longer exists (mocked
      // windowExists returns false). The reviewer is expected to have
      // produced result.txt, but we deliberately don't create it — this is
      // the bug class where Claude crashed mid-write or the window was killed
      // externally.
      await makeWorker({
        prState: "reviewing",
        reviewWindowName: `_${PROJECT}-review-${WORKER}`,
        reviewStartedAt: Date.now() - 60_000,
        lastSeenSha: headSha, // matches remote so no worker-pushed reset
        preReviewSha: headSha, // no head advancement so no retry path
      });

      const { poll } = await import("../../src/dashboard/poller.js");
      poll(PROJECT);

      const { findWorkerByName } = await import("../../src/dashboard/registry.js");
      const entry = findWorkerByName(PROJECT, WORKER);
      expect(entry?.prState).toBe("failing");
      expect(entry?.failCount).toBe(1);
      // Phase 2 fix: failingSha is now set so handleFailing's debounce gate
      // refuses to retry the same broken commit (test/poller.test.ts asserts
      // the same behavior with mocked git).
      expect(entry?.failingSha).toBe(headSha);

      const messages = await readAlertsForWorker();
      expect(messages.find(m => m.includes("Claude unavailable or unparseable output"))).toBeDefined();
    });
  });

  describe("merge succeeds but local fast-forward fails", () => {
    it("alerts on checkout drift and still completes the merge", async () => {
      const { createWorktree } = await import("../../src/dashboard/git.js");
      createWorktree(projectPath, worktreePath, WORKER);

      fs.writeFileSync(path.join(worktreePath, "feature.txt"), "feature\n");
      git(worktreePath, "add", "feature.txt");
      git(worktreePath, "commit", "-m", "feature");
      git(worktreePath, "push", "origin", WORKER);

      // Force the local main checkout off the base branch so fastForwardBase
      // bails (currentBranch !== baseBranch). This is one of the conditions
      // the operator hits when they manually checkout a feature branch and
      // forget to switch back.
      git(projectPath, "checkout", "-b", "operator-manual");

      await makeWorker({
        prState: "merge-pending",
        mergePendingAt: new Date().toISOString(),
      });

      const { poll } = await import("../../src/dashboard/poller.js");
      poll(PROJECT);

      const { findWorkerByName } = await import("../../src/dashboard/registry.js");
      const entry = findWorkerByName(PROJECT, WORKER);
      // The merge to origin/main succeeds (mergeToBase pushes via refspec, no
      // local checkout needed); finalizeMerge transitions to merged regardless
      // of whether the local FF lands.
      expect(entry?.prState).toBe("merged");

      // Origin/main carries the worker's commit.
      const originMainSha = git(originPath, "rev-parse", "main");
      const workerSha = git(worktreePath, "rev-parse", "HEAD");
      expect(originMainSha).toBe(workerSha);

      // But the alert fires because the local main checkout is on a different
      // branch and could not fast-forward. The off-base message names both
      // the worker's base and the current checkout so the operator knows
      // exactly what diverged.
      const messages = await readAlertsForWorker();
      expect(messages.find(m =>
        m.includes("merged to origin/main") && m.includes("operator-manual"),
      )).toBeDefined();
    });
  });
});

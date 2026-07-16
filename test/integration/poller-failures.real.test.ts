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

// The Haiku verdict-extraction fallback shells out to `claude -p`, which is
// neither available nor authed in CI. Mock it so each test controls whether the
// classifier "recovers" a verdict; a live call would just fail to null anyway.
vi.mock("../../src/dashboard/verdict-extract.js", () => ({
  extractReviewVerdict: vi.fn(() => null),
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
    it("transitions to failing when the reviewer window is gone, no result was written, and the retry budget is spent", async () => {
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
        preReviewSha: headSha, // no head advancement so no reviewer-commit retry
        // At the no-commit retry budget (MAX_UNPARSEABLE_REVIEW_RETRIES=2), so a
        // persistently-absent result file escalates to failing instead of
        // re-queuing another review. A fresh worker (count 0) would auto-retry.
        unparseableRetryCount: 2,
      });

      const { poll } = await import("../../src/dashboard/poller.js");
      poll(PROJECT);

      const { findWorkerByName } = await import("../../src/dashboard/registry.js");
      const entry = findWorkerByName(PROJECT, WORKER);
      expect(entry?.prState).toBe("failing");
      expect(entry?.failCount).toBe(1);
      expect(entry?.failingReason).toBe("unparseable-verdict");
      // Phase 2 fix: failingSha is now set so handleFailing's debounce gate
      // refuses to retry the same broken commit (test/poller.test.ts asserts
      // the same behavior with mocked git).
      expect(entry?.failingSha).toBe(headSha);

      const messages = await readAlertsForWorker();
      expect(messages.find(m => m.includes("Claude unavailable or unparseable output"))).toBeDefined();
    });
  });

  describe("reviewer reached a verdict but didn't format the token (Haiku fallback)", () => {
    it("recovers the verdict via Haiku extraction and dispatches to merge-pending instead of re-reviewing", async () => {
      const { createWorktree } = await import("../../src/dashboard/git.js");
      createWorktree(projectPath, worktreePath, WORKER);

      fs.writeFileSync(path.join(worktreePath, "feature.txt"), "feature\n");
      git(worktreePath, "add", "feature.txt");
      git(worktreePath, "commit", "-m", "feature");
      git(worktreePath, "push", "origin", WORKER);
      const headSha = git(worktreePath, "rev-parse", "HEAD");

      // The reviewer wrote a real conclusion but trailed off in prose — the
      // exact shape from the operator's screenshot — so parseLastLineVerdict
      // returns null even though the review clearly passed.
      const { reviewResultPath } = await import("../../src/dashboard/poller-review.js");
      fs.writeFileSync(
        reviewResultPath(PROJECT, WORKER),
        "Reviewed the diff and reran the suite.\n"
          + "Final suite is green (2609 unit + 103 integration, lint clean).\n",
      );

      // Haiku reads that output and classifies it FIXED.
      const { extractReviewVerdict } = await import("../../src/dashboard/verdict-extract.js");
      vi.mocked(extractReviewVerdict).mockReturnValue("FIXED");

      await makeWorker({
        prState: "reviewing",
        reviewWindowName: `_${PROJECT}-review-${WORKER}`,
        reviewStartedAt: Date.now() - 60_000,
        lastSeenSha: headSha,   // remote matches: not a worker-pushed reset
        preReviewSha: headSha,  // no head advancement
      });

      const { poll } = await import("../../src/dashboard/poller.js");
      poll(PROJECT);

      const { findWorkerByName } = await import("../../src/dashboard/registry.js");
      const entry = findWorkerByName(PROJECT, WORKER);
      expect(vi.mocked(extractReviewVerdict)).toHaveBeenCalledOnce();
      // Dispatched as a real FIXED verdict: merge-pending, not failing/re-review.
      expect(entry?.prState).toBe("merge-pending");
      expect(entry?.failingReason).toBeUndefined();
      // The durable snapshot records the recovered verdict and the reviewer's
      // own prose as the body.
      expect(entry?.lastReview?.verdict).toBe("fixed");
      expect(entry?.lastReview?.body).toContain("Final suite is green");
    });

    it("falls through to the existing re-review recovery when Haiku cannot recover a verdict", async () => {
      const { createWorktree } = await import("../../src/dashboard/git.js");
      createWorktree(projectPath, worktreePath, WORKER);

      fs.writeFileSync(path.join(worktreePath, "feature.txt"), "feature\n");
      git(worktreePath, "add", "feature.txt");
      git(worktreePath, "commit", "-m", "feature");
      git(worktreePath, "push", "origin", WORKER);
      const headSha = git(worktreePath, "rev-parse", "HEAD");

      const { reviewResultPath } = await import("../../src/dashboard/poller-review.js");
      fs.writeFileSync(
        reviewResultPath(PROJECT, WORKER),
        "I kicked off an async sub-analysis and will report back later.\n",
      );

      // Haiku also can't tell — returns null (the mock's default).
      const { extractReviewVerdict } = await import("../../src/dashboard/verdict-extract.js");
      vi.mocked(extractReviewVerdict).mockReturnValue(null);

      await makeWorker({
        prState: "reviewing",
        reviewWindowName: `_${PROJECT}-review-${WORKER}`,
        reviewStartedAt: Date.now() - 60_000,
        lastSeenSha: headSha,
        preReviewSha: headSha,
        // At the no-commit retry budget so the fall-through escalates to failing.
        unparseableRetryCount: 2,
      });

      const { poll } = await import("../../src/dashboard/poller.js");
      poll(PROJECT);

      const { findWorkerByName } = await import("../../src/dashboard/registry.js");
      const entry = findWorkerByName(PROJECT, WORKER);
      expect(vi.mocked(extractReviewVerdict)).toHaveBeenCalledOnce();
      expect(entry?.prState).toBe("failing");
      expect(entry?.failingReason).toBe("unparseable-verdict");
    });
  });

  describe("merge succeeds while the checkout is parked off-base", () => {
    it("advances the local base ref without checking it out, and raises no alert", async () => {
      const { createWorktree } = await import("../../src/dashboard/git.js");
      createWorktree(projectPath, worktreePath, WORKER);

      fs.writeFileSync(path.join(worktreePath, "feature.txt"), "feature\n");
      git(worktreePath, "add", "feature.txt");
      git(worktreePath, "commit", "-m", "feature");
      git(worktreePath, "push", "origin", WORKER);

      // Park the main checkout on another branch — the deliberate many-base
      // workflow: the operator keeps the project checkout on one feature branch
      // while a worker merges into a different one. The local `main` ref simply
      // trails origin; it is not checked out anywhere.
      git(projectPath, "checkout", "-b", "operator-manual");

      await makeWorker({
        prState: "merge-pending",
        mergePendingAt: new Date().toISOString(),
      });

      const { poll } = await import("../../src/dashboard/poller.js");
      poll(PROJECT);

      const { findWorkerByName } = await import("../../src/dashboard/registry.js");
      expect(findWorkerByName(PROJECT, WORKER)?.prState).toBe("merged");

      // Origin/main carries the worker's commit...
      const originMainSha = git(originPath, "rev-parse", "main");
      const workerSha = git(worktreePath, "rev-parse", "HEAD");
      expect(originMainSha).toBe(workerSha);

      // ...and the local `main` ref was advanced to match it even though the
      // checkout stayed on operator-manual (ff via `fetch origin main:main`).
      expect(git(projectPath, "rev-parse", "main")).toBe(originMainSha);
      expect(git(projectPath, "rev-parse", "--abbrev-ref", "HEAD")).toBe("operator-manual");

      // A trailing-then-advanced ref is normal in this workflow — no alert.
      const messages = await readAlertsForWorker();
      expect(messages.find(m => /diverged|fast-forward/.test(m))).toBeUndefined();
    });

    it("warns and leaves the local ref untouched when local base has diverged from origin", async () => {
      const { createWorktree } = await import("../../src/dashboard/git.js");
      createWorktree(projectPath, worktreePath, WORKER);

      fs.writeFileSync(path.join(worktreePath, "feature.txt"), "feature\n");
      git(worktreePath, "add", "feature.txt");
      git(worktreePath, "commit", "-m", "feature");
      git(worktreePath, "push", "origin", WORKER);

      // Give local `main` a commit that was never pushed, so once the worker
      // merges into origin/main the two genuinely diverge (each has a commit
      // the other lacks). This is the lex case: the local ref is not merely
      // behind origin — it has its own history.
      fs.writeFileSync(path.join(projectPath, "local-only.txt"), "local\n");
      git(projectPath, "add", "local-only.txt");
      git(projectPath, "commit", "-m", "local-only work");
      const divergedSha = git(projectPath, "rev-parse", "main");
      git(projectPath, "checkout", "-b", "operator-manual");

      await makeWorker({
        prState: "merge-pending",
        mergePendingAt: new Date().toISOString(),
      });

      const { poll } = await import("../../src/dashboard/poller.js");
      poll(PROJECT);

      const { findWorkerByName } = await import("../../src/dashboard/registry.js");
      expect(findWorkerByName(PROJECT, WORKER)?.prState).toBe("merged");

      // The remote merge still landed; the local diverged ref was left alone.
      expect(git(originPath, "rev-parse", "main")).toBe(git(worktreePath, "rev-parse", "HEAD"));
      expect(git(projectPath, "rev-parse", "main")).toBe(divergedSha);

      // A warn-level alert names the divergence (1 ahead, 1 behind) rather than
      // suggesting a force update-ref that would silently drop the local commit.
      const { readAlerts } = await import("../../src/dashboard/alerts.js");
      const diverged = readAlerts().alerts.find(
        a => a.worker === WORKER && /diverged from origin \(1 ahead, 1 behind\)/.test(a.message),
      );
      expect(diverged).toBeDefined();
      expect(diverged?.level).toBe("warn");
    });
  });

  describe("merge already landed but finalization was interrupted", () => {
    // Models a finalizeMerge torn down between the base push and the terminal
    // transition (the poller is restarted mid-finalize when a garden binary
    // rebuild restarts every project's poller). The merge is on origin/<base>
    // and the remote branch has been deleted; on the next poll the naive path
    // would rebase + force-push HEAD:<branch>, hit --force-with-lease "stale
    // info" against the deleted branch, and bail the worker to `working`.
    async function setUpInterruptedMerge(): Promise<void> {
      const { createWorktree } = await import("../../src/dashboard/git.js");
      createWorktree(projectPath, worktreePath, WORKER);

      fs.writeFileSync(path.join(worktreePath, "feature.txt"), "feature\n");
      git(worktreePath, "add", "feature.txt");
      git(worktreePath, "commit", "-m", "feature");
      git(worktreePath, "push", "origin", WORKER);

      // The base push already happened: origin/main carries the worker's HEAD.
      git(worktreePath, "push", "origin", "HEAD:main");
      // And deleteRemoteBranch already ran — the remote branch is gone, which
      // is exactly what makes the naive force-with-lease retry fail.
      git(originPath, "branch", "-D", WORKER);
    }

    it("resumes to merged instead of stranding the worker in working", async () => {
      await setUpInterruptedMerge();
      await makeWorker({
        prState: "merge-pending",
        mergePendingAt: new Date().toISOString(),
      });

      const { poll } = await import("../../src/dashboard/poller.js");
      poll(PROJECT);

      const { findWorkerByName } = await import("../../src/dashboard/registry.js");
      const entry = findWorkerByName(PROJECT, WORKER);
      // The regression: the old path reverted to "working" (force-push stale
      // info) and left nothing to re-trigger it. The resume path completes
      // finalization.
      expect(entry?.prState).toBe("merged");

      // origin/main still carries the worker's commit — no second merge.
      expect(git(originPath, "rev-parse", "main"))
        .toBe(git(worktreePath, "rev-parse", "HEAD"));
    });

    it("resumes to done when the .garden-done sentinel is set (trellis ALIGNED)", async () => {
      await setUpInterruptedMerge();
      // ALIGNED writes the sentinel before going merge-pending; finalizeMerge
      // picks the terminal `done` state off it. The interrupted finalize must
      // preserve that on resume rather than landing on transient `merged`.
      fs.writeFileSync(path.join(worktreePath, ".garden-done"), "");
      await makeWorker({
        prState: "merge-pending",
        mergePendingAt: new Date().toISOString(),
      });

      const { poll } = await import("../../src/dashboard/poller.js");
      poll(PROJECT);

      const { findWorkerByName } = await import("../../src/dashboard/registry.js");
      const entry = findWorkerByName(PROJECT, WORKER);
      expect(entry?.prState).toBe("done");
    });
  });
});

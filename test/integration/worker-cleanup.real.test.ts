import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { useGitTmpHome } from "./helpers.js";

// runWorkerCleanup shells out to real git — the whole point of the module is
// that it reports what git actually said, so a mocked git would test nothing.
const env = useGitTmpHome();

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function branches(repo: string): string[] {
  return git(repo, "branch", "--format=%(refname:short)").split("\n").filter(Boolean);
}

let wtPath: string;

beforeEach(() => {
  // No origin remote: there is no remote branch to delete, so local cleanup
  // succeeds without turning the intentional absence into a retry.
  wtPath = path.join(
    env.home, ".garden", "worktrees", "leadingtone-io", "numb-clear-vow",
  );
  fs.mkdirSync(path.dirname(wtPath), { recursive: true });
  fs.writeFileSync(
    path.join(env.gardenDir, "config.yml"),
    `projects:\n  leadingtone-io:\n    path: ${env.repoPath}\n`,
  );
  git(env.repoPath, "worktree", "add", "-b", "numb-clear-vow", wtPath);
});

async function seed(overrides: Record<string, unknown> = {}) {
  const { writeWorkerCleanupRequest } = await import("../../src/dashboard/worker-cleanup.js");
  writeWorkerCleanupRequest({
    project: "leadingtone-io",
    worker: "numb-clear-vow",
    repoPath: env.repoPath,
    worktreePath: wtPath,
    branchName: "numb-clear-vow",
    attempts: 0,
    ...overrides,
  } as never);
  const { workerCleanupMarkerPath } = await import("../../src/dashboard/git.js");
  return workerCleanupMarkerPath("leadingtone-io", "numb-clear-vow");
}

describe("runWorkerCleanup (real git)", () => {
  it("removes the worktree and branch, then clears the request", async () => {
    const { runWorkerCleanup } = await import("../../src/dashboard/worker-cleanup.js");
    const file = await seed();

    runWorkerCleanup("leadingtone-io", "numb-clear-vow");

    expect(fs.existsSync(wtPath)).toBe(false);
    expect(branches(env.repoPath)).not.toContain("numb-clear-vow");
    expect(fs.existsSync(file)).toBe(false);
  });

  it("keeps the request and records the error when git cannot act", async () => {
    // The motivating failure: the removing process cannot write the project
    // checkout. An unreadable repo path reproduces git's refusal without
    // needing a sandbox.
    const { runWorkerCleanup, readWorkerCleanupRequest } =
      await import("../../src/dashboard/worker-cleanup.js");
    const file = await seed();
    const hiddenRepo = `${env.repoPath}.temporarily-unavailable`;
    fs.renameSync(env.repoPath, hiddenRepo);

    runWorkerCleanup("leadingtone-io", "numb-clear-vow");
    fs.renameSync(hiddenRepo, env.repoPath);

    // Nothing was destroyed, and the request survives for the watchdog retry.
    expect(fs.existsSync(wtPath)).toBe(true);
    expect(branches(env.repoPath)).toContain("numb-clear-vow");
    const req = readWorkerCleanupRequest(file);
    expect(req?.attempts).toBe(1);
    expect(req?.lastError).toBeTruthy();
  });

  it("finishes a partially-completed cleanup instead of re-reporting it", async () => {
    // A retry runs after the worktree removal already succeeded. Each step is
    // guarded by its own existence check, so the branch delete still happens
    // and the run counts as a success.
    const { runWorkerCleanup } = await import("../../src/dashboard/worker-cleanup.js");
    const file = await seed({ attempts: 1 });
    git(env.repoPath, "worktree", "remove", wtPath, "--force");

    runWorkerCleanup("leadingtone-io", "numb-clear-vow");

    expect(branches(env.repoPath)).not.toContain("numb-clear-vow");
    expect(fs.existsSync(file)).toBe(false);
  });

  it("prunes a stale admin entry so a hand-deleted worktree can still be cleaned", async () => {
    // An operator `rm -rf` (or a half-finished removal) leaves .git/worktrees
    // still claiming the branch is checked out, which makes `branch -D` fail.
    // Without the prune the cleanup could never complete.
    const { runWorkerCleanup } = await import("../../src/dashboard/worker-cleanup.js");
    const file = await seed();
    fs.rmSync(wtPath, { recursive: true, force: true });

    runWorkerCleanup("leadingtone-io", "numb-clear-vow");

    expect(branches(env.repoPath)).not.toContain("numb-clear-vow");
    expect(fs.existsSync(file)).toBe(false);
  });

  it("gives up with an alert once the attempt budget is spent", async () => {
    const { runWorkerCleanup, CLEANUP_MAX_ATTEMPTS } =
      await import("../../src/dashboard/worker-cleanup.js");
    const { readAlerts } = await import("../../src/dashboard/alerts.js");
    const file = await seed({ attempts: CLEANUP_MAX_ATTEMPTS - 1 });
    const hiddenRepo = `${env.repoPath}.temporarily-unavailable`;
    fs.renameSync(env.repoPath, hiddenRepo);

    runWorkerCleanup("leadingtone-io", "numb-clear-vow");
    fs.renameSync(hiddenRepo, env.repoPath);

    // The request is retired so the standing leak is reported by the orphan
    // sweep (which names size and age) rather than by an endless retry — and
    // so resurrect/the orphan sweep stop reading it as "cleanup in flight".
    expect(fs.existsSync(file)).toBe(false);
    const alerts = readAlerts().alerts.filter(a => a.source === "cleanup");
    expect(alerts).toHaveLength(1);
    expect(alerts[0].worker).toBe("numb-clear-vow");
    expect(alerts[0].message).toContain(wtPath);
  });

  it("does nothing when no request exists", async () => {
    const { runWorkerCleanup } = await import("../../src/dashboard/worker-cleanup.js");
    runWorkerCleanup("leadingtone-io", "never-requested");
    expect(fs.existsSync(wtPath)).toBe(true);
  });

  it("rejects a worker-writable request that targets a different branch", async () => {
    const { runWorkerCleanup } = await import("../../src/dashboard/worker-cleanup.js");
    const file = await seed({ branchName: "main" });

    runWorkerCleanup("leadingtone-io", "numb-clear-vow");

    expect(branches(env.repoPath)).toContain("main");
    expect(branches(env.repoPath)).toContain("numb-clear-vow");
    expect(fs.existsSync(wtPath)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("keeps the request when a configured origin cannot be inspected", async () => {
    const { runWorkerCleanup, readWorkerCleanupRequest } =
      await import("../../src/dashboard/worker-cleanup.js");
    const missingOrigin = path.join(env.home, "missing-origin.git");
    git(env.repoPath, "remote", "add", "origin", missingOrigin);
    const file = await seed();

    runWorkerCleanup("leadingtone-io", "numb-clear-vow");

    // Local cleanup may finish, but the request remains until Garden can prove
    // whether the configured remote branch still needs deletion.
    expect(readWorkerCleanupRequest(file)?.attempts).toBe(1);
    expect(readWorkerCleanupRequest(file)?.lastError).toContain("inspect origin branch");
  });
});

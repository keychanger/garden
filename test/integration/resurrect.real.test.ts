// Integration test for `garden resurrect`'s worktree rebuild on real fs/git:
// the merged-before-kill case (branch restarts from origin/<base>), the
// unmerged-tip case (deleted branch's commits recovered from the object
// store), and adoption of a worktree the kill's background cleanup never
// removed. The dashboard is treated as not running (tmux mocked out), so the
// session-respawn leg defers to the next attach — that leg is the shared
// respawnWorkerWindow attach path, exercised by the dashboard itself.
import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { useGitTmpHome } from "./helpers.js";

const env = useGitTmpHome();

const PROJECT = "myproject";
const WORKER = "swift-oak";

vi.mock("../../src/session.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/session.js")>(
    "../../src/session.js",
  );
  return { ...actual, dashboardExists: vi.fn(() => false) };
});

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

let projectPath: string;
let originPath: string;
let worktreePath: string;
let transcriptPath: string;

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

  transcriptPath = path.join(env.home, "transcript.jsonl");
  fs.writeFileSync(transcriptPath, JSON.stringify({ type: "user", message: { content: "hello" } }) + "\n");

  fs.writeFileSync(
    path.join(env.home, ".garden", "config.yml"),
    `projects:\n  ${PROJECT}:\n    path: ${projectPath}\n    logColor: red\n`,
  );
});

async function tombstoneFor(entryOverrides: Record<string, unknown>) {
  const telemetry = await import("../../src/dashboard/telemetry.js");
  telemetry.recordWorkerRemoved(PROJECT, WORKER, 1_000, "default", {
    name: WORKER,
    sessionId: "session-1",
    task: "restore me",
    worktreePath,
    branchName: WORKER,
    baseBranch: "main",
    createdAt: 1_000,
    workflow: "default",
    transcriptPath,
    mergeCount: 2,
    holisticReviewedThroughMergeCount: 2,
    ...entryOverrides,
  });
  const { listTombstones } = await import("../../src/dashboard/resurrect.js");
  const t = listTombstones()[0];
  expect(t).toBeDefined();
  return t;
}

describe("resurrectWorker (real fs/git)", () => {
  it("rebuilds a fully-merged worker's worktree from origin/<base>", async () => {
    const mainSha = git(projectPath, "rev-parse", "origin/main");
    const t = await tombstoneFor({ lastSeenSha: mainSha }); // tip already merged

    const { resurrectWorker } = await import("../../src/dashboard/resurrect.js");
    const outcome = resurrectWorker(t);

    expect(outcome.startedFrom).toBe("origin/main");
    expect(outcome.resumed).toBe(false);
    expect(git(worktreePath, "rev-parse", "HEAD")).toBe(mainSha);
    expect(git(worktreePath, "rev-parse", "--abbrev-ref", "HEAD")).toBe(WORKER);

    const { findWorkerByName } = await import("../../src/dashboard/registry.js");
    const entry = findWorkerByName(PROJECT, WORKER);
    expect(entry).toBeTruthy();
    expect(entry?.agentStatus).toBe("idle");
    expect(entry?.prState).toBeUndefined();
    expect(entry?.mergeCount).toBe(2);
    expect(entry?.holisticReviewedThroughMergeCount).toBe(2);

    // Alive again: the tombstone no longer lists, and the ledger explains why.
    const { listTombstones } = await import("../../src/dashboard/resurrect.js");
    expect(listTombstones()).toHaveLength(0);
    const { readTelemetryEvents } = await import("../../src/dashboard/telemetry.js");
    expect(readTelemetryEvents().some(e => e.event === "worker.resurrected")).toBe(true);
  });

  it("restores unmerged work from the object store when the branch was deleted", async () => {
    // Simulate the killed worker's unmerged commit: create it on a branch,
    // then delete the branch — the commit survives unreferenced, exactly the
    // post-kill state.
    git(projectPath, "checkout", "-b", "scratch");
    fs.writeFileSync(path.join(projectPath, "wip.txt"), "unmerged work\n");
    git(projectPath, "add", "wip.txt");
    git(projectPath, "commit", "-m", "wip");
    const tipSha = git(projectPath, "rev-parse", "HEAD");
    git(projectPath, "checkout", "main");
    git(projectPath, "branch", "-D", "scratch");

    const t = await tombstoneFor({ lastSeenSha: tipSha });
    const { resurrectWorker } = await import("../../src/dashboard/resurrect.js");
    const outcome = resurrectWorker(t);

    expect(outcome.startedFrom).toBe(`unmerged tip ${tipSha.slice(0, 9)}`);
    expect(git(worktreePath, "rev-parse", "HEAD")).toBe(tipSha);
    expect(fs.readFileSync(path.join(worktreePath, "wip.txt"), "utf-8")).toBe("unmerged work\n");
    expect(outcome.notes.some(n => n.includes("recovered unmerged work"))).toBe(true);
  });

  it("adopts a worktree the kill's background cleanup never removed", async () => {
    const { createWorktree } = await import("../../src/dashboard/git.js");
    createWorktree(projectPath, worktreePath, WORKER);
    fs.writeFileSync(path.join(worktreePath, "uncommitted.txt"), "still here\n");

    const t = await tombstoneFor({});
    const { resurrectWorker } = await import("../../src/dashboard/resurrect.js");
    const outcome = resurrectWorker(t);

    expect(outcome.startedFrom).toBe("existing worktree");
    expect(fs.readFileSync(path.join(worktreePath, "uncommitted.txt"), "utf-8")).toBe("still here\n");
  });

  it("refuses a path that exists but is not a worktree", async () => {
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.writeFileSync(path.join(worktreePath, "junk.txt"), "not a worktree\n");

    const t = await tombstoneFor({});
    const { resurrectWorker } = await import("../../src/dashboard/resurrect.js");
    expect(() => resurrectWorker(t)).toThrow(/not a git worktree/);
  });
});

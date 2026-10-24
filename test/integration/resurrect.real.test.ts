// Integration test for `garden resurrect`'s worktree rebuild on real fs/git:
// the merged-before-kill case (branch restarts from origin/<base>), the
// unmerged-tip case (deleted branch's commits recovered from the object
// store), and adoption of a worktree the kill's background cleanup never
// removed. The dashboard is treated as not running (tmux mocked out), so the
// session-respawn leg defers to the next attach — that leg is the shared
// respawnWorkerWindow attach path, exercised by the dashboard itself.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

  it("rebuilds from a base that exists only as a local branch", async () => {
    git(projectPath, "checkout", "-q", "-b", "local-only");
    fs.writeFileSync(path.join(projectPath, "local.txt"), "local\n");
    git(projectPath, "add", "local.txt");
    git(projectPath, "commit", "-q", "-m", "local");
    const localSha = git(projectPath, "rev-parse", "HEAD");
    git(projectPath, "checkout", "-q", "main");
    const t = await tombstoneFor({ baseBranch: "local-only", lastSeenSha: localSha });

    const { resurrectWorker } = await import("../../src/dashboard/resurrect.js");
    const outcome = resurrectWorker(t);

    expect(outcome.startedFrom).toBe("local-only");
    expect(git(worktreePath, "rev-parse", "HEAD")).toBe(localSha);
  });

  // The dependency install runs unsandboxed, as the operator. A start point
  // that skipped review gets none: npm reads the tree's own .npmrc, whose keys
  // name programs npm runs itself, so --ignore-scripts does not confine it.
  // `node_modules` is the observable: npm creates it for a tree with a
  // dependency, so its absence means npm never ran rather than that this
  // particular script happened not to fire.
  describe("dependency installs", () => {
    const sentinel = () => path.join(env.home, "ran-as-operator");

    function commitPackageWithScripts() {
      fs.writeFileSync(path.join(projectPath, "package.json"), JSON.stringify({
        name: "victim",
        version: "1.0.0",
        scripts: { postinstall: "node mark.js" },
        dependencies: { "the-dep": `file:${path.join(env.home, "the-dep")}` },
      }));
      fs.writeFileSync(path.join(projectPath, "mark.js"), `require("fs").writeFileSync(${JSON.stringify(sentinel())}, "x");\n`);
      git(projectPath, "add", "package.json", "mark.js");
      git(projectPath, "commit", "-q", "-m", "scripts");
    }

    beforeEach(() => {
      vi.stubEnv("npm_config_offline", "true");
      vi.stubEnv("npm_config_audit", "false");
      vi.stubEnv("npm_config_fund", "false");
      vi.stubEnv("npm_config_update_notifier", "false");
      const dep = path.join(env.home, "the-dep");
      fs.mkdirSync(dep, { recursive: true });
      fs.writeFileSync(path.join(dep, "package.json"), JSON.stringify({ name: "the-dep", version: "1.0.0" }));
    });

    afterEach(() => { vi.unstubAllEnvs(); });

    it("skips the install when restoring an unmerged tip", async () => {
      git(projectPath, "checkout", "-q", "-b", "scratch");
      commitPackageWithScripts();
      const tipSha = git(projectPath, "rev-parse", "HEAD");
      git(projectPath, "checkout", "-q", "main");
      git(projectPath, "branch", "-D", "scratch");
      const t = await tombstoneFor({ lastSeenSha: tipSha });

      const { resurrectWorker } = await import("../../src/dashboard/resurrect.js");
      const outcome = resurrectWorker(t);

      expect(git(worktreePath, "rev-parse", "HEAD")).toBe(tipSha);
      expect(fs.existsSync(path.join(worktreePath, "node_modules"))).toBe(false);
      expect(fs.existsSync(sentinel())).toBe(false);
      expect(outcome.notes.some(n => n.includes("skipped review"))).toBe(true);
    });

    it("skips the install when adopting the worker's own leftover branch", async () => {
      git(projectPath, "checkout", "-q", "-b", WORKER);
      commitPackageWithScripts();
      git(projectPath, "checkout", "-q", "main");
      const t = await tombstoneFor({});

      const { resurrectWorker } = await import("../../src/dashboard/resurrect.js");
      const outcome = resurrectWorker(t);

      expect(outcome.startedFrom).toBe(`existing local branch ${WORKER}`);
      expect(fs.existsSync(path.join(worktreePath, "node_modules"))).toBe(false);
      expect(fs.existsSync(sentinel())).toBe(false);
    });

    it("skips the install for a base that exists only as a local branch", async () => {
      git(projectPath, "checkout", "-q", "-b", "local-only");
      commitPackageWithScripts();
      const localSha = git(projectPath, "rev-parse", "HEAD");
      git(projectPath, "checkout", "-q", "main");
      const t = await tombstoneFor({ baseBranch: "local-only", lastSeenSha: localSha });

      const { resurrectWorker } = await import("../../src/dashboard/resurrect.js");
      const outcome = resurrectWorker(t);

      expect(outcome.startedFrom).toBe("local-only");
      expect(fs.existsSync(path.join(worktreePath, "node_modules"))).toBe(false);
      expect(fs.existsSync(sentinel())).toBe(false);
    });

    it("skips the install for a base on origin the tombstone merely names", async () => {
      // baseBranch is copied from the registry, which a worker can write, so a
      // branch it pushed itself is not the project's reviewed base.
      git(projectPath, "checkout", "-q", "-b", "worker-pushed");
      commitPackageWithScripts();
      git(projectPath, "push", "-q", "origin", "worker-pushed");
      const pushedSha = git(projectPath, "rev-parse", "HEAD");
      git(projectPath, "checkout", "-q", "main");
      const t = await tombstoneFor({ baseBranch: "worker-pushed", lastSeenSha: pushedSha });

      const { resurrectWorker } = await import("../../src/dashboard/resurrect.js");
      const outcome = resurrectWorker(t);

      expect(outcome.startedFrom).toBe("origin/worker-pushed");
      expect(fs.existsSync(path.join(worktreePath, "node_modules"))).toBe(false);
      expect(fs.existsSync(sentinel())).toBe(false);
    });

    it("installs normally from the project's own base on origin", async () => {
      // The reviewed case: scripts run, as they must for native builds.
      commitPackageWithScripts();
      git(projectPath, "push", "-q", "origin", "main");
      const t = await tombstoneFor({ lastSeenSha: git(projectPath, "rev-parse", "origin/main") });

      const { resurrectWorker } = await import("../../src/dashboard/resurrect.js");
      const outcome = resurrectWorker(t);

      expect(outcome.startedFrom).toBe("origin/main");
      expect(fs.existsSync(path.join(worktreePath, "node_modules"))).toBe(true);
      expect(fs.existsSync(sentinel())).toBe(true);
      expect(outcome.notes.some(n => n.includes("skipped review"))).toBe(false);
    });
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

  it("rebuilds from the commit origin carries, not from a rewritten tracking ref", async () => {
    // This is the one start point whose dependencies are installed with their
    // package scripts, unsandboxed, as the operator — so the commit it starts
    // from must not be one a worker chose by rewriting the shared ref.
    const onOrigin = git(projectPath, "rev-parse", "refs/heads/main");
    fs.writeFileSync(path.join(projectPath, "smuggled.txt"), "never reviewed\n");
    git(projectPath, "add", "smuggled.txt");
    git(projectPath, "commit", "-q", "-m", "smuggled");
    const smuggled = git(projectPath, "rev-parse", "HEAD");
    git(projectPath, "reset", "-q", "--hard", onOrigin);
    // rebuildWorktree fetches first, which would heal the tracking ref — in the
    // live attack the rewrite lands after that fetch, a window too short to
    // schedule. Narrowing the fetch refspec reproduces the same end state.
    git(projectPath, "config", "remote.origin.fetch", "+refs/heads/nothing:refs/remotes/origin/nothing");
    git(projectPath, "update-ref", "refs/remotes/origin/main", smuggled);

    const t = await tombstoneFor({ lastSeenSha: onOrigin });
    const { resurrectWorker } = await import("../../src/dashboard/resurrect.js");
    const outcome = resurrectWorker(t);

    expect(outcome.startedFrom).toBe("origin/main");
    expect(git(worktreePath, "rev-parse", "HEAD")).toBe(onOrigin);
    expect(fs.existsSync(path.join(worktreePath, "smuggled.txt"))).toBe(false);
  });

  it("still rebuilds when origin cannot be asked, with nothing installed", async () => {
    // Resurrect is the emergency-recovery command, and origin being
    // unreachable is one of the times it is most needed. The local ref is
    // distrusted rather than refused: it rebuilds, installs nothing, and says so.
    git(projectPath, "config", "remote.origin.url", path.join(env.home, "gone.git"));
    const t = await tombstoneFor({ lastSeenSha: git(projectPath, "rev-parse", "refs/heads/main") });

    const { resurrectWorker } = await import("../../src/dashboard/resurrect.js");
    const outcome = resurrectWorker(t);

    expect(fs.existsSync(path.join(worktreePath, "README.md"))).toBe(true);
    expect(outcome.notes.some(n => n.includes("could not ask origin"))).toBe(true);
    expect(outcome.notes.some(n => n.includes("skipped review"))).toBe(true);
  });

  it("falls back to the local ref when origin names a commit the object store lacks", async () => {
    const localMain = git(projectPath, "rev-parse", "refs/heads/main");
    const other = path.join(env.home, "other-clone");
    spawnSync("git", ["clone", "-q", originPath, other], { stdio: "ignore" });
    git(other, "config", "user.email", "test@garden.local");
    git(other, "config", "user.name", "garden-test");
    fs.writeFileSync(path.join(other, "later.txt"), "later\n");
    git(other, "add", "later.txt");
    git(other, "commit", "-q", "-m", "later");
    git(other, "push", "-q", "origin", "main");
    // The fetch succeeds but brings nothing in, so ls-remote names a commit
    // this checkout has never seen.
    git(projectPath, "config", "remote.origin.fetch", "+refs/heads/nothing:refs/remotes/origin/nothing");

    const t = await tombstoneFor({ lastSeenSha: localMain });
    const { resurrectWorker } = await import("../../src/dashboard/resurrect.js");
    const outcome = resurrectWorker(t);

    expect(outcome.startedFrom).toBe("main");
    expect(git(worktreePath, "rev-parse", "HEAD")).toBe(localMain);
    expect(outcome.notes.some(n => n.includes("not in the local object store"))).toBe(true);
    expect(outcome.notes.some(n => n.includes("skipped review"))).toBe(true);
  });

  it("rebuilds from origin's own base ref, not a decoy that glob-matches it", async () => {
    // `git ls-remote origin refs/heads/main` tail-matches on component
    // boundaries, so a branch named `a/refs/heads/main` is also listed — and
    // listed FIRST, since refs sort lexicographically. Workers push branches
    // routinely, so taking the first line would let one steer every rebuild.
    const onOrigin = git(projectPath, "rev-parse", "refs/heads/main");
    fs.writeFileSync(path.join(projectPath, "smuggled.txt"), "never reviewed\n");
    git(projectPath, "add", "smuggled.txt");
    git(projectPath, "commit", "-q", "-m", "smuggled");
    const decoy = git(projectPath, "rev-parse", "HEAD");
    git(projectPath, "push", "-q", "origin", `${decoy}:refs/heads/a/refs/heads/main`);
    git(projectPath, "reset", "-q", "--hard", onOrigin);

    const t = await tombstoneFor({ lastSeenSha: onOrigin });
    const { resurrectWorker } = await import("../../src/dashboard/resurrect.js");
    resurrectWorker(t);

    expect(git(worktreePath, "rev-parse", "HEAD")).toBe(onOrigin);
    expect(fs.existsSync(path.join(worktreePath, "smuggled.txt"))).toBe(false);
  });

  it("leaves the rebuilt branch tracking its base", async () => {
    // Resolving the tip from origin means a SHA start point, which carries no
    // upstream of its own — and the worker rules have every worker check
    // `git log @{u}..HEAD` before ending a turn.
    const t = await tombstoneFor({ lastSeenSha: git(projectPath, "rev-parse", "refs/heads/main") });
    const { resurrectWorker } = await import("../../src/dashboard/resurrect.js");
    expect(resurrectWorker(t).startedFrom).toBe("origin/main");
    expect(git(worktreePath, "rev-parse", "--abbrev-ref", "@{u}")).toBe("origin/main");
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

  it("does not report a resurrection the registry could not record, and the retry adopts the tree", async () => {
    const registry = await import("../../src/dashboard/registry.js");
    registry.addWorker(PROJECT, { name: "calm-live-fir", sessionId: "s-live", task: "" });
    const t = await tombstoneFor({});
    const { resurrectWorker } = await import("../../src/dashboard/resurrect.js");

    // The registry file is intact, but stat fails on it for this whole run.
    const realStat = fs.statSync;
    const stat = vi.spyOn(fs, "statSync").mockImplementation(((file: fs.PathLike, ...rest: unknown[]) => {
      if (file === registry.REGISTRY_FILE) throw Object.assign(new Error("EIO"), { code: "EIO" });
      return (realStat as (...args: unknown[]) => unknown)(file, ...rest);
    }) as typeof fs.statSync);
    try {
      expect(() => resurrectWorker(t)).toThrow("could not be read");
    } finally {
      stat.mockRestore();
    }
    const { readTelemetryEvents } = await import("../../src/dashboard/telemetry.js");
    expect(readTelemetryEvents().some(e => e.event === "worker.resurrected")).toBe(false);
    expect(registry.findWorkerByName(PROJECT, WORKER)).toBeUndefined();

    expect(resurrectWorker(t).startedFrom).toBe("existing worktree");
    expect(registry.findWorkerByName(PROJECT, WORKER)).toBeTruthy();
    expect(registry.findWorkerByName(PROJECT, "calm-live-fir")).toBeTruthy();
  });

  it("refuses to race a detached kill cleanup that can still delete the worktree", async () => {
    const { createWorktree, workerCleanupMarkerPath } = await import("../../src/dashboard/git.js");
    createWorktree(projectPath, worktreePath, WORKER);
    const marker = workerCleanupMarkerPath(PROJECT, WORKER);
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, "");

    const t = await tombstoneFor({});
    const { resurrectWorker } = await import("../../src/dashboard/resurrect.js");
    expect(() => resurrectWorker(t)).toThrow(/cleanup.*still running/i);
  });

  it("refuses a path that exists but is not a worktree", async () => {
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.writeFileSync(path.join(worktreePath, "junk.txt"), "not a worktree\n");

    const t = await tombstoneFor({});
    const { resurrectWorker } = await import("../../src/dashboard/resurrect.js");
    expect(() => resurrectWorker(t)).toThrow(/not a git worktree/);
  });
});

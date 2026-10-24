import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { useGitTmpHome } from "./helpers.js";

// runWorkerCleanup shells out to real git — the whole point of the module is
// that it reports what git actually said, so a mocked git would test nothing.
const env = useGitTmpHome();

// What tmux reports, which is the test's choice: no dashboard by default, as on
// a CI runner, and the live-pane cases set panes explicitly.
// `panes: null` is a session that did not answer the listing, which is not the
// same as one with no panes: absence is only evidence when tmux gave it.
// `unreachable` is a tmux that answered nothing at all, as inside an agent
// sandbox, which every probe there reports exactly like no dashboard.
const tmuxView = vi.hoisted(() => ({
  dashboard: false,
  unreachable: false,
  panes: [] as { panePath: string; windowName?: string; atLeft?: boolean }[] | null,
}));
vi.mock("../../src/session.js", async (orig) => ({
  ...(await orig<typeof import("../../src/session.js")>()),
  dashboardExists: () => tmuxView.dashboard && !tmuxView.unreachable,
  dashboardReach: () => tmuxView.unreachable
    ? { state: "unreachable", detail: "error connecting to /private/tmp/tmux-501/default (Operation not permitted)" }
    : { state: tmuxView.dashboard ? "present" : "absent" },
}));
// Passes through to the real reap, so the daemon-kill case below still
// exercises it, while recording whether it was reached at all. `during` runs
// in its place in time, for a test that changes the tree while it reaps.
const reaped = vi.hoisted(() => ({ worktrees: [] as string[], during: undefined as undefined | (() => void) }));
vi.mock("../../src/dashboard/worker-reap.js", async (orig) => {
  const actual = await orig<typeof import("../../src/dashboard/worker-reap.js")>();
  return {
    ...actual,
    reapAndLog: (...args: Parameters<typeof actual.reapAndLog>) => {
      reaped.worktrees.push(args[2]);
      reaped.during?.();
      return actual.reapAndLog(...args);
    },
  };
});
vi.mock("../../src/dashboard/tmux.js", async (orig) => ({
  ...(await orig<typeof import("../../src/dashboard/tmux.js")>()),
  listSessionPanesOrNull: () => tmuxView.panes?.map((pane, i) => ({
    windowId: `@${i}`,
    windowName: pane.windowName ?? "main",
    paneId: `%${i}`,
    width: 80,
    height: 24,
    atLeft: pane.atLeft ?? false,
    panePath: pane.panePath,
  })) ?? null,
}));

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// The reap needs a readable process table; a sandboxed runner is denied `ps`
// and `lsof`, which is exactly the degradation the shipped code handles by
// leaving the work to the unsandboxed watchdog retry.
function processTableReadable(): boolean {
  const cwds = spawnSync("lsof", ["-d", "cwd", "-F", "pn"], { encoding: "utf8" });
  const ps = spawnSync("ps", ["-Ao", "pid,ppid"], { encoding: "utf8" });
  return !cwds.error && !ps.error
    && (cwds.stdout ?? "") !== "" && (ps.stdout ?? "") !== "";
}

function branches(repo: string): string[] {
  return git(repo, "branch", "--format=%(refname:short)").split("\n").filter(Boolean);
}

let wtPath: string;

beforeEach(() => {
  tmuxView.dashboard = false;
  tmuxView.unreachable = false;
  tmuxView.panes = [];
  reaped.worktrees = [];
  reaped.during = undefined;
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

  it("removes a husk whose admin entry is already gone", async () => {
    // The mirror of the case above, and the one that could never finish: the
    // directory survives while .git/worktrees/<name> does not. It is what a
    // half-completed removal leaves behind — the sandboxed fast path deletes
    // the admin entry, then is denied the directory — and `worktree remove`
    // refuses such a path ("is not a working tree") on every retry, so the
    // attempt budget burned out and the husk became a standing orphan.
    const { runWorkerCleanup } = await import("../../src/dashboard/worker-cleanup.js");
    const file = await seed();
    fs.rmSync(
      path.join(env.repoPath, ".git", "worktrees", "numb-clear-vow"),
      { recursive: true, force: true },
    );

    runWorkerCleanup("leadingtone-io", "numb-clear-vow");

    expect(fs.existsSync(wtPath)).toBe(false);
    expect(branches(env.repoPath)).not.toContain("numb-clear-vow");
    expect(fs.existsSync(file)).toBe(false);
  });

  it("removes a tree whose own .git file is gone while its admin entry remains", async () => {
    // The reverse of the husk above. Git deletes a worktree's entries in
    // readdir order, so a removal cut off part way (the 60s step timeout, a
    // killed process, an interrupted rm) can already have taken the tree's .git
    // file while leaving .git/worktrees/<name>. `worktree remove` then refuses
    // the path on every retry ("'<path>/.git' does not exist"), and the branch
    // still reads as checked out there, so `branch -D` failed with it.
    const { runWorkerCleanup } = await import("../../src/dashboard/worker-cleanup.js");
    const file = await seed();
    fs.rmSync(path.join(wtPath, ".git"));

    runWorkerCleanup("leadingtone-io", "numb-clear-vow");

    expect(fs.existsSync(wtPath)).toBe(false);
    expect(fs.existsSync(path.join(env.repoPath, ".git", "worktrees", "numb-clear-vow"))).toBe(false);
    expect(branches(env.repoPath)).not.toContain("numb-clear-vow");
    expect(fs.existsSync(file)).toBe(false);
  });

  it("recognizes the missing .git under the resolved path git recorded", async () => {
    // Git names the missing .git by the path it recorded at `worktree add`,
    // which is the resolved one, so under a symlinked ~/.garden the diagnostic
    // never spells the canonical path.
    const { runWorkerCleanup } = await import("../../src/dashboard/worker-cleanup.js");
    git(env.repoPath, "worktree", "remove", "--force", wtPath);
    const projectDir = path.dirname(wtPath);
    const resolvedDir = path.join(env.home, "elsewhere");
    fs.mkdirSync(resolvedDir);
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.symlinkSync(resolvedDir, projectDir);
    git(env.repoPath, "worktree", "add", wtPath, "numb-clear-vow");
    const file = await seed();
    fs.rmSync(path.join(wtPath, ".git"));

    runWorkerCleanup("leadingtone-io", "numb-clear-vow");

    expect(fs.existsSync(path.join(resolvedDir, "numb-clear-vow"))).toBe(false);
    expect(branches(env.repoPath)).not.toContain("numb-clear-vow");
    expect(fs.existsSync(file)).toBe(false);
  });

  it.each(["operator inspection", "is not a working tree"])(
    "preserves a locked worktree with reason '%s'", async (reason) => {
      const { runWorkerCleanup, readWorkerCleanupRequest } =
        await import("../../src/dashboard/worker-cleanup.js");
      const file = await seed();
      const uncommitted = path.join(wtPath, "uncommitted.txt");
      fs.writeFileSync(uncommitted, "keep this work");
      git(env.repoPath, "worktree", "lock", "--reason", reason, wtPath);

      runWorkerCleanup("leadingtone-io", "numb-clear-vow");

      expect(fs.existsSync(uncommitted)).toBe(true);
      expect(branches(env.repoPath)).toContain("numb-clear-vow");
      expect(readWorkerCleanupRequest(file)?.attempts).toBe(1);
      expect(readWorkerCleanupRequest(file)?.lastError).toContain("locked");
    },
  );

  it("preserves a locked worktree whose .git is gone, whatever its lock reason says", async () => {
    const { runWorkerCleanup, readWorkerCleanupRequest } =
      await import("../../src/dashboard/worker-cleanup.js");
    const file = await seed();
    const uncommitted = path.join(wtPath, "uncommitted.txt");
    fs.writeFileSync(uncommitted, "keep this work");
    git(env.repoPath, "worktree", "lock", "--reason",
      `fatal: validation failed, cannot remove working tree: '${wtPath}/.git' does not exist`, wtPath);
    fs.rmSync(path.join(wtPath, ".git"));

    runWorkerCleanup("leadingtone-io", "numb-clear-vow");

    expect(fs.existsSync(uncommitted)).toBe(true);
    expect(branches(env.repoPath)).toContain("numb-clear-vow");
    expect(readWorkerCleanupRequest(file)?.lastError).toContain("locked");
  });

  it("retries a husk when directory removal is denied", async () => {
    const { runWorkerCleanup, readWorkerCleanupRequest } =
      await import("../../src/dashboard/worker-cleanup.js");
    const file = await seed();
    fs.rmSync(path.join(env.repoPath, ".git", "worktrees", "numb-clear-vow"), {
      recursive: true, force: true,
    });
    const rmSync = fs.rmSync;
    const denied = vi.spyOn(fs, "rmSync").mockImplementation((target, options) => {
      if (target === wtPath) throw new Error("EACCES: permission denied");
      return rmSync(target, options);
    });
    try {
      runWorkerCleanup("leadingtone-io", "numb-clear-vow");
    } finally {
      denied.mockRestore();
    }

    expect(fs.existsSync(wtPath)).toBe(true);
    expect(readWorkerCleanupRequest(file)?.attempts).toBe(1);
    expect(readWorkerCleanupRequest(file)?.lastError).toContain("directory remove: Error: EACCES");

    runWorkerCleanup("leadingtone-io", "numb-clear-vow");

    expect(fs.existsSync(wtPath)).toBe(false);
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
    // `worktree remove` refuses a tree git no longer tracks, so the remedy
    // has to name the direct removal too.
    expect(alerts[0].message).toContain("rm -rf <path>");
  });

  it("does nothing when no request exists", async () => {
    const { runWorkerCleanup } = await import("../../src/dashboard/worker-cleanup.js");
    runWorkerCleanup("leadingtone-io", "never-requested");
    expect(fs.existsSync(wtPath)).toBe(true);
  });

  it("never runs a request found in the sessions dir, where any worker can write one", async () => {
    // Well-formed and naming this worker's own targets, as one an older build
    // wrote there would; a forged one looks the same.
    const { runWorkerCleanup } = await import("../../src/dashboard/worker-cleanup.js");
    const legacy = path.join(env.sessionsDir, "worker-cleanup-leadingtone-io-numb-clear-vow");
    fs.writeFileSync(legacy, JSON.stringify({
      project: "leadingtone-io",
      worker: "numb-clear-vow",
      repoPath: env.repoPath,
      worktreePath: wtPath,
      branchName: "numb-clear-vow",
      attempts: 0,
    }));

    runWorkerCleanup("leadingtone-io", "numb-clear-vow");

    expect(fs.existsSync(wtPath)).toBe(true);
    expect(git(wtPath, "rev-parse", "--is-inside-work-tree")).toBe("true");
    expect(branches(env.repoPath)).toContain("numb-clear-vow");
    expect(reaped.worktrees).toEqual([]);
  });

  it("rejects a request that targets a different branch", async () => {
    const { runWorkerCleanup } = await import("../../src/dashboard/worker-cleanup.js");
    const file = await seed({ branchName: "main" });

    runWorkerCleanup("leadingtone-io", "numb-clear-vow");

    expect(branches(env.repoPath)).toContain("main");
    expect(branches(env.repoPath)).toContain("numb-clear-vow");
    expect(fs.existsSync(wtPath)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });

  // End-to-end proof of the ordering the fix depends on: the daemon must be
  // dead BEFORE git removes the tree, or its next write recreates the path and
  // leaves the husk the watchdog reports as an orphaned worktree an hour later.
  it.skipIf(!processTableReadable())(
    "kills a daemonized process living in the worktree before removing it",
    async () => {
      const { runWorkerCleanup } = await import("../../src/dashboard/worker-cleanup.js");
      await seed();
      // Parent exits immediately, so the sleeper is reparented to init — the
      // shape that survives a pane kill and that ancestry checks miss.
      const started = spawnSync("sh", ["-c", "sleep 120 >/dev/null 2>&1 & echo $!"], {
        cwd: wtPath, encoding: "utf8",
      });
      const pid = Number.parseInt(started.stdout.trim(), 10);
      expect(Number.isSafeInteger(pid)).toBe(true);
      expect(alive(pid)).toBe(true);

      try {
        runWorkerCleanup("leadingtone-io", "numb-clear-vow");

        expect(alive(pid)).toBe(false);
        expect(fs.existsSync(wtPath)).toBe(false);
      } finally {
        try { process.kill(pid, "SIGKILL"); } catch { /* already reaped */ }
      }
    },
  );

  // A process the removed worker left running can put a link where its tree
  // was before the cleanup, or its retry, runs. Once the worker's own admin
  // entry is gone, git resolves the path it is given, so `worktree remove
  // --force` removed whatever worktree the link pointed at, uncommitted work
  // included.
  describe("a link planted at the worktree path", () => {
    function sibling(): string {
      const tree = path.join(path.dirname(wtPath), "tame-blue-fox");
      git(env.repoPath, "worktree", "add", "-q", "-b", "tame-blue-fox", tree);
      fs.writeFileSync(path.join(tree, "precious.txt"), "uncommitted");
      return tree;
    }

    it("is unlinked, leaving the worktree it points at", async () => {
      const { runWorkerCleanup } = await import("../../src/dashboard/worker-cleanup.js");
      const target = sibling();
      git(env.repoPath, "worktree", "remove", "--force", wtPath);
      fs.symlinkSync(target, wtPath);
      const file = await seed();

      runWorkerCleanup("leadingtone-io", "numb-clear-vow");

      expect(fs.readFileSync(path.join(target, "precious.txt"), "utf8")).toBe("uncommitted");
      expect(git(target, "rev-parse", "--is-inside-work-tree")).toBe("true");
      expect(fs.existsSync(path.join(env.repoPath, ".git", "worktrees", "tame-blue-fox"))).toBe(true);
      expect(() => fs.lstatSync(wtPath)).toThrow();
      // The reap is skipped too: it would sweep the link's target.
      expect(reaped.worktrees).toEqual([]);
      expect(branches(env.repoPath)).not.toContain("numb-clear-vow");
      expect(fs.existsSync(file)).toBe(false);
    });

    it("is caught when it is swapped in while the reap runs", async () => {
      const { runWorkerCleanup } = await import("../../src/dashboard/worker-cleanup.js");
      const target = sibling();
      // A husk: the admin entry is gone and the directory is back.
      git(env.repoPath, "worktree", "remove", "--force", wtPath);
      fs.mkdirSync(wtPath);
      reaped.during = () => {
        fs.rmdirSync(wtPath);
        fs.symlinkSync(target, wtPath);
      };
      const file = await seed();

      runWorkerCleanup("leadingtone-io", "numb-clear-vow");

      expect(reaped.worktrees).toEqual([wtPath]);
      expect(fs.readFileSync(path.join(target, "precious.txt"), "utf8")).toBe("uncommitted");
      expect(fs.existsSync(path.join(env.repoPath, ".git", "worktrees", "tame-blue-fox"))).toBe(true);
      expect(() => fs.lstatSync(wtPath)).toThrow();
      expect(fs.existsSync(file)).toBe(false);
    });
  });

  it("deletes origin's branch, not a tag that shares its name", async () => {
    const { runWorkerCleanup } = await import("../../src/dashboard/worker-cleanup.js");
    const origin = path.join(env.home, "origin.git");
    spawnSync("git", ["init", "--bare", "-q", "-b", "main", origin], { stdio: "ignore" });
    git(env.repoPath, "remote", "add", "origin", origin);
    // A worker can push a tag named after itself or a sibling. A bare-name
    // `push --delete` then fails as ambiguous on every attempt.
    git(env.repoPath, "push", "-q", "origin",
      "refs/heads/numb-clear-vow:refs/heads/numb-clear-vow",
      "refs/heads/numb-clear-vow:refs/tags/numb-clear-vow");
    const file = await seed();

    runWorkerCleanup("leadingtone-io", "numb-clear-vow");

    expect(git(env.repoPath, "ls-remote", "origin", "refs/heads/numb-clear-vow")).toBe("");
    expect(git(env.repoPath, "ls-remote", "origin", "refs/tags/numb-clear-vow")).not.toBe("");
    expect(fs.existsSync(file)).toBe(false);
  });

  it("leaves a worker whose pane is still running alone, whatever the registry says", async () => {
    // A sandboxed worker can delete a sibling's registry entry, and `garden
    // workers stop` run from a worker's pane removes the entry without being
    // able to kill the pane. The pane here is the visible one: no hidden
    // window carries the worker's name.
    const { runWorkerCleanup, readWorkerCleanupRequest } = await import("../../src/dashboard/worker-cleanup.js");
    fs.writeFileSync(path.join(wtPath, "precious.txt"), "uncommitted");
    const file = await seed();
    tmuxView.dashboard = true;
    tmuxView.panes = [{ panePath: path.join(env.home, "repo") }, { panePath: path.join(wtPath, "src") }];

    runWorkerCleanup("leadingtone-io", "numb-clear-vow");

    expect(fs.existsSync(path.join(wtPath, "precious.txt"))).toBe(true);
    expect(branches(env.repoPath)).toContain("numb-clear-vow");
    // Deferred, not failed: the retry finds it again and no attempt is spent.
    expect(readWorkerCleanupRequest(file)?.attempts).toBe(0);
  });

  it.each([
    ["the worktree root itself", () => wtPath],
    ["a directory inside it", () => path.join(wtPath, "src")],
  ])("leaves a worker alone when a pane's cwd is %s", async (_label, paneCwd) => {
    const { runWorkerCleanup, readWorkerCleanupRequest } = await import("../../src/dashboard/worker-cleanup.js");
    fs.writeFileSync(path.join(wtPath, "precious.txt"), "uncommitted");
    const file = await seed();
    tmuxView.dashboard = true;
    tmuxView.panes = [{ panePath: paneCwd() }];

    runWorkerCleanup("leadingtone-io", "numb-clear-vow");

    expect(fs.existsSync(path.join(wtPath, "precious.txt"))).toBe(true);
    expect(branches(env.repoPath)).toContain("numb-clear-vow");
    expect(readWorkerCleanupRequest(file)?.attempts).toBe(0);
  });

  it("defers a request that names only a branch while the worker's pane runs", async () => {
    // Validation passes such a request once the registry entry is gone, and
    // the entry lives where a worker can delete it. `branch -D` is refused for
    // a checked-out branch, but the origin delete would still run with the
    // operator's credentials and drop a live worker's pushed branch.
    const { runWorkerCleanup, readWorkerCleanupRequest } = await import("../../src/dashboard/worker-cleanup.js");
    const origin = path.join(env.home, "origin.git");
    spawnSync("git", ["init", "--bare", "-q", "-b", "main", origin], { stdio: "ignore" });
    git(env.repoPath, "remote", "add", "origin", origin);
    git(env.repoPath, "push", "-q", "origin", "refs/heads/numb-clear-vow:refs/heads/numb-clear-vow");
    const file = await seed({ worktreePath: undefined });
    tmuxView.dashboard = true;
    tmuxView.panes = [{ panePath: wtPath }];

    runWorkerCleanup("leadingtone-io", "numb-clear-vow");

    expect(git(env.repoPath, "ls-remote", "origin", "refs/heads/numb-clear-vow")).not.toBe("");
    expect(readWorkerCleanupRequest(file)?.attempts).toBe(0);
  });

  it("defers when the dashboard session does not answer the pane listing", async () => {
    // An empty listing and an unanswered one are different facts. Treating the
    // second as "no pane" reaps and removes on the strength of a question tmux
    // never answered.
    const { runWorkerCleanup, readWorkerCleanupRequest } = await import("../../src/dashboard/worker-cleanup.js");
    fs.writeFileSync(path.join(wtPath, "precious.txt"), "uncommitted");
    const file = await seed();
    tmuxView.dashboard = true;
    tmuxView.panes = null;

    runWorkerCleanup("leadingtone-io", "numb-clear-vow");

    expect(fs.existsSync(path.join(wtPath, "precious.txt"))).toBe(true);
    expect(branches(env.repoPath)).toContain("numb-clear-vow");
    expect(readWorkerCleanupRequest(file)?.attempts).toBe(0);
  });

  // garden/weak-tough-lynx, 2026-09-17: the cleanup a sandboxed `garden workers
  // stop` dispatched ran in that sandbox, where tmux answers nothing. Read as
  // "no dashboard", it went on while the worker's pane was still running, and
  // git removed what the sandbox allowed: not the worktree directory, but its
  // admin entry in the shared .git, and then the branch.
  it("defers, touching nothing, when tmux does not answer at all", async () => {
    const { runWorkerCleanup, readWorkerCleanupRequest } = await import("../../src/dashboard/worker-cleanup.js");
    const file = await seed();
    tmuxView.unreachable = true;
    // The sandbox may not write the worktree; a read-only tree stands in.
    const tree = [wtPath, ...fs.readdirSync(wtPath, { recursive: true }).map(p => path.join(wtPath, String(p)))];
    for (const p of [...tree].reverse()) fs.chmodSync(p, fs.statSync(p).mode & ~0o222);
    try {
      runWorkerCleanup("leadingtone-io", "numb-clear-vow");
    } finally {
      for (const p of tree) fs.chmodSync(p, fs.statSync(p).mode | 0o200);
    }

    expect(branches(env.repoPath)).toContain("numb-clear-vow");
    expect(git(wtPath, "rev-parse", "--is-inside-work-tree")).toBe("true");
    expect(reaped.worktrees).toEqual([]);
    expect(readWorkerCleanupRequest(file)?.attempts).toBe(0);
  });

  it("cleans up despite a poller or watchdog window sitting in the worktree", async () => {
    // Garden's own long-lived windows inherit the cwd of whichever client
    // spawned them, so a `garden` command run from inside a worktree parks one
    // there for the life of the dashboard. None of them is ever a worker, so
    // none is evidence that one is still alive.
    const { runWorkerCleanup } = await import("../../src/dashboard/worker-cleanup.js");
    const file = await seed();
    tmuxView.dashboard = true;
    tmuxView.panes = [
      { panePath: wtPath, windowName: "_garden-watchdog" },
      { panePath: path.join(wtPath, "src"), windowName: "_leadingtone-io-poller" },
      { panePath: wtPath, windowName: "_garden-logs" },
      { panePath: wtPath, windowName: "_garden-usage-poller" },
    ];

    runWorkerCleanup("leadingtone-io", "numb-clear-vow");

    expect(fs.existsSync(wtPath)).toBe(false);
    expect(branches(env.repoPath)).not.toContain("numb-clear-vow");
    expect(fs.existsSync(file)).toBe(false);
  });

  it("cleans up despite the visible window's left column sitting in the worktree", async () => {
    // The title, status and growhouse panes inherit the cwd `garden dashboard`
    // was launched from; none of them is ever a worker. The right slot of the
    // same window is, so it still defers.
    const { runWorkerCleanup, readWorkerCleanupRequest } = await import("../../src/dashboard/worker-cleanup.js");
    const file = await seed();
    tmuxView.dashboard = true;
    tmuxView.panes = [{ panePath: wtPath, windowName: "main", atLeft: false }];

    runWorkerCleanup("leadingtone-io", "numb-clear-vow");
    expect(fs.existsSync(wtPath)).toBe(true);
    expect(readWorkerCleanupRequest(file)?.attempts).toBe(0);

    tmuxView.panes = [
      { panePath: wtPath, windowName: "main", atLeft: true },
      { panePath: path.join(wtPath, "src"), windowName: "main", atLeft: true },
    ];
    runWorkerCleanup("leadingtone-io", "numb-clear-vow");

    expect(fs.existsSync(wtPath)).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("tells the operator once a deferral stops looking temporary", async () => {
    // While it defers, the request hides the worktree from the orphan sweep
    // and blocks resurrection, so a deferral nobody hears about is a leak
    // nothing reports. It still never counts an attempt: the give-up path
    // deletes the tree, and a live worker may be using it.
    const mod = await import("../../src/dashboard/worker-cleanup.js");
    const { readAlerts } = await import("../../src/dashboard/alerts.js");
    const file = await seed();
    tmuxView.dashboard = true;
    tmuxView.panes = [{ panePath: wtPath }];

    mod.runWorkerCleanup("leadingtone-io", "numb-clear-vow");
    const first = mod.readWorkerCleanupRequest(file);
    expect(first?.deferredSince).toBeGreaterThan(0);
    expect(readAlerts().alerts).toHaveLength(0);

    // Backdate the first deferral past the bound, as the next retry finds it.
    mod.writeWorkerCleanupRequest({
      ...first!,
      deferredSince: Date.now() - mod.CLEANUP_DEFER_ALERT_AFTER_MS - 1,
    });
    mod.runWorkerCleanup("leadingtone-io", "numb-clear-vow");

    const alerts = readAlerts().alerts;
    expect(alerts).toHaveLength(1);
    expect(alerts[0].level).toBe("warn");
    expect(alerts[0].message).toContain("deferred");
    expect(mod.readWorkerCleanupRequest(file)?.attempts).toBe(0);
    expect(fs.existsSync(wtPath)).toBe(true);

    // Said once, not on every retry two minutes apart.
    mod.runWorkerCleanup("leadingtone-io", "numb-clear-vow");
    expect(readAlerts().alerts).toHaveLength(1);
  });

  it("never reaps a worktree whose pane is still running", async () => {
    // The reap SIGKILLs every process whose cwd is inside the worktree, the
    // live worker's own agent included, so the defer has to come first. A
    // reorder leaves the tree intact, so every other assertion here still
    // passes while the sibling is killed.
    const { runWorkerCleanup } = await import("../../src/dashboard/worker-cleanup.js");
    await seed();
    tmuxView.dashboard = true;
    tmuxView.panes = [{ panePath: wtPath }];

    runWorkerCleanup("leadingtone-io", "numb-clear-vow");

    expect(reaped.worktrees).toEqual([]);
  });

  it("cleans up once no pane runs in the worktree", async () => {
    const { runWorkerCleanup } = await import("../../src/dashboard/worker-cleanup.js");
    const file = await seed();
    tmuxView.dashboard = true;
    // A sibling whose name extends this one's must not count as this worker.
    tmuxView.panes = [{ panePath: `${wtPath}-two` }, { panePath: env.repoPath }];

    runWorkerCleanup("leadingtone-io", "numb-clear-vow");

    expect(fs.existsSync(wtPath)).toBe(false);
    expect(branches(env.repoPath)).not.toContain("numb-clear-vow");
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

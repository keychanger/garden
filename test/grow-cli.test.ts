import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { useTmpHome, captureConsoleLog } from "./helpers.js";

// Tests for `garden workers new --workflow grow`. Uses the same
// real-temp-home pattern as trellis-cli.test.ts: a real project on disk
// (so resolveProject() returns a real config) plus mocked dashboard
// internals (so we don't actually spawn tmux panes). The dashboard's
// newWorker is mocked to return a fixed name; we assert on the options
// the CLI passed in plus the seed file written to disk.

vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../src/dashboard/workers.js", () => ({
  newWorker: vi.fn(() => "tall-fern"),
}));
// dispatchDelayedSeed spawns a detached `garden dashboard _seed-worker
// --delay-ms 6000 ...` Node child; harmless under {detached, stdio:ignore,
// unref()} but easier to assert against when stubbed. The convert path uses
// it directly when the branch is fully merged into base. Other exports of
// continue.js are unused by the workers CLI, so a partial mock is fine.
vi.mock("../src/dashboard/continue.js", () => ({
  dispatchDelayedSeed: vi.fn(),
}));

const env = useTmpHome();

async function importWorkersCmd() {
  return await import("../src/commands/workers.js");
}
async function importConfig() {
  return await import("../src/config.js");
}
async function importDashboardWorkers() {
  return await import("../src/dashboard/workers.js");
}

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

async function setupProject(name: string, opts: { maxGrow?: number } = {}): Promise<string> {
  const cfg = await importConfig();
  const projectDir = path.join(env.home, "projects", name);
  fs.mkdirSync(projectDir, { recursive: true });
  spawnSync("git", ["init", "-b", "main", projectDir], { stdio: "ignore" });
  git(projectDir, "config", "user.email", "test@garden.local");
  git(projectDir, "config", "user.name", "garden-test");
  fs.writeFileSync(path.join(projectDir, "README.md"), "# proj\n");
  git(projectDir, "add", ".");
  git(projectDir, "commit", "-m", "init");

  fs.mkdirSync(cfg.GARDEN_DIR, { recursive: true });
  cfg.saveConfig({
    projects: {
      [name]: {
        path: projectDir,
        ...(opts.maxGrow !== undefined ? { maxGrowIterations: opts.maxGrow } : {}),
      },
    },
  });
  return projectDir;
}

let savedPretty: string | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  savedPretty = process.env.GARDEN_PRETTY;
  process.env.GARDEN_PRETTY = "1";
});

afterEach(() => {
  if (savedPretty === undefined) delete process.env.GARDEN_PRETTY;
  else process.env.GARDEN_PRETTY = savedPretty;
});

describe("garden workers new --workflow grow", () => {
  it("plants a grow worker with --seed and the default maxIterations: 5", async () => {
    await setupProject("proj");
    const { workers } = await importWorkersCmd();
    const { newWorker } = await importDashboardWorkers();

    await captureConsoleLog(() =>
      workers(["new", "proj", "--workflow", "grow", "--seed", "harden auth flow"]),
    );

    expect(newWorker).toHaveBeenCalledWith(expect.objectContaining({
      projectName: "proj",
      workflow: "grow",
      grow: { seed: "harden auth flow", maxIterations: 5 },
      seedMessageFile: expect.stringMatching(/grow-seed-proj-\d+\.txt$/),
    }));
  });

  it("--max-iterations overrides the default budget", async () => {
    await setupProject("proj");
    const { workers } = await importWorkersCmd();
    const { newWorker } = await importDashboardWorkers();

    await captureConsoleLog(() =>
      workers([
        "new", "proj",
        "--workflow", "grow",
        "--seed", "polish",
        "--max-iterations", "10",
      ]),
    );

    expect(newWorker).toHaveBeenCalledWith(expect.objectContaining({
      grow: { seed: "polish", maxIterations: 10 },
    }));
  });

  it("project.maxGrowIterations applies when --max-iterations is omitted", async () => {
    await setupProject("proj", { maxGrow: 8 });
    const { workers } = await importWorkersCmd();
    const { newWorker } = await importDashboardWorkers();

    await captureConsoleLog(() =>
      workers(["new", "proj", "--workflow", "grow", "--seed", "x"]),
    );

    expect(newWorker).toHaveBeenCalledWith(expect.objectContaining({
      grow: { seed: "x", maxIterations: 8 },
    }));
  });

  it("--max-iterations beats project.maxGrowIterations", async () => {
    await setupProject("proj", { maxGrow: 8 });
    const { workers } = await importWorkersCmd();
    const { newWorker } = await importDashboardWorkers();

    await captureConsoleLog(() =>
      workers([
        "new", "proj",
        "--workflow", "grow",
        "--seed", "x",
        "--max-iterations", "3",
      ]),
    );

    expect(newWorker).toHaveBeenCalledWith(expect.objectContaining({
      grow: { seed: "x", maxIterations: 3 },
    }));
  });

  it("--seed-file reads from disk", async () => {
    const projectDir = await setupProject("proj");
    const seedFile = path.join(projectDir, "task.md");
    fs.writeFileSync(seedFile, "implement and harden the new module\n");

    const { workers } = await importWorkersCmd();
    const { newWorker } = await importDashboardWorkers();

    await captureConsoleLog(() =>
      workers([
        "new", "proj",
        "--workflow", "grow",
        "--seed-file", seedFile,
      ]),
    );

    expect(newWorker).toHaveBeenCalledWith(expect.objectContaining({
      grow: {
        seed: "implement and harden the new module",
        maxIterations: 5,
      },
    }));
  });

  it("--seed and --seed-file are mutually exclusive", async () => {
    await setupProject("proj");
    const { workers } = await importWorkersCmd();
    await expect(
      workers([
        "new", "proj",
        "--workflow", "grow",
        "--seed", "X",
        "--seed-file", "/tmp/never-read",
      ]),
    ).rejects.toThrow(/mutually exclusive/);
  });

  it("rejects an empty seed", async () => {
    await setupProject("proj");
    const { workers } = await importWorkersCmd();
    await expect(
      workers(["new", "proj", "--workflow", "grow", "--seed", "   "]),
    ).rejects.toThrow(/non-empty seed/);
  });

  it("requires --seed or --seed-file", async () => {
    await setupProject("proj");
    const { workers } = await importWorkersCmd();
    await expect(
      workers(["new", "proj", "--workflow", "grow"]),
    ).rejects.toThrow(/--seed/);
  });

  it("rejects --max-iterations < 1", async () => {
    await setupProject("proj");
    const { workers } = await importWorkersCmd();
    await expect(
      workers([
        "new", "proj",
        "--workflow", "grow",
        "--seed", "x",
        "--max-iterations", "0",
      ]),
    ).rejects.toThrow(/positive integer/);
  });

  it("accepts --model on grow workers and threads the pin to newWorker", async () => {
    await setupProject("proj");
    const { workers } = await importWorkersCmd();
    const { newWorker } = await importDashboardWorkers();
    await captureConsoleLog(() =>
      workers([
        "new", "proj",
        "--workflow", "grow",
        "--seed", "x",
        "--model", "deepseek-v4-flash",
      ]),
    );
    expect(newWorker).toHaveBeenCalledWith(
      expect.objectContaining({ workflow: "grow", model: "deepseek-v4-flash" }),
    );
  });

  it("rejects an empty --model value", async () => {
    await setupProject("proj");
    const { workers } = await importWorkersCmd();
    await expect(
      workers([
        "new", "proj",
        "--workflow", "grow",
        "--seed", "x",
        "--model", "  ",
      ]),
    ).rejects.toThrow(/--model requires a non-empty value/);
  });

  it("rejects --trellis on grow workers", async () => {
    await setupProject("proj");
    const { workers } = await importWorkersCmd();
    await expect(
      workers([
        "new", "proj",
        "--workflow", "grow",
        "--seed", "x",
        "--trellis", "auth",
      ]),
    ).rejects.toThrow(/--trellis can only be used with --workflow trellis/);
  });

  it("writes the iter-1 seed prompt to a file under SESSIONS_DIR/seeds", async () => {
    await setupProject("proj");
    const { workers } = await importWorkersCmd();
    const { newWorker } = await importDashboardWorkers();

    await captureConsoleLog(() =>
      workers([
        "new", "proj",
        "--workflow", "grow",
        "--seed", "polish auth",
        "--max-iterations", "3",
      ]),
    );

    const callArgs = vi.mocked(newWorker).mock.calls[0][0]!;
    const seedFile = callArgs.seedMessageFile!;
    expect(fs.existsSync(seedFile)).toBe(true);
    const content = fs.readFileSync(seedFile, "utf-8");
    expect(content).toContain("Grow loop, iteration 1 of 3");
    expect(content).toContain("polish auth");
    expect(content).toContain(".garden-done");
    expect(content).toContain(".garden/grow-log.md");
  });

  it("returns a friendly error when newWorker fails", async () => {
    await setupProject("proj");
    const { workers } = await importWorkersCmd();
    const { newWorker } = await importDashboardWorkers();
    vi.mocked(newWorker).mockReturnValueOnce(null);

    await expect(
      workers(["new", "proj", "--workflow", "grow", "--seed", "x"]),
    ).rejects.toThrow(/Failed to spawn grow worker/);
  });
});

describe("garden workers new --workflow default — grow flag rejection", () => {
  it("rejects --seed on default workflow", async () => {
    await setupProject("proj");
    const { workers } = await importWorkersCmd();
    await expect(
      workers(["new", "proj", "--seed", "x"]),
    ).rejects.toThrow(/can only be used with --workflow grow/);
  });

  it("rejects --seed-file on default workflow", async () => {
    await setupProject("proj");
    const { workers } = await importWorkersCmd();
    await expect(
      workers(["new", "proj", "--seed-file", "/tmp/x"]),
    ).rejects.toThrow(/can only be used with --workflow grow/);
  });

  it("rejects --max-iterations on default workflow", async () => {
    await setupProject("proj");
    const { workers } = await importWorkersCmd();
    await expect(
      workers(["new", "proj", "--max-iterations", "5"]),
    ).rejects.toThrow(/--max-iterations can only be used/);
  });
});

describe("--workflow whitelist", () => {
  it("rejects unknown workflows", async () => {
    await setupProject("proj");
    const { workers } = await importWorkersCmd();
    await expect(
      workers(["new", "proj", "--workflow", "loop"]),
    ).rejects.toThrow(/--workflow must be 'default', 'trellis', or 'grow'/);
  });
});

// =============================================================================
// `garden workers grow` — convert active default worker to grow
// =============================================================================

async function importRegistry() {
  return await import("../src/dashboard/registry.js");
}

async function addDefaultWorker(
  project: string, name: string, worktreePath: string,
): Promise<void> {
  const reg = await importRegistry();
  reg.addWorker(project, {
    name,
    sessionId: "sess-test",
    task: "",
    worktreePath,
    branchName: name,
    baseBranch: "main",
    workflow: "default",
  });
}

// Build a real git worktree branched off projectDir's main, with
// projectDir registered as `origin`. Mirrors the on-disk shape of a
// production worker worktree closely enough to exercise the convert
// path's git operations (rev-list, status, fetch, merge --ff-only).
function setupRealWorktree(projectDir: string, name: string): string {
  const wtPath = path.join(projectDir, "..", `wt-${name}`);
  fs.mkdirSync(wtPath, { recursive: true });
  spawnSync("git", ["init", "-b", name, wtPath], { stdio: "ignore" });
  git(wtPath, "config", "user.email", "test@garden.local");
  git(wtPath, "config", "user.name", "garden-test");
  git(wtPath, "remote", "add", "origin", projectDir);
  git(wtPath, "fetch", "origin", "main");
  git(wtPath, "reset", "--hard", "origin/main");
  // Production workers have `.garden/` listed in .git/info/exclude (added
  // by ensureWorktreeExcludes at plant time) so the goal file we write
  // doesn't show up in `git status` and doesn't trip the dirty check
  // during the post-flip fast-forward. Mirror that here.
  fs.appendFileSync(path.join(wtPath, ".git", "info", "exclude"), ".garden/\n");
  return wtPath;
}

// Add `count` commits to projectDir's main, simulating sibling merges that
// landed on the base branch after the worker's branch was merged. The
// worker's worktree is now `count` commits behind origin/main until it
// re-fetches.
function advanceOriginMain(projectDir: string, count: number): void {
  for (let i = 0; i < count; i++) {
    fs.writeFileSync(path.join(projectDir, `sibling-${Date.now()}-${i}.txt`), `${i}`);
    git(projectDir, "add", ".");
    git(projectDir, "commit", "-m", `sibling commit ${i}`);
  }
}

describe("garden workers grow (convert)", () => {
  let savedWorker: string | undefined;
  let savedProject: string | undefined;
  beforeEach(() => {
    savedWorker = process.env.GARDEN_WORKER;
    savedProject = process.env.GARDEN_PROJECT;
    delete process.env.GARDEN_WORKER;
    delete process.env.GARDEN_PROJECT;
  });
  afterEach(() => {
    if (savedWorker === undefined) delete process.env.GARDEN_WORKER;
    else process.env.GARDEN_WORKER = savedWorker;
    if (savedProject === undefined) delete process.env.GARDEN_PROJECT;
    else process.env.GARDEN_PROJECT = savedProject;
  });

  it("flips entry.workflow to 'grow' and stamps grow data with --seed", async () => {
    const projectDir = await setupProject("proj");
    const wtPath = path.join(projectDir, "..", "wt");
    fs.mkdirSync(wtPath, { recursive: true });
    await addDefaultWorker("proj", "tall-fern", wtPath);

    const { workers } = await importWorkersCmd();
    await captureConsoleLog(() =>
      workers(["grow", "tall-fern", "--seed", "harden auth"]),
    );

    const reg = await importRegistry();
    const entry = reg.findWorkerByName("proj", "tall-fern")!;
    expect(entry.workflow).toBe("grow");
    expect(entry.grow).toEqual({
      seed: "harden auth",
      iteration: 0,
      maxIterations: 5,
    });
  });

  it("writes the seed to .garden/grow-goal.md in the worktree", async () => {
    const projectDir = await setupProject("proj");
    const wtPath = path.join(projectDir, "..", "wt2");
    fs.mkdirSync(wtPath, { recursive: true });
    await addDefaultWorker("proj", "tall-fern", wtPath);

    const { workers } = await importWorkersCmd();
    await captureConsoleLog(() =>
      workers(["grow", "tall-fern", "--seed", "polish things"]),
    );

    const goalPath = path.join(wtPath, ".garden", "grow-goal.md");
    expect(fs.existsSync(goalPath)).toBe(true);
    // Goal file ends in a trailing newline (POSIX text-file convention) so
    // operators editing with `vim`/`echo >>` don't fight a no-eol marker.
    expect(fs.readFileSync(goalPath, "utf-8")).toBe("polish things\n");
  });

  it("self-resolves the worker via $GARDEN_WORKER when no positional arg is given", async () => {
    const projectDir = await setupProject("proj");
    const wtPath = path.join(projectDir, "..", "wt3");
    fs.mkdirSync(wtPath, { recursive: true });
    await addDefaultWorker("proj", "tall-fern", wtPath);
    process.env.GARDEN_WORKER = "tall-fern";

    const { workers } = await importWorkersCmd();
    await captureConsoleLog(() =>
      workers(["grow", "--seed", "from-env"]),
    );

    const reg = await importRegistry();
    expect(reg.findWorkerByName("proj", "tall-fern")!.workflow).toBe("grow");
  });

  it("errors with friendly message when neither arg nor env is set", async () => {
    await setupProject("proj");
    const { workers } = await importWorkersCmd();
    await expect(
      workers(["grow", "--seed", "x"]),
    ).rejects.toThrow(/Not in a worker shell.*GARDEN_WORKER/);
  });

  it("errors when the worker is not found in any project", async () => {
    await setupProject("proj");
    const { workers } = await importWorkersCmd();
    await expect(
      workers(["grow", "ghost", "--seed", "x"]),
    ).rejects.toThrow(/Worker 'ghost' not found in registry/);
  });

  it("rejects re-conversion of an already-grow worker", async () => {
    const projectDir = await setupProject("proj");
    const wtPath = path.join(projectDir, "..", "wt4");
    fs.mkdirSync(wtPath, { recursive: true });
    const reg = await importRegistry();
    reg.addWorker("proj", {
      name: "already-grown", sessionId: "s", task: "",
      worktreePath: wtPath, branchName: "already-grown", baseBranch: "main",
      workflow: "grow",
      grow: { seed: "old", iteration: 1, maxIterations: 5 },
    });

    const { workers } = await importWorkersCmd();
    // Re-conversion of a grow worker points the operator at the goal
    // file for amends, not at re-running the CLI. The error message must
    // include the absolute path so the operator can `vim` it directly
    // without piecing the path together themselves.
    await expect(
      workers(["grow", "already-grown", "--seed", "new"]),
    ).rejects.toThrow(/already on the 'grow' workflow/);
    await expect(
      workers(["grow", "already-grown", "--seed", "new"]),
    ).rejects.toThrow(/grow-goal\.md.*amend/);
  });

  it("rejects conversion of a trellis worker with workflow-specific guidance", async () => {
    const projectDir = await setupProject("proj");
    const wtPath = path.join(projectDir, "..", "wt5");
    fs.mkdirSync(wtPath, { recursive: true });
    const reg = await importRegistry();
    reg.addWorker("proj", {
      name: "vine", sessionId: "s", task: "",
      worktreePath: wtPath, branchName: "vine", baseBranch: "main",
      workflow: "trellis",
      trellis: { name: "auth", path: "/tmp/auth.md", iteration: 1, maxIterations: 30 },
    });

    const { workers } = await importWorkersCmd();
    // Trellis vines have no grow-goal.md — telling the operator to edit
    // it would point them at a non-existent file. The trellis-specific
    // path is `garden trellis amend` against the trellis doc. The error
    // must say so.
    await expect(
      workers(["grow", "vine", "--seed", "x"]),
    ).rejects.toThrow(/trellis vine/);
    await expect(
      workers(["grow", "vine", "--seed", "x"]),
    ).rejects.toThrow(/garden trellis amend/);
    // Must NOT mention grow-goal.md — that's the wrong path for trellis.
    const err = await workers(["grow", "vine", "--seed", "x"]).catch(e => e as Error);
    expect(err.message).not.toContain("grow-goal.md");
  });

  it("rejects when --seed and --seed-file are both passed", async () => {
    const projectDir = await setupProject("proj");
    const wtPath = path.join(projectDir, "..", "wt6");
    fs.mkdirSync(wtPath, { recursive: true });
    await addDefaultWorker("proj", "w", wtPath);

    const { workers } = await importWorkersCmd();
    await expect(
      workers(["grow", "w", "--seed", "x", "--seed-file", "/tmp/f"]),
    ).rejects.toThrow(/mutually exclusive/);
  });

  it("rejects when --goal-file and --seed are both passed", async () => {
    const projectDir = await setupProject("proj");
    const wtPath = path.join(projectDir, "..", "wt7");
    fs.mkdirSync(wtPath, { recursive: true });
    await addDefaultWorker("proj", "w", wtPath);

    const { workers } = await importWorkersCmd();
    await expect(
      workers(["grow", "w", "--seed", "x", "--goal-file", "/tmp/g"]),
    ).rejects.toThrow(/mutually exclusive/);
  });

  it("requires one of --seed / --seed-file / --goal-file", async () => {
    const projectDir = await setupProject("proj");
    const wtPath = path.join(projectDir, "..", "wt8");
    fs.mkdirSync(wtPath, { recursive: true });
    await addDefaultWorker("proj", "w", wtPath);

    const { workers } = await importWorkersCmd();
    await expect(
      workers(["grow", "w"]),
    ).rejects.toThrow(/Pass exactly one of --seed/);
  });

  it("--goal-file reads from disk and uses the file contents as the seed", async () => {
    const projectDir = await setupProject("proj");
    const wtPath = path.join(projectDir, "..", "wt9");
    fs.mkdirSync(wtPath, { recursive: true });
    await addDefaultWorker("proj", "w", wtPath);

    const goalSourceFile = path.join(env.home, "external-goal.md");
    fs.writeFileSync(goalSourceFile, "polish the auth flow with edge tests\n");

    const { workers } = await importWorkersCmd();
    await captureConsoleLog(() =>
      workers(["grow", "w", "--goal-file", goalSourceFile]),
    );

    const reg = await importRegistry();
    const entry = reg.findWorkerByName("proj", "w")!;
    expect(entry.grow!.seed).toBe("polish the auth flow with edge tests");
    // The goal file is written into the worktree (file is durable across iterations).
    expect(fs.readFileSync(path.join(wtPath, ".garden", "grow-goal.md"), "utf-8"))
      .toBe("polish the auth flow with edge tests\n");
  });

  it("rejects an empty seed", async () => {
    const projectDir = await setupProject("proj");
    const wtPath = path.join(projectDir, "..", "wt10");
    fs.mkdirSync(wtPath, { recursive: true });
    await addDefaultWorker("proj", "w", wtPath);

    const { workers } = await importWorkersCmd();
    await expect(
      workers(["grow", "w", "--seed", "   "]),
    ).rejects.toThrow(/non-empty/);
  });

  // The empty-seed guard runs after trim, so a file containing only
  // whitespace must trip it the same way --seed "   " does. The skill
  // tells operators to write goals via heredoc; a stray blank file
  // (operator typo, mid-edit save) shouldn't silently flip the workflow
  // with an empty seed that would later inline as "Original task: ".
  it("rejects an empty --seed-file", async () => {
    const projectDir = await setupProject("proj");
    const wtPath = path.join(projectDir, "..", "wt-empty-seed-file");
    fs.mkdirSync(wtPath, { recursive: true });
    await addDefaultWorker("proj", "w", wtPath);

    const emptyFile = path.join(env.home, "empty-seed.md");
    fs.writeFileSync(emptyFile, "   \n\n\t\n");

    const { workers } = await importWorkersCmd();
    await expect(
      workers(["grow", "w", "--seed-file", emptyFile]),
    ).rejects.toThrow(/non-empty/);
  });

  it("rejects an empty --goal-file", async () => {
    const projectDir = await setupProject("proj");
    const wtPath = path.join(projectDir, "..", "wt-empty-goal-file");
    fs.mkdirSync(wtPath, { recursive: true });
    await addDefaultWorker("proj", "w", wtPath);

    const emptyFile = path.join(env.home, "empty-goal.md");
    fs.writeFileSync(emptyFile, "");

    const { workers } = await importWorkersCmd();
    await expect(
      workers(["grow", "w", "--goal-file", emptyFile]),
    ).rejects.toThrow(/non-empty/);
  });

  // `garden workers grow w1 w2 --seed x` would otherwise silently use w1
  // and discard w2. The CLI must reject the ambiguity rather than guess.
  it("rejects extra positional arguments", async () => {
    const projectDir = await setupProject("proj");
    const wtPath = path.join(projectDir, "..", "wt-extra-pos");
    fs.mkdirSync(wtPath, { recursive: true });
    await addDefaultWorker("proj", "w", wtPath);

    const { workers } = await importWorkersCmd();
    await expect(
      workers(["grow", "w", "stray", "--seed", "x"]),
    ).rejects.toThrow(/Unexpected extra arguments.*'stray'/);
  });

  // Surface the underlying ENOENT (or whatever fs.readFileSync threw)
  // via err.message rather than String(err), matching the goal-file
  // write error format. Operators reading "Could not read 'foo': Error:
  // ENOENT: ..." (String(err)) is noisier than "Could not read 'foo':
  // ENOENT: ..." (err.message).
  it("surfaces the fs error message when --goal-file cannot be read", async () => {
    const projectDir = await setupProject("proj");
    const wtPath = path.join(projectDir, "..", "wt-read-fail");
    fs.mkdirSync(wtPath, { recursive: true });
    await addDefaultWorker("proj", "w", wtPath);

    const { workers } = await importWorkersCmd();
    const err = await workers([
      "grow", "w", "--goal-file", "/no/such/path.md",
    ]).catch(e => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/Could not read '\/no\/such\/path\.md'/);
    expect(err.message).toMatch(/ENOENT/);
    // err.message is the unwrapped node fs error string — should not
    // contain the redundant "Error: " prefix that String(err) adds.
    expect(err.message).not.toMatch(/Could not read '[^']+': Error: /);
  });

  it("--max-iterations overrides the default 5", async () => {
    const projectDir = await setupProject("proj");
    const wtPath = path.join(projectDir, "..", "wt11");
    fs.mkdirSync(wtPath, { recursive: true });
    await addDefaultWorker("proj", "w", wtPath);

    const { workers } = await importWorkersCmd();
    await captureConsoleLog(() =>
      workers(["grow", "w", "--seed", "x", "--max-iterations", "12"]),
    );

    const reg = await importRegistry();
    expect(reg.findWorkerByName("proj", "w")!.grow!.maxIterations).toBe(12);
  });

  it("project.maxGrowIterations applies when --max-iterations is omitted", async () => {
    const projectDir = await setupProject("proj", { maxGrow: 8 });
    const wtPath = path.join(projectDir, "..", "wt12");
    fs.mkdirSync(wtPath, { recursive: true });
    await addDefaultWorker("proj", "w", wtPath);

    const { workers } = await importWorkersCmd();
    await captureConsoleLog(() =>
      workers(["grow", "w", "--seed", "x"]),
    );

    const reg = await importRegistry();
    expect(reg.findWorkerByName("proj", "w")!.grow!.maxIterations).toBe(8);
  });

  it("--max-iterations < 1 is rejected", async () => {
    const projectDir = await setupProject("proj");
    const wtPath = path.join(projectDir, "..", "wt13");
    fs.mkdirSync(wtPath, { recursive: true });
    await addDefaultWorker("proj", "w", wtPath);

    const { workers } = await importWorkersCmd();
    await expect(
      workers(["grow", "w", "--seed", "x", "--max-iterations", "0"]),
    ).rejects.toThrow(/positive integer/);
  });

  // parseInt('5.7') silently truncates to 5; parseInt('5xyz') silently
  // returns 5. Both forms are typos the operator wants to know about,
  // not silently coerce. The CLI must reject them.
  it("rejects fractional --max-iterations like '5.7'", async () => {
    const projectDir = await setupProject("proj");
    const wtPath = path.join(projectDir, "..", "wt-frac");
    fs.mkdirSync(wtPath, { recursive: true });
    await addDefaultWorker("proj", "w", wtPath);

    const { workers } = await importWorkersCmd();
    await expect(
      workers(["grow", "w", "--seed", "x", "--max-iterations", "5.7"]),
    ).rejects.toThrow(/positive integer.*5\.7/);
  });

  it("rejects --max-iterations with trailing junk like '5xyz'", async () => {
    const projectDir = await setupProject("proj");
    const wtPath = path.join(projectDir, "..", "wt-junk");
    fs.mkdirSync(wtPath, { recursive: true });
    await addDefaultWorker("proj", "w", wtPath);

    const { workers } = await importWorkersCmd();
    await expect(
      workers(["grow", "w", "--seed", "x", "--max-iterations", "5xyz"]),
    ).rejects.toThrow(/positive integer.*5xyz/);
  });

  // The previous boolean-return contract swallowed the underlying fs
  // error, leaving operators with a generic "Failed to write" they
  // couldn't act on (read-only mount? full disk? gone worktree?). The
  // CLI now surfaces the cause from the throw. Forcing a failure: point
  // the registry at a "worktreePath" that's actually a regular file —
  // mkdirSync(".garden") under it returns ENOTDIR, which atomicWriteFile
  // surfaces.
  it("surfaces the underlying fs error when the goal-file write fails", async () => {
    const projectDir = await setupProject("proj");
    // Create a regular file at the path the registry will name as worktreePath.
    const fakeWorktree = path.join(projectDir, "..", "fake-as-file");
    fs.writeFileSync(fakeWorktree, "i am a file, not a dir");
    await addDefaultWorker("proj", "w", fakeWorktree);

    const { workers } = await importWorkersCmd();
    const err = await workers([
      "grow", "w", "--seed", "x",
    ]).catch(e => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/Failed to write goal file at/);
    // The error from mkdirSync surfaces — ENOTDIR or EEXIST depending on platform.
    expect(err.message).toMatch(/ENOTDIR|EEXIST|EISDIR|file exists|not a directory/i);
  });

  it("does not flip the workflow when the goal-file write fails", async () => {
    const projectDir = await setupProject("proj");
    const fakeWorktree = path.join(projectDir, "..", "fake-as-file-2");
    fs.writeFileSync(fakeWorktree, "regular file");
    await addDefaultWorker("proj", "leave-me", fakeWorktree);

    const { workers } = await importWorkersCmd();
    await expect(
      workers(["grow", "leave-me", "--seed", "x"]),
    ).rejects.toThrow();

    // Workflow flip happens AFTER the goal-file write; a failed write must
    // leave the worker on its original workflow so the operator can retry
    // (after fixing the cause) without ending up in a half-converted state.
    const reg = await importRegistry();
    const entry = reg.findWorkerByName("proj", "leave-me")!;
    expect(entry.workflow).toBe("default");
    expect(entry.grow).toBeUndefined();
  });

  // The bug this exercises: when the worker's prior default-workflow work
  // is already merged before /grow runs, the only path that would have
  // launched iter-1 (post-merge auto-continue with workflow=grow) never
  // fires — the merge happened with workflow=default and there's no future
  // merge coming. The convert command must dispatch iter-1 itself and
  // first fast-forward the worktree to origin/<base> so iter-1 starts on
  // current base (siblings may have merged in the meantime).
  it("dispatches iter-1 directly when the branch is fully merged into base", async () => {
    const projectDir = await setupProject("proj");
    const wtPath = setupRealWorktree(projectDir, "merged");
    const wtHeadBefore = git(wtPath, "rev-parse", "HEAD");
    advanceOriginMain(projectDir, 1);
    await addDefaultWorker("proj", "merged", wtPath);

    const { workers } = await importWorkersCmd();
    await captureConsoleLog(() =>
      workers(["grow", "merged", "--seed", "harden auth"]),
    );

    // Workflow flipped.
    const reg = await importRegistry();
    expect(reg.findWorkerByName("proj", "merged")!.workflow).toBe("grow");

    // Worktree fast-forwarded — HEAD should now equal origin/main, not the
    // pre-fetch tip. Confirms the fast-forward step ran.
    const wtHeadAfter = git(wtPath, "rev-parse", "HEAD");
    const originHead = git(wtPath, "rev-parse", "origin/main");
    expect(wtHeadAfter).toBe(originHead);
    expect(wtHeadAfter).not.toBe(wtHeadBefore);

    // Seed file written under SESSIONS_DIR/seeds with the iter-1 framing
    // (Iteration 1 of N). The detached `_seed-worker --delay-ms 6000`
    // subprocess is mocked away, so we assert on file presence + content
    // directly.
    const seedDir = path.join(env.home, ".garden", "sessions", "seeds");
    const seeds = fs.readdirSync(seedDir).filter(f => f.startsWith("grow-seed-proj-"));
    expect(seeds).toHaveLength(1);
    const seedContent = fs.readFileSync(path.join(seedDir, seeds[0]), "utf-8");
    // buildGrowIteration1Seed inlines the operator's seed verbatim and
    // names the iteration budget. Asserting on both pins the contract:
    // iter-1 dispatch went through buildGrowIteration1Seed (not, e.g.,
    // the iter-K continue prompt) and used the resolved maxIterations.
    expect(seedContent).toContain("harden auth");
    expect(seedContent).toMatch(/up to 5 bounded passes/);

    // dispatchDelayedSeed (mocked) was invoked with the project + worker.
    const continueMod = await import("../src/dashboard/continue.js");
    expect(continueMod.dispatchDelayedSeed).toHaveBeenCalledWith(
      expect.any(String),
      "proj",
      "merged",
      expect.stringMatching(/grow-seed-proj-\d+\.txt$/),
    );
  });

  // Pre-flight dirty check runs BEFORE any state mutation when the branch
  // is fully merged. This avoids a half-converted worker (workflow flipped
  // but iter-1 not dispatched), which the re-conversion guard at the top
  // of growCommand would then block on a retry — leaving the operator
  // unable to recover without manual registry edits.
  it("rejects the convert when the worktree is dirty (fully-merged branch)", async () => {
    const projectDir = await setupProject("proj");
    const wtPath = setupRealWorktree(projectDir, "dirty");
    fs.writeFileSync(path.join(wtPath, "uncommitted.txt"), "scratch");
    await addDefaultWorker("proj", "dirty", wtPath);

    const { workers } = await importWorkersCmd();
    await expect(
      workers(["grow", "dirty", "--seed", "harden"]),
    ).rejects.toThrow(/uncommitted changes/);

    // Worker stays on default — pre-flight aborted before the flip.
    const reg = await importRegistry();
    const entry = reg.findWorkerByName("proj", "dirty")!;
    expect(entry.workflow).toBe("default");
    expect(entry.grow).toBeUndefined();

    // No goal file, no seed file.
    expect(fs.existsSync(path.join(wtPath, ".garden", "grow-goal.md"))).toBe(false);
    const seedDir = path.join(env.home, ".garden", "sessions", "seeds");
    if (fs.existsSync(seedDir)) {
      const seeds = fs.readdirSync(seedDir).filter(f => f.startsWith("grow-seed-proj-"));
      expect(seeds).toHaveLength(0);
    }
  });

  // Status quo: if the worker has unmerged commits, the upcoming merge
  // fires growAutoContinueAfterMerge, which dispatches iter-1. The convert
  // command must not also dispatch iter-1 (that would race / double-fire).
  it("does not dispatch iter-1 when the worker has unmerged commits", async () => {
    const projectDir = await setupProject("proj");
    const wtPath = setupRealWorktree(projectDir, "ahead");
    fs.writeFileSync(path.join(wtPath, "in-flight.txt"), "wip");
    git(wtPath, "add", ".");
    git(wtPath, "commit", "-m", "in-flight work");
    const wtHeadBefore = git(wtPath, "rev-parse", "HEAD");
    await addDefaultWorker("proj", "ahead", wtPath);

    const { workers } = await importWorkersCmd();
    await captureConsoleLog(() =>
      workers(["grow", "ahead", "--seed", "harden"]),
    );

    // Workflow flipped (status quo).
    const reg = await importRegistry();
    expect(reg.findWorkerByName("proj", "ahead")!.workflow).toBe("grow");

    // Worktree HEAD did NOT move — no fast-forward when ahead > 0.
    expect(git(wtPath, "rev-parse", "HEAD")).toBe(wtHeadBefore);

    // No seed file, no dispatchDelayedSeed call.
    const seedDir = path.join(env.home, ".garden", "sessions", "seeds");
    if (fs.existsSync(seedDir)) {
      const seeds = fs.readdirSync(seedDir).filter(f => f.startsWith("grow-seed-proj-"));
      expect(seeds).toHaveLength(0);
    }
    const continueMod = await import("../src/dashboard/continue.js");
    expect(continueMod.dispatchDelayedSeed).not.toHaveBeenCalled();
  });
});

describe("garden workers new --harness", () => {
  it("rejects an unknown harness before spawning", async () => {
    await setupProject("proj");
    const { workers } = await importWorkersCmd();
    const { newWorker } = await importDashboardWorkers();

    await expect(
      workers(["new", "proj", "--harness", "bogus"]),
    ).rejects.toThrow(/--harness must be one of/);
    expect(newWorker).not.toHaveBeenCalled();
  });

  it("rejects --harness on a non-default workflow", async () => {
    await setupProject("proj");
    const { workers } = await importWorkersCmd();
    const { newWorker } = await importDashboardWorkers();

    await expect(
      workers([
        "new", "proj",
        "--workflow", "grow",
        "--seed", "x",
        "--harness", "codex",
      ]),
    ).rejects.toThrow(/only supported with --workflow default/);
    expect(newWorker).not.toHaveBeenCalled();
  });

  it("threads --harness codex into newWorker and reports it in the created line", async () => {
    await setupProject("proj");
    const { workers } = await importWorkersCmd();
    const { newWorker } = await importDashboardWorkers();

    const out = await captureConsoleLog(() =>
      workers(["new", "proj", "--harness", "codex"]),
    );

    expect(newWorker).toHaveBeenCalledWith(expect.objectContaining({
      projectName: "proj",
      workflow: "default",
      harness: "codex",
    }));
    expect(out.join("\n")).toContain("harness=codex");
  });

  it("canonicalizes the 'claude' alias to claude-code before threading + reporting", async () => {
    await setupProject("proj");
    const { workers } = await importWorkersCmd();
    const { newWorker } = await importDashboardWorkers();

    const out = await captureConsoleLog(() =>
      workers(["new", "proj", "--harness", "claude"]),
    );

    // The CLI pre-check canonicalizes the operator-facing "claude" alias at the
    // boundary (commands/workers.ts), so it clears the registry validation and
    // both the threaded opt and the created line carry "claude-code", never the
    // alias. This guards the load-bearing canonicalHarnessName call: without it
    // the pre-check would reject "claude" before newWorker is ever reached.
    expect(newWorker).toHaveBeenCalledWith(expect.objectContaining({
      projectName: "proj",
      workflow: "default",
      harness: "claude-code",
    }));
    expect(out.join("\n")).toContain("harness=claude-code");
  });

  it("omits the harness field for a plain default worker", async () => {
    await setupProject("proj");
    const { workers } = await importWorkersCmd();
    const { newWorker } = await importDashboardWorkers();

    await captureConsoleLog(() => workers(["new", "proj"]));

    const opts = vi.mocked(newWorker).mock.calls[0][0] as Record<string, unknown>;
    expect(opts.harness).toBeUndefined();
  });
});

describe("garden workers new --effort", () => {
  it("threads a plain effort rung into newWorker and reports it on a default worker", async () => {
    await setupProject("proj");
    const { workers } = await importWorkersCmd();
    const { newWorker } = await importDashboardWorkers();

    const out = await captureConsoleLog(() =>
      workers(["new", "proj", "--model", "sonnet", "--effort", "xhigh"]),
    );

    expect(newWorker).toHaveBeenCalledWith(expect.objectContaining({
      projectName: "proj",
      workflow: "default",
      model: "sonnet",
      effort: "xhigh",
    }));
    expect(out.join("\n")).toContain("effort=xhigh");
  });

  it("maps --effort ultra to the ultracode preset (never a bare effort value)", async () => {
    await setupProject("proj");
    const { workers } = await importWorkersCmd();
    const { newWorker } = await importDashboardWorkers();

    const out = await captureConsoleLog(() =>
      workers(["new", "proj", "--effort", "ultra"]),
    );

    const opts = vi.mocked(newWorker).mock.calls[0][0] as Record<string, unknown>;
    expect(opts.ultracode).toBe(true);
    expect(opts.effort).toBeUndefined();
    expect(out.join("\n")).toContain("effort=ultra");
  });

  it("threads --effort onto a grow worker", async () => {
    await setupProject("proj");
    const { workers } = await importWorkersCmd();
    const { newWorker } = await importDashboardWorkers();

    await captureConsoleLog(() =>
      workers(["new", "proj", "--workflow", "grow", "--seed", "x", "--effort", "high"]),
    );

    expect(newWorker).toHaveBeenCalledWith(expect.objectContaining({
      workflow: "grow",
      effort: "high",
    }));
  });

  it("rejects an invalid --effort value before spawning", async () => {
    await setupProject("proj");
    const { workers } = await importWorkersCmd();
    const { newWorker } = await importDashboardWorkers();

    await expect(
      workers(["new", "proj", "--effort", "bogus"]),
    ).rejects.toThrow(/--effort must be one of/);
    expect(newWorker).not.toHaveBeenCalled();
  });

  it("rejects --effort on a trellis worker", async () => {
    await setupProject("proj");
    const { workers } = await importWorkersCmd();
    const { newWorker } = await importDashboardWorkers();

    await expect(
      workers(["new", "proj", "--workflow", "trellis", "--effort", "xhigh"]),
    ).rejects.toThrow(/--effort is only supported with --workflow default or grow/);
    expect(newWorker).not.toHaveBeenCalled();
  });
});

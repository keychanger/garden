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

  it("rejects --model on grow workers (account default applies)", async () => {
    await setupProject("proj");
    const { workers } = await importWorkersCmd();
    await expect(
      workers([
        "new", "proj",
        "--workflow", "grow",
        "--seed", "x",
        "--model", "sonnet",
      ]),
    ).rejects.toThrow(/--model is not supported with --workflow grow/);
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
    expect(fs.readFileSync(goalPath, "utf-8")).toBe("polish things");
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
      .toBe("polish the auth flow with edge tests");
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
});

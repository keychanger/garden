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

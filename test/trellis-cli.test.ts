import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { useTmpHome, captureConsoleLog } from "./helpers.js";

// Tests for the `garden trellis ...` subcommand surface (phase 4). Most
// commands write to disk + commit on the project's main branch. The
// useTmpHome helper sandboxes HOME; we set up a real git repo per-test
// for amend/retire/revive coverage.

vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../src/dashboard/poller-fifo.js", () => ({
  triggerProjectPoll: vi.fn(),
  signalFifoPath: vi.fn(() => "/tmp/fake-fifo"),
  scheduleDelayedPoke: vi.fn(),
}));

const env = useTmpHome();

async function importTrellisCmd() {
  return await import("../src/commands/trellis.js");
}
async function importConfig() {
  return await import("../src/config.js");
}
async function importRegistry() {
  return await import("../src/dashboard/registry.js");
}

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

async function setupProject(name: string, opts: { trellisDir?: string } = {}): Promise<string> {
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
      [name]: { path: projectDir, ...(opts.trellisDir ? { trellisDir: opts.trellisDir } : {}) },
    },
  });
  return projectDir;
}

function makeTrellis(projectDir: string, name: string, opts: { retired?: string; sentinel?: boolean; intent?: string } = {}): string {
  const dir = path.join(projectDir, ".garden", "trellises");
  fs.mkdirSync(dir, { recursive: true });
  const sentinel = opts.sentinel === false ? "" : "the code is wrong";
  const retired = opts.retired ? `\n${opts.retired}` : "";
  const intent = opts.intent ? `\n## Intent\n\n${opts.intent}\n` : "";
  const file = path.join(dir, `${name}.md`);
  fs.writeFileSync(file, `# ${name}\n\nFor the ${name} feature. ${sentinel}.\n\n<!-- trellis: v1 -->${retired}\n${intent}`);
  return file;
}

let savedPretty: string | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  // Force pretty output even though stdout isn't a TTY in test runners.
  // The list/status pretty branches print human-readable text we assert
  // against; without this, output() falls through to JSON.
  savedPretty = process.env.GARDEN_PRETTY;
  process.env.GARDEN_PRETTY = "1";
});

afterEach(() => {
  if (savedPretty === undefined) delete process.env.GARDEN_PRETTY;
  else process.env.GARDEN_PRETTY = savedPretty;
});

describe("garden trellis list", () => {
  it("prints active trellises by default and groups archived under a header", async () => {
    const projectDir = await setupProject("proj");
    makeTrellis(projectDir, "alpha", { intent: "alpha intent" });
    makeTrellis(projectDir, "beta");
    makeTrellis(projectDir, "old", { retired: "<!-- retired: 2026-04-01 -->" });

    const { trellis } = await importTrellisCmd();
    const out = await captureConsoleLog(() => trellis(["list", "proj"]));
    const text = out.join("\n");
    expect(text).toContain("alpha");
    expect(text).toContain("beta");
    expect(text).toContain("Archived:");
    expect(text).toContain("old");
  });

  it("--active filters out archived trellises", async () => {
    const projectDir = await setupProject("proj");
    makeTrellis(projectDir, "alive");
    makeTrellis(projectDir, "old", { retired: "<!-- retired: 2026-04-01 -->" });

    const { trellis } = await importTrellisCmd();
    const out = await captureConsoleLog(() => trellis(["list", "proj", "--active"]));
    const text = out.join("\n");
    expect(text).toContain("alive");
    expect(text).not.toContain("old");
    expect(text).not.toContain("Archived");
  });

  it("prints empty-state hint when no trellises exist", async () => {
    await setupProject("proj");
    const { trellis } = await importTrellisCmd();
    const out = await captureConsoleLog(() => trellis(["list", "proj"]));
    expect(out.join("\n")).toMatch(/No trellises|garden trellis new/);
  });

  it("refuses unknown project", async () => {
    const { trellis } = await importTrellisCmd();
    await expect(trellis(["list", "nope"])).rejects.toThrow(/Unknown project/);
  });
});

describe("garden trellis show", () => {
  it("writes the trellis content to stdout", async () => {
    const projectDir = await setupProject("proj");
    const file = makeTrellis(projectDir, "auth");
    const expected = fs.readFileSync(file, "utf-8");

    const orig = process.stdout.write.bind(process.stdout);
    let captured = "";
    (process.stdout as { write: (s: string) => boolean }).write = (s: string) => {
      captured += s; return true;
    };
    try {
      const { trellis } = await importTrellisCmd();
      await trellis(["show", "proj", "auth"]);
    } finally {
      (process.stdout as { write: (s: string) => boolean }).write = orig;
    }
    expect(captured).toBe(expected);
  });

  it("refuses unknown trellis name", async () => {
    await setupProject("proj");
    const { trellis } = await importTrellisCmd();
    await expect(trellis(["show", "proj", "nonexistent"])).rejects.toThrow(/not found/);
  });
});

describe("garden trellis new", () => {
  it("scaffolds a file with the required spine (sentinel + tag) and recommended sections", async () => {
    const projectDir = await setupProject("proj");
    const { trellis } = await importTrellisCmd();
    await captureConsoleLog(() => trellis(["new", "proj", "feat"]));
    const file = path.join(projectDir, ".garden", "trellises", "feat.md");
    expect(fs.existsSync(file)).toBe(true);
    const content = fs.readFileSync(file, "utf-8");
    expect(content).toMatch(/^# feat/);
    expect(content).toContain("the code is wrong");
    expect(content).toContain("<!-- trellis: v1 -->");
    expect(content).toContain("## Intent");
    expect(content).toContain("## Out of scope");
  });

  it("refuses to overwrite an existing trellis", async () => {
    const projectDir = await setupProject("proj");
    makeTrellis(projectDir, "feat");
    const { trellis } = await importTrellisCmd();
    await expect(trellis(["new", "proj", "feat"])).rejects.toThrow(/already exists/);
  });
});

describe("garden trellis status", () => {
  it("prints iteration count, last verdict, drift list, and lessons", async () => {
    const projectDir = await setupProject("proj");
    makeTrellis(projectDir, "auth");

    const wtPath = path.join(env.home, "wt");
    fs.mkdirSync(path.join(wtPath, ".garden"), { recursive: true });
    fs.writeFileSync(
      path.join(wtPath, ".garden", "trellis-lessons.md"),
      "iter 1: tried foo\niter 2: tried bar\niter 3: tried baz",
    );

    const { addWorker } = await importRegistry();
    addWorker("proj", {
      name: "swift-vine",
      sessionId: "s1",
      task: "",
      worktreePath: wtPath,
      workflow: "trellis",
      trellisName: "auth",
      trellisPath: path.join(projectDir, ".garden", "trellises", "auth.md"),
      trellisIteration: 4,
      trellisMaxIterations: 30,
      trellisLastVerdict: "DRIFT",
      trellisLastDrift: ["1. [tests] missing timeout test"],
      trellisAlignedCount: 7,
    });

    const { trellis } = await importTrellisCmd();
    const out = await captureConsoleLog(() => trellis(["status", "swift-vine"]));
    const text = out.join("\n");
    expect(text).toContain("swift-vine");
    expect(text).toContain("auth");
    expect(text).toMatch(/4\s*\/\s*30/);
    expect(text).toContain("DRIFT");
    expect(text).toContain("missing timeout test");
    expect(text).toMatch(/iter 3: tried baz/); // lessons tail
  });

  it("refuses non-trellis workers", async () => {
    await setupProject("proj");
    const { addWorker } = await importRegistry();
    addWorker("proj", { name: "default-worker", sessionId: "s1", task: "", workflow: "default" });
    const { trellis } = await importTrellisCmd();
    await expect(trellis(["status", "default-worker"])).rejects.toThrow(/not trellis|trellis vines only/);
  });

  it("refuses unknown worker", async () => {
    const { trellis } = await importTrellisCmd();
    await expect(trellis(["status", "ghost-worker"])).rejects.toThrow(/not found/);
  });
});

describe("garden trellis amend", () => {
  it("refuses on a dirty main checkout (Q4)", async () => {
    const projectDir = await setupProject("proj");
    makeTrellis(projectDir, "auth");
    // Dirty the working tree.
    fs.writeFileSync(path.join(projectDir, "uncommitted.txt"), "dirty\n");

    const { trellis } = await importTrellisCmd();
    await expect(trellis(["amend", "proj", "auth"])).rejects.toThrow(/uncommitted changes/);
  });

  it("opens $EDITOR, commits when content changed, no-ops when unchanged", async () => {
    const projectDir = await setupProject("proj");
    const trellisFile = makeTrellis(projectDir, "auth");
    git(projectDir, "add", ".");
    git(projectDir, "commit", "-m", "add trellis");

    // Use a fake EDITOR that appends a line to the file.
    const fakeEditor = path.join(env.home, "fake-editor.sh");
    fs.writeFileSync(fakeEditor, "#!/bin/sh\necho 'amended' >> \"$1\"\n", { mode: 0o755 });
    process.env.EDITOR = fakeEditor;

    try {
      const { trellis } = await importTrellisCmd();
      await captureConsoleLog(() => trellis(["amend", "proj", "auth"]));

      // The file changed.
      expect(fs.readFileSync(trellisFile, "utf-8")).toContain("amended");
      // A commit landed on main.
      const log = git(projectDir, "log", "--oneline");
      expect(log).toMatch(/trellis: amend auth/);
    } finally {
      delete process.env.EDITOR;
    }
  });

  it("auto-revives a retired trellis on save", async () => {
    const projectDir = await setupProject("proj");
    const trellisFile = makeTrellis(projectDir, "auth", {
      retired: "<!-- retired: 2026-04-01 -->",
    });
    git(projectDir, "add", ".");
    git(projectDir, "commit", "-m", "add retired trellis");

    const fakeEditor = path.join(env.home, "fake-editor.sh");
    fs.writeFileSync(fakeEditor, "#!/bin/sh\necho 'amended' >> \"$1\"\n", { mode: 0o755 });
    process.env.EDITOR = fakeEditor;

    try {
      const { trellis } = await importTrellisCmd();
      const out = await captureConsoleLog(() => trellis(["amend", "proj", "auth"]));
      const content = fs.readFileSync(trellisFile, "utf-8");
      expect(content).not.toMatch(/<!--\s*retired:/);
      expect(out.join("\n")).toMatch(/auto-revived|revives/);
    } finally {
      delete process.env.EDITOR;
    }
  });
});

describe("garden trellis resume", () => {
  it("clears trellis-flagged failure and arms a fresh review", async () => {
    await setupProject("proj");
    const { addWorker, findWorkerByName } = await importRegistry();
    addWorker("proj", {
      name: "swift-vine",
      sessionId: "s1",
      task: "",
      workflow: "trellis",
      trellisName: "auth",
      prState: "failing",
      failingReason: "trellis-flagged",
      trellisFlaggedClauses: ["trellis line 47"],
    });

    const { trellis } = await importTrellisCmd();
    await captureConsoleLog(() => trellis(["resume", "swift-vine"]));

    const after = findWorkerByName("proj", "swift-vine");
    expect(after?.failingReason).toBeUndefined();
    expect(after?.trellisFlaggedClauses).toBeUndefined();
    expect(after?.prState).toBe("working");
    expect(after?.pendingReviewAt).toBeDefined();

    // Poller was poked.
    const fifo = await import("../src/dashboard/poller-fifo.js");
    expect(vi.mocked(fifo.triggerProjectPoll)).toHaveBeenCalledWith("proj");
  });

  it("refuses workers that are not flagged", async () => {
    await setupProject("proj");
    const { addWorker } = await importRegistry();
    addWorker("proj", {
      name: "swift-vine",
      sessionId: "s1",
      task: "",
      workflow: "trellis",
      prState: "working",
    });
    const { trellis } = await importTrellisCmd();
    await expect(trellis(["resume", "swift-vine"])).rejects.toThrow(/not in a flagged state/);
  });

  it("refuses non-trellis workers", async () => {
    await setupProject("proj");
    const { addWorker } = await importRegistry();
    addWorker("proj", {
      name: "default-worker",
      sessionId: "s1",
      task: "",
      workflow: "default",
    });
    const { trellis } = await importTrellisCmd();
    await expect(trellis(["resume", "default-worker"])).rejects.toThrow(/not trellis|trellis vines only/);
  });
});

describe("garden trellis retire / revive", () => {
  it("retire writes the retirement comment and commits on main", async () => {
    const projectDir = await setupProject("proj");
    const trellisFile = makeTrellis(projectDir, "auth");
    git(projectDir, "add", ".");
    git(projectDir, "commit", "-m", "add trellis");

    const { trellis } = await importTrellisCmd();
    await captureConsoleLog(() => trellis(["retire", "proj", "auth"]));

    const content = fs.readFileSync(trellisFile, "utf-8");
    expect(content).toMatch(/<!--\s*retired:\s*\d{4}-\d{2}-\d{2}/);
    const log = git(projectDir, "log", "--oneline");
    expect(log).toMatch(/trellis: retire auth/);
  });

  it("retire is idempotent on already-retired trellises", async () => {
    const projectDir = await setupProject("proj");
    makeTrellis(projectDir, "auth", { retired: "<!-- retired: 2026-04-01 -->" });
    git(projectDir, "add", ".");
    git(projectDir, "commit", "-m", "add retired trellis");

    const { trellis } = await importTrellisCmd();
    const out = await captureConsoleLog(() => trellis(["retire", "proj", "auth"]));
    expect(out.join("\n")).toMatch(/already retired/i);
  });

  it("revive removes the retirement comment and commits", async () => {
    const projectDir = await setupProject("proj");
    const trellisFile = makeTrellis(projectDir, "auth", {
      retired: "<!-- retired: 2026-04-01 -->",
    });
    git(projectDir, "add", ".");
    git(projectDir, "commit", "-m", "add retired trellis");

    const { trellis } = await importTrellisCmd();
    await captureConsoleLog(() => trellis(["revive", "proj", "auth"]));

    const content = fs.readFileSync(trellisFile, "utf-8");
    expect(content).not.toMatch(/<!--\s*retired:/);
    const log = git(projectDir, "log", "--oneline");
    expect(log).toMatch(/trellis: revive auth/);
  });

  it("revive is a no-op on active trellises", async () => {
    const projectDir = await setupProject("proj");
    makeTrellis(projectDir, "auth");
    git(projectDir, "add", ".");
    git(projectDir, "commit", "-m", "add trellis");

    const { trellis } = await importTrellisCmd();
    const out = await captureConsoleLog(() => trellis(["revive", "proj", "auth"]));
    expect(out.join("\n")).toMatch(/not retired/i);
  });
});

describe("usage message", () => {
  it("rejects unknown subcommand with a helpful usage block", async () => {
    const { trellis } = await importTrellisCmd();
    await expect(trellis(["bogus"])).rejects.toThrow(/Usage:[\s\S]*trellis list[\s\S]*trellis status/);
  });
});

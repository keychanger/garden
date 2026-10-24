import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { useGitTmpHome } from "./helpers.js";

const env = useGitTmpHome();

const PROJECT = "myproject";
const WORKER = "swift-oak";

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

let projectPath: string;
let originPath: string;
let worktreePath: string;

beforeEach(() => {
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
});

describe("worker bootstrap (real fs + real git)", () => {
  // The commit the worktree is created from, and the one the main checkout is
  // advanced to, must come from origin itself: refs/remotes/origin/<base> is
  // in the shared git dir every worker sandbox can write, and this worktree's
  // dependencies are installed with their package scripts, as the operator.
  // The step runs under #!/bin/sh, like the bootstrap script that carries it.
  describe("base-commit resolution", () => {
    async function resolve(base: string): Promise<{ status: number | null; sha: string }> {
      const { baseShaStep } = await import("../../src/dashboard/create.js");
      const { shellEscape } = await import("../../src/dashboard/tmux.js");
      const script = `BASE=${base}\n${baseShaStep(shellEscape(projectPath))}\nprintf '%s' "$BASE_SHA"`;
      const r = spawnSync("sh", ["-c", script], { encoding: "utf8" });
      return { status: r.status, sha: (r.stdout ?? "").trim() };
    }

    it("reports the commit origin carries", async () => {
      const onOrigin = git(projectPath, "rev-parse", "refs/heads/main");
      expect(await resolve("main")).toEqual({ status: 0, sha: onOrigin });
    });

    it("ignores a rewritten tracking ref", async () => {
      const onOrigin = git(projectPath, "rev-parse", "refs/heads/main");
      fs.writeFileSync(path.join(projectPath, "smuggled.txt"), "never reviewed\n");
      git(projectPath, "add", "smuggled.txt");
      git(projectPath, "commit", "-m", "smuggled");
      const smuggled = git(projectPath, "rev-parse", "HEAD");
      git(projectPath, "update-ref", "refs/remotes/origin/main", smuggled);
      expect(git(projectPath, "rev-parse", "refs/remotes/origin/main")).toBe(smuggled);

      const got = await resolve("main");
      expect(got.sha).toBe(onOrigin);
      expect(got.sha).not.toBe(smuggled);
    });

    it("reports origin's own ref, not a decoy branch that glob-matches it", async () => {
      // `ls-remote origin refs/heads/main` tail-matches on component
      // boundaries, so a branch named `a/refs/heads/main` is listed too — and
      // listed FIRST, since refs sort lexicographically. Workers push branches
      // routinely, so taking the first line would hand every later spawn a
      // commit of the worker's choosing, with its package scripts.
      const onOrigin = git(projectPath, "rev-parse", "refs/heads/main");
      fs.writeFileSync(path.join(projectPath, "smuggled.txt"), "never reviewed\n");
      git(projectPath, "add", "smuggled.txt");
      git(projectPath, "commit", "-m", "smuggled");
      const decoy = git(projectPath, "rev-parse", "HEAD");
      git(projectPath, "push", "origin", `${decoy}:refs/heads/a/refs/heads/main`);

      const got = await resolve("main");
      expect(got.sha).toBe(onOrigin);
      expect(got.sha).not.toBe(decoy);
    });

    it("reports nothing when the listing's object name is not one", async () => {
      // Defense in depth: BASE_SHA is handed to `worktree add` and
      // `merge --ff-only`, so a reading that is a ref NAME rather than an
      // object id would resolve back through the sandbox-writable ref
      // namespace this whole step exists to stop trusting. Real git always
      // answers with an oid, so the bad reading is injected with a git shim.
      const { baseShaStep } = await import("../../src/dashboard/create.js");
      const { shellEscape } = await import("../../src/dashboard/tmux.js");
      const bin = path.join(env.home, "shim-bin");
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(
        path.join(bin, "git"),
        `#!/bin/sh\nprintf 'refs/remotes/origin/main\\trefs/heads/main\\n'\n`,
        { mode: 0o755 },
      );
      const script = `BASE=main\n${baseShaStep(shellEscape(projectPath))}\nprintf '%s' "$BASE_SHA"`;
      const r = spawnSync("sh", ["-c", script], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      });
      expect((r.stdout ?? "").trim()).toBe("");
    });

    it("reports nothing for a branch origin does not carry, rather than guessing", async () => {
      // The bootstrap aborts on an empty reading; it must never fall back to a
      // local ref, which is the thing being distrusted.
      git(projectPath, "update-ref", "refs/remotes/origin/invented", git(projectPath, "rev-parse", "HEAD"));
      expect(await resolve("invented")).toEqual({ status: 0, sha: "" });
    });
  });

  it("createWorktree produces a worktree with the requested branch", async () => {
    const { createWorktree, worktreeExists, currentBranch } =
      await import("../../src/dashboard/git.js");
    createWorktree(projectPath, worktreePath, WORKER);
    expect(worktreeExists(worktreePath)).toBe(true);
    expect(currentBranch(worktreePath)).toBe(WORKER);
    expect(fs.existsSync(path.join(worktreePath, "README.md"))).toBe(true);
  });

  it("codex worker bootstrap installs the codex runtime + launches codex; claude bootstrap does neither", async () => {
    const { buildWorktreeBootstrapScript } = await import("../../src/dashboard/create.js");
    const codex = fs.readFileSync(
      buildWorktreeBootstrapScript(PROJECT, projectPath, WORKER, WORKER, "sid", worktreePath, "main", { harness: "codex" }),
      "utf-8",
    );
    // The additive codex branch: the runtime subcommand runs after worktree
    // setup, and the launch is the codex dialect (sandbox + hook-trust bypass).
    expect(codex).toContain("_install-worker-runtime");
    expect(codex).toContain("codex --dangerously-bypass-hook-trust");
    expect(codex).toContain("-s workspace-write");

    const claude = fs.readFileSync(
      buildWorktreeBootstrapScript(PROJECT, projectPath, WORKER, WORKER, "sid", worktreePath, "main"),
      "utf-8",
    );
    // Byte-for-byte the existing dialect: no codex install, launches claude.
    expect(claude).not.toContain("_install-worker-runtime");
    expect(claude).toContain("claude --rc");
  });

  // The script runs under set -e with an ERR trap that reports a failed
  // bootstrap. An agent exiting non-zero (a crash, a kill) is not one, and must
  // still reach the command that records the exit.
  it("records the agent's exit when the agent exits non-zero", async () => {
    const bin = path.join(env.home, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "claude"), "#!/bin/sh\nexit 137\n", { mode: 0o755 });
    const recorded = path.join(env.home, "recorded");
    const recorder = path.join(env.home, "record.sh");
    fs.writeFileSync(recorder, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${recorded}'\n`, { mode: 0o755 });
    vi.doMock("../../src/dashboard/runner.js", async (importOriginal) => ({
      ...await importOriginal<typeof import("../../src/dashboard/runner.js")>(),
      resolveGardenRunner: () => recorder,
    }));
    try {
      const { buildWorktreeBootstrapScript } = await import("../../src/dashboard/create.js");
      const lines = fs.readFileSync(
        buildWorktreeBootstrapScript(PROJECT, projectPath, WORKER, WORKER, "sid", worktreePath, "main"),
        "utf-8",
      ).split("\n");
      // The script's own error handling, then its launch tail; the worktree
      // setup between them is not what this checks.
      const trapAt = lines.findIndex(l => l.startsWith("trap ") && l.endsWith(" ERR"));
      const launchAt = lines.indexOf("# Launch the agent");
      expect(trapAt).toBeGreaterThan(0);
      expect(launchAt).toBeGreaterThan(trapAt);
      // bash, as macOS's /bin/sh is: the ERR trap is a bash extension, and
      // dash (Ubuntu's sh, on CI) refuses it before reaching the agent.
      const r = spawnSync("bash", ["-c", [...lines.slice(0, trapAt + 1), ...lines.slice(launchAt)].join("\n")], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SHELL: "/usr/bin/true" },
      });
      expect(r.stderr).not.toContain("Bootstrap aborted");
      expect(fs.existsSync(recorded) ? fs.readFileSync(recorded, "utf-8") : "")
        .toContain(`dashboard _agent-exited ${PROJECT} ${WORKER}`);
    } finally {
      vi.doUnmock("../../src/dashboard/runner.js");
    }
  });

  // Garden's settings file for the worktree (outside it, under ~/.garden/control).
  async function readGardenSettings() {
    const { claudeSettingsPath } = await import("../../src/dashboard/headless-paths.js");
    return JSON.parse(fs.readFileSync(claudeSettingsPath(worktreePath), "utf-8"));
  }

  it("installRuntimeConfig writes garden's settings file with hooks for every Claude Code event", async () => {
    const { createWorktree } = await import("../../src/dashboard/git.js");
    const { claudeCodeAdapter } = await import("../../src/dashboard/harness/claude-code.js");

    createWorktree(projectPath, worktreePath, WORKER);
    claudeCodeAdapter.installRuntimeConfig(worktreePath, { path: projectPath });

    expect(fs.existsSync(path.join(worktreePath, ".claude", "settings.json"))).toBe(false);
    const settings = await readGardenSettings();

    expect(settings.hooks).toBeDefined();
    expect(settings.hooks.SessionStart).toBeDefined();
    expect(settings.hooks.UserPromptSubmit).toBeDefined();
    expect(settings.hooks.Stop).toBeDefined();
    expect(settings.hooks.PreToolUse).toBeDefined();
    expect(settings.hooks.PostToolUse).toBeDefined();
    expect(settings.hooks.PermissionRequest).toBeDefined();

    // The firehose PostToolUse hook carries the NODE_COMPILE_CACHE prefix so
    // each cold-started hook process reuses the bundle's cached bytecode.
    const postCmd = settings.hooks.PostToolUse[0].hooks[0].command;
    expect(postCmd).toContain("NODE_COMPILE_CACHE=");
    expect(postCmd).toContain(".garden/control/node-compile");
    expect(postCmd).not.toContain(".cache/garden");
    expect(postCmd).toMatch(/posttooluse$/);
  });

  it("garden's settings have the documented allowlist and no project-level defaultMode", async () => {
    const { createWorktree } = await import("../../src/dashboard/git.js");
    const { claudeCodeAdapter } = await import("../../src/dashboard/harness/claude-code.js");

    createWorktree(projectPath, worktreePath, WORKER);
    claudeCodeAdapter.installRuntimeConfig(worktreePath, { path: projectPath });

    const settings = await readGardenSettings();
    expect(settings.permissions.defaultMode).toBeUndefined();
    expect(settings.permissions.allow).toContain("Bash(tmux:*)");
    expect(settings.permissions.allow).toContain("Bash(echo:*)");
    expect(settings.permissions.allow).toContain("Bash(head:*)");
    expect(settings.permissions.allow).toContain("Bash(tail:*)");
  });

  it("garden's settings sandbox config includes worktree allowWrite and Anthropic domain", async () => {
    const { createWorktree } = await import("../../src/dashboard/git.js");
    const { claudeCodeAdapter } = await import("../../src/dashboard/harness/claude-code.js");

    createWorktree(projectPath, worktreePath, WORKER);
    claudeCodeAdapter.installRuntimeConfig(worktreePath, { path: projectPath });

    const settings = await readGardenSettings();
    expect(settings.sandbox.filesystem.allowWrite).toContain(worktreePath);
    expect(settings.sandbox.network.allowedDomains).toContain("api.anthropic.com");
  });

  describe("a repo that commits its own .claude/settings.json", () => {
    const repoSettings = JSON.stringify({ permissions: { allow: ["Bash(make:*)"] } }, null, 2) + "\n";
    // What earlier garden builds wrote into the worktree.
    const oldGardenSettings = JSON.stringify({
      hooks: { SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "NODE_COMPILE_CACHE=/c /usr/bin/node /g/dist/hook.js sessionstart" }] }] },
    });

    function commitRepoSettings() {
      fs.mkdirSync(path.join(projectPath, ".claude"), { recursive: true });
      fs.writeFileSync(path.join(projectPath, ".claude", "settings.json"), repoSettings);
      git(projectPath, "add", ".claude/settings.json");
      git(projectPath, "commit", "-m", "share claude settings");
      git(projectPath, "push", "origin", "main");
    }

    it("leaves the repo's file untouched, so the worktree stays clean for the review gate", async () => {
      commitRepoSettings();
      const { createWorktree } = await import("../../src/dashboard/git.js");
      const { claudeCodeAdapter } = await import("../../src/dashboard/harness/claude-code.js");

      createWorktree(projectPath, worktreePath, WORKER);
      claudeCodeAdapter.installRuntimeConfig(worktreePath, { path: projectPath }, { beforeLaunch: true });

      expect(git(worktreePath, "status", "--porcelain")).toBe("");
      expect(fs.readFileSync(path.join(worktreePath, ".claude", "settings.json"), "utf-8")).toBe(repoSettings);
      expect((await readGardenSettings()).hooks.SessionStart).toBeDefined();
    });

    it("restores the repo's file that an earlier build overwrote, even behind skip-worktree", async () => {
      commitRepoSettings();
      const { createWorktree } = await import("../../src/dashboard/git.js");
      const { claudeCodeAdapter } = await import("../../src/dashboard/harness/claude-code.js");
      createWorktree(projectPath, worktreePath, WORKER);
      const file = path.join(worktreePath, ".claude", "settings.json");
      fs.writeFileSync(file, oldGardenSettings);
      fs.chmodSync(file, 0o444);
      git(worktreePath, "update-index", "--skip-worktree", ".claude/settings.json");
      // The installer runs unsandboxed and its restore is a path checkout, which
      // fires post-checkout: plant one where the worktree's hooksPath points, and
      // an fsmonitor in its config, as a worker could.
      const marker = path.join(path.dirname(worktreePath), "ran");
      const program = (name: string) => {
        const p = path.join(path.dirname(worktreePath), name);
        fs.writeFileSync(p, `#!/bin/sh\necho ${name} >> "${marker}"\nexit 1\n`);
        fs.chmodSync(p, 0o755);
        return p;
      };
      fs.mkdirSync(path.join(worktreePath, ".garden-hooks"), { recursive: true });
      fs.copyFileSync(program("post-checkout"), path.join(worktreePath, ".garden-hooks", "post-checkout"));
      git(worktreePath, "config", "extensions.worktreeConfig", "true");
      git(worktreePath, "config", "--worktree", "core.hooksPath", path.join(worktreePath, ".garden-hooks"));
      git(worktreePath, "config", "--worktree", "core.fsmonitor", program("fsmonitor"));

      claudeCodeAdapter.installRuntimeConfig(worktreePath, { path: projectPath }, { beforeLaunch: true });

      expect(fs.existsSync(marker)).toBe(false);
      expect(fs.readFileSync(file, "utf-8")).toBe(repoSettings);
      expect(git(worktreePath, "ls-files", "-v", ".claude/settings.json")).toBe("H .claude/settings.json");
      expect(git(worktreePath, "status", "--porcelain")).toBe("");
    });
  });

  it("retires an earlier build's untracked settings only when a launch follows", async () => {
    const { createWorktree } = await import("../../src/dashboard/git.js");
    const { claudeCodeAdapter } = await import("../../src/dashboard/harness/claude-code.js");
    createWorktree(projectPath, worktreePath, WORKER);
    const file = path.join(worktreePath, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "'/n/node' '/g/dist/cli.js' dashboard _claude-hook sessionstart" }] }] },
    }));

    // A refresh with no launch: a live worker from that build still reads it.
    claudeCodeAdapter.installRuntimeConfig(worktreePath, { path: projectPath });
    expect(fs.existsSync(file)).toBe(true);

    // Launched with --settings, Claude would load both copies and fire every hook twice.
    claudeCodeAdapter.installRuntimeConfig(worktreePath, { path: projectPath }, { beforeLaunch: true });
    expect(fs.existsSync(file)).toBe(false);
  });

  it("never removes an untracked settings file garden did not write", async () => {
    const { createWorktree } = await import("../../src/dashboard/git.js");
    const { claudeCodeAdapter } = await import("../../src/dashboard/harness/claude-code.js");
    createWorktree(projectPath, worktreePath, WORKER);
    const file = path.join(worktreePath, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const own = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }] } });
    fs.writeFileSync(file, own);

    claudeCodeAdapter.installRuntimeConfig(worktreePath, { path: projectPath }, { beforeLaunch: true });

    expect(fs.readFileSync(file, "utf-8")).toBe(own);
  });

  it("installs the done skill at .claude/skills/done/SKILL.md", async () => {
    const { createWorktree } = await import("../../src/dashboard/git.js");
    const { claudeCodeAdapter } = await import("../../src/dashboard/harness/claude-code.js");

    createWorktree(projectPath, worktreePath, WORKER);
    claudeCodeAdapter.installRuntimeConfig(worktreePath, { path: projectPath });

    const skillPath = path.join(worktreePath, ".claude", "skills", "done", "SKILL.md");
    expect(fs.existsSync(skillPath)).toBe(true);
    const body = fs.readFileSync(skillPath, "utf-8");
    expect(body).toContain(".garden-done");
  });

  // Older Codex builds wrote unanchored `AGENTS.md` and `.codex/` lines to the
  // info/exclude every checkout shares, and only a Codex refresh removed them,
  // so a project whose workers all run claude-code kept hiding every new nested
  // AGENTS.md from `git add -A`.
  describe("an older Codex build's unanchored exclude lines", () => {
    const excludeLines = () => fs.readFileSync(path.join(projectPath, ".git", "info", "exclude"), "utf-8").split("\n");
    const writeOlderCodexExcludes = () =>
      fs.appendFileSync(path.join(projectPath, ".git", "info", "exclude"), "AGENTS.md\n.codex/\n");
    // A checkout an older Codex worker composed its rules into, untracked.
    async function olderCodexCheckout(): Promise<string> {
      const { createWorktree } = await import("../../src/dashboard/git.js");
      const { composeAgentsMd } = await import("../../src/dashboard/harness/agents-md.js");
      const dir = path.join(path.dirname(worktreePath), "old-codex");
      createWorktree(projectPath, dir, "old-codex");
      fs.writeFileSync(path.join(dir, "AGENTS.md"), composeAgentsMd("OLD GARDEN RULES", ""));
      return dir;
    }

    it("are replaced by the claude-code installer, after every checkout's composition is retired", async () => {
      const { createWorktree } = await import("../../src/dashboard/git.js");
      const { claudeCodeAdapter } = await import("../../src/dashboard/harness/claude-code.js");
      createWorktree(projectPath, worktreePath, WORKER);
      const oldCodex = await olderCodexCheckout();
      writeOlderCodexExcludes();

      claudeCodeAdapter.installRuntimeConfig(worktreePath, { path: projectPath });

      expect(fs.existsSync(path.join(oldCodex, "AGENTS.md"))).toBe(false);
      expect(git(oldCodex, "status", "--porcelain")).toBe("");
      expect(excludeLines()).not.toContain("AGENTS.md");
      expect(excludeLines()).not.toContain(".codex/");
      expect(excludeLines()).toContain("/.codex/");
      fs.mkdirSync(path.join(worktreePath, "pkg"));
      fs.writeFileSync(path.join(worktreePath, "pkg", "AGENTS.md"), "# pkg rules\n");
      expect(git(worktreePath, "status", "--porcelain")).toBe("?? pkg/");
    });

    it("keep the AGENTS.md line under the claude-code installer while a composition cannot be retired", async () => {
      const { createWorktree } = await import("../../src/dashboard/git.js");
      const { claudeCodeAdapter } = await import("../../src/dashboard/harness/claude-code.js");
      createWorktree(projectPath, worktreePath, WORKER);
      const oldCodex = await olderCodexCheckout();
      writeOlderCodexExcludes();
      fs.chmodSync(oldCodex, 0o555); // the unlink fails
      try {
        claudeCodeAdapter.installRuntimeConfig(worktreePath, { path: projectPath });

        expect(fs.existsSync(path.join(oldCodex, "AGENTS.md"))).toBe(true);
        expect(git(oldCodex, "status", "--porcelain")).toBe("");
        expect(excludeLines()).toContain("AGENTS.md");
      } finally {
        fs.chmodSync(oldCodex, 0o755);
      }
    });

    it("are replaced when a Claude worker spawns, before its worktree exists", async () => {
      const { buildWorktreeBootstrapScript } = await import("../../src/dashboard/create.js");
      writeOlderCodexExcludes();

      buildWorktreeBootstrapScript(PROJECT, projectPath, WORKER, WORKER, "sid", worktreePath, "main");

      expect(fs.existsSync(worktreePath)).toBe(false);
      expect(excludeLines()).not.toContain("AGENTS.md");
      expect(excludeLines()).not.toContain(".codex/");
      expect(excludeLines()).toContain("/.codex/");
    });
  });

  it("worker registry round-trips a worker entry that points at the real worktree", async () => {
    const { createWorktree } = await import("../../src/dashboard/git.js");
    const { addWorker, getWorkers } = await import("../../src/dashboard/registry.js");

    createWorktree(projectPath, worktreePath, WORKER);

    addWorker(PROJECT, {
      name: WORKER,
      sessionId: "sess-1",
      task: "bootstrap test",
      worktreePath,
      branchName: WORKER,
      baseBranch: "main",
    });

    const workers = getWorkers(PROJECT);
    expect(workers).toHaveLength(1);
    expect(workers[0].worktreePath).toBe(worktreePath);
    expect(workers[0].branchName).toBe(WORKER);

    const file = path.join(env.sessionsDir, "dashboard.registry.json");
    expect(fs.existsSync(file)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(file, "utf-8"));
    expect(onDisk.workers[PROJECT][0].name).toBe(WORKER);
  });

  it("removeWorktree cleans up the directory and prunes the worktree from the project repo", async () => {
    const { createWorktree, removeWorktree, worktreeExists } =
      await import("../../src/dashboard/git.js");

    createWorktree(projectPath, worktreePath, WORKER);
    expect(worktreeExists(worktreePath)).toBe(true);
    removeWorktree(projectPath, worktreePath);
    expect(worktreeExists(worktreePath)).toBe(false);
    const wtList = git(projectPath, "worktree", "list");
    expect(wtList).not.toContain(worktreePath);
  });
});

describe("bootstrap dependency install (real git + stub npm)", () => {
  // A stub npm that does what the real one does to a lockfile out of sync
  // with package.json: rewrites it in place.
  async function install(): Promise<void> {
    const bin = path.join(env.home, "stub-bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "npm"), "#!/bin/sh\necho '{\"rewritten\": true}' > package-lock.json\n", { mode: 0o755 });
    const { npmInstallStep } = await import("../../src/dashboard/create.js");
    const { shellEscape } = await import("../../src/dashboard/tmux.js");
    // The bootstrap script runs under #!/bin/sh, so the step is exercised there.
    const r = spawnSync("sh", ["-c", npmInstallStep(shellEscape(projectPath))], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    expect(r.status).toBe(0);
  }

  beforeEach(() => {
    fs.writeFileSync(path.join(projectPath, "package.json"), "{}\n");
    fs.writeFileSync(path.join(projectPath, "package-lock.json"), "{\"committed\": true}\n");
    git(projectPath, "add", ".");
    git(projectPath, "commit", "-m", "add package files");
  });

  it("leaves the tree clean when npm rewrites a committed lockfile", async () => {
    await install();
    expect(git(projectPath, "status", "--porcelain")).toBe("");
  });

  it("keeps a lockfile that was already modified before the install", async () => {
    fs.writeFileSync(path.join(projectPath, "package-lock.json"), "{\"local\": true}\n");
    await install();
    expect(git(projectPath, "status", "--porcelain")).toBe("M package-lock.json");
  });
});

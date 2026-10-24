// Codex worker runtime-config install, exercised against real fs + git in a
// linked worktree (the shape a garden worker runs in). Covers the pieces the
// live worker-path verification proved: repo-root directory-trust pre-seed,
// git-excludes, and AGENTS.override.md rules delivery (fresh +
// compose-over-existing). See docs/future/CREWS.md.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

function git(cwd: string, ...args: string[]): string {
  return spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).stdout ?? "";
}

describe("codex worker config install (real fs + git)", () => {
  let tmp: string;
  let proj: string;
  let wt: string;
  let codexHome: string;
  let origCodexHome: string | undefined;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-cfg-")));
    codexHome = path.join(tmp, "codexhome");
    fs.mkdirSync(codexHome, { recursive: true });
    origCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;

    proj = path.join(tmp, "proj");
    fs.mkdirSync(proj);
    spawnSync("git", ["init", "-b", "main", proj], { stdio: "ignore" });
    git(proj, "config", "user.email", "t@garden.local");
    git(proj, "config", "user.name", "garden-test");
    fs.writeFileSync(path.join(proj, "README.md"), "# proj\n");
    git(proj, "add", "-A");
    git(proj, "commit", "-m", "init");

    wt = path.join(tmp, "wt");
    git(proj, "worktree", "add", wt, "-b", "wbranch");
  });

  afterEach(() => {
    if (origCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = origCodexHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("pre-seeds directory trust for the REPO ROOT (not the worktree) and excludes", async () => {
    const { getHarness } = await import("../../src/dashboard/harness/index.js");
    getHarness("codex").installRuntimeConfig(wt, { path: proj });

    const cfg = fs.readFileSync(path.join(codexHome, "config.toml"), "utf-8");
    // Codex resolves a linked worktree's trust to the main checkout (repo root),
    // so the entry keys on proj, not wt.
    expect(cfg).toContain(`[projects.${JSON.stringify(fs.realpathSync(proj))}]`);
    expect(cfg).toContain('trust_level = "trusted"');
    expect(cfg).not.toContain(JSON.stringify(fs.realpathSync(wt)));

    // Root-anchored: the file is shared by every checkout of the repo.
    const exclude = fs.readFileSync(path.join(proj, ".git", "info", "exclude"), "utf-8").split("\n");
    expect(exclude).toContain("/.codex/");
    expect(exclude).toContain("/AGENTS.override.md");
    expect(exclude).not.toContain("AGENTS.md");
    expect(exclude).not.toContain(".codex/");
  });

  it("does not duplicate the trust entry on a second install", async () => {
    const { getHarness } = await import("../../src/dashboard/harness/index.js");
    getHarness("codex").installRuntimeConfig(wt, { path: proj });
    getHarness("codex").installRuntimeConfig(wt, { path: proj });
    const cfg = fs.readFileSync(path.join(codexHome, "config.toml"), "utf-8");
    expect((cfg.match(/trust_level = "trusted"/g) ?? []).length).toBe(1);
  });

  it("serializes trust installation across independent worker processes", async () => {
    const adapterUrl = pathToFileURL(
      path.resolve("src/dashboard/harness/index.ts"),
    ).href;
    const source = `
      const { getHarness } = await import(${JSON.stringify(adapterUrl)});
      getHarness("codex").installRuntimeConfig(
        ${JSON.stringify(wt)},
        { path: ${JSON.stringify(proj)} },
      );
    `;
    const run = () => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [
        "--import", "tsx", "--input-type=module", "--eval", source,
      ], {
        cwd: process.cwd(),
        env: { ...process.env, CODEX_HOME: codexHome },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", chunk => { stderr += String(chunk); });
      child.on("error", reject);
      child.on("exit", code => {
        if (code === 0) resolve();
        else reject(new Error(`installer exited ${code}: ${stderr}`));
      });
    });

    await Promise.all(Array.from({ length: 8 }, run));
    const cfg = fs.readFileSync(path.join(codexHome, "config.toml"), "utf-8");
    expect((cfg.match(/trust_level = "trusted"/g) ?? []).length).toBe(1);
  }, 20_000);

  it("writes garden rules to AGENTS.override.md, out of git status, when the repo ships no AGENTS.md", async () => {
    const { getHarness } = await import("../../src/dashboard/harness/index.js");
    getHarness("codex").installRuntimeConfig(wt, { path: proj }, { rulesText: "COMMIT AND PUSH THEN STOP" });
    const agents = fs.readFileSync(path.join(wt, "AGENTS.override.md"), "utf-8");
    expect(agents).toContain("COMMIT AND PUSH THEN STOP");
    expect(agents).toContain("managed by garden");
    expect(fs.existsSync(path.join(wt, "AGENTS.md"))).toBe(false);
    expect(git(wt, "status", "--porcelain")).toBe("");
  });

  it("lets a worker create the repo's AGENTS.md, and composes it into the rules", async () => {
    const { getHarness } = await import("../../src/dashboard/harness/index.js");
    getHarness("codex").installRuntimeConfig(wt, { path: proj }, { rulesText: "GARDEN RULES" });
    fs.writeFileSync(path.join(wt, "AGENTS.md"), "# new repo doc\n");
    expect(git(wt, "status", "--porcelain")).toContain("AGENTS.md");

    getHarness("codex").installRuntimeConfig(wt, { path: proj }, { rulesText: "GARDEN RULES" });
    expect(fs.readFileSync(path.join(wt, "AGENTS.md"), "utf-8")).toBe("# new repo doc\n");
    expect(fs.readFileSync(path.join(wt, "AGENTS.override.md"), "utf-8")).toContain("# new repo doc");
  });

  it("never composes a file the worker linked AGENTS.md to into its rules", async () => {
    // The installer runs unsandboxed and hands the composition back to the
    // worker as its instructions; following the link would deliver a file the
    // worker's own sandbox cannot read.
    const { installCodexAgentsMd } = await import("../../src/dashboard/harness/codex.js");
    const secret = path.join(tmp, "secret.txt");
    fs.writeFileSync(secret, "OPERATOR-SECRET\n");
    fs.symlinkSync(secret, path.join(wt, "AGENTS.md"));

    installCodexAgentsMd(wt, "GARDEN RULES");

    const agents = fs.readFileSync(path.join(wt, "AGENTS.override.md"), "utf-8");
    expect(agents).toContain("GARDEN RULES");
    expect(agents).not.toContain("OPERATOR-SECRET");
    expect(fs.readFileSync(secret, "utf-8")).toBe("OPERATOR-SECRET\n");
  });

  it("replaces a link planted at AGENTS.override.md rather than writing through it", async () => {
    const { installCodexAgentsMd } = await import("../../src/dashboard/harness/codex.js");
    const target = path.join(tmp, "operator-file.txt");
    fs.writeFileSync(target, "KEEP\n");
    fs.symlinkSync(target, path.join(wt, "AGENTS.override.md"));

    installCodexAgentsMd(wt, "GARDEN RULES");

    expect(fs.lstatSync(path.join(wt, "AGENTS.override.md")).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(wt, "AGENTS.override.md"), "utf-8")).toContain("GARDEN RULES");
    expect(fs.readFileSync(target, "utf-8")).toBe("KEEP\n");
  });

  it("runs no fsmonitor from the worktree's config while refreshing rules", async () => {
    fs.writeFileSync(path.join(wt, "AGENTS.md"), "# Repo agents\n");
    git(wt, "add", "AGENTS.md");
    git(wt, "commit", "-m", "add agents");
    const marker = path.join(tmp, "ran");
    const fsmonitor = path.join(tmp, "fsmonitor.sh");
    fs.writeFileSync(fsmonitor, `#!/bin/sh\necho fsmonitor >> "${marker}"\nexit 1\n`);
    fs.chmodSync(fsmonitor, 0o755);
    git(wt, "config", "extensions.worktreeConfig", "true");
    git(wt, "config", "--worktree", "core.fsmonitor", fsmonitor);
    const { getHarness } = await import("../../src/dashboard/harness/index.js");

    getHarness("codex").installRuntimeConfig(wt, { path: proj }, { rulesText: "GARDEN RULES" });

    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.readFileSync(path.join(wt, "AGENTS.override.md"), "utf-8")).toContain("# Repo agents");
  });

  it("refreshes composed rules through the adapter while preserving repository rules", async () => {
    fs.writeFileSync(path.join(wt, "AGENTS.md"), "# repo rules\nRUN THE TESTS\n");
    git(wt, "add", "AGENTS.md");
    git(wt, "commit", "-m", "add agents");

    const { getHarness } = await import("../../src/dashboard/harness/index.js");
    getHarness("codex").installRuntimeConfig(
      wt, { path: proj }, { rulesText: "GARDEN RULES V1" },
    );
    getHarness("codex").installRuntimeConfig(
      wt, { path: proj }, { rulesText: "GARDEN RULES V2" },
    );

    const agents = fs.readFileSync(path.join(wt, "AGENTS.override.md"), "utf-8");
    expect(agents).toContain("GARDEN RULES V2");
    expect(agents).not.toContain("GARDEN RULES V1");
    expect(agents).toContain("RUN THE TESTS");
    expect((agents.match(/managed by garden/g) ?? []).length).toBe(1);
  });

  // The project-checkout launch builders (buildWorkerCommand /
  // buildResumeCommand) install the runtime config into the operator's own
  // checkout, so they deliberately omit rulesText: an override there would
  // put garden's worker rules in place of the repo's AGENTS.md for every
  // Codex session the operator runs in that checkout.
  it("writes no rules file when no rulesText is supplied", async () => {
    fs.writeFileSync(path.join(wt, "AGENTS.md"), "# repo rules\nDO NOT CLOBBER\n");
    git(wt, "add", "AGENTS.md");
    git(wt, "commit", "-m", "add agents");

    const { getHarness } = await import("../../src/dashboard/harness/index.js");
    getHarness("codex").installRuntimeConfig(wt, { path: proj });

    expect(fs.readFileSync(path.join(wt, "AGENTS.md"), "utf-8"))
      .toBe("# repo rules\nDO NOT CLOBBER\n");
    expect(git(wt, "ls-files", "-v", "AGENTS.md").trim()).toMatch(/^H /);
    expect(fs.existsSync(path.join(wt, "AGENTS.override.md"))).toBe(false);
  });

  it("composes over the worktree's AGENTS.md as it stands, leaving a local edit visible", async () => {
    fs.writeFileSync(path.join(wt, "AGENTS.md"), "# repo rules\nINDEX VERSION\n");
    git(wt, "add", "AGENTS.md");
    git(wt, "commit", "-m", "add agents");
    fs.writeFileSync(path.join(wt, "AGENTS.md"), "# repo rules\nLOCAL VERSION\n");

    const { getHarness } = await import("../../src/dashboard/harness/index.js");
    getHarness("codex").installRuntimeConfig(
      wt, { path: proj }, { rulesText: "GARDEN RULES" },
    );

    const agents = fs.readFileSync(path.join(wt, "AGENTS.override.md"), "utf-8");
    expect(agents).toContain("GARDEN RULES");
    expect(agents).toContain("LOCAL VERSION");
    expect(agents).not.toContain("INDEX VERSION");
    expect(git(wt, "status", "--porcelain")).toBe(" M AGENTS.md\n");
  });

  it("composes over a repo's own AGENTS.md, leaves it untouched, and keeps git status clean", async () => {
    fs.writeFileSync(path.join(wt, "AGENTS.md"), "# repo rules\nRUN THE TESTS\n");
    git(wt, "add", "AGENTS.md");
    git(wt, "commit", "-m", "add agents");

    const { getHarness } = await import("../../src/dashboard/harness/index.js");
    getHarness("codex").installRuntimeConfig(wt, { path: proj }, { rulesText: "GARDEN WORKER RULES" });

    const agents = fs.readFileSync(path.join(wt, "AGENTS.override.md"), "utf-8");
    // Both present; garden's rules above the original.
    expect(agents).toContain("GARDEN WORKER RULES");
    expect(agents).toContain("RUN THE TESTS");
    expect(agents.indexOf("GARDEN WORKER RULES")).toBeLessThan(agents.indexOf("RUN THE TESTS"));
    expect(fs.readFileSync(path.join(wt, "AGENTS.md"), "utf-8")).toBe("# repo rules\nRUN THE TESTS\n");
    expect(git(wt, "ls-files", "-v", "AGENTS.md").trim()).toMatch(/^H /);
    expect(git(wt, "status", "--porcelain")).toBe("");
  });

  it("leaves an AGENTS.override.md that garden did not write alone", async () => {
    fs.writeFileSync(path.join(wt, "AGENTS.override.md"), "# the operator's own override\n");
    const { installCodexAgentsMd } = await import("../../src/dashboard/harness/codex.js");
    installCodexAgentsMd(wt, "GARDEN RULES");
    expect(fs.readFileSync(path.join(wt, "AGENTS.override.md"), "utf-8")).toBe("# the operator's own override\n");
  });

  it("never rewrites an AGENTS.override.md the repo tracks, even one carrying garden's marker", async () => {
    const { composeAgentsMd } = await import("../../src/dashboard/harness/agents-md.js");
    const committed = composeAgentsMd("COMMITTED BY MISTAKE", "");
    fs.writeFileSync(path.join(wt, "AGENTS.override.md"), committed);
    git(wt, "add", "AGENTS.override.md");
    git(wt, "commit", "-m", "commit an override");

    const { getHarness } = await import("../../src/dashboard/harness/index.js");
    getHarness("codex").installRuntimeConfig(wt, { path: proj }, { rulesText: "GARDEN RULES" });

    expect(fs.readFileSync(path.join(wt, "AGENTS.override.md"), "utf-8")).toBe(committed);
    expect(git(wt, "status", "--porcelain")).toBe("");
  });

  it("deletes the untracked composition an older build wrote into AGENTS.md", async () => {
    const { composeAgentsMd } = await import("../../src/dashboard/harness/agents-md.js");
    fs.writeFileSync(path.join(wt, "AGENTS.md"), composeAgentsMd("OLD GARDEN RULES", ""));
    fs.appendFileSync(path.join(proj, ".git", "info", "exclude"), "AGENTS.md\n");

    const { getHarness } = await import("../../src/dashboard/harness/index.js");
    getHarness("codex").installRuntimeConfig(wt, { path: proj }, { rulesText: "GARDEN RULES" });

    expect(fs.existsSync(path.join(wt, "AGENTS.md"))).toBe(false);
    expect(fs.readFileSync(path.join(wt, "AGENTS.override.md"), "utf-8")).toContain("GARDEN RULES");
    expect(fs.readdirSync(wt).filter(f => f.startsWith("AGENTS.md.garden-legacy"))).toEqual([]);
    expect(git(wt, "status", "--porcelain")).toBe("");
  });

  // The exclude file is shared, so one worker's refresh dropping the bare line
  // would surface a sibling's untracked composition, garden's rules and all,
  // as a new file the sibling could commit.
  it("retires a sibling worktree's untracked composition before dropping the shared line", async () => {
    const { composeAgentsMd } = await import("../../src/dashboard/harness/agents-md.js");
    const wt2 = path.join(tmp, "wt2");
    git(proj, "worktree", "add", wt2, "-b", "w2");
    fs.writeFileSync(path.join(wt, "AGENTS.md"), composeAgentsMd("OLD GARDEN RULES", ""));
    fs.writeFileSync(path.join(wt2, "AGENTS.md"), composeAgentsMd("OLD GARDEN RULES", ""));
    fs.appendFileSync(path.join(proj, ".git", "info", "exclude"), "AGENTS.md\n");

    const { getHarness } = await import("../../src/dashboard/harness/index.js");
    getHarness("codex").installRuntimeConfig(wt, { path: proj }, { rulesText: "GARDEN RULES" });

    expect(fs.existsSync(path.join(wt2, "AGENTS.md"))).toBe(false);
    expect(git(wt2, "status", "--porcelain")).toBe("");
    expect(fs.readFileSync(path.join(proj, ".git", "info", "exclude"), "utf-8").split("\n")).not.toContain("AGENTS.md");
  });

  it("keeps the shared line while a checkout's untracked composition cannot be retired", async () => {
    const { composeAgentsMd } = await import("../../src/dashboard/harness/agents-md.js");
    const wt2 = path.join(tmp, "wt2");
    git(proj, "worktree", "add", wt2, "-b", "w2");
    fs.writeFileSync(path.join(wt2, "AGENTS.md"), composeAgentsMd("OLD GARDEN RULES", ""));
    fs.appendFileSync(path.join(proj, ".git", "info", "exclude"), "AGENTS.md\n");
    fs.chmodSync(wt2, 0o555); // the unlink fails
    try {
      const { getHarness } = await import("../../src/dashboard/harness/index.js");
      getHarness("codex").installRuntimeConfig(wt, { path: proj }, { rulesText: "GARDEN RULES" });

      expect(fs.existsSync(path.join(wt2, "AGENTS.md"))).toBe(true);
      expect(git(wt2, "status", "--porcelain")).toBe("");
      expect(fs.readFileSync(path.join(proj, ".git", "info", "exclude"), "utf-8").split("\n")).toContain("AGENTS.md");
    } finally {
      fs.chmodSync(wt2, 0o755);
    }
  });

  it("saves what a worker added to an older untracked composition before deleting it", async () => {
    const { composeAgentsMd } = await import("../../src/dashboard/harness/agents-md.js");
    const old = composeAgentsMd("OLD GARDEN RULES", "# notes the worker kept here\n");
    fs.writeFileSync(path.join(wt, "AGENTS.md"), old);

    const { getHarness } = await import("../../src/dashboard/harness/index.js");
    getHarness("codex").installRuntimeConfig(wt, { path: proj }, { rulesText: "GARDEN RULES" });

    expect(fs.existsSync(path.join(wt, "AGENTS.md"))).toBe(false);
    const saved = fs.readdirSync(wt).filter(f => f.startsWith("AGENTS.md.garden-legacy-"));
    expect(saved).toHaveLength(1);
    expect(fs.readFileSync(path.join(wt, saved[0]), "utf-8")).toBe(old);
    expect(git(wt, "status", "--porcelain")).toBe("");
  });

  it("scopes the composed worker rules away from a headless agent sharing the worktree", async () => {
    // A reviewer, resolver or CI-fix run that Codex runs in this worktree
    // loads the rules file too. Reviewers that read the worker rules unscoped
    // pushed their review commits "so the poller sees" them.
    fs.writeFileSync(path.join(wt, "AGENTS.md"), "# repo rules\nRUN THE TESTS\n");
    git(wt, "add", "AGENTS.md");
    git(wt, "commit", "-m", "add agents");
    const { installCodexAgentsMd } = await import("../../src/dashboard/harness/codex.js");
    const { stripGardenRules } = await import("../../src/dashboard/harness/agents-md.js");
    installCodexAgentsMd(wt, "COMMIT AND PUSH THEN STOP");

    const composed = fs.readFileSync(path.join(wt, "AGENTS.override.md"), "utf-8");
    const rules = composed.indexOf("COMMIT AND PUSH THEN STOP");
    // Ahead of the rules, so a reader capped at Codex's default 32 KiB keeps it,
    // and outside any HTML comment.
    const note = composed.slice(0, rules).replace(/<!--[\s\S]*?-->/g, "");
    expect(note).toMatch(/headless/);
    for (const workerOnly of ["push", ".garden-done", ".garden-awaiting-input", "garden blocked"]) {
      expect(note).toContain(workerOnly);
    }
    // The reviewer prompt's copy of the repo's own file stays free of it.
    expect(stripGardenRules(composed)).toBe("# repo rules\nRUN THE TESTS\n");
  });
});

// The rules file against the git that garden and its agents run in a worker's
// worktree, with a real origin: the merge queue's fetch, clean and rebase, a
// worker committing its own AGENTS.md edit, and the info/exclude shared by
// every checkout of the repo.
describe("codex rules file vs the worktree's git (real fs + git + origin)", () => {
  let tmp: string;
  let proj: string;
  let wt: string;
  let origCodexHome: string | undefined;

  function run(cwd: string, ...args: string[]): string {
    const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout;
  }
  const read = (file: string) => fs.readFileSync(file, "utf-8");
  async function install(rulesText: string): Promise<void> {
    const { getHarness } = await import("../../src/dashboard/harness/index.js");
    getHarness("codex").installRuntimeConfig(wt, { path: proj }, { rulesText });
  }
  // A sibling's merge lands an AGENTS.md change on origin's main.
  function landOnBase(content: string): void {
    fs.writeFileSync(path.join(proj, "AGENTS.md"), content);
    run(proj, "commit", "-qam", "sibling edits AGENTS.md");
    run(proj, "push", "-q", "origin", "main");
  }
  // The worker commits, then the merge queue runs handleMergePending's sequence.
  async function commitAndRebase(): Promise<unknown> {
    fs.writeFileSync(path.join(wt, "feature.txt"), "work\n");
    run(wt, "add", "feature.txt");
    run(wt, "commit", "-qm", "feature");
    const { fetchBaseBranch, cleanWorktree, rebaseBranch } = await import("../../src/dashboard/git.js");
    fetchBaseBranch(wt, "main");
    cleanWorktree(wt);
    return rebaseBranch(wt, "main");
  }
  // What an older build left in a worktree whose repo tracks AGENTS.md: the
  // composition in the working file, hidden behind skip-worktree, and the
  // unanchored exclude lines.
  async function installAsOlderBuild(rulesText: string, excludes = ".codex/\nAGENTS.md\n"): Promise<string> {
    const { composeAgentsMd } = await import("../../src/dashboard/harness/agents-md.js");
    const composed = composeAgentsMd(rulesText, read(path.join(wt, "AGENTS.md")));
    fs.writeFileSync(path.join(wt, "AGENTS.md"), composed);
    run(wt, "update-index", "--skip-worktree", "AGENTS.md");
    fs.appendFileSync(path.join(proj, ".git", "info", "exclude"), excludes);
    return composed;
  }
  const legacyCopies = () => fs.readdirSync(wt).filter(f => f.startsWith("AGENTS.md.garden-legacy-"));

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-git-")));
    origCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = path.join(tmp, "codexhome");
    fs.mkdirSync(process.env.CODEX_HOME);
    const origin = path.join(tmp, "origin.git");
    spawnSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    proj = path.join(tmp, "proj");
    spawnSync("git", ["init", "-q", "-b", "main", proj]);
    run(proj, "config", "user.email", "t@garden.local");
    run(proj, "config", "user.name", "garden-test");
    fs.writeFileSync(path.join(proj, "AGENTS.md"), "# repo rules\nVERSION ONE\n");
    fs.writeFileSync(path.join(proj, "README.md"), "# proj\n");
    run(proj, "add", "-A");
    run(proj, "commit", "-qm", "init");
    run(proj, "remote", "add", "origin", origin);
    run(proj, "push", "-q", "origin", "main");
    // Branched the way the bootstrap does: off the base commit, tracking origin's base.
    wt = path.join(tmp, "wt");
    run(proj, "worktree", "add", "-q", "-b", "wbranch", wt, run(proj, "rev-parse", "HEAD").trim());
    run(proj, "branch", "-q", "--set-upstream-to=refs/remotes/origin/main", "wbranch");
  });

  afterEach(() => {
    if (origCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = origCodexHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("lets the merge queue rebase a worker after the base changes AGENTS.md", async () => {
    await install("GARDEN RULES");
    landOnBase("# repo rules\nVERSION TWO\n");

    expect(await commitAndRebase()).toEqual({ kind: "ok" });
    expect(read(path.join(wt, "AGENTS.md"))).toBe("# repo rules\nVERSION TWO\n");

    // The next refresh hands the worker the repo's new instructions.
    await install("GARDEN RULES V2");
    const rules = read(path.join(wt, "AGENTS.override.md"));
    expect(rules).toContain("GARDEN RULES V2");
    expect(rules).toContain("VERSION TWO");
    expect(rules).not.toContain("VERSION ONE");
    expect(run(wt, "status", "--porcelain")).toBe("");
  });

  // The other two git paths garden itself runs across a base change: the
  // fast-forward behind the holistic review and `workers grow`, and the reset
  // onto the reviewer's force-pushed branch after a merge.
  it("lets a fully merged worker fast-forward onto a base that changed AGENTS.md", async () => {
    await install("GARDEN RULES");
    landOnBase("# repo rules\nVERSION TWO\n");
    const { syncWorktreeToBase } = await import("../../src/dashboard/git.js");
    expect(syncWorktreeToBase(wt, "main")).toEqual({ ok: true });
    expect(read(path.join(wt, "AGENTS.md"))).toBe("# repo rules\nVERSION TWO\n");
  });

  it("lets the post-merge sync reset onto a reviewer's rebase across an AGENTS.md change", async () => {
    await install("GARDEN RULES");
    fs.writeFileSync(path.join(wt, "feature.txt"), "work\n");
    run(wt, "add", "feature.txt");
    run(wt, "commit", "-qm", "feature");
    const feature = run(wt, "rev-parse", "HEAD").trim();
    landOnBase("# repo rules\nVERSION TWO\n");
    // The reviewer's rebase, published from another checkout.
    run(proj, "checkout", "-q", "-b", "reviewed", "main");
    run(proj, "cherry-pick", feature);
    run(proj, "push", "-q", "-f", "origin", "reviewed:wbranch");
    const { syncWorktreeToRemote } = await import("../../src/dashboard/git.js");
    expect(syncWorktreeToRemote(wt, "wbranch")).toEqual({ ok: true });
    expect(read(path.join(wt, "AGENTS.md"))).toBe("# repo rules\nVERSION TWO\n");
  });

  it("retires an older build's tracked composition, so the next rebase goes through", async () => {
    await installAsOlderBuild("OLD GARDEN RULES");
    await install("GARDEN RULES");

    expect(read(path.join(wt, "AGENTS.md"))).toBe("# repo rules\nVERSION ONE\n");
    expect(run(wt, "ls-files", "-v", "AGENTS.md").trim()).toMatch(/^H /);
    const rules = read(path.join(wt, "AGENTS.override.md"));
    expect(rules).toContain("GARDEN RULES");
    expect(rules).not.toContain("OLD GARDEN RULES");
    expect(rules).toContain("VERSION ONE");
    expect(legacyCopies()).toEqual([]);
    expect(run(wt, "status", "--porcelain")).toBe("");

    landOnBase("# repo rules\nVERSION TWO\n");
    expect(await commitAndRebase()).toEqual({ kind: "ok" });
  });

  // Another checkout's refresh can drop the shared lines first; a tracked
  // composition is retired by its own worker's refresh all the same.
  it("retires an older build's tracked composition after the shared lines are gone", async () => {
    await installAsOlderBuild("OLD GARDEN RULES", "");
    await install("GARDEN RULES");

    expect(read(path.join(wt, "AGENTS.md"))).toBe("# repo rules\nVERSION ONE\n");
    expect(run(wt, "ls-files", "-v", "AGENTS.md").trim()).toMatch(/^H /);
    expect(run(wt, "status", "--porcelain")).toBe("");
  });

  it("saves a worker's edit to an older build's composition before restoring AGENTS.md", async () => {
    const composed = await installAsOlderBuild("OLD GARDEN RULES");
    fs.appendFileSync(path.join(wt, "AGENTS.md"), "WORKER EDIT\n");
    await install("GARDEN RULES");

    expect(read(path.join(wt, "AGENTS.md"))).toBe("# repo rules\nVERSION ONE\n");
    expect(run(wt, "ls-files", "-v", "AGENTS.md").trim()).toMatch(/^H /);
    const saved = legacyCopies();
    expect(saved).toHaveLength(1);
    expect(read(path.join(wt, saved[0]))).toBe(`${composed}WORKER EDIT\n`);
    expect(run(wt, "status", "--porcelain")).toBe("");
  });

  it("replaces the unanchored exclude lines an older build wrote", async () => {
    await installAsOlderBuild("OLD GARDEN RULES");
    await install("GARDEN RULES");

    const exclude = read(path.join(proj, ".git", "info", "exclude")).split("\n");
    expect(exclude).not.toContain("AGENTS.md");
    expect(exclude).not.toContain(".codex/");
    expect(exclude).toContain("/AGENTS.override.md");
    expect(exclude).toContain("/.codex/");
    fs.mkdirSync(path.join(wt, "pkg"));
    fs.writeFileSync(path.join(wt, "pkg", "AGENTS.md"), "# pkg rules\n");
    expect(run(wt, "status", "--porcelain")).toBe("?? pkg/\n");
  });

  it("lets a worker commit its own AGENTS.md edit, and keeps the edit through a refresh", async () => {
    await install("GARDEN RULES V1");
    fs.appendFileSync(path.join(wt, "AGENTS.md"), "WORKER EDIT\n");
    expect(run(wt, "status", "--porcelain")).toContain("AGENTS.md");

    await install("GARDEN RULES V2"); // attach, bounce, loop respawn
    expect(read(path.join(wt, "AGENTS.md"))).toBe("# repo rules\nVERSION ONE\nWORKER EDIT\n");
    run(wt, "add", "AGENTS.md");
    run(wt, "commit", "-qm", "document the change");
    expect(run(wt, "show", "HEAD:AGENTS.md")).toBe("# repo rules\nVERSION ONE\nWORKER EDIT\n");
  });

  it("leaves a new nested AGENTS.md visible to git in every checkout", async () => {
    await install("GARDEN RULES");
    expect(run(wt, "status", "--porcelain")).toBe("");

    fs.mkdirSync(path.join(wt, "pkg"));
    fs.writeFileSync(path.join(wt, "pkg", "AGENTS.md"), "# pkg rules\n");
    fs.mkdirSync(path.join(proj, "svc"));
    fs.writeFileSync(path.join(proj, "svc", "AGENTS.md"), "# svc rules\n");
    expect(run(wt, "status", "--porcelain")).toContain("pkg/");
    expect(run(proj, "status", "--porcelain")).toContain("svc/");
  });
});

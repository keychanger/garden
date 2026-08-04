// Codex worker runtime-config install, exercised against real fs + git in a
// linked worktree (the shape a garden worker runs in). Covers the pieces the
// live worker-path verification proved: repo-root directory-trust pre-seed,
// git-excludes, and AGENTS.md rules delivery (fresh + compose-over-existing).
// See docs/future/CREWS.md.
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

    const exclude = fs.readFileSync(path.join(proj, ".git", "info", "exclude"), "utf-8");
    expect(exclude).toContain(".codex/");
    expect(exclude).toContain("AGENTS.md");
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

  it("writes garden rules to AGENTS.md when the repo ships none", async () => {
    const { installCodexAgentsMd } = await import("../../src/dashboard/harness/codex.js");
    installCodexAgentsMd(wt, "COMMIT AND PUSH THEN STOP");
    const agents = fs.readFileSync(path.join(wt, "AGENTS.md"), "utf-8");
    expect(agents).toContain("COMMIT AND PUSH THEN STOP");
    expect(agents).toContain("managed by garden");
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

    const agents = fs.readFileSync(path.join(wt, "AGENTS.md"), "utf-8");
    expect(agents).toContain("GARDEN RULES V2");
    expect(agents).not.toContain("GARDEN RULES V1");
    expect(agents).toContain("RUN THE TESTS");
    expect((agents.match(/managed by garden/g) ?? []).length).toBe(1);
  });

  // The project-checkout launch builders (buildWorkerCommand /
  // buildResumeCommand) install the runtime config into the operator's own
  // checkout, so they deliberately omit rulesText. That omission is only safe
  // because it leaves a repo-file rules channel alone: rewriting a tracked
  // AGENTS.md there and marking it skip-worktree would clobber the operator's
  // instructions invisibly (`git status` stays clean by construction).
  it("leaves a tracked AGENTS.md untouched when no rulesText is supplied", async () => {
    fs.writeFileSync(path.join(wt, "AGENTS.md"), "# repo rules\nDO NOT CLOBBER\n");
    git(wt, "add", "AGENTS.md");
    git(wt, "commit", "-m", "add agents");

    const { getHarness } = await import("../../src/dashboard/harness/index.js");
    getHarness("codex").installRuntimeConfig(wt, { path: proj });

    expect(fs.readFileSync(path.join(wt, "AGENTS.md"), "utf-8"))
      .toBe("# repo rules\nDO NOT CLOBBER\n");
    expect(git(wt, "ls-files", "-v", "AGENTS.md").trim()).toMatch(/^H /);
  });

  it("preserves a tracked worktree edit on the first rules install", async () => {
    fs.writeFileSync(path.join(wt, "AGENTS.md"), "# repo rules\nINDEX VERSION\n");
    git(wt, "add", "AGENTS.md");
    git(wt, "commit", "-m", "add agents");
    fs.writeFileSync(path.join(wt, "AGENTS.md"), "# repo rules\nLOCAL VERSION\n");

    const { getHarness } = await import("../../src/dashboard/harness/index.js");
    getHarness("codex").installRuntimeConfig(
      wt, { path: proj }, { rulesText: "GARDEN RULES" },
    );

    const agents = fs.readFileSync(path.join(wt, "AGENTS.md"), "utf-8");
    expect(agents).toContain("GARDEN RULES");
    expect(agents).toContain("LOCAL VERSION");
    expect(agents).not.toContain("INDEX VERSION");
  });

  it("refreshes repository rules from Git even while AGENTS.md is skip-worktree", async () => {
    fs.writeFileSync(path.join(wt, "AGENTS.md"), "# repo rules\nVERSION ONE\n");
    git(wt, "add", "AGENTS.md");
    git(wt, "commit", "-m", "add agents");

    const { getHarness } = await import("../../src/dashboard/harness/index.js");
    getHarness("codex").installRuntimeConfig(
      wt, { path: proj }, { rulesText: "GARDEN RULES V1" },
    );

    // Model a rebase/merge advancing the tracked file: Git's index has the
    // new repository content while the skip-worktree file still contains
    // Garden's V1 composition over VERSION ONE.
    const blob = spawnSync(
      "git", ["-C", wt, "hash-object", "-w", "--stdin"],
      { input: "# repo rules\nVERSION TWO\n", encoding: "utf-8" },
    );
    expect(blob.status).toBe(0);
    git(wt, "update-index", "--no-skip-worktree", "AGENTS.md");
    git(wt, "update-index", "--cacheinfo", `100644,${blob.stdout.trim()},AGENTS.md`);
    git(wt, "update-index", "--skip-worktree", "AGENTS.md");

    getHarness("codex").installRuntimeConfig(
      wt, { path: proj }, { rulesText: "GARDEN RULES V2" },
    );
    const agents = fs.readFileSync(path.join(wt, "AGENTS.md"), "utf-8");
    expect(agents).toContain("GARDEN RULES V2");
    expect(agents).toContain("VERSION TWO");
    expect(agents).not.toContain("VERSION ONE");
  });

  it("composes over a repo's own AGENTS.md, preserves it, and keeps git status clean", async () => {
    fs.writeFileSync(path.join(wt, "AGENTS.md"), "# repo rules\nRUN THE TESTS\n");
    git(wt, "add", "AGENTS.md");
    git(wt, "commit", "-m", "add agents");

    const { installCodexAgentsMd } = await import("../../src/dashboard/harness/codex.js");
    installCodexAgentsMd(wt, "GARDEN WORKER RULES");

    const agents = fs.readFileSync(path.join(wt, "AGENTS.md"), "utf-8");
    // Both present; garden's rules prepended above the original.
    expect(agents).toContain("GARDEN WORKER RULES");
    expect(agents).toContain("RUN THE TESTS");
    expect(agents.indexOf("GARDEN WORKER RULES")).toBeLessThan(agents.indexOf("RUN THE TESTS"));
    // skip-worktree keeps the local composition out of git status / commits.
    const status = spawnSync("git", ["-C", wt, "status", "--porcelain"], { encoding: "utf-8" }).stdout;
    expect(status).not.toContain("AGENTS.md");
  });
});

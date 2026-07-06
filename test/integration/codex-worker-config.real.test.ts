// Codex worker runtime-config install, exercised against real fs + git in a
// linked worktree (the shape a garden worker runs in). Covers the pieces the
// live worker-path verification proved: repo-root directory-trust pre-seed,
// git-excludes, and AGENTS.md rules delivery (fresh + compose-over-existing).
// See docs/future/CREWS.md.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

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

  it("writes garden rules to AGENTS.md when the repo ships none", async () => {
    const { installCodexAgentsMd } = await import("../../src/dashboard/harness/codex.js");
    installCodexAgentsMd(wt, "COMMIT AND PUSH THEN STOP");
    const agents = fs.readFileSync(path.join(wt, "AGENTS.md"), "utf-8");
    expect(agents).toContain("COMMIT AND PUSH THEN STOP");
    expect(agents).toContain("managed by garden");
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

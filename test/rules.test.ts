import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { useTmpHome } from "./helpers.js";

const env = useTmpHome();

async function importRules() {
  return await import("../src/rules.js");
}

describe("buildRulesContext", () => {
  it("includes project name", async () => {
    const { buildRulesContext } = await importRules();
    const result = buildRulesContext("myproject", "/tmp/myproject");
    expect(result).toContain('"myproject"');
  });

  it("includes global rules when present", async () => {
    const { buildRulesContext } = await importRules();
    fs.writeFileSync(path.join(env.gardenDir, "rules.md"), "global rule content");
    const result = buildRulesContext("proj", "/tmp/proj");
    expect(result).toContain("global rule content");
    expect(result).toContain("## Global rules");
  });

  it("includes project rules when present", async () => {
    const { buildRulesContext } = await importRules();
    const projectPath = path.join(env.home, "myproject");
    fs.mkdirSync(path.join(projectPath, ".garden"), { recursive: true });
    fs.writeFileSync(path.join(projectPath, ".garden", "rules.md"), "project rule content");
    const result = buildRulesContext("myproject", projectPath);
    expect(result).toContain("project rule content");
    expect(result).toContain("## Project rules");
  });

  it("includes both when both present", async () => {
    const { buildRulesContext } = await importRules();
    fs.writeFileSync(path.join(env.gardenDir, "rules.md"), "global rules");
    const projectPath = path.join(env.home, "proj");
    fs.mkdirSync(path.join(projectPath, ".garden"), { recursive: true });
    fs.writeFileSync(path.join(projectPath, ".garden", "rules.md"), "project rules");
    const result = buildRulesContext("proj", projectPath);
    expect(result).toContain("global rules");
    expect(result).toContain("project rules");
  });

  it("handles missing global rules", async () => {
    const { buildRulesContext } = await importRules();
    const result = buildRulesContext("proj", "/tmp/proj");
    expect(result).not.toContain("## Global rules");
    expect(result).toContain('"proj"');
  });

  it("handles missing project rules", async () => {
    const { buildRulesContext } = await importRules();
    const result = buildRulesContext("proj", "/tmp/nonexistent");
    expect(result).not.toContain("## Project rules");
  });
});

describe("buildWorktreeRules", () => {
  it("includes branch name", async () => {
    const { buildWorktreeRules } = await importRules();
    const result = buildWorktreeRules("swift-oak");
    expect(result).toContain("`swift-oak`");
  });

  it("instructs to commit incrementally", async () => {
    const { buildWorktreeRules } = await importRules();
    const result = buildWorktreeRules("test-branch");
    expect(result).toContain("Commit your work incrementally");
  });

  it("instructs to push branch for review", async () => {
    const { buildWorktreeRules } = await importRules();
    const result = buildWorktreeRules("test-branch");
    expect(result).toContain("push your branch");
  });

  it("instructs about poller auto-merge", async () => {
    const { buildWorktreeRules } = await importRules();
    const result = buildWorktreeRules("test-branch");
    expect(result).toContain("poller will automatically rebase, review, and merge");
  });

  it("defaults to main as base branch", async () => {
    const { buildWorktreeRules } = await importRules();
    const result = buildWorktreeRules("test-branch");
    expect(result).toContain("merge your changes into main");
  });

  it("uses custom base branch when specified", async () => {
    const { buildWorktreeRules } = await importRules();
    const result = buildWorktreeRules("test-branch", "develop");
    expect(result).toContain("merge your changes into develop");
    expect(result).not.toContain("into main");
  });

  it("treats docs and configs as deliverables, not just code", async () => {
    // Workers have regressed on doc-only tasks (e.g. "create CLAUDE.md"):
    // they wrote the file, considered the task done, and stopped without
    // committing or pushing. The wording must explicitly cover non-code files.
    const { buildWorktreeRules } = await importRules();
    const result = buildWorktreeRules("test-branch");
    expect(result).toContain("docs");
    expect(result).toContain("CLAUDE.md");
  });

  it("instructs to verify clean tree before ending turn", async () => {
    // A pre-stop self-check is the cheapest way to catch the worker that
    // wrote a file but never committed or pushed it.
    const { buildWorktreeRules } = await importRules();
    const result = buildWorktreeRules("test-branch");
    expect(result).toContain("git status");
    expect(result).toContain("@{u}..HEAD");
  });

  it("explicitly forbids creating a side branch", async () => {
    // This directive prevents the worker side-branch trap that loops the
    // poller forever. See `feedback_worker_branch_trap` in agent memory and
    // forcePushBranch's HEAD: refspec for the corresponding code-level guard.
    const { buildWorktreeRules } = await importRules();
    const result = buildWorktreeRules("swift-oak");
    expect(result).toContain("Do NOT");
    expect(result).toContain("git checkout -b");
    expect(result).toContain("`swift-oak`");
  });

  it("explicitly forbids sleep/polling loops that watch the poller", async () => {
    // The poller advances working -> reviewing only on the Claude Code Stop
    // hook. A worker that sleeps in a bash loop to watch state transitions
    // keeps its turn alive and blocks the hook from firing — deadlock.
    const { buildWorktreeRules } = await importRules();
    const result = buildWorktreeRules("test-branch");
    expect(result).toMatch(/sleep|loop-poll/i);
    expect(result).toContain("Stop hook");
    expect(result).toContain("end your turn");
  });
});

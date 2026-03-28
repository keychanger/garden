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

  it("instructs to open PR against main", async () => {
    const { buildWorktreeRules } = await importRules();
    const result = buildWorktreeRules("test-branch");
    expect(result).toContain("pull request against main");
  });

  it("instructs to exit after PR", async () => {
    const { buildWorktreeRules } = await importRules();
    const result = buildWorktreeRules("test-branch");
    expect(result).toContain("After opening the PR, exit");
  });
});

describe("buildReviewRules", () => {
  it("includes PR number", async () => {
    const { buildReviewRules } = await importRules();
    const result = buildReviewRules(42, "swift-oak");
    expect(result).toContain("PR #42");
  });

  it("includes branch name", async () => {
    const { buildReviewRules } = await importRules();
    const result = buildReviewRules(42, "swift-oak");
    expect(result).toContain("`swift-oak`");
  });

  it("instructs to read diff", async () => {
    const { buildReviewRules } = await importRules();
    const result = buildReviewRules(42, "swift-oak");
    expect(result).toContain("gh pr diff 42");
  });

  it("instructs to merge on approval", async () => {
    const { buildReviewRules } = await importRules();
    const result = buildReviewRules(42, "swift-oak");
    expect(result).toContain("gh pr merge 42 --squash --delete-branch");
  });

  it("instructs to request changes with feedback", async () => {
    const { buildReviewRules } = await importRules();
    const result = buildReviewRules(42, "swift-oak");
    expect(result).toContain("gh pr review 42 --request-changes");
  });

  it("instructs to exit after review", async () => {
    const { buildReviewRules } = await importRules();
    const result = buildReviewRules(42, "swift-oak");
    expect(result).toContain("After completing your review action, exit");
  });
});

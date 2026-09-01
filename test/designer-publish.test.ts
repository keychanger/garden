import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  isPublishablePath,
  DESIGNER_PUBLISH_ROOT,
  DESIGNER_ARTIFACT_REL,
  publishDesignerArtifact,
} from "../src/dashboard/designer-publish.js";

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

// A real temp git worktree with an initial commit and a drafted designer artifact.
function makeWorktreeWithArtifact(): string {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), "designer-publish-"));
  spawnSync("git", ["init", "-b", "main", wt], { stdio: "ignore" });
  git(wt, "config", "user.email", "test@garden.local");
  git(wt, "config", "user.name", "garden-test");
  fs.writeFileSync(path.join(wt, "README.md"), "# proj\n");
  git(wt, "add", ".");
  git(wt, "commit", "-m", "init");
  fs.mkdirSync(path.join(wt, ".garden", "designer"), { recursive: true });
  fs.writeFileSync(path.join(wt, DESIGNER_ARTIFACT_REL), "# Design\n\nThe approved artifact.\n");
  return wt;
}

describe("isPublishablePath", () => {
  it("accepts paths under docs/", () => {
    expect(isPublishablePath("docs/future/notification-levels.md")).toBe(true);
    expect(isPublishablePath("docs/memo.md")).toBe(true);
    expect(DESIGNER_PUBLISH_ROOT).toBe("docs/");
  });

  it("rejects code paths, absolute paths, and traversal escapes", () => {
    expect(isPublishablePath("src/dashboard/x.ts")).toBe(false);
    expect(isPublishablePath("README.md")).toBe(false);
    expect(isPublishablePath(".garden/designer/artifact.md")).toBe(false);
    expect(isPublishablePath("/etc/passwd")).toBe(false);
    // Traversal that textually starts with docs/ but escapes the boundary.
    expect(isPublishablePath("docs/../src/evil.ts")).toBe(false);
  });
});

describe("publishDesignerArtifact", () => {
  it("rejects a non-docs target without touching the tree", () => {
    const wt = makeWorktreeWithArtifact();
    const r = publishDesignerArtifact(wt, "src/x.md");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/under 'docs\/'/);
    // Artifact untouched.
    expect(fs.existsSync(path.join(wt, DESIGNER_ARTIFACT_REL))).toBe(true);
  });

  it("rejects a non-Markdown target", () => {
    const wt = makeWorktreeWithArtifact();
    const r = publishDesignerArtifact(wt, "docs/future/design.txt");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Markdown/);
  });

  it("errors when there is no drafted artifact", () => {
    const wt = makeWorktreeWithArtifact();
    fs.rmSync(path.join(wt, DESIGNER_ARTIFACT_REL));
    const r = publishDesignerArtifact(wt, "docs/future/design.md");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/No artifact to publish/);
  });

  it("--dry-run reports the plan and changes nothing", () => {
    const wt = makeWorktreeWithArtifact();
    const before = git(wt, "rev-parse", "HEAD");
    const r = publishDesignerArtifact(wt, "docs/future/design.md", { dryRun: true });
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/\[dry-run\]/);
    // No move, no commit, no sentinel.
    expect(fs.existsSync(path.join(wt, DESIGNER_ARTIFACT_REL))).toBe(true);
    expect(fs.existsSync(path.join(wt, "docs/future/design.md"))).toBe(false);
    expect(fs.existsSync(path.join(wt, ".garden-done"))).toBe(false);
    expect(git(wt, "rev-parse", "HEAD")).toBe(before);
  });

  it("moves the artifact to the tracked docs path, commits it, and marks done", () => {
    const wt = makeWorktreeWithArtifact();
    const r = publishDesignerArtifact(wt, "docs/future/notification-levels.md");
    expect(r.ok).toBe(true);

    // The artifact moved out of .garden/ into the tracked docs path.
    expect(fs.existsSync(path.join(wt, DESIGNER_ARTIFACT_REL))).toBe(false);
    const published = path.join(wt, "docs/future/notification-levels.md");
    expect(fs.existsSync(published)).toBe(true);
    expect(fs.readFileSync(published, "utf-8")).toContain("The approved artifact.");

    // A single commit was created touching only the published doc.
    const changed = git(wt, "diff", "--name-only", "HEAD~1..HEAD");
    expect(changed).toBe("docs/future/notification-levels.md");
    expect(git(wt, "log", "-1", "--pretty=%s")).toMatch(/designer/);

    // The done sentinel was written so the skip-review merge finalizes to done.
    expect(fs.existsSync(path.join(wt, ".garden-done"))).toBe(true);

    // The success message points the designer at both handoff routes. The
    // trellis route must plant by NAME from the trellis dir — --trellis never
    // resolves a docs/ path (trellis-tag.ts findTrellisByName).
    expect(r.message).toContain("garden handoff");
    expect(r.message).toContain(
      "cp docs/future/notification-levels.md .garden/trellises/notification-levels.md",
    );
    expect(r.message).toContain("--workflow trellis --trellis notification-levels");
    expect(r.message).not.toContain("--trellis docs/");
  });

  it("uses the configured trellisDir and shell-escapes the printed command", () => {
    const wt = makeWorktreeWithArtifact();
    const r = publishDesignerArtifact(wt, "docs/future/notification levels.md", {
      project: "my project",
      trellisDir: "docs/custom trellises",
    });

    expect(r.ok).toBe(true);
    expect(r.message).toContain(
      "cp 'docs/future/notification levels.md' 'docs/custom trellises/notification levels.md'",
    );
    expect(r.message).toContain(
      "garden workers new 'my project' --workflow trellis --trellis 'notification levels'",
    );
    expect(r.message).toContain("garden handoff 'my project'");
  });
});

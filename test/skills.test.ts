import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({
  default: {
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  },
}));

import fs from "node:fs";
import {
  DONE_SKILL_FILENAME,
  DONE_SKILL_CONTENT,
  installClaudeSkills,
} from "../src/dashboard/skills.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("installClaudeSkills", () => {
  it("writes done.md under <targetDir>/.claude/skills/", () => {
    installClaudeSkills("/Users/x/.garden/worktrees/myproject/bold-ash");
    expect(fs.mkdirSync).toHaveBeenCalledWith(
      "/Users/x/.garden/worktrees/myproject/bold-ash/.claude/skills",
      { recursive: true },
    );
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      "/Users/x/.garden/worktrees/myproject/bold-ash/.claude/skills/done.md",
      DONE_SKILL_CONTENT,
    );
  });

  it("filename constant matches what installClaudeSkills writes", () => {
    expect(DONE_SKILL_FILENAME).toBe("done.md");
  });
});

describe("DONE_SKILL_CONTENT", () => {
  it("starts with valid frontmatter declaring the skill name", () => {
    expect(DONE_SKILL_CONTENT).toMatch(/^---\nname: done\n/);
  });

  it("declares a description that triggers when the worker is finishing its work", () => {
    const match = DONE_SKILL_CONTENT.match(/description: ([^\n]+)/);
    expect(match).not.toBeNull();
    const desc = match![1];
    // The description is the trigger condition Claude evaluates — it must
    // mention both the precondition (work is complete) and the action
    // (writes the sentinel) so the skill fires at the right moment.
    expect(desc.toLowerCase()).toContain("complet");
    expect(desc).toContain(".garden-done");
  });

  it("includes the touch command and the sentinel filename in the body", () => {
    expect(DONE_SKILL_CONTENT).toContain("touch .garden-done");
    expect(DONE_SKILL_CONTENT).toContain(".garden-done");
  });

  it("explicitly warns against committing the sentinel", () => {
    expect(DONE_SKILL_CONTENT.toLowerCase()).toMatch(/do.*not.*git add|not.*commit/);
  });

  it("calls out when NOT to invoke the skill (mid-phase, failing reviews)", () => {
    expect(DONE_SKILL_CONTENT.toLowerCase()).toContain("when not to use");
    expect(DONE_SKILL_CONTENT.toLowerCase()).toContain("failing");
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({
  default: {
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    rmSync: vi.fn(),
  },
}));

import fs from "node:fs";
import {
  DONE_SKILL_DIRNAME,
  DONE_SKILL_FILENAME,
  DONE_SKILL_CONTENT,
  HANDOFF_SKILL_DIRNAME,
  HANDOFF_SKILL_FILENAME,
  HANDOFF_SKILL_CONTENT,
  installClaudeSkills,
} from "../src/dashboard/skills.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("installClaudeSkills", () => {
  it("writes SKILL.md under <targetDir>/.claude/skills/done/ (Claude Code's required dir+SKILL.md layout)", () => {
    installClaudeSkills("/Users/x/.garden/worktrees/myproject/bold-ash");
    expect(fs.mkdirSync).toHaveBeenCalledWith(
      "/Users/x/.garden/worktrees/myproject/bold-ash/.claude/skills/done",
      { recursive: true },
    );
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      "/Users/x/.garden/worktrees/myproject/bold-ash/.claude/skills/done/SKILL.md",
      DONE_SKILL_CONTENT,
    );
  });

  it("removes the legacy flat-file done.md so refreshes/bounces of pre-fix worktrees heal", () => {
    installClaudeSkills("/Users/x/.garden/worktrees/myproject/bold-ash");
    expect(fs.rmSync).toHaveBeenCalledWith(
      "/Users/x/.garden/worktrees/myproject/bold-ash/.claude/skills/done.md",
      { force: true },
    );
  });

  it("constants match what installClaudeSkills writes", () => {
    expect(DONE_SKILL_DIRNAME).toBe("done");
    expect(DONE_SKILL_FILENAME).toBe("SKILL.md");
    expect(HANDOFF_SKILL_DIRNAME).toBe("handoff");
    expect(HANDOFF_SKILL_FILENAME).toBe("SKILL.md");
  });

  it("writes the handoff skill alongside done so workers can invoke it", () => {
    installClaudeSkills("/Users/x/.garden/worktrees/myproject/bold-ash");
    expect(fs.mkdirSync).toHaveBeenCalledWith(
      "/Users/x/.garden/worktrees/myproject/bold-ash/.claude/skills/handoff",
      { recursive: true },
    );
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      "/Users/x/.garden/worktrees/myproject/bold-ash/.claude/skills/handoff/SKILL.md",
      HANDOFF_SKILL_CONTENT,
    );
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

describe("HANDOFF_SKILL_CONTENT", () => {
  it("starts with valid frontmatter declaring the skill name", () => {
    expect(HANDOFF_SKILL_CONTENT).toMatch(/^---\nname: handoff\n/);
  });

  it("description gates invocation to explicit operator instruction", () => {
    const match = HANDOFF_SKILL_CONTENT.match(/description: ([^\n]+)/);
    expect(match).not.toBeNull();
    const desc = match![1];
    // The trigger must require an explicit operator instruction so the worker
    // does not self-hand-off — that behavior is the whole point of the rule.
    expect(desc.toLowerCase()).toMatch(/operator|instruct/);
    expect(desc.toLowerCase()).toContain("not");
  });

  it("teaches the heredoc invocation recipe", () => {
    expect(HANDOFF_SKILL_CONTENT).toContain("garden handoff <target-project>");
    expect(HANDOFF_SKILL_CONTENT).toContain("<<'EOF'");
    expect(HANDOFF_SKILL_CONTENT).toContain("-m");
  });

  it("instructs the worker to write .garden-done after a successful handoff", () => {
    expect(HANDOFF_SKILL_CONTENT).toContain("touch .garden-done");
  });

  it("calls out when NOT to invoke the skill", () => {
    expect(HANDOFF_SKILL_CONTENT.toLowerCase()).toContain("when not to use");
    expect(HANDOFF_SKILL_CONTENT.toLowerCase()).toMatch(/did not ask|self-handing/);
  });
});

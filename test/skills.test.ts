import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({
  default: {
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    unlinkSync: vi.fn(),
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
  TRELLIS_AUTHOR_SKILL_DIRNAME,
  TRELLIS_AUTHOR_SKILL_FILENAME,
  TRELLIS_AUTHOR_SKILL_CONTENT,
  installClaudeSkills,
} from "../src/dashboard/skills.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("installClaudeSkills", () => {
  it("writes SKILL.md under <targetDir>/.claude/skills/done/ (Claude Code's required dir+SKILL.md layout)", () => {
    installClaudeSkills("/Users/x/.garden/worktrees/myproject/bold-ash");
    // atomicWriteFile creates the parent dir, writes to a tmp path, then renames.
    expect(fs.mkdirSync).toHaveBeenCalledWith(
      "/Users/x/.garden/worktrees/myproject/bold-ash/.claude/skills/done",
      { recursive: true },
    );
    expect(fs.renameSync).toHaveBeenCalledWith(
      expect.stringContaining("/Users/x/.garden/worktrees/myproject/bold-ash/.claude/skills/done/SKILL.md."),
      "/Users/x/.garden/worktrees/myproject/bold-ash/.claude/skills/done/SKILL.md",
    );
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("/Users/x/.garden/worktrees/myproject/bold-ash/.claude/skills/done/SKILL.md."),
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
    expect(fs.renameSync).toHaveBeenCalledWith(
      expect.stringContaining("/Users/x/.garden/worktrees/myproject/bold-ash/.claude/skills/handoff/SKILL.md."),
      "/Users/x/.garden/worktrees/myproject/bold-ash/.claude/skills/handoff/SKILL.md",
    );
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("/Users/x/.garden/worktrees/myproject/bold-ash/.claude/skills/handoff/SKILL.md."),
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

  it("teaches the fan-out shape — multiple handoffs from one worker before marking done", () => {
    // Workers reach for handoff at the close of a phased plan when they have
    // several deferred items. The skill must explicitly surface that pattern;
    // a 1:1 pass-the-baton framing alone won't trigger fan-out delegation.
    expect(HANDOFF_SKILL_CONTENT.toLowerCase()).toMatch(/fan-out|fan out/);
    expect(HANDOFF_SKILL_CONTENT.toLowerCase()).toMatch(/independent|parallel/);
  });

  it("warns that an item too small to justify a briefing should not be handed off", () => {
    // Without this the worker will hand off trivial follow-ups where its
    // in-flight context is the actual value, paying briefing cost for nothing.
    expect(HANDOFF_SKILL_CONTENT.toLowerCase()).toMatch(/briefing.*(?:longer|cost|small)|small.*briefing/);
  });
});

describe("TRELLIS_AUTHOR_SKILL_CONTENT", () => {
  it("starts with valid frontmatter declaring the skill name", () => {
    expect(TRELLIS_AUTHOR_SKILL_CONTENT).toMatch(/^---\nname: trellis-author\n/);
  });

  it("description triggers on operator intent to formalize a feature as a trellis", () => {
    const match = TRELLIS_AUTHOR_SKILL_CONTENT.match(/description: ([^\n]+)/);
    expect(match).not.toBeNull();
    const desc = match![1].toLowerCase();
    expect(desc).toContain("trellis");
    // The trigger must be operator-driven; the skill should not self-fire.
    expect(desc).toMatch(/operator|formaliz/);
  });

  it("walks through scope sizing, spine, sections, and self-review", () => {
    const body = TRELLIS_AUTHOR_SKILL_CONTENT.toLowerCase();
    expect(body).toContain("scope sizing");
    expect(body).toContain("spine");
    expect(body).toMatch(/recommended sections|recommended/i);
    expect(body).toContain("self-review");
  });

  it("names the spec sentinel and the trellis tag explicitly", () => {
    expect(TRELLIS_AUTHOR_SKILL_CONTENT).toContain("the code is wrong");
    expect(TRELLIS_AUTHOR_SKILL_CONTENT).toContain("<!-- trellis: v1 -->");
  });

  it("calls out 'Out of scope' as load-bearing", () => {
    expect(TRELLIS_AUTHOR_SKILL_CONTENT).toContain("Out of scope");
  });
});

describe("installClaudeSkills — trellis-author", () => {
  it("writes SKILL.md under .claude/skills/trellis-author alongside done and handoff", () => {
    installClaudeSkills("/Users/x/.garden/worktrees/myproject/bold-ash");
    expect(fs.mkdirSync).toHaveBeenCalledWith(
      "/Users/x/.garden/worktrees/myproject/bold-ash/.claude/skills/trellis-author",
      { recursive: true },
    );
    expect(fs.renameSync).toHaveBeenCalledWith(
      expect.stringContaining("/Users/x/.garden/worktrees/myproject/bold-ash/.claude/skills/trellis-author/SKILL.md."),
      "/Users/x/.garden/worktrees/myproject/bold-ash/.claude/skills/trellis-author/SKILL.md",
    );
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("/Users/x/.garden/worktrees/myproject/bold-ash/.claude/skills/trellis-author/SKILL.md."),
      TRELLIS_AUTHOR_SKILL_CONTENT,
    );
  });

  it("constants match what installClaudeSkills writes", () => {
    expect(TRELLIS_AUTHOR_SKILL_DIRNAME).toBe("trellis-author");
    expect(TRELLIS_AUTHOR_SKILL_FILENAME).toBe("SKILL.md");
  });
});

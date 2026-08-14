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
  GROW_SKILL_DIRNAME,
  GROW_SKILL_FILENAME,
  GROW_SKILL_CONTENT,
  BOTANIST_SKILL_DIRNAME,
  BOTANIST_SKILL_FILENAME,
  BOTANIST_SKILL_CONTENT,
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

  it("is idempotent: a second call writes the same files without erroring", () => {
    // installRuntimeConfig is invoked on every refresh and bounce, so this
    // helper runs many times against the same worktree across a worker's
    // lifetime. The file-system path must be safe to repeat:
    // mkdirSync(recursive) tolerates an existing directory, atomicWriteFile
    // renames over an existing target — the second call should produce the
    // same write/rename calls without throwing.
    installClaudeSkills("/Users/x/.garden/worktrees/myproject/bold-ash");
    const firstWriteCalls = vi.mocked(fs.writeFileSync).mock.calls.length;
    expect(() => installClaudeSkills("/Users/x/.garden/worktrees/myproject/bold-ash"))
      .not.toThrow();
    // Same number of writes on the second call (one per skill, plus
    // whatever the helper does for legacy-cleanup). Pinning the multiplier
    // would over-couple to the implementation; just check that the call
    // count doubled.
    expect(vi.mocked(fs.writeFileSync).mock.calls.length).toBe(firstWriteCalls * 2);
  });

  it("writes the botanist skill alongside the others", () => {
    installClaudeSkills("/Users/x/.garden/worktrees/myproject/bold-ash");
    expect(fs.mkdirSync).toHaveBeenCalledWith(
      "/Users/x/.garden/worktrees/myproject/bold-ash/.claude/skills/botanist",
      { recursive: true },
    );
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("/Users/x/.garden/worktrees/myproject/bold-ash/.claude/skills/botanist/SKILL.md."),
      BOTANIST_SKILL_CONTENT,
    );
  });

  it("botanist skill declares its name in frontmatter and forbids editing code", () => {
    expect(BOTANIST_SKILL_CONTENT).toMatch(/^---\nname: botanist\n/);
    expect(BOTANIST_SKILL_DIRNAME).toBe("botanist");
    expect(BOTANIST_SKILL_FILENAME).toBe("SKILL.md");
    expect(BOTANIST_SKILL_CONTENT).toContain("design artifact");
    expect(BOTANIST_SKILL_CONTENT).toContain("Do not edit");
  });

  it("botanist skill has the botanist run the approved handoff itself", () => {
    // The approval ask carries the handoff plan, and the default plan is a
    // botanist-spawned default-workflow builder seeded from the brief file.
    expect(BOTANIST_SKILL_CONTENT).toContain("state your handoff plan");
    expect(BOTANIST_SKILL_CONTENT).toContain(
      "garden handoff <project> < .garden/botanist/handoff-brief.md",
    );
    // Trellis builders stay operator-run — the handoff IPC is default-only.
    expect(BOTANIST_SKILL_CONTENT).toContain("--workflow trellis --trellis");
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
    // mention both the precondition (every requested deliverable has landed +
    // is verified) and the action (writes the sentinel) so the skill fires at
    // the right moment, not on a vague feeling of being finished.
    expect(desc).toContain("deliverable");
    expect(desc).toContain(".garden-done");
  });

  it("gates invocation on enumerate-and-verify, distinguishing operator deliverables from internal workflow stages", () => {
    // The re-gated done semantics: re-read the request, account for each
    // deliverable (landed + verified), and explicitly exclude the worker's own
    // internal workflow stages so a deep/long worker can't read "all my
    // analysis phases done" as "the request is done". Anti-busywork bias stays.
    expect(DONE_SKILL_CONTENT).toContain("re-read");
    expect(DONE_SKILL_CONTENT).toContain("NOT operator deliverables");
    expect(DONE_SKILL_CONTENT).toContain("verified");
    expect(DONE_SKILL_CONTENT).toContain("Bias toward invoking");
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

describe("GROW_SKILL_CONTENT", () => {
  it("starts with valid frontmatter declaring the skill name", () => {
    expect(GROW_SKILL_CONTENT).toMatch(/^---\nname: grow\n/);
  });

  it("description triggers on operator intent to convert / harden / improvement-pass", () => {
    const match = GROW_SKILL_CONTENT.match(/description: ([^\n]+)/);
    expect(match).not.toBeNull();
    const desc = match![1].toLowerCase();
    // The trigger names the operator-driven phrases the skill should fire on.
    expect(desc).toContain("grow loop");
    expect(desc).toMatch(/\/grow|harden|improvement pass|convert/);
    // Self-fire is forbidden: the description must explicitly negate
    // unprompted invocation, the same way handoff and trellis-author do.
    expect(desc).toContain("not");
  });

  it("teaches the convert CLI invocation with the goal-file path", () => {
    expect(GROW_SKILL_CONTENT).toContain("garden workers grow $GARDEN_WORKER");
    expect(GROW_SKILL_CONTENT).toContain("--goal-file .garden/grow-goal.md");
    expect(GROW_SKILL_CONTENT).toContain("--max-iterations");
  });

  it("instructs the worker to write the goal to .garden/grow-goal.md before running the CLI", () => {
    expect(GROW_SKILL_CONTENT).toContain(".garden/grow-goal.md");
    expect(GROW_SKILL_CONTENT.toLowerCase()).toMatch(/mkdir -p \.garden|mkdir.*\.garden/);
  });

  it("walks through scope sizing (in scope, out of scope, done criterion)", () => {
    const body = GROW_SKILL_CONTENT.toLowerCase();
    expect(body).toContain("in scope");
    expect(body).toContain("out of scope");
    expect(body).toMatch(/done look|convergence criterion/);
  });

  it("calls out when NOT to invoke the skill (already grow/trellis, unprompted)", () => {
    expect(GROW_SKILL_CONTENT.toLowerCase()).toContain("when not to use");
    // Should warn about both re-conversion (already on grow/trellis) and
    // unprompted self-invocation, so the worker doesn't fire it on its own.
    expect(GROW_SKILL_CONTENT.toLowerCase()).toMatch(/already on.*workflow|re-conversion|already.*grow/);
    expect(GROW_SKILL_CONTENT.toLowerCase()).toMatch(/operator did not ask|self-conversion/);
  });

  it("documents mid-loop amend via direct file edit", () => {
    // Operators expect to refine the goal between iterations; the skill must
    // surface that path so the worker doesn't tell them to re-run the CLI.
    expect(GROW_SKILL_CONTENT.toLowerCase()).toMatch(/amend|edit.*\.garden\/grow-goal\.md/);
  });

  it("explicitly warns against committing the goal file", () => {
    expect(GROW_SKILL_CONTENT.toLowerCase()).toMatch(/do not.*git add|not.*commit|gitignored/);
  });
});

describe("installClaudeSkills — grow", () => {
  it("writes SKILL.md under .claude/skills/grow alongside the other three skills", () => {
    installClaudeSkills("/Users/x/.garden/worktrees/myproject/bold-ash");
    expect(fs.mkdirSync).toHaveBeenCalledWith(
      "/Users/x/.garden/worktrees/myproject/bold-ash/.claude/skills/grow",
      { recursive: true },
    );
    expect(fs.renameSync).toHaveBeenCalledWith(
      expect.stringContaining("/Users/x/.garden/worktrees/myproject/bold-ash/.claude/skills/grow/SKILL.md."),
      "/Users/x/.garden/worktrees/myproject/bold-ash/.claude/skills/grow/SKILL.md",
    );
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("/Users/x/.garden/worktrees/myproject/bold-ash/.claude/skills/grow/SKILL.md."),
      GROW_SKILL_CONTENT,
    );
  });

  it("constants match what installClaudeSkills writes", () => {
    expect(GROW_SKILL_DIRNAME).toBe("grow");
    expect(GROW_SKILL_FILENAME).toBe("SKILL.md");
  });
});

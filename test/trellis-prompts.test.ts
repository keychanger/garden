import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { useTmpHome } from "./helpers.js";
import {
  trellisAuthoritySection,
  trellisAlignmentStepSection,
  trellisDocumentSection,
  trellisOverridesSection,
  trellisVerdictFormatSection,
  trellisReviewSections,
} from "../src/dashboard/trellis-prompts.js";
import { makeContext, type PromptContext, type PromptData } from "../src/dashboard/prompt-compose.js";
import type { WorkerEntry } from "../src/dashboard/registry.js";

const env = useTmpHome();

function emptyData(): PromptData {
  return {
    diff: "",
    commitSummary: "",
    branchName: "swift-oak",
    rules: "",
    checksCommand: undefined,
    changedFiles: [],
    docSections: [],
    testSections: [],
    specFiles: [],
  };
}

function ctx(entry: Partial<WorkerEntry>): PromptContext {
  const projectPath = path.join(env.home, "proj");
  fs.mkdirSync(projectPath, { recursive: true });
  return makeContext(
    "proj",
    projectPath,
    "main",
    {
      name: "swift-oak",
      sessionId: "s1",
      task: "",
      branchName: "swift-oak",
      worktreePath: path.join(env.home, "wt"),
      ...entry,
    } as WorkerEntry,
    emptyData(),
  );
}

describe("trellisAuthoritySection", () => {
  it("renders the verbatim authority text", () => {
    const out = trellisAuthoritySection.render(ctx({}));
    expect(out).toContain("source of truth for this feature");
    expect(out).toContain("Bias toward DRIFT over FLAGGED");
    // The spec quotes this with a `>` blockquote prefix because it's
    // quoting the text; in the actual prompt we render it as plain text
    // (the prompt IS the instruction, not a quote of one).
    expect(out).toContain("citing line\nnumbers");
  });
});

describe("trellisAlignmentStepSection", () => {
  it("uses ctx.nextStep() for numbering and lists Surface/Behavior/Tests/Docs", () => {
    const c = ctx({});
    c.nextStep(); // simulate prior step (rebase)
    c.nextStep(); // checks step
    const out = trellisAlignmentStepSection.render(c);
    expect(out).toContain("## Step 3:");
    expect(out).toContain("Surface, Behavior, Tests, Docs");
    expect(out).toContain("priority-ordered");
  });
});

describe("trellisDocumentSection", () => {
  it("returns null when entry has no trellis path", () => {
    expect(trellisDocumentSection.render(ctx({}))).toBeNull();
  });

  it("inlines the trellis content from the worktree-rooted path", () => {
    const projectPath = path.join(env.home, "proj");
    const wtPath = path.join(env.home, "wt");
    const trellisProjectPath = path.join(projectPath, ".garden", "trellises", "auth.md");
    const trellisWtPath = path.join(wtPath, ".garden", "trellises", "auth.md");
    // Project path version (not read by the section)
    fs.mkdirSync(path.dirname(trellisProjectPath), { recursive: true });
    fs.writeFileSync(trellisProjectPath, "# project version (should NOT be read)");
    // Worktree path version (the one the section reads)
    fs.mkdirSync(path.dirname(trellisWtPath), { recursive: true });
    fs.writeFileSync(trellisWtPath, "# worktree version\n\nthe code is wrong");

    const out = trellisDocumentSection.render(ctx({
      worktreePath: wtPath,
      trellis: { name: "auth", path: trellisProjectPath },
    }));
    expect(out).toContain("worktree version");
    expect(out).not.toContain("project version");
    expect(out).toContain(".garden/trellises/auth.md");
  });

  it("returns null when the file is unreadable", () => {
    const out = trellisDocumentSection.render(ctx({
      trellis: { name: "ghost", path: path.join(env.home, "nonexistent.md") },
    }));
    expect(out).toBeNull();
  });
});

describe("trellisOverridesSection", () => {
  it("returns null when no overrides file exists", () => {
    const wtPath = path.join(env.home, "wt-no-overrides");
    fs.mkdirSync(wtPath, { recursive: true });
    expect(trellisOverridesSection.render(ctx({ worktreePath: wtPath }))).toBeNull();
  });

  it("inlines overrides content when file present", () => {
    const wtPath = path.join(env.home, "wt-with-overrides");
    fs.mkdirSync(path.join(wtPath, ".garden"), { recursive: true });
    fs.writeFileSync(
      path.join(wtPath, ".garden", "trellis-overrides.md"),
      "Override line 47: deferred to v2",
    );
    const out = trellisOverridesSection.render(ctx({ worktreePath: wtPath }));
    expect(out).toContain("Override line 47");
    expect(out).toContain("operator-recorded");
  });
});

describe("trellisVerdictFormatSection", () => {
  it("documents all four verdicts and the drift-list format", () => {
    const out = trellisVerdictFormatSection.render(ctx({}));
    expect(out).toContain("ALIGNED");
    expect(out).toContain("DRIFT");
    expect(out).toContain("FAILED");
    expect(out).toContain("FLAGGED");
    expect(out).toContain("priority-ordered");
    expect(out).toContain("(trellis line 47)");
  });

  it("forbids background work in the headless review", () => {
    const out = trellisVerdictFormatSection.render(ctx({}));
    expect(out).toContain("Never launch a command in the background");
    expect(out).toContain("This process exits when your turn ends");
  });

  it("has name 'verdict-format' to mirror the default review section", () => {
    expect(trellisVerdictFormatSection.name).toBe("verdict-format");
  });
});

describe("trellisReviewSections", () => {
  it("composes intro, authority, rebase/checks/alignment steps, then trellis body, then verdict format", () => {
    const names = trellisReviewSections.map(s => s.name);
    expect(names[0]).toBe("intro");
    expect(names).toContain("trellis-authority");
    expect(names).toContain("trellis-alignment-step");
    expect(names).toContain("trellis-document");
    expect(names).toContain("trellis-overrides");
    // verdict format is last
    expect(names[names.length - 1]).toBe("verdict-format");
    // Default's "code-review-step" is NOT included — trellis is not a
    // general-purpose review.
    expect(names).not.toContain("code-review-step");
  });
});

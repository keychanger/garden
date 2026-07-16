import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({
  default: {
    readFileSync: vi.fn(() => "file content"),
  },
}));

vi.mock("../src/config.js", () => ({
  tryGetProject: vi.fn(() => ({ path: "/repo/myproject", checks: null })),
}));

vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/dashboard/git.js", () => ({
  getDiffAgainstBase: vi.fn(() => "diff content"),
  getCommitSummary: vi.fn(() => "abc1234 fix: something"),
  getChangedFiles: vi.fn(() => ["src/foo.ts"]),
}));

vi.mock("../src/rules.js", () => ({
  buildRulesContext: vi.fn(() => "project rules here"),
}));

import fs from "node:fs";
import { tryGetProject } from "../src/config.js";
import { getDiffAgainstBase, getChangedFiles } from "../src/dashboard/git.js";
import { buildReviewPrompt, buildResolvePrompt, findSpecFiles, buildSpecWarning, readDocSections, readTestSections } from "../src/dashboard/prompts.js";
import type { WorkerEntry } from "../src/dashboard/registry.js";

function makeEntry(overrides?: Partial<WorkerEntry>): WorkerEntry {
  return {
    name: "bold-ash",
    sessionId: "s1",
    task: "",
    worktreePath: "/tmp/wt/myproject/bold-ash",
    branchName: "bold-ash",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getDiffAgainstBase).mockReturnValue("diff content");
  vi.mocked(getChangedFiles).mockReturnValue(["src/foo.ts"]);
  vi.mocked(tryGetProject).mockReturnValue({ path: "/repo/myproject", checks: null } as ReturnType<typeof tryGetProject>);
  vi.mocked(fs.readFileSync).mockReturnValue("file content");
});

describe("buildReviewPrompt — initial review", () => {
  it("rebases onto origin, not the local base ref", () => {
    // The local base ref in a worktree can be stuck behind origin (prior
    // merges that failed to fast-forward the main checkout). Rebasing onto
    // the stale local ref re-picks commits that origin already has with
    // different SHAs, which cascades into unresolvable dup-SHA conflicts
    // in the merge queue.
    const result = buildReviewPrompt("myproject", "/repo/myproject", "main", makeEntry());
    expect(result).toContain("git rebase origin/main");
    expect(result).not.toMatch(/git rebase main\b/);
  });

  it("includes full code review step", () => {
    const result = buildReviewPrompt("myproject", "/repo/myproject", "main", makeEntry());
    expect(result).toContain("Code review");
    expect(result).toContain("Adherence to project rules");
    expect(result).toContain("Documentation accuracy");
    expect(result).toContain("Test quality");
  });

  it("includes doc verification text", () => {
    const result = buildReviewPrompt("myproject", "/repo/myproject", "main", makeEntry());
    expect(result).toContain("Verify these are still accurate after the diff above");
  });

  it("includes test verification text", () => {
    vi.mocked(fs.readFileSync).mockImplementation(((p: string) => {
      if (String(p).includes("test/")) return "test file content";
      return "file content";
    }) as typeof fs.readFileSync);
    const result = buildReviewPrompt("myproject", "/repo/myproject", "main", makeEntry());
    expect(result).toContain("Verify these still correctly cover the changed behavior");
  });

  it("includes checks command when configured", () => {
    vi.mocked(tryGetProject).mockReturnValue({ path: "/repo/myproject", checks: "npm test" } as ReturnType<typeof tryGetProject>);
    const result = buildReviewPrompt("myproject", "/repo/myproject", "main", makeEntry());
    expect(result).toContain("npm test");
    expect(result).toContain("garden checks myproject");
    expect(result).toContain("Run checks");
  });

  it("omits checks step when not configured", () => {
    const result = buildReviewPrompt("myproject", "/repo/myproject", "main", makeEntry());
    expect(result).not.toContain("Run checks");
  });

  it("includes worker task", () => {
    const result = buildReviewPrompt("myproject", "/repo/myproject", "main", makeEntry({ task: "refactor dashboard" }));
    expect(result).toContain("refactor dashboard");
  });

  it("returns null when diff fails", () => {
    vi.mocked(getDiffAgainstBase).mockImplementation(() => { throw new Error("no diff"); });
    const result = buildReviewPrompt("myproject", "/repo/myproject", "main", makeEntry());
    expect(result).toBeNull();
  });

});

describe("buildResolvePrompt", () => {
  it("frames the task as resolving, not reviewing", () => {
    const result = buildResolvePrompt("myproject", "/repo/myproject", "main", makeEntry());
    expect(result).toContain("resolving a rebase conflict");
    expect(result).toContain("This is not a code review");
  });

  it("includes base branch in rebase instruction", () => {
    const result = buildResolvePrompt("myproject", "/repo/myproject", "develop", makeEntry());
    expect(result).toContain("git rebase origin/develop");
  });

  it("instructs resolver not to push", () => {
    const result = buildResolvePrompt("myproject", "/repo/myproject", "main", makeEntry());
    expect(result).toContain("Do **not** push");
  });

  it("uses DONE/FAILED verdict, not CLEAN/FIXED", () => {
    const result = buildResolvePrompt("myproject", "/repo/myproject", "main", makeEntry());
    expect(result).toContain("`DONE`");
    expect(result).toContain("`FAILED`");
    expect(result).not.toContain("CLEAN");
    expect(result).not.toContain("FIXED");
  });

  it("reports the current attempt number of the budget", () => {
    const result = buildResolvePrompt(
      "myproject", "/repo/myproject", "main",
      makeEntry({ resolveAttempts: 1 }),
    );
    expect(result).toContain("attempt 2 of 2");
  });

  it("defaults to attempt 1 when resolveAttempts is unset", () => {
    const result = buildResolvePrompt("myproject", "/repo/myproject", "main", makeEntry());
    expect(result).toContain("attempt 1 of 2");
  });

  it("includes worker task and previous review body as context", () => {
    const entry = makeEntry({ task: "add retry logic", lastReviewBody: "Looks good." });
    const result = buildResolvePrompt("myproject", "/repo/myproject", "main", entry);
    expect(result).toContain("add retry logic");
    expect(result).toContain("Looks good.");
  });

  it("tells the resolver to abort any in-progress rebase first", () => {
    const result = buildResolvePrompt("myproject", "/repo/myproject", "main", makeEntry());
    expect(result).toContain("rebase in progress");
    expect(result).toContain("git rebase --abort");
  });
});

describe("findSpecFiles", () => {
  it("detects spec marker in markdown files", () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      "# Spec\n\nIf the code disagrees, the code is wrong.",
    );
    const result = findSpecFiles("/wt", ["docs/STATUS.md"]);
    expect(result).toEqual(["docs/STATUS.md"]);
  });

  it("skips non-markdown files", () => {
    const result = findSpecFiles("/wt", ["src/foo.ts"]);
    expect(result).toEqual([]);
  });

  it("skips markdown without marker", () => {
    vi.mocked(fs.readFileSync).mockReturnValue("# README\n\nJust a readme.");
    const result = findSpecFiles("/wt", ["README.md"]);
    expect(result).toEqual([]);
  });
});

describe("buildSpecWarning", () => {
  it("returns empty for no spec files", () => {
    expect(buildSpecWarning([])).toEqual([]);
  });

  it("includes warning text for spec files", () => {
    const result = buildSpecWarning(["STATUS.md"]);
    expect(result.join("\n")).toContain("Specification files in this diff");
    expect(result.join("\n")).toContain("STATUS.md");
  });
});

describe("readDocSections", () => {
  it("reads DESIGN.md and CLAUDE.md", () => {
    const result = readDocSections("/wt");
    expect(result.length).toBe(2);
    expect(result[0]).toContain("DESIGN.md");
    expect(result[1]).toContain("CLAUDE.md");
  });

  it("handles missing files gracefully", () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error("ENOENT"); });
    const result = readDocSections("/wt");
    expect(result).toEqual([]);
  });
});

describe("readTestSections", () => {
  it("reads test files corresponding to changed source files", () => {
    vi.mocked(fs.readFileSync).mockReturnValue("test content");
    const result = readTestSections("/wt", ["src/dashboard/poller.ts"]);
    expect(result.length).toBe(1);
    expect(result[0]).toContain("test/poller.test.ts");
  });

  it("skips files without corresponding tests", () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error("ENOENT"); });
    const result = readTestSections("/wt", ["src/new-file.ts"]);
    expect(result).toEqual([]);
  });
});

// Snapshot lock for the workflow-architecture refactor (WORKFLOWS.md). The
// prompt-composition refactor (Phase 2) decomposes buildReviewPrompt and
// buildResolvePrompt into PromptSection instances. These snapshots fix the
// pre-refactor output as the byte-equal acceptance criterion: any drift at
// any point in the four-phase refactor surfaces here.
describe("prompt output snapshots (workflow-refactor regression net)", () => {
  it("buildReviewPrompt — default fixture, no checks", () => {
    const result = buildReviewPrompt("myproject", "/repo/myproject", "main", makeEntry());
    expect(result).toMatchSnapshot();
  });

  it("buildReviewPrompt — with checks command configured", () => {
    vi.mocked(tryGetProject).mockReturnValue({ path: "/repo/myproject", checks: "npm test" } as ReturnType<typeof tryGetProject>);
    const result = buildReviewPrompt("myproject", "/repo/myproject", "main", makeEntry());
    expect(result).toMatchSnapshot();
  });

  it("buildReviewPrompt — with worker task set", () => {
    const result = buildReviewPrompt(
      "myproject", "/repo/myproject", "main",
      makeEntry({ task: "refactor dashboard layout" }),
    );
    expect(result).toMatchSnapshot();
  });

  it("buildReviewPrompt — with spec file in changed set", () => {
    vi.mocked(getChangedFiles).mockReturnValue(["docs/STATUS.md"]);
    vi.mocked(fs.readFileSync).mockImplementation(((p: string) => {
      const path = String(p);
      if (path.endsWith("STATUS.md")) return "# Spec\n\nIf the code disagrees, the code is wrong.";
      return "file content";
    }) as typeof fs.readFileSync);
    const result = buildReviewPrompt("myproject", "/repo/myproject", "main", makeEntry());
    expect(result).toMatchSnapshot();
  });

  it("buildResolvePrompt — default fixture", () => {
    const result = buildResolvePrompt("myproject", "/repo/myproject", "main", makeEntry());
    expect(result).toMatchSnapshot();
  });

  it("buildResolvePrompt — with task and previous review body", () => {
    const result = buildResolvePrompt(
      "myproject", "/repo/myproject", "main",
      makeEntry({
        task: "add retry logic to the merge queue",
        lastReviewBody: "Looks good. Approved with minor nits.",
        resolveAttempts: 1,
      }),
    );
    expect(result).toMatchSnapshot();
  });
});

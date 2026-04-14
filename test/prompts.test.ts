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
import { buildReviewPrompt, findSpecFiles, buildSpecWarning, readDocSections, readTestSections } from "../src/dashboard/prompts.js";
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
  it("includes rebase instructions", () => {
    const result = buildReviewPrompt("myproject", "/repo/myproject", "main", makeEntry());
    expect(result).toContain("git rebase main");
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

describe("buildReviewPrompt — re-review", () => {
  it("includes re-review intro", () => {
    const result = buildReviewPrompt("myproject", "/repo/myproject", "main", makeEntry(), { reReview: true });
    expect(result).toContain("previously reviewed and approved");
    expect(result).toContain("re-reviewing");
  });

  it("includes context section with task and lastReviewBody", () => {
    const entry = makeEntry({ task: "add retry logic", lastReviewBody: "Code is well structured." });
    const result = buildReviewPrompt("myproject", "/repo/myproject", "main", entry, { reReview: true });
    expect(result).toContain("add retry logic");
    expect(result).toContain("Code is well structured.");
    expect(result).toContain("Previous review (approved)");
  });

  it("uses focused review step instead of full code review", () => {
    const result = buildReviewPrompt("myproject", "/repo/myproject", "main", makeEntry(), { reReview: true });
    expect(result).toContain("Verify correctness after rebase");
    expect(result).not.toContain("Code review");
    expect(result).not.toContain("Documentation accuracy");
    expect(result).not.toContain("Test quality");
  });

  it("omits doc and test verification text", () => {
    const result = buildReviewPrompt("myproject", "/repo/myproject", "main", makeEntry(), { reReview: true });
    expect(result).not.toContain("Verify these are still accurate after the diff above");
    expect(result).not.toContain("Verify these still correctly cover the changed behavior");
  });

  it("includes commit message reading instruction in rebase step", () => {
    const result = buildReviewPrompt("myproject", "/repo/myproject", "main", makeEntry(), { reReview: true });
    expect(result).toContain("Read the commit messages carefully");
  });
});

describe("findSpecFiles", () => {
  it("detects spec marker in markdown files", () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      "# Spec\n\nIf the code disagrees, the code is wrong.",
    );
    const result = findSpecFiles("/wt", ["src/dashboard/STATUS.md"]);
    expect(result).toEqual(["src/dashboard/STATUS.md"]);
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

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
  getDiffStat: vi.fn(() => " src/foo.ts | 4000 ++++\n 1 file changed"),
  getCommitSummary: vi.fn(() => "abc1234 fix: something"),
  getChangedFiles: vi.fn(() => ["src/foo.ts"]),
  resolveHolisticDiff: vi.fn(() => "holistic diff content"),
}));

vi.mock("../src/rules.js", () => ({
  buildRulesContext: vi.fn(() => "project rules here"),
}));

import fs from "node:fs";
import { tryGetProject } from "../src/config.js";
import { getDiffAgainstBase, getDiffStat, getChangedFiles, resolveHolisticDiff } from "../src/dashboard/git.js";
import { buildReviewPrompt, buildResolvePrompt, buildCiFixPrompt, buildHolisticFinalReviewPrompt, findSpecFiles, buildSpecWarning, readDocSections, readTestSections } from "../src/dashboard/prompts.js";
import { MAX_REVIEW_PROMPT_BYTES } from "../src/dashboard/prompt-compose.js";
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
  vi.mocked(fs.readFileSync).mockImplementation(defaultRead);
});

// Fixture repo shaped the way garden expects one: AGENTS.md is the real
// instruction file and CLAUDE.md is the `@AGENTS.md` pointer at it.
const docBody = (title: string) => `# ${title}\n\n${`${title} notes for the project. `.repeat(10)}`;
const defaultRead = ((p: unknown) => {
  const name = String(p).split("/").pop() as string;
  if (name === "DESIGN.md") return docBody("Architecture");
  if (name === "AGENTS.md") return docBody("Agent quick-start");
  if (name === "CLAUDE.md") return "@AGENTS.md\n";
  return "file content";
}) as unknown as typeof fs.readFileSync;

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
      return defaultRead(p as never) as string;
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

// A branch delta too large to inline is still reviewable: the reviewer runs
// inside the worktree with a shell, so the prompt degrades to the per-file
// summary plus the command to page the diff. The alternative — refusing to
// review at all — is what the ceiling used to mean.
describe("buildReviewPrompt — oversized diff", () => {
  const oversized = "x".repeat(MAX_REVIEW_PROMPT_BYTES + 1);

  it("swaps the inline diff for a file summary the reviewer pages itself", () => {
    vi.mocked(getDiffAgainstBase).mockReturnValue(oversized);
    vi.mocked(getDiffStat).mockReturnValue(" src/foo.ts | 4000 ++++\n 1 file changed");

    const result = buildReviewPrompt("myproject", "/repo/myproject", "main", makeEntry())!;

    expect(result).not.toContain(oversized);
    expect(result).toContain("too large to inline");
    expect(result).toContain("git diff origin/main...HEAD -- <path>");
    expect(result).toContain("1 file changed");
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(MAX_REVIEW_PROMPT_BYTES);
    expect(getDiffStat).toHaveBeenCalledWith("/tmp/wt/myproject/bold-ash", "origin/main...HEAD");
  });

  it("tells the reviewer to name the files it could not read", () => {
    // Without this the reviewer emits a CLEAN over a delta it only partly
    // read, and the verdict reads as full coverage.
    vi.mocked(getDiffAgainstBase).mockReturnValue(oversized);
    const result = buildReviewPrompt("myproject", "/repo/myproject", "main", makeEntry())!;
    expect(result).toContain("which files you did NOT");
  });

  it("still renders the summary block when the stat call fails", () => {
    vi.mocked(getDiffAgainstBase).mockReturnValue(oversized);
    vi.mocked(getDiffStat).mockReturnValue("");
    const result = buildReviewPrompt("myproject", "/repo/myproject", "main", makeEntry())!;
    expect(result).toContain("summary unavailable");
    expect(result).toContain("git diff origin/main...HEAD -- <path>");
  });

  it("leaves a diff that fits completely untouched", () => {
    const result = buildReviewPrompt("myproject", "/repo/myproject", "main", makeEntry())!;
    expect(result).toContain("diff content");
    expect(result).not.toContain("too large to inline");
    expect(getDiffStat).not.toHaveBeenCalled();
  });

  it("degrades the ci-fix prompt the same way", () => {
    // The ci-fix diff section opts out on an empty diff, and the degraded path
    // empties `diff` — so checking diff-first would drop the section entirely
    // and leave the agent no pointer to the delta at all.
    vi.mocked(getDiffAgainstBase).mockReturnValue(oversized);

    const result = buildCiFixPrompt("myproject", "/repo/myproject", "main", makeEntry())!;

    expect(result).not.toContain(oversized);
    expect(result).toContain("Diff under review (too large to inline");
    expect(result).toContain("git diff origin/main...HEAD -- <path>");
  });

  it("degrades the whole-task holistic range the same way", () => {
    // The assembled cross-phase range is the likeliest one to blow the
    // ceiling, and a skipped holistic pass is a silently lost check.
    vi.mocked(resolveHolisticDiff).mockReturnValue(oversized);
    const entry = makeEntry({ baseBranchSha: "base123", holisticTouchedFiles: ["src/foo.ts"] });

    const result = buildHolisticFinalReviewPrompt("myproject", "/repo/myproject", "main", entry)!;

    expect(result).not.toContain(oversized);
    expect(result).toContain("git diff base123..origin/main -- <path>");
    expect(getDiffStat).toHaveBeenCalledWith(
      "/tmp/wt/myproject/bold-ash", "base123..origin/main", ["src/foo.ts"],
    );
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
  const body = (name: string) => `# ${name}\n\n${`${name} architecture notes. `.repeat(20)}`;
  const GARDEN_MARKER = "<!-- garden worker rules (managed by garden; not committed) -->";

  // Serve per-filename content through the shared readFileSync mock.
  const serve = (files: Record<string, string>) => {
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
      const name = String(p).split("/").pop() as string;
      if (!(name in files)) throw new Error("ENOENT");
      return files[name];
    });
  };

  it("reads DESIGN.md, AGENTS.md and CLAUDE.md", () => {
    serve({ "DESIGN.md": body("DESIGN"), "AGENTS.md": body("AGENTS"), "CLAUDE.md": body("CLAUDE") });
    const result = readDocSections("/wt");
    expect(result.length).toBe(3);
    expect(result[0]).toContain("DESIGN.md");
    expect(result[1]).toContain("AGENTS.md");
    expect(result[2]).toContain("CLAUDE.md");
  });

  it("skips a CLAUDE.md that is only an @AGENTS.md import stub", () => {
    serve({ "AGENTS.md": body("AGENTS"), "CLAUDE.md": "@AGENTS.md\n" });
    const result = readDocSections("/wt");
    expect(result.length).toBe(1);
    expect(result[0]).toContain("AGENTS.md");
  });

  it("skips an import stub with maintainer comments", () => {
    serve({
      "AGENTS.md": body("AGENTS"),
      "CLAUDE.md": "@AGENTS.md\n\n<!-- AGENTS.md is the source of truth. -->\n",
    });
    const result = readDocSections("/wt");
    expect(result.length).toBe(1);
    expect(result[0]).toContain("AGENTS.md");
  });

  it("keeps short documents that are not import stubs", () => {
    serve({ "DESIGN.md": "# Design\n\nShort but authoritative." });
    expect(readDocSections("/wt")).toEqual([
      "### DESIGN.md\n\n# Design\n\nShort but authoritative.",
    ]);
  });

  it("reads a symlinked pair once", () => {
    // A symlink resolves to identical bytes through both names.
    const shared = body("SHARED");
    serve({ "AGENTS.md": shared, "CLAUDE.md": shared });
    const result = readDocSections("/wt");
    expect(result.length).toBe(1);
  });

  it("strips garden's worker rules from a composed AGENTS.md", () => {
    const repoDoc = body("REPO");
    serve({ "AGENTS.md": `${GARDEN_MARKER}\n\nworker rules text\n\n---\n\n${repoDoc}` });
    const result = readDocSections("/wt");
    expect(result.length).toBe(1);
    expect(result[0]).toContain("REPO architecture notes");
    expect(result[0]).not.toContain("worker rules text");
    expect(result[0]).not.toContain(GARDEN_MARKER);
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
      return defaultRead(p as never) as string;
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

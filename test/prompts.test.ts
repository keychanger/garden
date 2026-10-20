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
  readCommittedFiles: vi.fn(),
}));

vi.mock("../src/rules.js", () => ({
  buildRulesContext: vi.fn(() => "project rules here"),
}));

import fs from "node:fs";
import path from "node:path";
import { tryGetProject } from "../src/config.js";
import { buildRulesContext } from "../src/rules.js";
import { getDiffAgainstBase, getDiffStat, getChangedFiles, readCommittedFiles, resolveHolisticDiff } from "../src/dashboard/git.js";
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

// The prompt builders read the worker's files as committed (readCommittedFiles);
// serve those reads from the same readFileSync fixture each test sets up.
function committedFromFixture(wtPath: string, paths: readonly string[]): Map<string, string> {
  const files = new Map<string, string>();
  for (const p of paths) {
    try { files.set(p, String(fs.readFileSync(path.join(wtPath, p), "utf-8"))); } catch { /* absent at HEAD */ }
  }
  return files;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readCommittedFiles).mockImplementation(committedFromFixture);
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
    expect(result).toContain("git rebase refs/remotes/origin/main");
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
    expect(result).toContain("git diff refs/remotes/origin/main...HEAD -- <path>");
    expect(result).toContain("1 file changed");
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(MAX_REVIEW_PROMPT_BYTES);
    expect(getDiffStat).toHaveBeenCalledWith("/tmp/wt/myproject/bold-ash", "refs/remotes/origin/main...HEAD");
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
    expect(result).toContain("git diff refs/remotes/origin/main...HEAD -- <path>");
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
    expect(result).toContain("git diff refs/remotes/origin/main...HEAD -- <path>");
    expect(getDiffStat).toHaveBeenCalledWith("/tmp/wt/myproject/bold-ash", "refs/remotes/origin/main...HEAD");
  });

  it("degrades the whole-task holistic range the same way", () => {
    // The assembled cross-phase range is the likeliest one to blow the
    // ceiling, and a skipped holistic pass is a silently lost check.
    vi.mocked(resolveHolisticDiff).mockReturnValue(oversized);
    const entry = makeEntry({ baseBranchSha: "base123", holisticTouchedFiles: ["src/foo.ts"] });

    const result = buildHolisticFinalReviewPrompt("myproject", "/repo/myproject", "main", entry)!;

    expect(result).not.toContain(oversized);
    expect(result).toContain("git diff base123..refs/remotes/origin/main -- <path>");
    expect(getDiffStat).toHaveBeenCalledWith(
      "/tmp/wt/myproject/bold-ash", "base123..refs/remotes/origin/main", ["src/foo.ts"],
    );
  });
});

// The test files inlined for the changed sources scale with how many files a
// branch touches, and DESIGN.md + AGENTS.md can run to hundreds of KB on their
// own, so a broad branch can bust the ceiling with a diff that would fit. The
// reviewer reads files in the worktree as readily as it pages a diff, so the
// reference material is listed by path before the diff under review is.
describe("buildReviewPrompt — oversized reference material", () => {
  const KB = 1024;
  const diffOf = (bytes: number) => "+diff-line\n".repeat(Math.ceil(bytes / 11));
  const oversized = "x".repeat(MAX_REVIEW_PROMPT_BYTES + 1);
  const review = () => buildReviewPrompt("myproject", "/repo/myproject", "main", makeEntry())!;
  const serveReferences = ({ docBytes = 0, testBytes = 0 }) => {
    vi.mocked(fs.readFileSync).mockImplementation(((p: unknown) => {
      const file = String(p);
      if (docBytes && file.endsWith("/DESIGN.md")) return "DESIGN-BODY ".repeat(Math.ceil(docBytes / 12));
      if (testBytes && file.endsWith("/test/foo.test.ts")) return "TEST-BODY ".repeat(Math.ceil(testBytes / 10));
      return defaultRead(p as never);
    }) as typeof fs.readFileSync);
  };

  it("lists the test files instead of inlining them when they are what does not fit", () => {
    const diff = diffOf(300 * KB);
    vi.mocked(getDiffAgainstBase).mockReturnValue(diff);
    serveReferences({ testBytes: 800 * KB });

    const result = review();

    expect(result).toContain(diff);
    expect(result).toContain("## Test Files (corresponding to changed source files — too large to inline)");
    expect(result).toContain("- test/foo.test.ts");
    expect(result).not.toContain("TEST-BODY");
    expect(result).toContain("Agent quick-start notes");
    expect(getDiffStat).not.toHaveBeenCalled();
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(MAX_REVIEW_PROMPT_BYTES);
  });

  it("lists the documentation too when listing the test files is not enough", () => {
    const diff = diffOf(300 * KB);
    vi.mocked(getDiffAgainstBase).mockReturnValue(diff);
    serveReferences({ docBytes: 800 * KB, testBytes: 300 * KB });

    const result = review();

    expect(result).toContain(diff);
    expect(result).toContain("## Documentation (current state in the worktree — too large to inline)");
    expect(result).toContain("- DESIGN.md\n- AGENTS.md");
    expect(result).not.toContain("DESIGN-BODY");
    expect(result).not.toContain("TEST-BODY");
    expect(getDiffStat).not.toHaveBeenCalled();
  });

  it("pages the diff only when it cannot fit inline, and inlines the references again", () => {
    // A merely huge diff degrades exactly as it did before the references were
    // pageable: listing them could not have brought the prompt under.
    vi.mocked(getDiffAgainstBase).mockReturnValue(oversized);
    serveReferences({ docBytes: 100 * KB, testBytes: 100 * KB });

    const result = review();

    expect(result).toContain("## Diff (too large to inline — file summary only)");
    expect(result).toContain("DESIGN-BODY");
    expect(result).toContain("TEST-BODY");
    expect(getDiffStat).toHaveBeenCalledTimes(1);
  });

  it("keeps listing the test files beside a paged diff while they still do not fit", () => {
    vi.mocked(getDiffAgainstBase).mockReturnValue(oversized);
    serveReferences({ docBytes: 200 * KB, testBytes: 900 * KB });

    const result = review();

    expect(result).toContain("## Diff (too large to inline — file summary only)");
    expect(result).toContain("- test/foo.test.ts");
    expect(result).not.toContain("TEST-BODY");
    expect(result).toContain("DESIGN-BODY");
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(MAX_REVIEW_PROMPT_BYTES);
  });

  it("still offers the non-blocking notes convention a listed document defines", () => {
    vi.mocked(fs.readFileSync).mockImplementation(((p: unknown) => {
      const file = String(p);
      if (file.endsWith("/DESIGN.md")) return `An uncited finding is non-blocking. ${"DESIGN-BODY ".repeat(Math.ceil(1100 * KB / 12))}`;
      return defaultRead(p as never);
    }) as typeof fs.readFileSync);

    const result = review();

    expect(result).not.toContain("DESIGN-BODY");
    expect(result).toContain("`Non-blocking notes:` heading");
  });

  it("lists the whole-task review's test files before paging its diff", () => {
    const diff = diffOf(300 * KB);
    vi.mocked(resolveHolisticDiff).mockReturnValue(diff);
    serveReferences({ testBytes: 800 * KB });
    const entry = makeEntry({ baseBranchSha: "base123", holisticTouchedFiles: ["src/foo.ts"] });

    const result = buildHolisticFinalReviewPrompt("myproject", "/repo/myproject", "main", entry)!;

    expect(result).toContain(diff);
    expect(result).toContain("- test/foo.test.ts");
    expect(result).not.toContain("TEST-BODY");
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
    expect(result).toContain("git rebase refs/remotes/origin/develop");
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

  it("inlines a test file shared by same-named sources once", () => {
    vi.mocked(fs.readFileSync).mockReturnValue("test content");
    const result = readTestSections("/wt", ["src/commands/workers.ts", "src/dashboard/workers.ts"]);
    expect(result).toEqual(["### test/workers.test.ts\n\ntest content"]);
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

// A headless agent's process exits when its turn ends, so a backgrounded
// command is orphaned and never reports back. Six consecutive wolf reviews
// died as progress narration ("I'll wait for the completion notification")
// after backgrounding `garden checks`, so every headless role must carry the
// mechanism, not just the rule.
describe("headless single-turn discipline", () => {
  const buildersWithoutChecks = {
    review: () => buildReviewPrompt("myproject", "/repo/myproject", "main", makeEntry()),
    resolve: () => buildResolvePrompt("myproject", "/repo/myproject", "main", makeEntry()),
    ciFix: () => buildCiFixPrompt("myproject", "/repo/myproject", "main", makeEntry()),
    holistic: () => buildHolisticFinalReviewPrompt(
      "myproject", "/repo/myproject", "main",
      makeEntry({ baseBranchSha: "base123", holisticTouchedFiles: ["src/foo.ts"] }),
    ),
  };

  beforeEach(() => {
    vi.mocked(resolveHolisticDiff).mockReturnValue("holistic diff");
  });

  for (const [role, build] of Object.entries(buildersWithoutChecks)) {
    it(`${role} prompt forbids backgrounding and says why`, () => {
      const result = build()!;
      expect(result).toContain("Never launch a command in the background");
      expect(result).toContain("This process exits when your turn ends");
    });
  }

  it("holistic shadow mode carries it too", () => {
    const result = buildHolisticFinalReviewPrompt(
      "myproject", "/repo/myproject", "main",
      makeEntry({
        baseBranchSha: "base123",
        holisticTouchedFiles: ["src/foo.ts"],
        holisticReviewMode: "shadow",
      }),
    )!;
    expect(result).toContain("Never launch a command in the background");
  });

  it("the checks step tells the reviewer to run checks in the foreground", () => {
    vi.mocked(tryGetProject).mockReturnValue(
      { path: "/repo/myproject", checks: "npm test" } as ReturnType<typeof tryGetProject>,
    );
    const result = buildReviewPrompt("myproject", "/repo/myproject", "main", makeEntry())!;
    expect(result).toContain("Run it in the FOREGROUND");
    expect(result).toContain("several foreground");
  });
});

describe("non-blocking notes convention", () => {
  const holistic = (mode: "fix" | "shadow") => buildHolisticFinalReviewPrompt(
    "myproject", "/repo/myproject", "main",
    makeEntry({ baseBranchSha: "base123", holisticTouchedFiles: ["src/foo.ts"], holisticReviewMode: mode }),
  )!;
  const review = () => buildReviewPrompt("myproject", "/repo/myproject", "main", makeEntry())!;
  const agentDoc = (content: string) => vi.mocked(fs.readFileSync).mockImplementation(((p: string) =>
    String(p).endsWith("AGENTS.md") ? content : defaultRead(p)) as typeof fs.readFileSync);

  beforeEach(() => {
    vi.mocked(resolveHolisticDiff).mockReturnValue("holistic diff");
  });

  it("is withheld from a project whose rules classify nothing as non-blocking", () => {
    expect(review()).not.toContain("Non-blocking notes");
    expect(holistic("fix")).not.toContain("Non-blocking notes");
  });

  describe("when the project's agent doc defines non-blocking findings", () => {
    beforeEach(() => {
      agentDoc("Without that citation it is a non-blocking note: a reviewer lists it.");
    });

    it("tells the per-phase reviewer to list rule-classified findings instead of implementing them", () => {
      const result = review();
      expect(result).toContain("`Non-blocking notes:` heading placed directly above your");
      expect(result).toContain("a pre-existing or unrelated problem, a coverage nit");
      expect(result).toContain("whose only findings are non-blocking notes is CLEAN");
    });

    it("is part of the holistic fix pass but not the analysis-only shadow pass", () => {
      expect(holistic("fix")).toContain("`Non-blocking notes:` heading");
      expect(holistic("shadow")).not.toContain("Non-blocking notes");
    });
  });

  it("is offered when the project's rules file defines non-blocking findings", () => {
    vi.mocked(buildRulesContext).mockReturnValueOnce("Findings without a citation are non-blocking.");
    expect(review()).toContain("`Non-blocking notes:` heading");
  });
});

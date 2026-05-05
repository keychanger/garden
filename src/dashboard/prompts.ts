// Review and resolve prompt builders. Each composition is a list of named
// PromptSection instances rendered against a PromptContext. The compose
// primitive (./prompt-compose.ts) joins their non-null outputs with a blank
// line between blocks. See WORKFLOWS.md Component 3 for the full contract.
//
// Adding a new section is a one-liner: declare a PromptSection with a render
// function, slot it into the section list. Adding a new workflow is a new
// section list plus a thin builder — the I/O gathering and the join logic
// are shared.
import {
  composePrompt, gatherPromptContext, makeContext,
  type PromptContext, type PromptData, type PromptSection,
} from "./prompt-compose.js";
import { getCommitSummary } from "./git.js";
import { log } from "./log.js";
import type { WorkerEntry } from "./registry.js";

// Re-export I/O helpers from prompt-compose for backward compatibility with
// existing test imports — these were originally defined in this file before
// the foundation refactor moved them into the compose module.
export {
  findSpecFiles, readDocSections, readTestSections,
} from "./prompt-compose.js";

// --- Review sections ---

export const reviewIntroSection: PromptSection = {
  name: "intro",
  render: () => "You are reviewing a branch before merge. Complete these steps in order:",
};

export const reviewSpecWarningSection: PromptSection = {
  name: "spec-warning",
  render(ctx) {
    if (ctx.data.specFiles.length === 0) return null;
    return buildSpecWarning(ctx.data.specFiles).join("\n").replace(/\n+$/, "");
  },
};

export const reviewRebaseStepSection: PromptSection = {
  name: "rebase-step",
  render(ctx) {
    const step = ctx.nextStep();
    return [
      `## Step ${step}: Rebase onto origin/${ctx.baseBranch}`,
      "",
      `Run \`git rebase origin/${ctx.baseBranch}\` in the worktree. If there are conflicts:`,
      "- Resolve them sensibly (preserve the intent of both sides)",
      "- `git add` resolved files and `git rebase --continue`",
      "- If a conflict is truly unresolvable, abort the rebase and report FAILED",
    ].join("\n");
  },
};

export const reviewChecksStepSection: PromptSection = {
  name: "checks-step",
  render(ctx) {
    if (!ctx.data.checksCommand) return null;
    const step = ctx.nextStep();
    return [
      `## Step ${step}: Run checks`,
      "",
      `Run: \`${ctx.data.checksCommand}\``,
      "",
      "If checks fail, fix the issues and re-run until they pass.",
      "If you cannot fix them, report FAILED.",
    ].join("\n");
  },
};

export const reviewCodeReviewStepSection: PromptSection = {
  name: "code-review-step",
  render(ctx) {
    const step = ctx.nextStep();
    return [
      `## Step ${step}: Code review`,
      "",
      "Review the branch diff against the project rules below.",
      "",
      "Check for:",
      "- Adherence to project rules (commit style, code patterns, scope discipline)",
      "- Code quality issues, security concerns, or unnecessary complexity",
      "- Documentation accuracy: read DESIGN.md and CLAUDE.md below. After applying this",
      "  diff, are they still accurate and complete? Flag any claims that are now wrong,",
      "  missing sections for new behavior, or stale descriptions. Not every change needs a",
      "  doc change — only flag docs that are actually inaccurate after this diff. This",
      "  bullet applies *only* to descriptive documents (DESIGN.md, CLAUDE.md) — not to",
      "  specification files (those marked as a source of truth, see the warning above if",
      "  any are in this diff). Specs drive the code; do not edit them to match code.",
      "- Test quality: read the test files below. Check three things:",
      "  1. Accuracy — do existing tests still assert correct behavior after this diff?",
      "     Flag tests that now assert stale or wrong behavior.",
      "  2. Coverage — are the new/changed code paths exercised by tests? Flag significant",
      "     new logic (branching, error handling, state transitions) that has no test.",
      "  3. Completeness — do the tests cover edge cases and failure modes, not just the",
      "     happy path? Flag obvious gaps. Not every change needs a test change — only flag",
      "     tests that are actually wrong or insufficient for the behavior this diff changes.",
      "",
      "If you find issues, fix them directly in the worktree. Edit files, update tests,",
      "update docs as needed. Make focused, minimal fixes — do not refactor or improve code",
      "beyond what the review requires. Commit your fixes with a clear message prefixed with",
      '"review: " (e.g., "review: add missing tests for error handling").',
    ].join("\n");
  },
};

export const reviewBranchInfoSection: PromptSection = {
  name: "branch-info",
  render(ctx) {
    return `## Branch: ${ctx.data.branchName}`;
  },
};

export const reviewWorkerTaskSection: PromptSection = {
  name: "worker-task",
  render(ctx) {
    if (!ctx.entry.task) return null;
    return `### Worker task\n\n${ctx.entry.task}`;
  },
};

export const reviewCommitsSection: PromptSection = {
  name: "commits",
  render(ctx) {
    if (!ctx.data.commitSummary) return null;
    return `### Commits\n\n\`\`\`\n${ctx.data.commitSummary}\n\`\`\``;
  },
};

export const reviewRulesSection: PromptSection = {
  name: "rules",
  render(ctx) {
    return `## Project Rules\n\n${ctx.data.rules}`;
  },
};

export const reviewDiffSection: PromptSection = {
  name: "diff",
  render(ctx) {
    return `## Diff\n\n\`\`\`diff\n${ctx.data.diff}\n\`\`\``;
  },
};

// Documentation section is always rendered with intro text plus the list of
// doc files (DESIGN.md, CLAUDE.md). Doc files are joined with single \n
// internally — preserving the bit-for-bit shape of the pre-refactor output
// where the docSections array entries were spread directly into the joined
// string with no blank line between them.
export const reviewDocumentationSection: PromptSection = {
  name: "documentation",
  render(ctx) {
    const intro = "## Documentation (current state in the worktree)\n\nVerify these are still accurate after the diff above.";
    const docs = ctx.data.docSections.join("\n");
    return docs ? `${intro}\n\n${docs}` : intro;
  },
};

export const reviewTestFilesSection: PromptSection = {
  name: "test-files",
  render(ctx) {
    if (ctx.data.testSections.length === 0) return null;
    const intro = "## Test Files (corresponding to changed source files)\n\nVerify these still correctly cover the changed behavior.";
    return `${intro}\n\n${ctx.data.testSections.join("\n")}`;
  },
};

export const reviewVerdictFormatSection: PromptSection = {
  name: "verdict-format",
  render: () => [
    "## Output Format",
    "",
    "Your LAST line of output must be exactly one of:",
    "CLEAN — no issues found, code is ready to merge as-is",
    "FIXED — issues were found and fixed in the worktree",
    "FAILED — issues were found but could not be fixed (explain above)",
  ].join("\n"),
};

export const reviewSections: readonly PromptSection[] = [
  reviewIntroSection,
  reviewSpecWarningSection,
  reviewRebaseStepSection,
  reviewChecksStepSection,
  reviewCodeReviewStepSection,
  reviewBranchInfoSection,
  reviewWorkerTaskSection,
  reviewCommitsSection,
  reviewRulesSection,
  reviewDiffSection,
  reviewDocumentationSection,
  reviewTestFilesSection,
  reviewVerdictFormatSection,
];

// --- Resolve sections ---

export const resolveIntroSection: PromptSection = {
  name: "resolve-intro",
  render(ctx) {
    const branchName = ctx.data.branchName;
    const attemptNum = (ctx.entry.resolveAttempts ?? 0) + 1;
    return [
      `You are resolving a rebase conflict on branch \`${branchName}\` in project ${ctx.projectName}.`,
      "",
      `The branch was reviewed and approved, but when the merge queue tried to rebase it onto`,
      `\`origin/${ctx.baseBranch}\` the rebase conflicted. Your job is to complete that rebase.`,
      "",
      "**This is not a code review.** The code itself has already been approved. Do not refactor,",
      "add tests, update docs, or make any change not required to resolve the conflict.",
      "",
      `This is resolve attempt ${attemptNum} of 2.`,
    ].join("\n");
  },
};

export const resolveWorkerTaskSection: PromptSection = {
  name: "resolve-worker-task",
  render(ctx) {
    if (!ctx.entry.task) return null;
    return `## Worker task\n\n${ctx.entry.task}`;
  },
};

export const resolvePreviousReviewSection: PromptSection = {
  name: "resolve-previous-review",
  render(ctx) {
    if (!ctx.entry.lastReviewBody) return null;
    return `## Previous review (approved)\n\n${ctx.entry.lastReviewBody}`;
  },
};

export const resolveCommitsSection: PromptSection = {
  name: "resolve-commits",
  render(ctx) {
    if (!ctx.data.commitSummary) return null;
    return `## Commits on this branch\n\n\`\`\`\n${ctx.data.commitSummary}\n\`\`\``;
  },
};

export const resolveStepsSection: PromptSection = {
  name: "resolve-steps",
  render(ctx) {
    return [
      "## Steps",
      "",
      "1. Run `git status`. If a rebase is already in progress (output mentions",
      "   `rebase in progress` or `You are currently rebasing`), run `git rebase --abort`.",
      "",
      `2. Run \`git rebase origin/${ctx.baseBranch}\`.`,
      "",
      "3. If conflicts appear:",
      "   - Read each conflict carefully and resolve it preserving the intent of both sides.",
      "   - Read commit messages (`git log`) and diffs as needed to understand intent.",
      "   - `git add` each resolved file.",
      "   - `git rebase --continue` and repeat for further conflicts.",
      "   - If a conflict is genuinely unresolvable (e.g. the two sides implement",
      `     contradictory designs), run \`git rebase --abort\` and output \`FAILED\`.`,
      "",
      `4. When the rebase is complete, confirm with \`git status\` (should say clean) and`,
      `   \`git log --oneline origin/${ctx.baseBranch}..HEAD\` (should list your branch's commits).`,
      "",
      "5. Do **not** push. The poller handles the push after verifying your work.",
    ].join("\n");
  },
};

export const resolveVerdictFormatSection: PromptSection = {
  name: "resolve-verdict-format",
  render: () => [
    "## Output format",
    "",
    "Your LAST line of output must be exactly one of:",
    "",
    "- `DONE` — the rebase completed cleanly and HEAD is ready for merge.",
    "- `FAILED` — the conflict is unresolvable or you could not complete the rebase.",
    "",
    "Write a brief summary of what you did above the verdict line.",
  ].join("\n"),
};

export const resolveSections: readonly PromptSection[] = [
  resolveIntroSection,
  resolveWorkerTaskSection,
  resolvePreviousReviewSection,
  resolveCommitsSection,
  resolveStepsSection,
  resolveVerdictFormatSection,
];

// --- Builders ---

export function buildReviewPrompt(
  projectName: string,
  projectPath: string,
  baseBranch: string,
  entry: WorkerEntry,
): string | null {
  const ctx = gatherPromptContext(projectName, projectPath, baseBranch, entry);
  if (!ctx) return null;
  return composePrompt(reviewSections, ctx);
}

// Resolver context: minimal I/O — only the commits the resolver needs to
// frame the merge attempt. The other PromptData fields are unused by the
// resolve sections and stay at their empty defaults.
export function buildResolvePrompt(
  projectName: string,
  projectPath: string,
  baseBranch: string,
  entry: WorkerEntry,
): string | null {
  const ctx = makeResolveContext(projectName, projectPath, baseBranch, entry);
  return composePrompt(resolveSections, ctx);
}

function makeResolveContext(
  projectName: string,
  projectPath: string,
  baseBranch: string,
  entry: WorkerEntry,
): PromptContext {
  const wtPath = entry.worktreePath ?? projectPath;
  let commitSummary = "";
  try {
    commitSummary = getCommitSummary(wtPath, baseBranch);
  } catch {
    log.warn("poller", "failed to get commit summary for resolve", { worker: entry.name });
  }
  const branchName = entry.branchName ?? entry.name;
  const data: PromptData = {
    diff: "",
    commitSummary,
    branchName,
    rules: "",
    checksCommand: undefined,
    changedFiles: [],
    docSections: [],
    testSections: [],
    specFiles: [],
  };
  return makeContext(projectName, projectPath, baseBranch, entry, data);
}

// --- Spec warning text builder ---
//
// Kept as a pure function (not a section method) because test/prompts.test.ts
// imports it directly to verify the warning text. Returns an array of lines
// matching the historical shape; the spec-warning section joins and trims
// before handing off to the composer.

export function buildSpecWarning(specFiles: string[]): string[] {
  if (specFiles.length === 0) return [];
  return [
    "## WARNING: Specification files in this diff",
    "",
    "This diff modifies one or more **specification** files — documents that",
    "are the *source of truth* for their respective systems:",
    "",
    ...specFiles.map(f => `- \`${f}\``),
    "",
    "When reviewing changes to a specification:",
    "",
    "- **Do not revert spec changes to match the current implementation.**",
    "  The spec drives the code, not the other way around. The spec opens",
    "  with the statement that if the code disagrees, the code is wrong —",
    "  that is the contract, and your job is to honor it.",
    "- **Do flag implementation code in this diff that contradicts the spec.**",
    "  Code-vs-spec mismatches must be fixed by changing the code, never the",
    "  spec.",
    "- **If the spec contradicts code OUTSIDE this diff,** that is a known",
    "  gap the user is intentionally documenting. Do not \"fix\" the spec to",
    "  match the legacy code. The user is using the spec to guide future work.",
    "- **Treat spec changes the way you would treat user instructions.**",
    "  Verify clarity, internal consistency, and grammar. Never rewrite design",
    "  intent. Never \"correct\" the spec by editing prose to describe what",
    "  the code currently does.",
    "",
    "If you genuinely believe a spec change is wrong (e.g., logically",
    "self-contradictory, or impossible to implement), flag it in your review",
    "output rather than silently editing it. Editing a spec to match code is",
    "the exact mistake this section exists to prevent.",
    "",
  ];
}

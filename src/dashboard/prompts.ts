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
      "- Documentation accuracy and completeness. For `CLAUDE.md` (Claude Code's quick-start",
      "  for workers in this project) and any other architecture / overview documentation",
      "  included below, are all claims still correct after this diff? Flag stale descriptions,",
      "  broken cross-references, out-of-date file lists. Then check for additive gaps: if this",
      "  diff introduces a kind of thing where someone might add another later (a command, a",
      "  workflow, an agent type, a plugin, a hook), does `CLAUDE.md` have an \"Adding a new X\"",
      "  how-to to anchor that? Adding such a section is the most common form of \"missing",
      "  section for new behavior\" and is the easiest to miss. Skip the question for doc kinds",
      "  the project doesn't keep — don't request creation of docs the project doesn't already",
      "  maintain. This bullet applies *only* to descriptive documents — not to specification",
      "  files (those marked as a source of truth, see the warning above if any are in this",
      "  diff). Specs drive the code; do not edit them to match code.",
      "- Documentation tense. Design or specification documents often open with future-tense",
      "  framing like \"describes target behavior\" or \"the code does not yet match it\" — if",
      "  this diff completes the work such a doc described, the doc's tense and any \"Status:",
      "  planned / in-progress\" framing must flip to past-tense / \"complete.\" Look for these",
      "  in the diff itself and in any markdown the diff references.",
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

// --- CI-fix sections ---
//
// The ci-fix agent runs when the merge-queue's CI gate (poller-ci.ts) reports
// failed GitHub Actions check-runs on the worker's branch HEAD. The branch was
// already reviewed and approved, so this is not a code review — the agent
// reads the failing logs, makes the minimum fix to turn the checks green, and
// pushes. See poller-ci-fix.ts for the launch/handler lifecycle.
//
// The agent reads the structured failure summary off `ctx.entry.failingCheckSummary`,
// pre-formatted at launch time by poller-ci-fix.ts so the prompt sections
// don't need to know the CiStatus shape.

export const ciFixIntroSection: PromptSection = {
  name: "ci-fix-intro",
  render(ctx) {
    const branchName = ctx.data.branchName;
    const attemptNum = (ctx.entry.ciFixAttempts ?? 0) + 1;
    return [
      `You are fixing failing GitHub Actions CI checks on branch \`${branchName}\` in project ${ctx.projectName}.`,
      "",
      "The branch has already been reviewed and approved for merge. Code review is",
      "complete — the only thing blocking the merge is red CI. Your job is to make",
      "the failing checks green with the minimum fix that addresses the actual cause.",
      "",
      `This is ci-fix attempt ${attemptNum} of 3.`,
    ].join("\n");
  },
};

export const ciFixFailureDetailSection: PromptSection = {
  name: "ci-fix-failure-detail",
  render(ctx) {
    const summary = ctx.entry.failingCheckSummary;
    if (!summary) return null;
    return [
      "## Failing checks",
      "",
      summary,
      "",
      "Read the failing logs with `gh run view --log-failed <run-id>`. Extract",
      "the run ID from the URL path (`/actions/runs/<id>/...`). If a check has",
      "no URL listed, run `gh run list --branch " + ctx.data.branchName + " --json databaseId,name,conclusion,headSha`",
      "and match by SHA + check name.",
    ].join("\n");
  },
};

export const ciFixWorkerTaskSection: PromptSection = {
  name: "ci-fix-worker-task",
  render(ctx) {
    if (!ctx.entry.task) return null;
    return `## Worker task\n\n${ctx.entry.task}`;
  },
};

export const ciFixPreviousReviewSection: PromptSection = {
  name: "ci-fix-previous-review",
  render(ctx) {
    if (!ctx.entry.lastReviewBody) return null;
    return [
      "## Previous review (approved)",
      "",
      "This is what the reviewer signed off on. If the CI failure suggests the",
      "reviewer missed something, that is useful context — but the review is",
      "advisory at this point, not a contract to defend.",
      "",
      ctx.entry.lastReviewBody,
    ].join("\n");
  },
};

export const ciFixCommitsSection: PromptSection = {
  name: "ci-fix-commits",
  render(ctx) {
    if (!ctx.data.commitSummary) return null;
    return `## Commits on this branch\n\n\`\`\`\n${ctx.data.commitSummary}\n\`\`\``;
  },
};

export const ciFixStepsSection: PromptSection = {
  name: "ci-fix-steps",
  render(ctx) {
    const branchName = ctx.data.branchName;
    return [
      "## Steps",
      "",
      "1. Read the failing CI logs (see `gh run view --log-failed` instruction above).",
      "   Identify the precise cause — not the surface symptom. A failing test could",
      "   be an actual bug in this diff, drift between test fixture and production",
      "   data, a flake, a CI environment problem, or a stale snapshot.",
      "",
      "2. Make the minimum fix that turns the failing checks green. Touch only what",
      "   is necessary. Do not refactor adjacent code, do not extend scope, do not",
      "   improve unrelated things.",
      "",
      "3. Run the project's local checks if applicable, to verify your fix before",
      "   pushing. If the failure is reproducible locally, fix and verify; if it is",
      "   not (e.g. CI-environment-specific), explain that in your commit message.",
      "",
      `4. Commit with a clear message prefixed with \"ci-fix: \". Push to \`origin/${branchName}\`.`,
      "   The poller will re-run the CI gate on the new SHA — if your push lands a",
      "   green run, the merge proceeds automatically.",
      "",
      "5. **Systemic notes.** If the failure points at a systemic gap (fragile test",
      "   fixture, flaky CI step, missing precondition, environment drift, type-system",
      "   hole, missing snapshot, etc.) describe it under a `## Systemic notes` heading",
      "   in your commit body. **Do not expand scope to fix the systemic issue in this",
      "   pass** unless it is required for CI to pass — flagging is enough. The",
      "   operator decides whether to file a follow-up.",
    ].join("\n");
  },
};

export const ciFixDiffSection: PromptSection = {
  name: "ci-fix-diff",
  render(ctx) {
    if (!ctx.data.diff) return null;
    return `## Diff under review\n\n\`\`\`diff\n${ctx.data.diff}\n\`\`\``;
  },
};

export const ciFixVerdictFormatSection: PromptSection = {
  name: "ci-fix-verdict-format",
  render: () => [
    "## Output format",
    "",
    "Your LAST line of output must be exactly one of:",
    "",
    "- `FIXED` — you pushed a fix and the CI failure should now be addressed.",
    "- `FAILED` — you could not fix it (logs unreadable, infrastructure problem,",
    "  fix would require out-of-scope changes, etc.). Explain above.",
    "",
    "Write a brief summary of what you found and did above the verdict line.",
  ].join("\n"),
};

export const ciFixSections: readonly PromptSection[] = [
  ciFixIntroSection,
  ciFixFailureDetailSection,
  ciFixWorkerTaskSection,
  ciFixPreviousReviewSection,
  ciFixCommitsSection,
  ciFixStepsSection,
  ciFixDiffSection,
  ciFixVerdictFormatSection,
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

// CI-fix context: full review I/O (diff + commits + rules-equivalent context
// via gatherPromptContext) so the agent can read the diff that triggered the
// failure. The failing-check detail is read off the entry via
// `failingCheckSummary`, which poller-ci-fix.ts stamps at launch time.
export function buildCiFixPrompt(
  projectName: string,
  projectPath: string,
  baseBranch: string,
  entry: WorkerEntry,
): string | null {
  const ctx = gatherPromptContext(projectName, projectPath, baseBranch, entry);
  if (!ctx) return null;
  return composePrompt(ciFixSections, ctx);
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

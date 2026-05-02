// Review prompt building: constructs prompts for the reviewer Claude session.
// Extracted from poller.ts to keep the state machine separate from prompt text.
import fs from "node:fs";
import path from "node:path";
import { tryGetProject } from "../config.js";
import { buildRulesContext } from "../rules.js";
import {
  getDiffAgainstBase, getCommitSummary, getChangedFiles,
} from "./git.js";
import { log } from "./log.js";
import type { WorkerEntry } from "./registry.js";

const SPEC_MARKER = "the code is wrong";

// --- Exported prompt builder ---

export function buildReviewPrompt(
  projectName: string,
  projectPath: string,
  baseBranch: string,
  entry: WorkerEntry,
): string | null {
  const data = gatherPromptData(projectName, projectPath, baseBranch, entry);
  if (!data) return null;

  const { diff, commitSummary, branchName, rules, checksCommand, docSections, testSections, specWarning } = data;

  let stepNum = 1;
  const rebaseStep = stepNum++;
  const checksStep = checksCommand ? stepNum++ : null;
  const reviewStep = stepNum;

  const sections: string[] = [];

  sections.push(
    "You are reviewing a branch before merge. Complete these steps in order:",
    "",
  );

  // Spec warning (if any spec files changed)
  sections.push(...specWarning);

  // Rebase onto `origin/<base>`, not the local ref: the worktree's local base can
  // lag behind origin when a prior main-checkout fast-forward failed, and rebasing
  // on a stale ref produces dup-SHA conflicts downstream in the merge queue.
  sections.push(
    `## Step ${rebaseStep}: Rebase onto origin/${baseBranch}`,
    "",
    `Run \`git rebase origin/${baseBranch}\` in the worktree. If there are conflicts:`,
    "- Resolve them sensibly (preserve the intent of both sides)",
    "- `git add` resolved files and `git rebase --continue`",
    "- If a conflict is truly unresolvable, abort the rebase and report FAILED",
    "",
  );

  // Step: Checks (optional)
  if (checksCommand) {
    sections.push(
      `## Step ${checksStep}: Run checks`,
      "",
      `Run: \`${checksCommand}\``,
      "",
      "If checks fail, fix the issues and re-run until they pass.",
      "If you cannot fix them, report FAILED.",
      "",
    );
  }

  // Step: Review
  sections.push(
    `## Step ${reviewStep}: Code review`,
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
    "",
  );

  // Tail: branch info, commits, rules, diff, docs, tests, output format
  sections.push(`## Branch: ${branchName}`, "");
  if (entry.task) sections.push(`### Worker task\n\n${entry.task}`, "");
  if (commitSummary) sections.push(`### Commits\n\n\`\`\`\n${commitSummary}\n\`\`\``);
  sections.push(
    "",
    "## Project Rules",
    "",
    rules,
    "",
    "## Diff",
    "",
    "```diff",
    diff,
    "```",
    "",
    "## Documentation (current state in the worktree)",
    "",
    "Verify these are still accurate after the diff above.",
    "",
  );
  sections.push(...docSections);

  if (testSections.length > 0) {
    sections.push(
      "",
      "## Test Files (corresponding to changed source files)",
      "",
      "Verify these still correctly cover the changed behavior.",
      "",
    );
    sections.push(...testSections);
  }

  sections.push(
    "",
    "## Output Format",
    "",
    "Your LAST line of output must be exactly one of:",
    "CLEAN — no issues found, code is ready to merge as-is",
    "FIXED — issues were found and fixed in the worktree",
    "FAILED — issues were found but could not be fixed (explain above)",
  );

  return sections.join("\n");
}

// Build the prompt for a resolver Claude session. The resolver has a single
// narrow job: complete `git rebase origin/<base>` in the worktree and commit
// any conflict resolutions. It does NOT code-review; the code was already
// approved by the initial reviewer. It does NOT push — the poller pushes
// after programmatic verification (see STATUS.md invariant 7).
//
// The verdict is DONE or FAILED, not CLEAN/FIXED/FAILED. This keeps the
// resolver's output space distinct from the reviewer's so parsing cannot
// be confused by a stale result file from a prior run.
export function buildResolvePrompt(
  projectName: string,
  projectPath: string,
  baseBranch: string,
  entry: WorkerEntry,
): string | null {
  const wtPath = entry.worktreePath ?? projectPath;

  let commitSummary: string;
  try {
    commitSummary = getCommitSummary(wtPath, baseBranch);
  } catch {
    log.warn("poller", "failed to get commit summary for resolve", { worker: entry.name });
    commitSummary = "";
  }

  const branchName = entry.branchName ?? entry.name;
  const attemptNum = (entry.resolveAttempts ?? 0) + 1;

  const sections: string[] = [];

  sections.push(
    `You are resolving a rebase conflict on branch \`${branchName}\` in project ${projectName}.`,
    "",
    `The branch was reviewed and approved, but when the merge queue tried to rebase it onto`,
    `\`origin/${baseBranch}\` the rebase conflicted. Your job is to complete that rebase.`,
    "",
    "**This is not a code review.** The code itself has already been approved. Do not refactor,",
    "add tests, update docs, or make any change not required to resolve the conflict.",
    "",
    `This is resolve attempt ${attemptNum} of 2.`,
    "",
  );

  if (entry.task) {
    sections.push("## Worker task", "", entry.task, "");
  }

  if (entry.lastReviewBody) {
    sections.push(
      "## Previous review (approved)",
      "",
      entry.lastReviewBody,
      "",
    );
  }

  if (commitSummary) {
    sections.push("## Commits on this branch", "", "```", commitSummary, "```", "");
  }

  sections.push(
    "## Steps",
    "",
    "1. Run `git status`. If a rebase is already in progress (output mentions",
    "   `rebase in progress` or `You are currently rebasing`), run `git rebase --abort`.",
    "",
    `2. Run \`git rebase origin/${baseBranch}\`.`,
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
    `   \`git log --oneline origin/${baseBranch}..HEAD\` (should list your branch's commits).`,
    "",
    "5. Do **not** push. The poller handles the push after verifying your work.",
    "",
    "## Output format",
    "",
    "Your LAST line of output must be exactly one of:",
    "",
    "- `DONE` — the rebase completed cleanly and HEAD is ready for merge.",
    "- `FAILED` — the conflict is unresolvable or you could not complete the rebase.",
    "",
    "Write a brief summary of what you did above the verdict line.",
  );

  return sections.join("\n");
}

// --- Exported helpers (used by poller for spec detection) ---

export function findSpecFiles(wtPath: string, changedFiles: string[]): string[] {
  const specs: string[] = [];
  for (const file of changedFiles) {
    if (!file.endsWith(".md")) continue;
    try {
      const content = fs.readFileSync(path.join(wtPath, file), "utf-8");
      if (content.slice(0, 2000).includes(SPEC_MARKER)) {
        specs.push(file);
      }
    } catch { /* file may have been renamed or deleted in the diff */ }
  }
  return specs;
}

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

export function readDocSections(wtPath: string): string[] {
  const sections: string[] = [];
  for (const docFile of ["DESIGN.md", "CLAUDE.md"]) {
    const fullPath = path.join(wtPath, docFile);
    try {
      const content = fs.readFileSync(fullPath, "utf-8");
      sections.push(`### ${docFile}\n\n${content}`);
    } catch { /* file may not exist */ }
  }
  return sections;
}

export function readTestSections(wtPath: string, changedFiles: string[]): string[] {
  const sections: string[] = [];
  for (const file of changedFiles) {
    const basename = path.basename(file, path.extname(file));
    const testFile = path.join(wtPath, "test", `${basename}.test.ts`);
    try {
      const content = fs.readFileSync(testFile, "utf-8");
      sections.push(`### test/${basename}.test.ts\n\n${content}`);
    } catch { /* no corresponding test file */ }
  }
  return sections;
}

// --- Private helpers ---

interface PromptData {
  diff: string;
  commitSummary: string;
  branchName: string;
  rules: string;
  checksCommand: string | undefined;
  docSections: string[];
  testSections: string[];
  specWarning: string[];
}

function gatherPromptData(
  projectName: string,
  projectPath: string,
  baseBranch: string,
  entry: WorkerEntry,
): PromptData | null {
  const wtPath = entry.worktreePath ?? projectPath;

  let diff: string;
  try {
    diff = getDiffAgainstBase(wtPath, baseBranch);
  } catch {
    log.warn("poller", "failed to get diff for review", { worker: entry.name });
    return null;
  }

  const commitSummary = getCommitSummary(wtPath, baseBranch);
  const branchName = entry.branchName ?? entry.name;
  const rules = buildRulesContext(projectName, projectPath);
  const project = tryGetProject(projectName);
  const checksCommand = project?.checks;
  const changedFiles = getChangedFiles(wtPath, baseBranch);

  const docSections = readDocSections(wtPath);
  const testSections = readTestSections(wtPath, changedFiles);
  const specFiles = findSpecFiles(wtPath, changedFiles);
  const specWarning = buildSpecWarning(specFiles);

  return { diff, commitSummary, branchName, rules, checksCommand, docSections, testSections, specWarning };
}

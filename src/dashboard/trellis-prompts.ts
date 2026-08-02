// Trellis-flavored review prompt sections + builder. See WORKFLOWS.md
// "Reviewer prompt and verdict".
//
// The trellis reviewer reuses most default review sections (intro, spec
// warning, rebase + checks steps, branch info, commits, rules, diff,
// docs, tests). It adds three trellis-specific sections — authority,
// alignment step, document inline — and overrides the verdict format
// to ALIGNED/DRIFT/FAILED/FLAGGED.
//
// The default verdict format section is *not* in trellisReviewSections;
// the trellis verdict format takes its place at the end of the list.
// The default code-review-step section is intentionally omitted: the
// trellis reviewer's job is "compare against the trellis," not
// "general-purpose review." See trellisAuthoritySection prose.
import fs from "node:fs";
import path from "node:path";
import {
  composePrompt, composeWithinCeiling, gatherPromptContext,
  type PromptContext, type PromptSection,
} from "./prompt-compose.js";
import { getDiffStat } from "./git.js";
import {
  reviewIntroSection,
  reviewSpecWarningSection,
  reviewRebaseStepSection,
  reviewChecksStepSection,
  reviewBranchInfoSection,
  reviewCommitsSection,
  reviewRulesSection,
  reviewDiffSection,
  reviewDocumentationSection,
  reviewTestFilesSection,
} from "./prompts.js";
import type { WorkerEntry } from "./registry.js";

// Authority asymmetry text. Per WORKFLOWS.md, this is verbatim — paraphrasing
// weakens the prompt's load-bearing instruction.
const TRELLIS_AUTHORITY_TEXT = [
  "The trellis is the source of truth for this feature. Your job is to",
  "compare the code, tests, and documentation against the trellis and",
  "report drift. You are not a general-purpose code reviewer in this",
  "mode — you do not propose stylistic changes, do not extend scope, do",
  "not improve adjacent code. You compare against the trellis.",
  "",
  "Bias toward DRIFT over FLAGGED. If a clause seems hard to satisfy,",
  "assume the implementer is at fault. Only emit FLAGGED if you can",
  "articulate a specific contradiction in the trellis, citing line",
  "numbers, that no implementation could satisfy.",
].join("\n");

export const trellisAuthoritySection: PromptSection = {
  name: "trellis-authority",
  render: () => `## Trellis authority\n\n${TRELLIS_AUTHORITY_TEXT}`,
};

// Three-way drift analysis step instruction. Numbered via ctx.nextStep so
// it integrates with the rebase + checks steps that came before.
export const trellisAlignmentStepSection: PromptSection = {
  name: "trellis-alignment-step",
  render(ctx) {
    const step = ctx.nextStep();
    return [
      `## Step ${step}: Three-way drift analysis`,
      "",
      "For each section of the trellis (Surface, Behavior, Tests, Docs):",
      "1. List the trellis's claims in that section.",
      "2. For each claim, locate the corresponding artifact (a function, a",
      "   test, a doc section). Use grep, file reads, or the test runner.",
      "3. Mark each claim as `present`, `partial`, or `absent`.",
      "",
      "Output a structured drift list (see verdict format below). Drift",
      "items are priority-ordered: `absent` highest, `partial` next, prose",
      "mismatches lowest.",
    ].join("\n");
  },
};

// Inline the trellis content from the worker's worktree view at HEAD.
// The reviewer's rebase step has advanced the worktree to origin/<base>,
// so the worktree's copy of the trellis IS the canonical post-amendment
// version. Read from there rather than the project's main checkout to
// avoid lag when the operator amends the trellis mid-loop and the
// project's local main hasn't caught up yet.
//
// Returns null when the file is missing — the verdict format section
// covers the "trellis document missing or unreadable" case as a
// FLAGGED reason.
export const trellisDocumentSection: PromptSection = {
  name: "trellis-document",
  render(ctx) {
    const trellisPath = ctx.entry.trellis?.path;
    if (!trellisPath) return null;
    const readPath = worktreeRootedTrellisPath(ctx, trellisPath);
    let content: string;
    try {
      content = fs.readFileSync(readPath, "utf-8");
    } catch {
      return null;
    }
    const display = ctx.entry.worktreePath
      ? path.relative(ctx.entry.worktreePath, readPath) || readPath
      : readPath;
    return `## Trellis (source of truth)\n\nPath: \`${display}\`\n\n\`\`\`markdown\n${content}\n\`\`\``;
  },
};

// Inline trellis-overrides.md if it exists. Phase 2 ships the file
// mechanism only; the `--override` CLI flag lands in v1.5. When the file
// is absent the section returns null. See WORKFLOWS.md "Flagging the
// trellis" / "Override".
export const trellisOverridesSection: PromptSection = {
  name: "trellis-overrides",
  render(ctx) {
    const wtPath = ctx.entry.worktreePath;
    if (!wtPath) return null;
    const overridePath = path.join(wtPath, ".garden", "trellis-overrides.md");
    let content: string;
    try {
      content = fs.readFileSync(overridePath, "utf-8").trim();
    } catch {
      return null;
    }
    if (!content) return null;
    return [
      "## Trellis overrides (operator-recorded)",
      "",
      "The operator has recorded the following overrides for clauses you",
      "might otherwise flag. Treat these as resolved — do not re-flag the",
      "same clauses for the same reason.",
      "",
      "```markdown",
      content,
      "```",
    ].join("\n");
  },
};

// Output contract for ALIGNED/DRIFT/FAILED/FLAGGED. Replaces the default
// reviewer's CLEAN/FIXED/FAILED format.
export const trellisVerdictFormatSection: PromptSection = {
  name: "verdict-format",
  render: () => [
    "## Output Format",
    "",
    "End your review with one of these verdicts on the final line:",
    "",
    "- `ALIGNED` — every trellis claim has a corresponding present",
    "  artifact, all checks pass, no drift remains.",
    "- `DRIFT` — the diff is otherwise mergeable (rules satisfied, checks",
    "  pass) but trellis alignment is incomplete. Above the verdict line,",
    "  list each drift item as a numbered bullet, priority-ordered, in",
    "  this format:",
    "",
    "      1. [surface] `foo()` exists but takes no `timeout` arg (trellis line 47)",
    "      2. [tests] no test for the timeout behavior (trellis line 91)",
    "      3. [docs] CLAUDE.md unchanged; trellis line 122 requires a section update",
    "",
    "  Above the drift list, enumerate how many trellis claims are",
    "  `present` (e.g. `Aligned: 7`). This running count tracks convergence.",
    "- `FAILED` — the diff is not mergeable. Cause: tests failed, rebase",
    "  failed, rules violated, or you could not fix. Same semantic as the",
    "  default workflow's FAILED.",
    "- `FLAGGED` — the trellis itself is contradictory or impossible.",
    "  Above the verdict line, cite the clauses with line numbers and",
    "  describe the contradiction. Be specific. Bias against this verdict —",
    "  see Trellis authority above.",
    "",
    "Use only one verdict. The verdict word must be the last non-empty",
    "line of your review.",
  ].join("\n"),
};

// Section list for the trellis review. Order is load-bearing — see
// WORKFLOWS.md "Section composition".
export const trellisReviewSections: readonly PromptSection[] = [
  reviewIntroSection,
  reviewSpecWarningSection,
  trellisAuthoritySection,
  reviewRebaseStepSection,
  reviewChecksStepSection,
  trellisAlignmentStepSection,
  reviewBranchInfoSection,
  reviewCommitsSection,
  reviewRulesSection,
  reviewDiffSection,
  reviewDocumentationSection,
  reviewTestFilesSection,
  trellisDocumentSection,
  trellisOverridesSection,
  trellisVerdictFormatSection,
];

// Build the full trellis review prompt for a worker. Returns null when
// the diff cannot be read (mirrors buildReviewPrompt's contract).
export function buildTrellisReviewPrompt(
  projectName: string,
  projectPath: string,
  baseBranch: string,
  entry: WorkerEntry,
): string | null {
  const ctx = gatherPromptContext(projectName, projectPath, baseBranch, entry);
  if (!ctx) return null;
  const wtPath = entry.worktreePath ?? projectPath;
  return composeWithinCeiling(trellisReviewSections, ctx,
    () => getDiffStat(wtPath, `origin/${baseBranch}...HEAD`));
}

// --- Helpers -------------------------------------------------------------

// Translate a project-rooted trellis path into the equivalent path inside
// the worker's worktree. trellisPath is stored at plant time as the
// absolute path under the project root; the worktree is a separate
// checkout of the same project. When the project root prefix matches,
// swap it for the worktree root prefix. When it doesn't (path resides
// outside the project, unlikely in practice), fall through to the
// stored path.
function worktreeRootedTrellisPath(ctx: PromptContext, trellisPath: string): string {
  const wtPath = ctx.entry.worktreePath;
  if (!wtPath) return trellisPath;
  const projectRoot = ctx.projectPath;
  const projectPrefix = projectRoot.endsWith(path.sep) ? projectRoot : projectRoot + path.sep;
  if (trellisPath.startsWith(projectPrefix)) {
    return path.join(wtPath, trellisPath.slice(projectPrefix.length));
  }
  return trellisPath;
}

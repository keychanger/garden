// Prompt composition primitive: PromptSection objects render named blocks of
// text against a shared PromptContext. composePrompt joins their non-null
// outputs with a blank line between blocks. See WORKFLOWS.md Component 3 for
// the full contract.
//
// The current reviewer/resolver each build their prompt as a 100-line wall of
// `sections.push(...)` strings. Decomposing into named sections lets a future
// workflow declare its own composition (different intro, different verdict
// format, different ordering) without re-implementing the whole builder.
//
// Sections that need a step number call ctx.nextStep() — counter starts at 1
// and increments on each call. Sections that don't number themselves don't
// call it; conditional sections that early-return null don't perturb the
// counter either.
import fs from "node:fs";
import path from "node:path";
import { tryGetProject } from "../config.js";
import { buildRulesContext } from "../rules.js";
import { stripGardenRules } from "./harness/agents-md.js";
import {
  getChangedFiles, getCommitSummary, getDiffAgainstBase,
} from "./git.js";
import { log } from "./log.js";
import type { WorkerEntry } from "./registry.js";

const SPEC_MARKER = "the code is wrong";

export interface PromptData {
  diff: string;
  /** Per-file `--stat` summary of the same range as `diff`, set only when the
   *  delta was too large to inline (see composeWithinCeiling). Diff sections
   *  render this plus paging instructions instead of `diff`, which is empty. */
  diffStat?: string;
  commitSummary: string;
  branchName: string;
  rules: string;
  checksCommand: string | undefined;
  changedFiles: string[];
  docSections: string[];
  testSections: string[];
  specFiles: string[];
}

export interface PromptContext {
  projectName: string;
  projectPath: string;
  baseBranch: string;
  entry: WorkerEntry;
  /** Cached data, gathered once at the top of the composition. Workflows
   *  that don't need a particular field leave it at its empty default
   *  (empty string, empty array, undefined) — sections that consume the
   *  field opt out via null when it is absent. */
  data: PromptData;
  /** Counter for step-numbered sections. First call returns 1, second
   *  returns 2, etc. Sections that don't render (returning null) do not
   *  call this, so the count corresponds to actual rendered steps. */
  nextStep(): number;
}

export interface PromptSection {
  /** Identifier for ordering, deduplication, and override. */
  name: string;
  /** Returns the rendered text of this section, or null to omit it.
   *  Returned text MUST NOT have leading or trailing newlines — the
   *  composer adds the blank-line separator between blocks. */
  render(ctx: PromptContext): string | null;
}

export function composePrompt(
  sections: readonly PromptSection[],
  ctx: PromptContext,
): string {
  const parts: string[] = [];
  for (const section of sections) {
    const rendered = section.render(ctx);
    if (rendered === null) continue;
    parts.push(rendered);
  }
  return parts.join("\n\n");
}

// Ceiling on the assembled reviewer prompt. Past this the prompt is rejected by
// the agent CLI before the reviewer starts — the request exceeds the model's
// context window — so launching is guaranteed to waste the whole retry ladder
// and park the worker behind a misleading "unavailable or unparseable output"
// alert. It is a composition threshold first (composeWithinCeiling below drops
// the inline diff to bring a prompt under it) and a park-the-worker threshold
// only when that fails.
//
// Sized from measurement, not guesswork. Across the last 80 commits of two
// active repos (garden, wolf): median review delta 3-14KB, p95 88-155KB, and
// the largest single delta observed 336KB. The failure this guards against was
// a 2.88MB branch diff (one commit, 195 files, +48160/-5455) that assembled to
// ~1.16M tokens against a 1M ceiling. 1MB sits ~3x above the largest healthy
// delta and ~2.8x below the failure, so a borderline-large branch is still
// handed to the reviewer inline — if the diff is merely big, letting the review
// run and fail is no worse than not trying.
//
// It is NOT sized to the reviewer's whole context window on purpose. The
// reviewer works in that window too: it rebases, resolves conflicts, runs the
// checks suite (whose failure output alone runs to tens of KB), reads files and
// edits them. A prompt sized to fill the window compacts mid-review, and a
// compacted reviewer certifies a summary of the diff rather than the diff.
//
// Deliberately one constant rather than a config key: a per-project knob would
// be tuning a threshold nothing is expected to reach.
export const MAX_REVIEW_PROMPT_BYTES = 1024 * 1024;

export function reviewPromptBytes(prompt: string): number {
  return Buffer.byteLength(prompt, "utf8");
}

// Compose, and if the assembled prompt busts the ceiling, recompose once with
// the diff replaced by its `--stat` summary (`stat` is a thunk so the extra git
// call happens only on that path). The reviewer runs INSIDE the worktree with a
// shell, so a delta too large to carry inline is still reviewable — it just has
// to page through `git diff` itself, which is what the diff sections tell it to
// do when `diffStat` is set. A degraded review beats the alternative of parking
// the worker and reviewing nothing; a branch that fits takes the byte-identical
// original path. The caller's own ceiling check remains the backstop for when
// even the summarized prompt does not fit (rules/docs/tests dominating).
export function composeWithinCeiling(
  sections: readonly PromptSection[],
  ctx: PromptContext,
  stat: () => string,
): string {
  const prompt = composePrompt(sections, ctx);
  if (reviewPromptBytes(prompt) <= MAX_REVIEW_PROMPT_BYTES) return prompt;
  const paged = makeContext(ctx.projectName, ctx.projectPath, ctx.baseBranch, ctx.entry, {
    ...ctx.data, diff: "", diffStat: stat(),
  });
  return composePrompt(sections, paged);
}

// Review-flavored gatherer: fetches diff, commits, rules, docs, tests, and
// spec files in one pass. Returns null only when the diff cannot be read —
// without a diff there is nothing to review and the caller short-circuits.
// All other failures (missing test files, missing docs, etc.) degrade to
// empty values; sections that consume those fields opt out gracefully.
export function gatherPromptContext(
  projectName: string,
  projectPath: string,
  baseBranch: string,
  entry: WorkerEntry,
): PromptContext | null {
  const wtPath = entry.worktreePath ?? projectPath;

  let diff: string;
  try {
    diff = getDiffAgainstBase(wtPath, baseBranch);
  } catch {
    log.warn("poller", "failed to get diff for review", { worker: entry.name, data: { project: projectName } });
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

  return makeContext(projectName, projectPath, baseBranch, entry, {
    diff, commitSummary, branchName, rules, checksCommand,
    changedFiles, docSections, testSections, specFiles,
  });
}

// Build a PromptContext directly. Used by callers (e.g. the resolver) that
// don't need the full review I/O — they fill only the fields their
// sections consume and leave the rest at empty defaults.
export function makeContext(
  projectName: string,
  projectPath: string,
  baseBranch: string,
  entry: WorkerEntry,
  data: PromptData,
): PromptContext {
  let stepCount = 0;
  return {
    projectName, projectPath, baseBranch, entry,
    data,
    nextStep: () => ++stepCount,
  };
}

// I/O helpers for the gather function — exported so prompts.ts can re-export
// them for backward compat with existing imports in test/prompts.test.ts.

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

// Architecture / overview docs handed to the reviewer so it can check the diff
// against them. AGENTS.md and CLAUDE.md are the same document in most repos —
// one is the real file, the other an `@` import or a symlink. Import-only files
// may also carry maintainer comments, which Claude Code does not put in context.
const DOC_FILES = ["DESIGN.md", "AGENTS.md", "CLAUDE.md"];

function isAgentDocPointer(body: string): boolean {
  const visible = body.replace(/<!--[\s\S]*?-->/g, "").trim();
  return /^@(AGENTS|CLAUDE)\.md$/.test(visible);
}

export function readDocSections(wtPath: string): string[] {
  const sections: string[] = [];
  const seen = new Set<string>();
  for (const docFile of DOC_FILES) {
    const fullPath = path.join(wtPath, docFile);
    let content: string;
    try {
      content = fs.readFileSync(fullPath, "utf-8");
    } catch { continue; /* file may not exist */ }
    // On a Codex worktree, garden owns AGENTS.md and has prepended the worker
    // rules the prompt already carries. Review the repo's own content only.
    const body = stripGardenRules(content).trim();
    if (!body || isAgentDocPointer(body)) continue;
    // A symlinked pair resolves to identical bytes through both names.
    if (seen.has(body)) continue;
    seen.add(body);
    sections.push(`### ${docFile}\n\n${body}`);
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

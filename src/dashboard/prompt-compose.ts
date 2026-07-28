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

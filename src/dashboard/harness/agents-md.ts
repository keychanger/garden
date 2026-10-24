// The AGENTS.md composition format, shared by the writer and the readers.
//
// A Codex worker's only instruction channel is a project instruction file, so
// garden composes its worker rules above the repo's own AGENTS.md and writes
// the result to the worktree's AGENTS.override.md (see installCodexAgentsMd in
// codex.ts). Older builds wrote it into AGENTS.md itself. Anything that later
// reads that file as project documentation — the reviewer prompt's
// readDocSections — has to undo the composition, or it feeds garden's rules
// back into a prompt that already carries them.
//
// This module is a string-only leaf with no imports on purpose: prompt-compose
// reaches it from the lean dist/hook.js closure, and codex.ts (git/fs/exec) must
// not be dragged in behind it. Same split rationale as designer-paths.ts.

export const AGENTS_MARKER = "<!-- garden worker rules (managed by garden; not committed) -->";

const DELIM = "\n\n---\n\n";

// Garden's rules above the delimiter, the repo's own AGENTS.md below it.
export function composeAgentsMd(rulesText: string, original: string): string {
  const head = `${AGENTS_MARKER}\n\n${rulesText.trim()}\n`;
  if (!original.trim()) return head;
  return `${head}${DELIM}${original.trimStart()}`;
}

// Recover the repo's own AGENTS.md from a composed file. Returns the input
// unchanged when garden did not compose it. A rules text that itself contains
// the delimiter truncates early, leaving some garden rules in the result — that
// costs prompt bytes in a prompt that already carries the rules, and never
// drops repo content.
export function stripGardenRules(content: string): string {
  if (!content.startsWith(AGENTS_MARKER)) return content;
  const at = content.indexOf(DELIM);
  return at === -1 ? "" : content.slice(at + DELIM.length);
}

// True when content is a composition over exactly `original`, whatever rules
// sit above it. Matched from the end, so a delimiter inside the rules cannot
// misplace the boundary the way it can for stripGardenRules.
export function composedOver(content: string, original: string): boolean {
  if (!content.startsWith(AGENTS_MARKER)) return false;
  if (!original.trim()) return !content.includes(DELIM);
  return content.endsWith(`${DELIM}${original.trimStart()}`);
}

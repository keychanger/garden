// Guard for AGENTS.md's size budget (reads this repository's own file).
//
// CLAUDE.md is an `@AGENTS.md` import, so every Claude Code session rooted in
// a garden checkout or worktree loads AGENTS.md whole before it does anything:
// interactive workers, headless claude-code reviewers, resolvers and ci-fix
// agents (the review prompt names the file instead of inlining a second copy,
// claudeLoadedDocs), subagents, and the operator's own sessions. A Codex
// worker reads it below garden's rules in AGENTS.override.md, and a Codex
// reviewer gets it inline in its prompt. So this file is the map: modules,
// conventions, the "Adding X" checklists. Behavior, rationale and incident
// history go in DESIGN.md.
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

// Claude Code's own threshold: its status diagnostics flag an instruction file
// longer than max(40,000 chars, 5% of the model's context window at its
// chars-per-token estimate), which is 40,000 for a 200K-token window (read
// from Claude Code 2.1.310). Raising this is a decision, not a fix: record the
// measured size and the reason here, as hook-bundle.real.test.ts does.
const AGENTS_MD_CEILING_CHARS = 40_000;

// findSpecFiles (prompt-compose.ts) treats a changed .md file as a spec when
// its first 2,000 characters contain this marker, and tells the reviewer never
// to edit it. AGENTS.md describes the marker in its Conventions; if a reorder
// brought that line into the head, AGENTS.md itself would become a spec.
const SPEC_MARKER = "the code is wrong";
const SPEC_HEAD_CHARS = 2_000;

const ROOT = path.resolve(__dirname, "..");
const agents = fs.readFileSync(path.join(ROOT, "AGENTS.md"), "utf-8");

describe("AGENTS.md budget", () => {
  it("stays under Claude Code's instruction-file threshold", () => {
    expect(agents.length).toBeLessThanOrEqual(AGENTS_MD_CEILING_CHARS);
  });

  it("does not carry the spec marker in its head", () => {
    expect(agents.slice(0, SPEC_HEAD_CHARS)).not.toContain(SPEC_MARKER);
  });

  // A map is only as good as its pointers: every `<doc>.md "Section"`
  // reference (and each `, "Next"` or `+ "Next"` chained onto it) must name a
  // heading or a bold label in that document.
  it("points only at sections that exist", () => {
    const ref = /`?((?:[\w.-]+\/)*[\w.-]+\.md)`?(?: §)? "([^"]+)"((?:(?: \+|,) "[^"]+")*)/g;
    const dangling: string[] = [];
    for (const m of agents.matchAll(ref)) {
      const target = path.join(ROOT, m[1]);
      const names = [m[2], ...[...(m[3] ?? "").matchAll(/"([^"]+)"/g)].map(n => n[1])];
      const lines = fs.existsSync(target) ? fs.readFileSync(target, "utf-8").split("\n") : [];
      for (const name of names) {
        const found = lines.some(l => (/^#{1,6} /.test(l) && l.includes(name)) || l.includes(`**${name}`));
        if (!found) dangling.push(`${m[1]} "${name}"`);
      }
    }
    expect(dangling).toEqual([]);
  });
});

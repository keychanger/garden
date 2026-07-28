// The AGENTS.md composition format: garden's worker rules above the repo's own
// instructions, and the strip that undoes it for the reviewer prompt.
import { describe, it, expect } from "vitest";
import { AGENTS_MARKER, composeAgentsMd, stripGardenRules } from "../src/dashboard/harness/agents-md.js";

describe("composeAgentsMd", () => {
  it("puts garden's rules above the repo's own AGENTS.md", () => {
    const out = composeAgentsMd("worker rules", "# Repo\n\nrepo instructions");
    expect(out.startsWith(AGENTS_MARKER)).toBe(true);
    expect(out.indexOf("worker rules")).toBeLessThan(out.indexOf("repo instructions"));
  });

  it("writes rules alone when the repo has no AGENTS.md", () => {
    const out = composeAgentsMd("worker rules", "");
    expect(out).toBe(`${AGENTS_MARKER}\n\nworker rules\n`);
    expect(out).not.toContain("---");
  });

  it("round-trips through stripGardenRules", () => {
    const original = "# Repo\n\nrepo instructions\n";
    expect(stripGardenRules(composeAgentsMd("worker rules", original))).toBe(original);
  });

  it("is recognizable as composed, so a re-install is idempotent", () => {
    const once = composeAgentsMd("worker rules", "# Repo");
    expect(once.startsWith(AGENTS_MARKER)).toBe(true);
  });
});

describe("stripGardenRules", () => {
  it("leaves an uncomposed file untouched", () => {
    const repo = "# Repo\n\nrepo instructions\n";
    expect(stripGardenRules(repo)).toBe(repo);
  });

  it("returns empty when garden wrote the whole file", () => {
    expect(stripGardenRules(composeAgentsMd("worker rules", ""))).toBe("");
  });

  it("keeps a --- inside the repo's own content", () => {
    const original = "# Repo\n\nfirst\n\n---\n\nsecond\n";
    expect(stripGardenRules(composeAgentsMd("worker rules", original))).toBe(original);
  });
});

// classifyAgentDocs backs `garden doctor`'s agent-docs check: does a repo serve
// one instruction file to both harnesses, or will CLAUDE.md and AGENTS.md drift?
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyAgentDocs } from "../src/commands/doctor.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-agentdocs-"));
});

const write = (name: string, body: string) => fs.writeFileSync(path.join(dir, name), body);

describe("classifyAgentDocs", () => {
  it("reports none when the repo has no agent instructions", () => {
    expect(classifyAgentDocs(dir)).toBe("none");
  });

  it("reports claude-only when Codex would read nothing", () => {
    write("CLAUDE.md", "# Instructions");
    expect(classifyAgentDocs(dir)).toBe("claude-only");
  });

  it("reports codex-only when Claude Code would read nothing", () => {
    write("AGENTS.md", "# Instructions");
    expect(classifyAgentDocs(dir)).toBe("codex-only");
  });

  it("reports unlinked when both are independent files", () => {
    write("AGENTS.md", "# Instructions");
    write("CLAUDE.md", "# Instructions, separately maintained");
    expect(classifyAgentDocs(dir)).toBe("unlinked");
  });

  it("reports paired for an @AGENTS.md import", () => {
    write("AGENTS.md", "# Instructions");
    write("CLAUDE.md", "@AGENTS.md\n\n## Claude Code\n\nUse plan mode for src/billing.\n");
    expect(classifyAgentDocs(dir)).toBe("paired");
  });

  it("reports paired for a symlink in either direction", () => {
    write("AGENTS.md", "# Instructions");
    fs.symlinkSync("AGENTS.md", path.join(dir, "CLAUDE.md"));
    expect(classifyAgentDocs(dir)).toBe("paired");
  });

  it("does not count an @AGENTS.md mentioned inside a code fence", () => {
    write("AGENTS.md", "# Instructions");
    write("CLAUDE.md", "Docs say to write:\n\n```\n@AGENTS.md\n```\n\nBut this file is its own doc.");
    expect(classifyAgentDocs(dir)).toBe("unlinked");
  });
});

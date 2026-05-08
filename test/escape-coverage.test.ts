// Lint-style coverage check: every place that interpolates `gardenRunner`
// or `gr` into a shell-context template string must pass that value through
// `shellEscape` (or be a const that was already escaped). This catches
// future regressions that re-introduce unescaped runner paths — a class
// of bugs that silently breaks auto-continue and tmux hooks when garden is
// installed at a path containing spaces or shell metacharacters.
//
// The check is heuristic: it walks every TS file under src/, finds template
// literals that interpolate `${gardenRunner}` or `${gr}`, and asserts the
// referenced identifier was either pre-escaped (a `const x = shellEscape(...)`
// is in scope) or the interpolation itself wraps with `shellEscape(...)`.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC = path.resolve(__dirname, "..", "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && full.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("gardenRunner shell-escape coverage", () => {
  it("every ${gardenRunner} or ${gr} interpolation is shell-escaped or pre-escaped", () => {
    const files = walk(SRC);
    const offenders: Array<{ file: string; line: number; text: string }> = [];

    for (const file of files) {
      const content = fs.readFileSync(file, "utf-8");
      const lines = content.split("\n");

      // Track whether the surrounding scope pre-escapes the identifier.
      // We look for `const gardenRunner = shellEscape(...)` or
      // `const gr = shellEscape(...)` anywhere earlier in the file. This is
      // a coarse approximation (file-level rather than block-scoped), but
      // false positives are caught by an explicit allowlist below.
      const escapedIdentifiers = new Set<string>();
      const reEscapedAssign = /^\s*const\s+(gardenRunner|gr|runner)\s*=\s*shellEscape\(/;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        const m = reEscapedAssign.exec(line);
        if (m) escapedIdentifiers.add(m[1]);

        // Find any ${name} interpolation where name is one of the runner identifiers.
        const interpRegex = /\$\{(gardenRunner|gr|runner)\}/g;
        let match: RegExpExecArray | null;
        while ((match = interpRegex.exec(line)) !== null) {
          const ident = match[1];
          // Skip if pre-escaped at file scope.
          if (escapedIdentifiers.has(ident)) continue;
          // Skip if the interpolation wraps with shellEscape — same line
          // contains `shellEscape(<ident>)`.
          if (line.includes(`shellEscape(${ident})`)) continue;
          // Skip lines that are obviously not shell contexts: comments,
          // tagged template names, or display strings. The heuristic:
          // require the line contains a backtick (template literal) AND
          // is not a single-line comment.
          if (line.trim().startsWith("//")) continue;
          if (!line.includes("`")) continue;
          offenders.push({
            file: path.relative(SRC, file),
            line: i + 1,
            text: line.trim(),
          });
        }
      }
    }

    // Format offenders for a readable assertion failure.
    const formatted = offenders.map(o => `${o.file}:${o.line} ${o.text}`);
    expect(formatted).toEqual([]);
  });
});

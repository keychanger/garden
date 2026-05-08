// Coverage check for the gardenRunner escape contract:
//
// `resolveGardenRunner()` returns a multi-token shell command line — an
// interpreter path followed by a script path, separated by a space. Each
// token is individually shell-escaped inside the helper, so the joined
// string interpolates safely into any shell context. Call sites MUST NOT
// re-wrap the value in `shellEscape(...)` — that would single-quote the
// whole multi-token string and turn it into a non-existent filename
// containing a literal space (the bug from commit 8d334f3 that broke the
// status pane, Claude Code hooks, auto-continue, and trellis menus
// silently — the shell printed `No such file or directory` for a path
// containing the space between `node` and the script).
//
// This test enforces the contract two ways:
//   1) A behavioral check: a synthetic runner with a path containing a
//      space round-trips through `bash -c` and produces the original
//      arguments — proving each token survives word-splitting.
//   2) A lint scan: no source file calls `shellEscape(gardenRunner)`,
//      `shellEscape(gr)`, or `shellEscape(runner)`. The fix moved escaping
//      into the helper; call sites interpolate raw.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { shellEscape } from "../src/dashboard/tmux.js";

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

describe("gardenRunner shell-escape contract", () => {
  it("a per-token-escaped multi-token runner survives bash word-splitting", () => {
    // Mirror what resolveGardenRunner() does: pre-escape each token
    // individually, join with a space. Use a path with a space so the
    // bug (single-quoting the joined string) would visibly fail.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-escape-test-"));
    try {
      const subdir = path.join(dir, "with space");
      fs.mkdirSync(subdir);
      const script = path.join(subdir, "echo.sh");
      fs.writeFileSync(script, '#!/bin/sh\necho "$@"\n', { mode: 0o755 });

      const runner = `${shellEscape("/bin/sh")} ${shellEscape(script)}`;
      const out = execFileSync(
        "bash",
        ["-c", `${runner} hello world`],
        { encoding: "utf-8" },
      ).trim();
      expect(out).toBe("hello world");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("no call site re-wraps gardenRunner / gr / runner in shellEscape", () => {
    const files = walk(SRC);
    const offenders: Array<{ file: string; line: number; text: string }> = [];

    for (const file of files) {
      const content = fs.readFileSync(file, "utf-8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim().startsWith("//")) continue;
        // The helper itself escapes each runner token before joining them.
        if (file.endsWith(`${path.sep}runner.ts`)) continue;
        if (/shellEscape\((gardenRunner|gr|runner)\)/.test(line)) {
          offenders.push({
            file: path.relative(SRC, file),
            line: i + 1,
            text: line.trim(),
          });
        }
      }
    }

    const formatted = offenders.map(o => `${o.file}:${o.line} ${o.text}`);
    expect(formatted).toEqual([]);
  });
});

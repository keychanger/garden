import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

// The pretty logs pane spends 59 columns on timestamp, project, and worker
// before the message, and it lives in a half-width dashboard pane. A static
// message longer than this wraps back to column 0 on a typical terminal.
const MAX_STATIC_MESSAGE_CHARS = 56;

const LOG_CALL = /log(?:\.(?:info|warn|error|debug)|\[\w+\])\(\s*(["'`])[^"'`]*\1,\s*(["'`])((?:\\.|(?!\2)[\s\S])*)\2/g;

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(full);
    return e.name.endsWith(".ts") ? [full] : [];
  });
}

describe("log messages", () => {
  it("keep their static text short enough to fit the logs pane", () => {
    const tooLong: string[] = [];
    for (const file of sourceFiles(path.resolve(__dirname, "../src"))) {
      const source = fs.readFileSync(file, "utf-8");
      for (const match of source.matchAll(LOG_CALL)) {
        const staticText = match[3].replace(/\$\{[^}]*\}/g, "");
        if (staticText.length > MAX_STATIC_MESSAGE_CHARS) tooLong.push(`${path.relative(process.cwd(), file)}: ${match[3]}`);
      }
    }
    expect(tooLong).toEqual([]);
  });
});

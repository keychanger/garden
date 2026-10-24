import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  CLEAR_HOLISTIC, FRESH_CI_FIX_CYCLE, FRESH_RESOLVE_CYCLE, FRESH_REVIEW_CYCLE,
} from "../src/dashboard/cycle-resets.js";

const SETS = { FRESH_REVIEW_CYCLE, FRESH_RESOLVE_CYCLE, FRESH_CI_FIX_CYCLE, CLEAR_HOLISTIC };
const SRC = path.resolve(__dirname, "../src");
const SETS_FILE = path.join(SRC, "dashboard", "cycle-resets.ts");

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return e.name.endsWith(".ts") ? [p] : [];
  });
}

describe("per-cycle reset sets", () => {
  it("name the fields of each cycle", () => {
    expect(Object.keys(FRESH_REVIEW_CYCLE).sort()).toEqual([
      "quotaRetryCount", "reviewFallbackHarness", "reviewRetryAt", "reviewRetryCount",
      "unparseableRetryCount", "unparseableReviewAt",
    ]);
    expect(Object.keys(FRESH_RESOLVE_CYCLE).sort()).toEqual(["lastResolveBody", "preResolveSha", "resolveAttempts"]);
    expect(Object.keys(FRESH_CI_FIX_CYCLE).sort()).toEqual([
      "ciFixAttempts", "failingCheckSummary", "lastCiFixBody", "preCiFixSha",
    ]);
    expect(Object.keys(CLEAR_HOLISTIC).sort()).toEqual(["holisticFinalActive", "holisticReviewMode"]);
  });

  it("are frozen, so a caller cannot change what every other site clears", () => {
    for (const set of Object.values(SETS)) expect(Object.isFrozen(set)).toBe(true);
  });

  // A site that clears a member by hand can leave the rest of the set behind,
  // which is how the one-shot unparseable marker leaked into later cycles.
  it("are the only way any source file clears one of their fields", () => {
    const clears = Object.entries(SETS).flatMap(([name, set]) =>
      Object.entries(set).map(([field, value]) => ({
        name,
        text: `${field}: ${String(value)}`,
        pattern: new RegExp(`(^|[^\\w.])${field}: ${String(value)}(?![\\w.])`),
      })));
    const handWritten: string[] = [];
    for (const file of sourceFiles(SRC)) {
      if (file === SETS_FILE) continue;
      fs.readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line)) return;
        for (const c of clears) {
          if (c.pattern.test(line)) handWritten.push(`${path.relative(SRC, file)}:${i + 1} ${c.text} (spread ${c.name})`);
        }
      });
    }
    expect(handWritten).toEqual([]);
  });
});

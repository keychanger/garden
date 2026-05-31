import { describe, it, expect } from "vitest";
import { parseLastLineVerdict } from "../src/dashboard/verdict.js";

const REVIEW_VOCAB = ["CLEAN", "FIXED", "FAILED"] as const;
const RESOLVE_VOCAB = ["DONE", "FAILED"] as const;

describe("parseLastLineVerdict", () => {
  it("returns the verdict and body when the verdict is on the last line", () => {
    const output = "Looks good.\nAll tests passed.\nCLEAN";
    const result = parseLastLineVerdict(output, REVIEW_VOCAB);
    expect(result).toEqual({
      verdict: "CLEAN",
      body: "Looks good.\nAll tests passed.",
    });
  });

  it("ignores trailing blank lines when finding the last non-empty line", () => {
    const output = "All good.\nCLEAN\n\n  \n";
    const result = parseLastLineVerdict(output, REVIEW_VOCAB);
    expect(result?.verdict).toBe("CLEAN");
    expect(result?.body).toBe("All good.");
  });

  it("matches verdicts with trailing punctuation", () => {
    const output = "Done.\nCLEAN.";
    expect(parseLastLineVerdict(output, REVIEW_VOCAB)?.verdict).toBe("CLEAN");
  });

  it("matches verdicts with trailing exclamation", () => {
    const output = "FIXED!";
    expect(parseLastLineVerdict(output, REVIEW_VOCAB)?.verdict).toBe("FIXED");
  });

  it("uppercases lowercase tokens before vocab match", () => {
    const output = "summary\nclean";
    expect(parseLastLineVerdict(output, REVIEW_VOCAB)?.verdict).toBe("CLEAN");
  });

  it("returns null for empty output", () => {
    expect(parseLastLineVerdict("", REVIEW_VOCAB)).toBeNull();
  });

  it("returns null for whitespace-only output", () => {
    expect(parseLastLineVerdict("   \n  \n\t\n", REVIEW_VOCAB)).toBeNull();
  });

  it("returns null when no token in the scan window matches the vocabulary", () => {
    const output = "INVALID\nUNKNOWN_VERDICT\nrandom text";
    expect(parseLastLineVerdict(output, REVIEW_VOCAB)).toBeNull();
  });

  it("walks back through the scan window to find a verdict", () => {
    const output = "Step 1 done.\nFIXED\nAdded a trailing summary that should be ignored.\nThe fix was small.";
    const result = parseLastLineVerdict(output, REVIEW_VOCAB);
    expect(result?.verdict).toBe("FIXED");
    expect(result?.body).toBe("Step 1 done.");
  });

  it("honors custom scanLines: a verdict outside the window is not found", () => {
    const output = ["Reasoning", "CLEAN", "more text", "trailing", "lines"].join("\n");
    // With scanLines=1, only the last non-empty line ("lines") is checked.
    expect(parseLastLineVerdict(output, REVIEW_VOCAB, { scanLines: 1 })).toBeNull();
  });

  it("honors scanLines: 1 for the resolver-style last-line-only contract", () => {
    const output = "Conflict resolved.\nDONE";
    const result = parseLastLineVerdict(output, RESOLVE_VOCAB, { scanLines: 1 });
    expect(result?.verdict).toBe("DONE");
    expect(result?.body).toBe("Conflict resolved.");
  });

  it("scanLines: 1 still skips trailing blank lines", () => {
    const output = "summary\nDONE\n\n\n";
    const result = parseLastLineVerdict(output, RESOLVE_VOCAB, { scanLines: 1 });
    expect(result?.verdict).toBe("DONE");
  });

  it("works with a single-element vocabulary", () => {
    const output = "PASS";
    expect(parseLastLineVerdict(output, ["PASS"] as const)?.verdict).toBe("PASS");
  });

  it("ignores tokens that aren't standalone (with extra content on the line)", () => {
    const output = "Result is CLEAN with caveats.";
    expect(parseLastLineVerdict(output, REVIEW_VOCAB)).toBeNull();
  });

  it("accepts a verdict decorated with an em-dash and trailing prose", () => {
    const output = "Reviewed the diff.\nCLEAN — no issues found, code is ready to merge as-is";
    const result = parseLastLineVerdict(output, REVIEW_VOCAB);
    expect(result?.verdict).toBe("CLEAN");
    expect(result?.body).toBe("Reviewed the diff.");
  });

  it("accepts a verdict decorated with a colon", () => {
    const output = "Summary above.\nFIXED: corrected the off-by-one in the loop";
    expect(parseLastLineVerdict(output, REVIEW_VOCAB)?.verdict).toBe("FIXED");
  });

  it("accepts a verdict decorated with a hyphen", () => {
    const output = "FAILED - the conflict could not be resolved";
    expect(parseLastLineVerdict(output, REVIEW_VOCAB)?.verdict).toBe("FAILED");
  });

  it("accepts a verdict decorated with an en-dash", () => {
    // The separator class carries both em-dash (—) and en-dash (–); this
    // pins the en-dash branch so it can't be dropped without a test failing.
    const output = "FAILED – the conflict could not be resolved";
    expect(parseLastLineVerdict(output, REVIEW_VOCAB)?.verdict).toBe("FAILED");
  });

  it("accepts a verdict decorated with a comma", () => {
    const output = "CLEAN, ready to merge";
    expect(parseLastLineVerdict(output, REVIEW_VOCAB)?.verdict).toBe("CLEAN");
  });

  it("accepts a decorated verdict with no space before the separator", () => {
    const output = "CLEAN—no issues";
    expect(parseLastLineVerdict(output, REVIEW_VOCAB)?.verdict).toBe("CLEAN");
  });

  it("decorated verdicts win on the resolver's scanLines: 1 contract", () => {
    const output = "Rebased onto main.\nDONE — HEAD is ready for merge";
    const result = parseLastLineVerdict(output, RESOLVE_VOCAB, { scanLines: 1 });
    expect(result?.verdict).toBe("DONE");
    expect(result?.body).toBe("Rebased onto main.");
  });

  it("does not misread prose that begins with a vocab word and a space", () => {
    // A separator/punctuation must follow the token — a plain word boundary
    // is not enough, so a sentence opening with a vocab word stays prose.
    const output = "Some reasoning.\nFIXED the bug by adding a guard clause.";
    expect(parseLastLineVerdict(output, REVIEW_VOCAB)).toBeNull();
  });

  it("does not misread a prose line beginning with a capitalized vocab word", () => {
    const output = "CLEAN code is the goal here and we are close.";
    expect(parseLastLineVerdict(output, REVIEW_VOCAB)).toBeNull();
  });

  it("returns empty body when verdict is the only content", () => {
    expect(parseLastLineVerdict("CLEAN", REVIEW_VOCAB)).toEqual({
      verdict: "CLEAN",
      body: "",
    });
  });

  it("preserves multi-line body content above the verdict", () => {
    const output = "Line 1\n\nLine 3 with blank above.\nFIXED";
    const result = parseLastLineVerdict(output, REVIEW_VOCAB);
    expect(result?.body).toBe("Line 1\n\nLine 3 with blank above.");
  });

  it("disambiguates between vocabularies (resolver vocab does not match CLEAN)", () => {
    const output = "Some text\nCLEAN";
    expect(parseLastLineVerdict(output, RESOLVE_VOCAB)).toBeNull();
  });

  it("does not match across the scan window when an earlier line matches", () => {
    // The scan walks BACK from the last non-empty line — the last verdict
    // wins, not the first.
    const output = "CLEAN\nintermediate text\nFAILED";
    expect(parseLastLineVerdict(output, REVIEW_VOCAB)?.verdict).toBe("FAILED");
  });
});

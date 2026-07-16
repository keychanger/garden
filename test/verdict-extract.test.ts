import { describe, it, expect } from "vitest";
import { selectVerdictFromResponse } from "../src/dashboard/verdict-extract.js";

const REVIEW_VOCAB = ["CLEAN", "FIXED", "FAILED"] as const;

describe("selectVerdictFromResponse", () => {
  it("returns the token for a compliant one-word answer", () => {
    expect(selectVerdictFromResponse("CLEAN", REVIEW_VOCAB)).toBe("CLEAN");
  });

  it("is case-insensitive", () => {
    expect(selectVerdictFromResponse("fixed", REVIEW_VOCAB)).toBe("FIXED");
  });

  it("tolerates surrounding whitespace and a trailing newline", () => {
    expect(selectVerdictFromResponse("  FAILED\n", REVIEW_VOCAB)).toBe("FAILED");
  });

  it("recovers the token from a lightly-decorated answer", () => {
    // Haiku occasionally ignores "one word only" and wraps the token.
    expect(selectVerdictFromResponse("The verdict is CLEAN.", REVIEW_VOCAB)).toBe("CLEAN");
  });

  it("returns null when the model escapes with UNKNOWN", () => {
    expect(selectVerdictFromResponse("UNKNOWN", REVIEW_VOCAB)).toBeNull();
  });

  it("returns null when no token is present", () => {
    expect(selectVerdictFromResponse("I could not determine the outcome.", REVIEW_VOCAB)).toBeNull();
  });

  it("returns null when the answer echoes more than one option (ambiguous)", () => {
    // Guard against a non-compliant reply that lists the choices back: better
    // to re-review than to merge on a coin-flip.
    const echoed = "It is one of CLEAN, FIXED, or FAILED depending on context.";
    expect(selectVerdictFromResponse(echoed, REVIEW_VOCAB)).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(selectVerdictFromResponse("", REVIEW_VOCAB)).toBeNull();
  });

  it("requires a whole-word match (a substring does not count)", () => {
    // "CLEANLY" must not be read as the CLEAN verdict.
    expect(selectVerdictFromResponse("The code reads cleanly and safely.", REVIEW_VOCAB)).toBeNull();
  });

  it("selects the single present token even alongside unrelated prose", () => {
    expect(
      selectVerdictFromResponse("Based on the reviewer's conclusion: FIXED", REVIEW_VOCAB),
    ).toBe("FIXED");
  });
});

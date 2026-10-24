import { describe, it, expect, vi } from "vitest";
import { spawnSync } from "node:child_process";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

import { extractReviewVerdict, selectVerdictFromResponse } from "../src/dashboard/verdict-extract.js";

// The reviewer's whole output on wolf/wild-mild-creek, 2026-09-24. The
// classifier ran on the same expired account, printed the same line, and the
// poller failed the worker on it as a code rejection.
const AUTH_FAILURE = "Failed to authenticate: OAuth session expired and could not be refreshed";

function claudeExits(status: number, stdout: string): void {
  vi.mocked(spawnSync).mockReturnValueOnce({
    status, signal: null, stdout, stderr: "", pid: 1, output: [],
  } as never);
}

describe("extractReviewVerdict", () => {
  it("names no verdict when the claude process fails, whatever it printed", () => {
    // A failed login is printed to stdout, and the process exits 1.
    claudeExits(1, `${AUTH_FAILURE}\n`);
    expect(extractReviewVerdict(AUTH_FAILURE)).toBeNull();
  });

  it("runs the classifier with every tool disabled", () => {
    claudeExits(0, "CLEAN\n");
    expect(extractReviewVerdict("Suite green; nothing to change.")).toBe("CLEAN");
    expect(spawnSync).toHaveBeenLastCalledWith(
      "claude", ["-p", "--model", "haiku", "--tools", ""], expect.any(Object),
    );
  });

  it("asks for UNKNOWN, not FAILED, when the reviewer never reached a conclusion", () => {
    claudeExits(0, "UNKNOWN\n");
    extractReviewVerdict(AUTH_FAILURE);
    const prompt = String(vi.mocked(spawnSync).mock.lastCall?.[2]?.input);
    const failedLine = prompt.split("\n").find(line => line.trim().startsWith("FAILED —"));
    expect(failedLine).toBeDefined();
    expect(failedLine).not.toMatch(/could not finish/i);
    expect(prompt).toMatch(/error[^\n]*\n?[^\n]*UNKNOWN/i);
  });
});

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

  it("returns null for an UNKNOWN whose explanation uses a verdict word", () => {
    // "failed" here describes the reviewer, it is not the FAILED verdict.
    expect(
      selectVerdictFromResponse("UNKNOWN: the reviewer failed to authenticate.", REVIEW_VOCAB),
    ).toBeNull();
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

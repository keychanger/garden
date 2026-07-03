import { describe, it, expect } from "vitest";
import {
  TRELLIS_VERDICTS,
  parseTrellisVerdict,
  parseDriftList,
  parseFlaggedClauses,
  renderDriftItem,
} from "../src/dashboard/trellis-verdict.js";

describe("parseTrellisVerdict", () => {
  it("returns the verdict and body for ALIGNED", () => {
    const out = "Reviewed everything; all claims present.\nALIGNED";
    const r = parseTrellisVerdict(out);
    expect(r?.verdict).toBe("ALIGNED");
    expect(r?.body).toContain("all claims present");
  });

  it("returns the verdict for DRIFT with a body", () => {
    const out = "1. [surface] foo missing\n2. [tests] none\nDRIFT";
    const r = parseTrellisVerdict(out);
    expect(r?.verdict).toBe("DRIFT");
    expect(r?.body).toContain("foo missing");
  });

  it("returns FLAGGED when reviewer cites a contradiction", () => {
    const out = "Trellis line 47 contradicts line 91.\nFLAGGED";
    const r = parseTrellisVerdict(out);
    expect(r?.verdict).toBe("FLAGGED");
  });

  it("returns FAILED for unrecoverable code failures", () => {
    const out = "Tests failed and I cannot fix them.\nFAILED";
    const r = parseTrellisVerdict(out);
    expect(r?.verdict).toBe("FAILED");
  });

  it("returns null when the verdict line is unrecognized", () => {
    expect(parseTrellisVerdict("body text only")).toBeNull();
    // CLEAN/FIXED are NOT trellis verdicts — they belong to default.
    expect(parseTrellisVerdict("body\nCLEAN")).toBeNull();
  });

  it("does not read an 'Aligned: N' claim tally as the ALIGNED verdict", () => {
    // A reviewer that enumerates a tally but omits the verdict line must NOT
    // falsely converge the vine — the tally is scrubbed, leaving no verdict.
    expect(parseTrellisVerdict("Reviewed.\nAligned: 4")).toBeNull();
    expect(parseTrellisVerdict("Aligned:4")).toBeNull();
    expect(parseTrellisVerdict("aligned: 3")).toBeNull();
    expect(parseTrellisVerdict("Aligned: 4 / Partial: 1 / Absent: 2")).toBeNull();
    expect(parseTrellisVerdict("Aligned: 4\nPartial: 1\nAbsent: 2")).toBeNull();
  });

  it("keeps a genuine ALIGNED verdict that carries a digit-decorated tail", () => {
    // "ALIGNED: 0 drift" is a real verdict (a word follows the number), not a
    // tally (bare number then end-of-line or a `/`). It must survive. (Only ':'
    // is a VERDICT_LINE separator, so '=' forms never parse as ALIGNED at all.)
    expect(parseTrellisVerdict("ALIGNED: 0 drift").verdict).toBe("ALIGNED");
    expect(parseTrellisVerdict("ALIGNED: 7 present").verdict).toBe("ALIGNED");
    expect(parseTrellisVerdict("ALIGNED — matches spec").verdict).toBe("ALIGNED");
    expect(parseTrellisVerdict("ALIGNED: everything present").verdict).toBe("ALIGNED");
  });

  it("recovers a real verdict sitting above a trailing tally line", () => {
    // Scrubbing the tally exposes the genuine verdict beneath it rather than
    // returning the tally-as-ALIGNED.
    const r = parseTrellisVerdict("1. [surface] foo missing\nDRIFT\nAligned: 3");
    expect(r?.verdict).toBe("DRIFT");
  });

  it("leaves a normal DRIFT with a tally above it fully intact", () => {
    // The guard is ALIGNED-scoped, so the DRIFT alignedCount pipeline (a tally
    // ABOVE the DRIFT verdict) keeps its body and count.
    const r = parseTrellisVerdict("Aligned: 7\n1. [surface] foo (trellis line 5)\nDRIFT");
    expect(r?.verdict).toBe("DRIFT");
    expect(r?.body).toContain("Aligned: 7");
  });

  it("vocabulary contains exactly the four trellis verdicts", () => {
    expect([...TRELLIS_VERDICTS].sort()).toEqual(
      ["ALIGNED", "DRIFT", "FAILED", "FLAGGED"].sort(),
    );
  });
});

describe("parseDriftList", () => {
  it("parses numbered bullets with [tag] body and (trellis line N) citation", () => {
    const body = `Aligned: 7

1. [surface] \`foo()\` missing the timeout option (trellis line 47)
2. [tests] no test for the timeout behavior (trellis line 91)
3. [docs] CLAUDE.md unchanged; trellis line 122 requires update`;
    const r = parseDriftList(body);
    expect(r.items).toHaveLength(3);
    expect(r.items[0].tag).toBe("surface");
    expect(r.items[0].body).toContain("foo()");
    expect(r.items[0].body).not.toContain("trellis line 47");
    expect(r.items[0].line).toBe(47);
    expect(r.items[1].tag).toBe("tests");
    expect(r.items[1].line).toBe(91);
    expect(r.items[2].tag).toBe("docs");
    expect(r.alignedCount).toBe(7);
  });

  it("tolerates loose formatting (parens, indentation, missing line citation)", () => {
    const body = `2) [behavior]   error path returns wrong shape
   3) [tests] no error-path test`;
    const r = parseDriftList(body);
    expect(r.items).toHaveLength(2);
    expect(r.items[0].tag).toBe("behavior");
    expect(r.items[0].line).toBeUndefined();
    expect(r.items[1].tag).toBe("tests");
  });

  it("returns null when no numbered bullets are present (zero-item refusal)", () => {
    // A DRIFT with no parseable bullets must not yield an empty list — the
    // caller would seed a "none reported" continue prompt and invite a false
    // convergence. null forces the caller onto its prose-fallback route.
    expect(parseDriftList("just some prose, no drift items")).toBeNull();
    expect(parseDriftList("Aligned: 5")).toBeNull();
    expect(parseDriftList("prose line one\nprose line two")).toBeNull();
  });

  it("recognizes 'N aligned' phrasing too", () => {
    const r = parseDriftList("3 aligned items.\n\n1. [surface] foo");
    expect(r.alignedCount).toBe(3);
    expect(r.items).toHaveLength(1);
  });
});

describe("parseFlaggedClauses", () => {
  it("extracts cited line numbers from FLAGGED body", () => {
    const body = "Trellis line 47 says X. Trellis line 91 says NOT X. (trellis line 122) is also affected.";
    const clauses = parseFlaggedClauses(body);
    expect(clauses).toEqual(["trellis line 47", "trellis line 91", "trellis line 122"]);
  });

  it("dedupes repeat citations", () => {
    const body = "trellis line 47 ... again, trellis line 47 conflicts.";
    expect(parseFlaggedClauses(body)).toEqual(["trellis line 47"]);
  });

  it("returns empty when no citations", () => {
    expect(parseFlaggedClauses("no citations here")).toEqual([]);
  });
});

describe("renderDriftItem", () => {
  it("renders with line citation when present", () => {
    expect(renderDriftItem({ tag: "surface", body: "foo missing", line: 47, raw: "" }, 0))
      .toBe("1. [surface] foo missing (trellis line 47)");
  });

  it("renders without line citation when absent", () => {
    expect(renderDriftItem({ tag: "tests", body: "no test", raw: "" }, 1))
      .toBe("2. [tests] no test");
  });
});

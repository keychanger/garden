import { describe, it, expect } from "vitest";
import { needsJudging, parseVerdict } from "../src/dashboard/judge.js";

describe("needsJudging", () => {
  it("skips plain commands with no shell metacharacters", () => {
    expect(needsJudging("ls")).toBe(false);
    expect(needsJudging("git status")).toBe(false);
    expect(needsJudging("npm test")).toBe(false);
    expect(needsJudging("node dist/cli.js foo bar")).toBe(false);
    expect(needsJudging("pwd")).toBe(false);
  });

  it("requires judgment for command substitution", () => {
    expect(needsJudging('echo "$(whoami)"')).toBe(true);
    expect(needsJudging("echo `date`")).toBe(true);
  });

  it("requires judgment for redirects and pipes", () => {
    expect(needsJudging("cat foo > bar")).toBe(true);
    expect(needsJudging('cat > "$TMPDIR/preview.mjs"')).toBe(true);
    expect(needsJudging("ls | wc -l")).toBe(true);
    expect(needsJudging("echo hi < input")).toBe(true);
  });

  it("requires judgment for logical operators and sequencing", () => {
    expect(needsJudging("npm test && npm run build")).toBe(true);
    expect(needsJudging("foo; bar")).toBe(true);
    expect(needsJudging("foo || bar")).toBe(true);
  });

  it("requires judgment for variable expansion and globbing", () => {
    expect(needsJudging("echo $HOME")).toBe(true);
    expect(needsJudging("rm *.tmp")).toBe(true);
    expect(needsJudging("ls ?oo")).toBe(true);
  });

  it("requires judgment for subshells and brace groups", () => {
    expect(needsJudging("(cd foo && ls)")).toBe(true);
    expect(needsJudging("{ echo a; echo b; }")).toBe(true);
  });

  it("handles empty input", () => {
    expect(needsJudging("")).toBe(false);
  });
});

describe("parseVerdict", () => {
  it("parses a well-formed allow verdict", () => {
    const v = parseVerdict('{"decision":"allow","reason":"plain file write"}');
    expect(v.decision).toBe("allow");
    expect(v.reason).toBe("plain file write");
  });

  it("parses a well-formed uncertain verdict", () => {
    const v = parseVerdict('{"decision":"uncertain","reason":"unclear target"}');
    expect(v.decision).toBe("uncertain");
  });

  it("extracts JSON from surrounding text", () => {
    const text = 'Sure! Here is the verdict:\n{"decision":"allow","reason":"safe"}\nEnd.';
    const v = parseVerdict(text);
    expect(v.decision).toBe("allow");
  });

  it("falls back to uncertain on no JSON", () => {
    const v = parseVerdict("this is just prose");
    expect(v.decision).toBe("uncertain");
  });

  it("falls back to uncertain on malformed JSON", () => {
    const v = parseVerdict('{"decision": "allow"'); // missing brace
    expect(v.decision).toBe("uncertain");
  });

  it("rejects invalid decision field values", () => {
    const v = parseVerdict('{"decision":"deny","reason":"nope"}');
    expect(v.decision).toBe("uncertain");
  });

  it("rejects non-object JSON", () => {
    const v = parseVerdict('["allow"]');
    expect(v.decision).toBe("uncertain");
  });

  it("truncates long reason strings", () => {
    const long = "a".repeat(500);
    const v = parseVerdict(`{"decision":"allow","reason":"${long}"}`);
    expect(v.reason.length).toBeLessThanOrEqual(120);
  });

  it("handles missing reason field gracefully", () => {
    const v = parseVerdict('{"decision":"allow"}');
    expect(v.decision).toBe("allow");
    expect(v.reason).toBe("");
  });
});

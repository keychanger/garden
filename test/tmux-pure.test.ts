import { describe, it, expect } from "vitest";
import { shellEscape } from "../src/dashboard/tmux.js";

describe("shellEscape", () => {
  it("passes through simple alphanumeric strings", () => {
    expect(shellEscape("hello")).toBe("hello");
    expect(shellEscape("test123")).toBe("test123");
  });

  it("passes through paths with safe characters", () => {
    expect(shellEscape("/usr/local/bin")).toBe("/usr/local/bin");
    expect(shellEscape("file.txt")).toBe("file.txt");
    expect(shellEscape("my-file_v2")).toBe("my-file_v2");
    expect(shellEscape("key=value")).toBe("key=value");
    expect(shellEscape("host:port")).toBe("host:port");
  });

  it("wraps strings with spaces in single quotes", () => {
    expect(shellEscape("hello world")).toBe("'hello world'");
  });

  it("escapes embedded single quotes", () => {
    expect(shellEscape("it's")).toBe("'it'\\''s'");
  });

  it("handles empty string", () => {
    expect(shellEscape("")).toBe("''");
  });

  it("wraps strings with special shell characters", () => {
    expect(shellEscape("$HOME")).toBe("'$HOME'");
    expect(shellEscape("a;b")).toBe("'a;b'");
    expect(shellEscape("a|b")).toBe("'a|b'");
    expect(shellEscape("a&b")).toBe("'a&b'");
  });

  it("wraps backtick command substitution", () => {
    expect(shellEscape("`whoami`")).toBe("'`whoami`'");
  });

  it("wraps double quotes", () => {
    expect(shellEscape('foo"bar')).toBe("'foo\"bar'");
  });

  it("wraps parentheses and braces", () => {
    expect(shellEscape("(cmd)")).toBe("'(cmd)'");
    expect(shellEscape("{a,b}")).toBe("'{a,b}'");
  });

  it("wraps strings with newlines", () => {
    expect(shellEscape("foo\nbar")).toBe("'foo\nbar'");
  });

  it("wraps backslash sequences", () => {
    expect(shellEscape("foo\\bar")).toBe("'foo\\bar'");
  });

  it("wraps tab characters", () => {
    expect(shellEscape("foo\tbar")).toBe("'foo\tbar'");
  });

  it("handles combined injection attempt", () => {
    const payload = "'; rm -rf /; echo '";
    const result = shellEscape(payload);
    // Must not be executable as a command — verify it's properly quoted
    expect(result).toContain("'\\''");
    // Round-trip: the shell would interpret this as the literal input string
    expect(result.startsWith("'")).toBe(true);
    expect(result.endsWith("'")).toBe(true);
  });
});

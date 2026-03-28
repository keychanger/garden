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
});

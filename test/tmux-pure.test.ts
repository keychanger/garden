import { describe, it, expect } from "vitest";
import { shellEscape, tmuxLiteral, menuRunShell, promptArgv, promptCommand } from "../src/dashboard/tmux.js";

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

describe("tmuxLiteral", () => {
  it("doubles every #, so one format pass yields the text unchanged", () => {
    expect(tmuxLiteral("a #(id) #{x} #[fg=red] ## b")).toBe("a ##(id) ##{x} ##[fg=red] #### b");
    expect(tmuxLiteral("plain")).toBe("plain");
  });
});

describe("menuRunShell", () => {
  // run-shell expands its command as a format before /bin/sh sees it.
  it("escapes # for run-shell's own format pass", () => {
    expect(menuRunShell("garden x 'b#(id)'")).toBe("run-shell \"garden x 'b##(id)'\"");
  });
});

describe("promptArgv", () => {
  it("stores the reply in an option and names the route that reads it", () => {
    const argv = promptArgv("Seed: ", "garden", ["_grow-plant", "proj"]);
    // tmux appends a space to the label itself.
    expect(argv).toEqual([
      "command-prompt", "-p", "Seed:",
      "set-option -g @garden_prompt_reply \"%%%\" ; run-shell \"garden dashboard _prompt-reply _grow-plant proj\"",
    ]);
  });

  it("escapes a pre-fill, which tmux expands as a format", () => {
    const argv = promptArgv("f: ", "garden", ["_logs-filter-apply"], "w:a #(id) b");
    expect(argv.slice(3, 5)).toEqual(["-I", "w:a ##(id) b"]);
  });
});

describe("promptCommand", () => {
  it("quotes only the arguments that need it", () => {
    expect(promptCommand("Crew name: ", "garden", ["_crew-save", "proj"])).toBe(
      "command-prompt -p \"Crew name:\" "
      + "\"set-option -g @garden_prompt_reply \\\"%%%\\\" ; run-shell \\\"garden dashboard _prompt-reply _crew-save proj\\\"\"",
    );
  });
});

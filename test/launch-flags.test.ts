// The one flag parser behind `workers new` / `grow`, `garden handoff` and
// `garden crew add` / `edit`, and the per-harness `--effort` vocabulary the two
// spawn commands read. The commands' own suites cover each at its boundary;
// these pin the rules every one of them inherits.
import { describe, it, expect } from "vitest";
import { parseFlags, parseEffortFlag, type FlagTable } from "../src/commands/launch-flags.js";

const TABLE: FlagTable = {
  values: ["--model", "--effort", "-m"],
  switches: ["--ultracode"],
  opaque: ["-m"],
};

describe("parseFlags", () => {
  it("splits values and switches, trimming every value but an opaque one", () => {
    const { flags, positional } = parseFlags(["--model", " opus ", "--ultracode", "-m", "  as typed  "], TABLE);
    expect(Object.fromEntries(flags)).toEqual({ "--model": "opus", "--ultracode": "", "-m": "  as typed  " });
    expect(positional).toEqual([]);
  });

  it("refuses an unknown option, naming the ones the command takes", () => {
    expect(() => parseFlags(["--modle", "opus"], TABLE))
      .toThrow("Unknown or repeated option '--modle'. Supported once each: --ultracode, --model, --effort, -m.");
  });

  it("refuses a repeated option rather than keeping one of its values", () => {
    expect(() => parseFlags(["--model", "opus", "--model", "sonnet"], TABLE))
      .toThrow(/^Unknown or repeated option '--model'/);
    expect(() => parseFlags(["--ultracode", "--ultracode"], TABLE))
      .toThrow(/^Unknown or repeated option '--ultracode'/);
  });

  it.each([
    [["--model"]],
    [["--model", "--effort", "high"]],
    [["--model", "-m", "msg"]],
    [["--model", " --ultracode"]],
    [["--model", "-x"]],
    [["--model", ""]],
    [["--model", "   "]],
  ])("refuses %j as an option with no value", (args) => {
    expect(() => parseFlags(args, TABLE)).toThrow(/^--model requires a value$/);
  });

  it("keeps an opaque value exactly as given, even one that reads like an option", () => {
    expect(parseFlags(["-m", "--model"], TABLE).flags.get("-m")).toBe("--model");
    expect(parseFlags(["-m", ""], TABLE).flags.get("-m")).toBe("");
    expect(() => parseFlags(["-m"], TABLE)).toThrow(/^-m requires a value$/);
  });

  it("refuses a bare argument unless the table allows them", () => {
    expect(() => parseFlags(["stray"], TABLE)).toThrow(/^Unknown or repeated option 'stray'/);
    expect(() => parseFlags(["-x"], TABLE)).toThrow(/^Unknown or repeated option '-x'/);
    const open = { ...TABLE, positional: true };
    expect(parseFlags(["proj", "-x", "--model", "opus", "more"], open).positional).toEqual(["proj", "-x", "more"]);
    expect(() => parseFlags(["proj", "--bogus", "x"], open)).toThrow(/^Unknown or repeated option '--bogus'/);
  });

  it("words its refusals from the table when it says how", () => {
    const table: FlagTable = { ...TABLE, usage: "--model <m>", missing: { "--model": "--model needs a model id." } };
    expect(() => parseFlags(["--nope"], table)).toThrow("Supported once each: --model <m>.");
    expect(() => parseFlags(["--model"], table)).toThrow(/^--model needs a model id\.$/);
    expect(() => parseFlags(["--effort"], table)).toThrow(/^--effort requires a value$/);
  });
});

describe("parseEffortFlag", () => {
  it("reads claude-code's rungs, where ultra is the ultracode preset", () => {
    expect(parseEffortFlag("xhigh", "claude-code")).toEqual({ effort: "xhigh" });
    expect(parseEffortFlag(" ultra ", "claude-code")).toEqual({ ultracode: true });
    expect(() => parseEffortFlag("max", "claude-code"))
      .toThrow("--effort must be one of: low, medium, high, xhigh, ultra for a claude-code worker, got 'max'");
  });

  it("reads Codex's ladder, max included, where its own ultra is a plain rung", () => {
    expect(parseEffortFlag("max", "codex")).toEqual({ effort: "max" });
    expect(parseEffortFlag("ultra", "codex")).toEqual({ effort: "ultra" });
    expect(() => parseEffortFlag("turbo", "codex"))
      .toThrow("--effort must be one of: low, medium, high, xhigh, max, ultra for a codex worker, got 'turbo'");
  });
});

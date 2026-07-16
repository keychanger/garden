// The shared display-menu primitive's argv builder. The load-bearing detail is
// arity: a separator is ONE token (empty name), a normal row is three
// (label, key, command). Pure, so no tmux is driven.
import { describe, it, expect } from "vitest";
import { buildMenuArgv } from "../src/dashboard/menu.js";
import { menuRunShell } from "../src/dashboard/tmux.js";

describe("buildMenuArgv", () => {
  it("opens with the centered display-menu flags and the title", () => {
    const argv = buildMenuArgv({ title: "My Menu", rows: [] });
    expect(argv).toEqual(["display-menu", "-O", "-T", "My Menu", "-x", "C", "-y", "C"]);
  });

  it("emits three tokens for a normal row (label, key, command)", () => {
    const argv = buildMenuArgv({ title: "t", rows: [{ label: "Do it", key: "d", tmux: "run-shell true" }] });
    expect(argv.slice(-3)).toEqual(["Do it", "d", "run-shell true"]);
  });

  it("emits a SINGLE token for a separator (empty name)", () => {
    const argv = buildMenuArgv({
      title: "t",
      rows: [{ label: "A", key: "a", tmux: "x" }, { sep: true, label: "" }, { label: "B", key: "b", tmux: "y" }],
    });
    // 8 base flags + 3 (row A) + 1 (separator) + 3 (row B) = 15
    expect(argv).toHaveLength(15);
    expect(argv.slice(8)).toEqual(["A", "a", "x", "", "B", "b", "y"]);
  });

  it("wraps a `run` shell command via menuRunShell and defaults an absent key to ''", () => {
    const argv = buildMenuArgv({ title: "t", rows: [{ label: "R", run: "garden dashboard _x" }] });
    expect(argv.slice(-3)).toEqual(["R", "", menuRunShell("garden dashboard _x")]);
  });

  it("prefers a raw `tmux` command over `run`", () => {
    const argv = buildMenuArgv({ title: "t", rows: [{ label: "R", tmux: "command-prompt -p x", run: "ignored" }] });
    expect(argv.slice(-1)).toEqual(["command-prompt -p x"]);
  });
});

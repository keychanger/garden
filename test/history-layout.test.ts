import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HISTORY_LAYOUT_AWK, HISTORY_PIN_SEPARATOR } from "../src/dashboard/header.js";

describe("HISTORY_LAYOUT_AWK", () => {
  // Runs the real awk program the pane uses, at a given pane height.
  function layout(pin: string[], body: string[], rows: number): string[] {
    const file = path.join(os.tmpdir(), `garden-history-layout-${process.pid}.txt`);
    fs.writeFileSync(file, [...pin, HISTORY_PIN_SEPARATOR, ...body].join("\n"));
    try {
      return execFileSync("awk", ["-v", `rows=${rows}`, HISTORY_LAYOUT_AWK, file]).toString()
        .replace(/\x1b\[[0-9;]*m/g, "").split("\n");
    } finally {
      fs.rmSync(file, { force: true });
    }
  }
  const pin = ["─ opening ask ─", " p1", " p2", " p3", "───"];
  const body = Array.from({ length: 12 }, (_, i) => `b${i + 1}`);

  it("keeps the block above the newest lines that fill the screen, everything earlier above it", () => {
    const out = layout(pin, body, 10);
    // The bottom 10 rows are what the pane shows: the whole block, then b8..b12.
    expect(out.slice(-10)).toEqual([...pin, "b8", "b9", "b10", "b11", "b12"]);
    // b1..b7 print first, so they scroll into tmux history.
    expect(out.slice(0, 7)).toEqual(body.slice(0, 7));
  });

  it("caps a long opening ask at 60% of the pane and says how much is hidden", () => {
    const out = layout(pin, body, 6);
    expect(out.slice(-6)).toEqual(["─ opening ask ─", " p1", " … 2 more lines · scroll to the top, or ⌥i h", "───", "b11", "b12"]);
  });

  it("prints the block then the whole conversation when the height is unknown", () => {
    expect(layout(pin, body, 0)).toEqual([...pin, ...body]);
  });

  it("prints only the conversation when there is no opening ask", () => {
    expect(layout([], ["no conversation yet"], 10)).toEqual(["no conversation yet"]);
  });
});

import { describe, it, expect } from "vitest";
import {
  parseHistoryDoc,
  headerLines,
  settle,
  scroll,
  frameLines,
  parseInput,
  HISTORY_PIN_SEPARATOR,
  type HistoryDoc,
} from "../src/dashboard/history-view.js";

const plain = (lines: string[]) => lines.map(l => l.replace(/\x1b\[[0-9;]*m/g, ""));

function doc(pinLines: number, bodyLines: number): HistoryDoc {
  return {
    pin: Array.from({ length: pinLines }, (_, i) => `pin${i + 1}`),
    body: Array.from({ length: bodyLines }, (_, i) => `line${i + 1}`),
  };
}

describe("parseHistoryDoc", () => {
  it("splits the opening ask from the conversation at the separator line", () => {
    const text = ["ask1", "ask2", HISTORY_PIN_SEPARATOR, "a", "b"].join("\n");
    expect(parseHistoryDoc(text)).toEqual({ pin: ["ask1", "ask2"], body: ["a", "b"] });
  });

  it("treats a file without a separator as conversation only", () => {
    expect(parseHistoryDoc("no active worker")).toEqual({ pin: [], body: ["no active worker"] });
  });
});

describe("headerLines", () => {
  it("keeps an opening ask that fits within 60% of the pane", () => {
    expect(headerLines(doc(6, 0).pin, 10)).toEqual(doc(6, 0).pin);
  });

  it("cuts a longer ask to its head, a pointer counting the hidden lines, and its closing rule", () => {
    const lines = plain(headerLines(doc(9, 0).pin, 10));
    expect(lines).toEqual(["pin1", "pin2", "pin3", "pin4", " … 4 more lines · ⌥i h for the full prompt", "pin9"]);
  });
});

describe("frameLines", () => {
  it("holds the opening ask above the newest lines when following", () => {
    const d = doc(3, 20);
    const pos = settle({ top: 0, follow: true }, d, 10);
    expect(frameLines(d, pos, 10)).toEqual(["pin1", "pin2", "pin3", ...d.body.slice(13)]);
  });

  it("keeps the opening ask on screen after scrolling to the start", () => {
    const d = doc(3, 20);
    const pos = scroll({ top: 0, follow: true }, "top", d, 10);
    const lines = plain(frameLines(d, pos, 10));
    expect(lines.slice(0, 9)).toEqual(["pin1", "pin2", "pin3", "line1", "line2", "line3", "line4", "line5", "line6"]);
    expect(lines[9]).toBe(" ↓ 14 more lines below · G or scroll down for the newest");
  });

  it("shows a short conversation whole with no indicator", () => {
    const d = doc(2, 3);
    expect(frameLines(d, settle({ top: 0, follow: true }, d, 10), 10)).toEqual(["pin1", "pin2", "line1", "line2", "line3"]);
  });
});

describe("scrolling", () => {
  it("stops following when scrolled up and resumes at the bottom", () => {
    const d = doc(3, 20);
    const up = scroll({ top: 0, follow: true }, { by: -3, unit: "line" }, d, 10);
    expect(up).toEqual({ top: 10, follow: false });
    expect(scroll(up, { by: 3, unit: "line" }, d, 10)).toEqual({ top: 13, follow: true });
  });

  it("pages by the rows under the header", () => {
    const d = doc(3, 40);
    expect(scroll({ top: 0, follow: true }, { by: -1, unit: "page" }, d, 10)).toEqual({ top: 26, follow: false });
    expect(scroll({ top: 0, follow: true }, { by: -0.5, unit: "page" }, d, 10)).toEqual({ top: 29, follow: false });
  });

  it("clamps at both ends", () => {
    const d = doc(3, 20);
    expect(scroll({ top: 2, follow: false }, { by: -10, unit: "line" }, d, 10)).toEqual({ top: 0, follow: false });
    expect(scroll({ top: 2, follow: false }, "bottom", d, 10)).toEqual({ top: 13, follow: true });
  });

  it("keeps a scrolled-up position when the conversation grows, and follows new lines at the bottom", () => {
    const grown = doc(3, 25);
    expect(settle({ top: 5, follow: false }, grown, 10)).toEqual({ top: 5, follow: false });
    expect(settle({ top: 13, follow: true }, grown, 10)).toEqual({ top: 18, follow: true });
  });

  it("re-clamps a position past the end after the pane grows", () => {
    expect(settle({ top: 13, follow: false }, doc(3, 20), 20)).toEqual({ top: 3, follow: true });
  });
});

describe("parseInput", () => {
  it("reads SGR wheel reports, modified or not, and ignores clicks", () => {
    expect(parseInput("\x1b[<64;10;5M\x1b[<65;10;5M\x1b[<80;1;1M\x1b[<0;3;4M\x1b[<0;3;4m")).toEqual([
      { by: -3, unit: "line" },
      { by: 3, unit: "line" },
      { by: -3, unit: "line" },
    ]);
  });

  it("reads arrows, paging keys, and vi-style letters", () => {
    expect(parseInput("\x1b[A\x1bOB\x1b[5~\x1b[6~kjg G")).toEqual([
      { by: -1, unit: "line" },
      { by: 1, unit: "line" },
      { by: -1, unit: "page" },
      { by: 1, unit: "page" },
      { by: -1, unit: "line" },
      { by: 1, unit: "line" },
      "top",
      { by: 1, unit: "page" },
      "bottom",
    ]);
  });

  it("skips unhandled escape sequences whole so their final letter is not a key", () => {
    // Ctrl+Right ends in C, a focus-out report in O; neither should act.
    expect(parseInput("\x1b[1;5C\x1b[O\x1b[1;5D")).toEqual([]);
    expect(parseInput("\x1b[1;2Bj")).toEqual([{ by: 1, unit: "line" }]);
  });
});

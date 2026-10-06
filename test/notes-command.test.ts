import { describe, it, expect, vi, beforeEach } from "vitest";
import { captureConsoleLog } from "./helpers.js";
import type { ReviewNote } from "../src/dashboard/review-notes.js";

const h = vi.hoisted(() => ({ isTTY: true, notes: [] as ReviewNote[] }));

vi.mock("../src/output.js", () => ({
  output: vi.fn(),
  get isTTY() { return h.isTTY; },
}));
vi.mock("../src/config.js", () => ({
  resolveProjectFromArgs: (args: string[]) => ({
    project: { name: "wolf", path: "/repo/wolf" },
    remainingArgs: args[0] === "wolf" ? args.slice(1) : args,
  }),
}));
vi.mock("../src/dashboard/review-notes.js", () => ({
  readReviewNotes: vi.fn(() => h.notes),
  clearReviewNotes: vi.fn(),
}));

import { notes } from "../src/commands/notes.js";
import { output } from "../src/output.js";
import { clearReviewNotes, readReviewNotes } from "../src/dashboard/review-notes.js";

const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
const note: ReviewNote = {
  at: "2026-10-06T12:00:00Z", project: "wolf", worker: "cold-brash-lark",
  branch: "cold-brash-lark", verdict: "clean", notes: "- latch cites no incident\n- pinned test",
};

beforeEach(() => {
  h.isTTY = true;
  h.notes = [];
  vi.clearAllMocks();
});

describe("garden notes", () => {
  it("prints each note under its worker, branch and verdict", async () => {
    h.notes = [note];
    const text = (await captureConsoleLog(() => notes(["wolf"]))).map(strip).join("\n");
    expect(readReviewNotes).toHaveBeenCalledWith("wolf");
    expect(text).toContain("cold-brash-lark (cold-brash-lark) clean");
    expect(text).toContain("    - latch cites no incident");
    expect(text).toContain("    - pinned test");
  });

  it("says so when there are none", async () => {
    const text = (await captureConsoleLog(() => notes(["wolf"]))).map(strip).join("\n");
    expect(text).toContain("No review notes for wolf.");
  });

  it("emits JSON when piped", async () => {
    h.isTTY = false;
    h.notes = [note];
    await notes(["wolf"]);
    expect(output).toHaveBeenCalledWith({ project: "wolf", notes: [note] });
  });

  it("clears on --clear", async () => {
    const text = (await captureConsoleLog(() => notes(["wolf", "--clear"]))).join("\n");
    expect(clearReviewNotes).toHaveBeenCalledWith("wolf");
    expect(text).toContain("cleared");
  });
});

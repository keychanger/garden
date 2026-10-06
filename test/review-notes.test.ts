import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { useTmpHome } from "./helpers.js";

const addAlert = vi.hoisted(() => vi.fn());
vi.mock("../src/dashboard/alerts.js", () => ({ addAlert }));

describe("extractNonBlockingNotes", () => {
  it("returns the section between the heading and the end of the body", async () => {
    const { extractNonBlockingNotes } = await import("../src/dashboard/review-notes.js");
    const body = [
      "Checks pass. Diff is fine.",
      "",
      "Non-blocking notes:",
      "- New retry latch in sync.ts cites no incident.",
      "- Test pins the call order of fetch helpers.",
    ].join("\n");
    expect(extractNonBlockingNotes(body)).toBe(
      "- New retry latch in sync.ts cites no incident.\n- Test pins the call order of fetch helpers.",
    );
  });

  it("returns null when the section is absent", async () => {
    const { extractNonBlockingNotes } = await import("../src/dashboard/review-notes.js");
    expect(extractNonBlockingNotes("Looks good, nothing to add.")).toBeNull();
    expect(extractNonBlockingNotes("")).toBeNull();
  });

  it("accepts markdown-decorated headings and inline content", async () => {
    const { extractNonBlockingNotes } = await import("../src/dashboard/review-notes.js");
    expect(extractNonBlockingNotes("## Non-blocking notes\n- a")).toBe("- a");
    expect(extractNonBlockingNotes("**Non-blocking notes:**\n- b")).toBe("- b");
    expect(extractNonBlockingNotes("non blocking notes: one guard without an incident")).toBe(
      "one guard without an incident",
    );
  });

  it("treats an empty or 'none' section as no notes", async () => {
    const { extractNonBlockingNotes } = await import("../src/dashboard/review-notes.js");
    expect(extractNonBlockingNotes("Non-blocking notes:\n\n")).toBeNull();
    expect(extractNonBlockingNotes("Non-blocking notes: none")).toBeNull();
    expect(extractNonBlockingNotes("Non-blocking notes:\nNone.")).toBeNull();
  });

  it("stops at the next markdown heading", async () => {
    const { extractNonBlockingNotes } = await import("../src/dashboard/review-notes.js");
    expect(extractNonBlockingNotes("Non-blocking notes:\n- a\n## Summary\nall good")).toBe("- a");
  });

  it("takes the last heading when the reasoning mentions the convention earlier", async () => {
    const { extractNonBlockingNotes } = await import("../src/dashboard/review-notes.js");
    const body = "Non-blocking notes: I will list some below.\nreasoning...\nNon-blocking notes:\n- real";
    expect(extractNonBlockingNotes(body)).toBe("- real");
  });
});

describe("recordReviewNotes", () => {
  const home = useTmpHome();
  beforeEach(() => addAlert.mockClear());

  const input = { project: "wolf", worker: "cold-brash-lark", branch: "cold-brash-lark", verdict: "clean" };

  it("persists the notes durably and raises a deduped info alert", async () => {
    const { recordReviewNotes, readReviewNotes } = await import("../src/dashboard/review-notes.js");
    recordReviewNotes({ ...input, body: "ok\n\nNon-blocking notes:\n- first" });
    recordReviewNotes({ ...input, verdict: "fixed", body: "Non-blocking notes:\n- second" });

    const notes = readReviewNotes("wolf");
    expect(notes.map(n => [n.worker, n.branch, n.verdict, n.notes])).toEqual([
      ["cold-brash-lark", "cold-brash-lark", "clean", "- first"],
      ["cold-brash-lark", "cold-brash-lark", "fixed", "- second"],
    ]);
    expect(Date.parse(notes[0].at)).not.toBeNaN();
    expect(notes[0].project).toBe("wolf");

    expect(addAlert).toHaveBeenCalledWith(expect.objectContaining({
      level: "info",
      project: "wolf",
      worker: "cold-brash-lark",
      message: expect.stringContaining("garden notes wolf"),
      dedupKey: "review-notes:wolf:cold-brash-lark:cold-brash-lark",
    }));
  });

  it("writes and alerts nothing when the body carries no notes", async () => {
    const { recordReviewNotes, readReviewNotes } = await import("../src/dashboard/review-notes.js");
    recordReviewNotes({ ...input, body: "Looks good." });
    expect(readReviewNotes("wolf")).toEqual([]);
    expect(addAlert).not.toHaveBeenCalled();
  });

  it("keeps the notes in the trusted control tree, not the worker-writable sessions dir", async () => {
    const { recordReviewNotes } = await import("../src/dashboard/review-notes.js");
    recordReviewNotes({ ...input, body: "Non-blocking notes:\n- x" });
    expect(fs.existsSync(path.join(home.gardenDir, "control", "reports", "review-notes-wolf.jsonl"))).toBe(true);
  });

  it("never throws when the notes file cannot be written", async () => {
    const { recordReviewNotes } = await import("../src/dashboard/review-notes.js");
    fs.mkdirSync(path.join(home.gardenDir, "control"), { recursive: true });
    fs.writeFileSync(path.join(home.gardenDir, "control", "reports"), "not a directory");
    expect(() => recordReviewNotes({ ...input, body: "Non-blocking notes:\n- x" })).not.toThrow();
    expect(addAlert).not.toHaveBeenCalled();
  });

  it("skips torn lines on read and clears on request", async () => {
    const { recordReviewNotes, readReviewNotes, clearReviewNotes } = await import("../src/dashboard/review-notes.js");
    const { reviewNotesPath } = await import("../src/dashboard/headless-paths.js");
    recordReviewNotes({ ...input, body: "Non-blocking notes:\n- kept" });
    fs.appendFileSync(reviewNotesPath("wolf"), "{\"at\":\"2026-10-06T00:00:00Z\",\"no");
    expect(readReviewNotes("wolf").map(n => n.notes)).toEqual(["- kept"]);
    clearReviewNotes("wolf");
    expect(readReviewNotes("wolf")).toEqual([]);
  });
});

import { describe, it, expect } from "vitest";
import { closestIndex, parseFlags, workerMergeEpochs } from "../src/dashboard/holistic-backtest.js";

// reflog entries ascending by epoch; the reconstruction picks the entry nearest
// a merge timestamp, then takes index-1 for the pre-merge base SHA.
const reflog = [
  { epoch: 100, sha: "aaa" },
  { epoch: 200, sha: "bbb" },
  { epoch: 305, sha: "ccc" }, // first merge ~310
  { epoch: 410, sha: "ddd" }, // last merge ~405
];

describe("closestIndex (reflog ↔ merge-timestamp join)", () => {
  it("matches the reflog entry nearest a merge timestamp", () => {
    expect(closestIndex(reflog, 310)).toBe(2); // closest to 305
    expect(closestIndex(reflog, 405)).toBe(3); // closest to 410
  });

  it("index-1 of the first-merge match yields the pre-merge base SHA", () => {
    const firstIdx = closestIndex(reflog, 310);
    expect(reflog[firstIdx - 1].sha).toBe("bbb"); // state before the first merge
  });

  it("ties resolve to the earlier entry", () => {
    expect(closestIndex(reflog, 150)).toBe(0); // equidistant 100/200 → first
  });
});

describe("workerMergeEpochs (de-duplicates the double-logged merge)", () => {
  // Every successful merge emits two "merged to base branch" lines: one from
  // mergeToBase (src "git", the real base push) and one from finalizeMerge's
  // poller line. Counting both would report 2 merges per real merge.
  const line = (src: string, worker: string, ts: string, msg = "merged to base branch") =>
    JSON.stringify({ ts, level: "info", src, worker, msg });
  const log = [
    line("git", "alice", "2026-06-01T00:00:00.000Z"),
    line("poller", "alice", "2026-06-01T00:00:01.000Z"), // duplicate of the merge above
    line("git", "alice", "2026-06-02T00:00:00.000Z"),
    line("poller", "alice", "2026-06-02T00:00:01.000Z"), // duplicate
    line("git", "bob", "2026-06-03T00:00:00.000Z"),       // different worker
    line("poller", "bob", "2026-06-03T00:00:01.000Z"),
    line("git", "alice", "2026-06-04T00:00:00.000Z", "reviewing"), // different msg
    "",            // blank line
    "{not json",   // malformed line
  ].join("\n");

  it("counts each merge once (src:git), ignoring the poller duplicate", () => {
    expect(workerMergeEpochs(log, "alice")).toEqual([
      Date.parse("2026-06-01T00:00:00.000Z") / 1000,
      Date.parse("2026-06-02T00:00:00.000Z") / 1000,
    ]);
  });

  it("filters by worker, skips non-merge messages, blank and malformed lines", () => {
    expect(workerMergeEpochs(log, "bob")).toHaveLength(1);
    expect(workerMergeEpochs("", "alice")).toEqual([]);
  });
});

describe("parseFlags", () => {
  it("parses explicit endpoints, base override, and --run", () => {
    expect(parseFlags(["--from", "abc", "--to", "origin/main", "--base", "dev", "--run"]))
      .toEqual({ from: "abc", to: "origin/main", base: "dev", run: true });
  });

  it("defaults run to false and leaves endpoints undefined", () => {
    expect(parseFlags([])).toEqual({ run: false });
  });
});

import { describe, it, expect } from "vitest";
import { closestIndex, parseFlags } from "../src/dashboard/holistic-backtest.js";

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

describe("parseFlags", () => {
  it("parses explicit endpoints, base override, and --run", () => {
    expect(parseFlags(["--from", "abc", "--to", "origin/main", "--base", "dev", "--run"]))
      .toEqual({ from: "abc", to: "origin/main", base: "dev", run: true });
  });

  it("defaults run to false and leaves endpoints undefined", () => {
    expect(parseFlags([])).toEqual({ run: false });
  });
});

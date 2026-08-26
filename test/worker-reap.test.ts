import { describe, it, expect, vi } from "vitest";
import {
  selectReapTargets, ancestorPids, processIsAlive,
} from "../src/dashboard/worker-reap.js";

// `lsof -d cwd -F pn` emits one field per line: p<pid> opens a process block,
// n<path> carries its cwd.
function lsof(entries: Array<[number, string]>): string {
  return entries.map(([pid, cwd]) => `p${pid}\nfcwd\nn${cwd}`).join("\n") + "\n";
}

const ROOT = "/Users/j/.garden/worktrees/keychange-ai/mute-wry-dove";

describe("selectReapTargets", () => {
  it("selects processes sitting in the worktree root and below it", () => {
    const out = lsof([
      [100, ROOT],
      [200, `${ROOT}/.next/cache/webpack`],
      [300, "/Users/j/code/keychange/keychange-ai"],
    ]);
    expect(selectReapTargets(out, ROOT, new Set())).toEqual([100, 200]);
  });

  it("does not select a sibling worktree sharing the root's name prefix", () => {
    // The bug a bare startsWith(root) would introduce: reaping a live worker.
    const out = lsof([
      [100, `${ROOT}-2/src`],
      [200, `${ROOT}extra`],
      [300, ROOT],
    ]);
    expect(selectReapTargets(out, ROOT, new Set())).toEqual([300]);
  });

  it("excludes protected pids", () => {
    const out = lsof([[100, ROOT], [200, `${ROOT}/src`]]);
    expect(selectReapTargets(out, ROOT, new Set([100]))).toEqual([200]);
  });

  it("never selects init or the kernel", () => {
    const out = lsof([[0, ROOT], [1, ROOT], [2, ROOT]]);
    expect(selectReapTargets(out, ROOT, new Set())).toEqual([2]);
  });

  it("ignores malformed and unparseable blocks", () => {
    const out = [
      "garbage",
      "pnotanumber", "fcwd", `n${ROOT}`,
      "", "fcwd", `n${ROOT}`,
      `p400`, "fcwd", `n${ROOT}`,
    ].join("\n");
    expect(selectReapTargets(out, ROOT, new Set())).toEqual([400]);
  });

  it("deduplicates a pid reported more than once", () => {
    const out = lsof([[100, ROOT], [100, `${ROOT}/src`]]);
    expect(selectReapTargets(out, ROOT, new Set())).toEqual([100]);
  });

  it("returns nothing for an empty table", () => {
    expect(selectReapTargets("", ROOT, new Set())).toEqual([]);
  });

  it("tolerates a root given with a trailing separator", () => {
    const out = lsof([[100, ROOT], [200, `${ROOT}/src`]]);
    expect(selectReapTargets(out, `${ROOT}/`, new Set())).toEqual([100, 200]);
  });
});

describe("ancestorPids", () => {
  const ps = ["  PID  PPID", " 500     1", " 600   500", " 700   600", " 800     1"].join("\n");

  it("walks self up to init", () => {
    expect(ancestorPids(ps, 700)).toEqual(new Set([700, 600, 500]));
  });

  it("includes self even when the table has no entry for it", () => {
    expect(ancestorPids(ps, 999)).toEqual(new Set([999]));
  });

  it("stops at init rather than including it", () => {
    expect(ancestorPids(ps, 500)).toEqual(new Set([500]));
  });

  it("terminates on a cyclic table", () => {
    const cyclic = [" 10    20", " 20    10"].join("\n");
    expect(ancestorPids(cyclic, 10)).toEqual(new Set([10, 20]));
  });
});

describe("processIsAlive", () => {
  it("distinguishes a missing process from one we cannot signal", () => {
    const kill = vi.spyOn(process, "kill");
    const error = (code: string) => Object.assign(new Error(code), { code });
    kill.mockImplementationOnce(() => { throw error("ESRCH"); });
    kill.mockImplementationOnce(() => { throw error("EPERM"); });

    expect(processIsAlive(100)).toBe(false);
    expect(processIsAlive(200)).toBe(true);
  });
});

import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  selectReapTargets, ancestorPids, processIsAlive, reapWorktreeProcesses,
} from "../src/dashboard/worker-reap.js";

// The process table a reap reads, when a test supplies one. Unset, spawnSync
// is the real one.
const table = vi.hoisted(() => ({ lsof: null as string | null, ps: "" }));
vi.mock("node:child_process", async (orig) => {
  const actual = await orig<typeof import("node:child_process")>();
  const spawnSync = ((cmd: string, ...rest: unknown[]) => {
    if (table.lsof !== null && cmd === "lsof") return { stdout: table.lsof, status: 0 };
    if (table.lsof !== null && cmd === "ps") return { stdout: table.ps, status: 0 };
    return (actual.spawnSync as (...args: unknown[]) => unknown)(cmd, ...rest);
  }) as typeof actual.spawnSync;
  return { ...actual, spawnSync };
});

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

describe("reapWorktreeProcesses", () => {
  // The worktree's own name is an entry in the removed worker's write grant.
  // Resolved, a link planted there aimed the sweep at its target: every
  // process the operator owns, for a link to /.
  it("resolves the worktree's parent but not a link planted at its own name", () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "garden-reap-link-")));
    const signalled: number[] = [];
    const kill = vi.spyOn(process, "kill").mockImplementation(((pid: number, sig?: string | number) => {
      if (sig === 0) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      signalled.push(pid);
      return true;
    }) as typeof process.kill);
    try {
      fs.mkdirSync(path.join(tmp, "real-parent", "kept-tree"), { recursive: true });
      fs.mkdirSync(path.join(tmp, "elsewhere"));
      fs.symlinkSync(path.join(tmp, "real-parent"), path.join(tmp, "parent-link"));
      fs.symlinkSync(path.join(tmp, "elsewhere"), path.join(tmp, "real-parent", "planted"));
      table.ps = `  PID  PPID\n${process.pid}     1\n`;
      table.lsof = lsof([
        [4242, path.join(tmp, "real-parent", "kept-tree", "src")],
        [4343, path.join(tmp, "elsewhere")],
      ]);

      // A symlinked parent still finds the tree, as under a symlinked HOME.
      expect(reapWorktreeProcesses(path.join(tmp, "parent-link", "kept-tree"))?.terminated).toEqual([4242]);
      expect(reapWorktreeProcesses(path.join(tmp, "real-parent", "planted")))
        .toEqual({ terminated: [], killed: [], survived: [] });
      expect(signalled).toEqual([4242]);
    } finally {
      table.lsof = null;
      kill.mockRestore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

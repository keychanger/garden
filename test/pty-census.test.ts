import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

import { spawnSync } from "node:child_process";
import {
  parsePtmxHolders, parseParents, parsePanes, attributeHolder, workerFromCwd,
  countAllocatedPtys, takePtyCensus, unexplainedHoldings, isPtyPressure,
  explainPtyExhaustion,
} from "../src/dashboard/pty-census.js";

const LSOF = `COMMAND     PID USER   FD   TYPE DEVICE   SIZE/OFF NODE NAME
tmux       1474  jic    5u   CHR  15,52        0t0  605 /dev/ptmx
tmux       1474  jic    7u   CHR   15,1     0t2996  605 /dev/ptmx
iTerm2    57951  jic    4u   CHR   15,0 0t33925196  605 /dev/ptmx
iTerm2    57951  jic    9u   CHR   15,0 0t33925196  605 /dev/ptmx
Google Ch   800  jic   12u   CHR  15,90        0t0  605 /dev/ptmx
python3    4242  jic    3u   CHR  15,91        0t0  605 /dev/ptmx
`;

const WORKTREES = "/Users/op/.garden/worktrees";

describe("pty census parsing", () => {
  it("counts distinct ptys per process, so a master held on two fds counts once", () => {
    const holders = parsePtmxHolders(LSOF);
    expect(holders.get(1474)).toEqual({ command: "tmux", minors: new Set(["52", "1"]) });
    expect(holders.get(57951)?.minors.size).toBe(1);
    expect(holders.get(800)?.command).toBe("Google Ch");
  });

  it("reads ps parent pairs and tmux pane pids", () => {
    expect(parseParents("  10  1\n 20 10\n")).toEqual(new Map([[10, 1], [20, 10]]));
    expect(parsePanes("300 _wolf-worker-rapt-west-quail\n301 main\n"))
      .toEqual(new Map([[300, "_wolf-worker-rapt-west-quail"], [301, "main"]]));
  });

  it("counts only allocated pty nodes, not the static legacy ttys", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pty-census-"));
    for (const name of ["ttys000", "ttys057", "ttys0", "ttysf", "ttyp0", "null"]) {
      fs.writeFileSync(path.join(dir, name), "");
    }
    expect(countAllocatedPtys(dir)).toBe(2);
    fs.rmSync(dir, { recursive: true });
  });
});

describe("attributeHolder", () => {
  const panes = new Map([[300, "_wolf-worker-rapt-west-quail"]]);

  it("names the garden pane a holder descends from", () => {
    const parents = new Map([[4242, 4000], [4000, 300], [300, 1474]]);
    expect(attributeHolder(4242, parents, panes, undefined, WORKTREES)).toBe("_wolf-worker-rapt-west-quail");
  });

  it("falls back to the worktree a reparented holder is running in", () => {
    const parents = new Map([[4242, 1]]);
    expect(attributeHolder(4242, parents, panes, `${WORKTREES}/wolf/rapt-west-quail/src`, WORKTREES))
      .toBe("wolf/rapt-west-quail (detached)");
  });

  it("reports a holder with neither link as outside garden", () => {
    expect(attributeHolder(57951, new Map([[57951, 1]]), panes, "/Users/op", WORKTREES)).toBe("outside garden");
    expect(workerFromCwd(WORKTREES, WORKTREES)).toBeNull();
  });

  it("terminates on a parent cycle", () => {
    expect(attributeHolder(5, new Map([[5, 6], [6, 5]]), panes, undefined, WORKTREES)).toBe("outside garden");
  });
});

describe("takePtyCensus and its consumers", () => {
  const platform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    vi.spyOn(fs, "readdirSync").mockReturnValue(
      Array.from({ length: 400 }, (_, i) => `ttys${String(i).padStart(3, "0")}`) as never,
    );
    vi.mocked(spawnSync).mockImplementation(((cmd: string, args: string[]) => {
      const out = (stdout: string) => ({ status: 0, stdout });
      if (cmd === "sysctl") return out("511\n");
      if (cmd === "ps") return out("1474 1\n300 1474\n4000 300\n4242 4000\n57951 1\n800 1\n");
      if (cmd === "tmux" && args[0] === "list-panes") return out("300 _wolf-worker-rapt-west-quail\n301 main\n");
      if (cmd === "tmux") return out("1474\n");
      if (cmd === "lsof" && args.includes("cwd")) return out("p800\nn/Users/op\np57951\nn/Users/op\n");
      if (cmd === "lsof") return out(LSOF);
      return out("");
    }) as never);
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: platform });
    vi.restoreAllMocks();
  });

  it("attributes every holder and compares the tmux server against its panes", () => {
    const census = takePtyCensus()!;
    expect(census.inUse).toBe(400);
    expect(census.limit).toBe(511);
    expect(census.tmuxServer).toEqual({ held: 2, panes: 2 });
    expect(census.holders.find((h) => h.pid === 4242)?.owner).toBe("_wolf-worker-rapt-west-quail");
    expect(census.holders.find((h) => h.pid === 1474)?.owner).toBe("tmux server");
    expect(unexplainedHoldings(census)).toEqual([
      "Google Ch[800] outside garden: 1",
      "iTerm2[57951] outside garden: 1",
      "python3[4242] _wolf-worker-rapt-west-quail: 1",
    ]);
    expect(isPtyPressure(census)).toBe(true);
  });

  it("is not taken off macOS, where its sources do not exist", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    expect(takePtyCensus()).toBeNull();
  });

  it("translates tmux's fork errno into pty exhaustion with the holders named", () => {
    const message = explainPtyExhaustion(
      new Error("tmux respawn-pane failed: respawn pane failed: fork failed: Device not configured"),
    );
    expect(message).toMatch(/^out of pseudo-terminals \(400\/511 in use; top holders: tmux server \(2 panes\): 2; /);
  });

  it("leaves every other spawn failure alone", () => {
    expect(explainPtyExhaustion(new Error("tmux swap-pane failed: can't find pane: %36"))).toBeNull();
  });
});

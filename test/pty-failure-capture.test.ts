import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { log } from "../src/dashboard/log.js";
import type { PtyCensus } from "../src/dashboard/pty-census.js";
import {
  describeRun, probeFreshOpenpty, probeThrowawayServer, probeAtFailure, respawnProbingForkFailure,
  PaneForkFailure, describeTmuxServer, describeMachine, holdersByCommand, capturePtyFailure,
  readKernelLog, runKernelLogCapture, formatLogShowTime, KERNEL_LOG_BEFORE_MS, KERNEL_LOG_AFTER_MS,
  type Runner, type RunResult,
} from "../src/dashboard/pty-failure-capture.js";

const FORK = "tmux respawn-pane failed: respawn pane failed: fork failed: Device not configured";
const ok = (stdout = ""): RunResult => ({ status: 0, stdout, stderr: "" });
const fail = (stderr: string, status = 1): RunResult => ({ status, stdout: "", stderr });
const errno = (code: string): RunResult => ({
  status: null, stdout: "", stderr: "", error: Object.assign(new Error(`spawnSync x ${code}`), { code }),
});

// A runner answering by command line, recording every call in order.
function scripted(answers: Array<[RegExp, RunResult]>, fallback = ok()) {
  const calls: Array<{ line: string; env?: NodeJS.ProcessEnv }> = [];
  const run: Runner = (cmd, args, env) => {
    const line = [cmd, ...args].join(" ");
    calls.push({ line, env });
    return answers.find(([re]) => re.test(line))?.[1] ?? fallback;
  };
  return { run, calls };
}

describe("describeRun", () => {
  it("separates success, denial, failure, and a command that could not run", () => {
    expect(describeRun(ok())).toBe("ok");
    expect(describeRun(fail("script: openpty: Operation not permitted"))).toBe("denied: script: openpty: Operation not permitted");
    expect(describeRun(fail("script: openpty: Device not configured"))).toBe("failed (exit 1): script: openpty: Device not configured");
    expect(describeRun(fail(""))).toBe("failed (exit 1): no output");
    expect(describeRun(errno("ENOENT"))).toBe("unavailable: command not found");
    expect(describeRun(errno("ETIMEDOUT"))).toBe("no result: timed out after 5s");
  });
});

describe("at-failure probes", () => {
  it("opens a fresh pty from a separate process", () => {
    const { run, calls } = scripted([[/script/, fail("script: openpty: Device not configured")]]);
    expect(probeFreshOpenpty(run)).toBe("failed (exit 1): script: openpty: Device not configured");
    expect(calls[0].line).toBe("/usr/bin/script -q /dev/null /usr/bin/true");
  });

  it("creates and respawns a pane on a throwaway server, then kills that server", () => {
    const { run, calls } = scripted([[/new-session/, ok("%0\n")]]);
    expect(probeThrowawayServer(run)).toBe("new-session ok; respawn-pane ok");
    const lines = calls.map((c) => c.line);
    expect(lines[0]).toMatch(/^tmux -L garden-probe-\d+ -f \/dev\/null new-session -d -s probe /);
    expect(lines[1]).toMatch(/respawn-pane -k -t %0 sh -c exec sleep 86400$/);
    expect(lines[2]).toMatch(/kill-server$/);
    expect(calls.every((c) => c.env && !("TMUX" in c.env))).toBe(true);
  });

  it("reports a throwaway server tmux could not create even though it exited 0", () => {
    const { run, calls } = scripted([[/new-session/, {
      status: 0, stdout: "", stderr: "error creating /private/tmp/tmux-501/garden-probe-1 (Operation not permitted)\n",
    }]]);
    expect(probeThrowawayServer(run)).toBe(
      "new-session denied: error creating /private/tmp/tmux-501/garden-probe-1 (Operation not permitted)",
    );
    expect(calls.at(-1)?.line).toMatch(/kill-server$/);
  });

  it("reports the respawn failing on the throwaway server", () => {
    const { run } = scripted([
      [/new-session/, ok("%3\n")],
      [/respawn-pane/, fail("respawn pane failed: fork failed: Device not configured")],
    ]);
    expect(probeThrowawayServer(run))
      .toBe("new-session ok; respawn-pane failed (exit 1): respawn pane failed: fork failed: Device not configured");
  });

  it("probes locality before re-attempting the same respawn against the failed pane", () => {
    const { run, calls } = scripted([[/new-session/, ok("%0\n")]]);
    expect(probeAtFailure({ paneId: "%41", cwd: "/repo" }, run)).toEqual({
      freshOpenpty: "ok",
      throwawayTmux: "new-session ok; respawn-pane ok",
      retry: "ok",
    });
    expect(calls.at(-1)?.line).toBe("tmux respawn-pane -k -c /repo -t %41 sh -c exec sleep 86400");
    expect(calls[0].line).toMatch(/^\/usr\/bin\/script /);
  });

  it("records each probe that throws without losing the others", () => {
    const run: Runner = (cmd) => {
      if (cmd === "/usr/bin/script") throw new Error("spawn EPERM");
      return ok("%0\n");
    };
    const probes = probeAtFailure(null, run);
    expect(probes.freshOpenpty).toBe("unavailable: Error: spawn EPERM");
    expect(probes.throwawayTmux).toBe("new-session ok; respawn-pane ok");
    expect(probes.retry).toBe("not attempted at this call site");
  });
});

describe("respawnProbingForkFailure", () => {
  it("runs no probe when the respawn succeeds", () => {
    const run = vi.fn<Runner>(() => ok());
    respawnProbingForkFailure(() => {}, { paneId: "%1", cwd: "/" }, run);
    expect(run).not.toHaveBeenCalled();
  });

  it("rethrows any other failure unchanged and unprobed", () => {
    const run = vi.fn<Runner>(() => ok());
    const err = new Error("tmux swap-pane failed: can't find pane: %36");
    expect(() => respawnProbingForkFailure(() => { throw err; }, null, run)).toThrow(err);
    expect(run).not.toHaveBeenCalled();
  });

  it("attaches the probes to a fork failure and keeps tmux's message", () => {
    const { run } = scripted([[/new-session/, ok("%0\n")]]);
    let caught: unknown;
    try {
      respawnProbingForkFailure(() => { throw new Error(FORK); }, { paneId: "%1", cwd: "/" }, run);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PaneForkFailure);
    expect(String(caught)).toBe(`Error: ${FORK}`);
    expect((caught as PaneForkFailure).probes.retry).toBe("ok");
  });
});

describe("server and machine state", () => {
  const LSOF_FDS = "p1474\nfcwd\nn/\nftxt\nn/opt/homebrew/bin/tmux\nf0\nn/dev/null\nf5\nn/dev/ptmx\nf7\nn/dev/ptmx\nf9\nn->0x1\n";

  it("names the tmux server's pid, uptime, version, size, fds, and fd limit", () => {
    const now = 1_800_000_000_000;
    const { run } = scripted([
      [/display-message/, ok(`1474 ${now / 1000 - 26 * 24 * 3600} 3.7c\n`)],
      [/list-windows/, ok("x\nx\nx\n")],
      [/list-panes/, ok("x\nx\nx\nx\n")],
      [/^lsof/, ok(LSOF_FDS)],
      [/run-shell/, ok("256\nunlimited\n")],
    ]);
    expect(describeTmuxServer(run, now)).toEqual({
      tmuxServer: "pid 1474, up 624h, version 3.7c, 3 windows, 4 panes",
      tmuxServerFds: "4 open, 2 on /dev/ptmx",
      tmuxServerNofile: "soft 256, hard unlimited",
    });
  });

  it("records an unreachable server instead of guessing its state", () => {
    const { run, calls } = scripted([[/display-message/, fail("error connecting to /private/tmp/tmux-501/default (Operation not permitted)")]]);
    expect(describeTmuxServer(run)).toEqual({
      tmuxServer: "unavailable: display-message denied: error connecting to /private/tmp/tmux-501/default (Operation not permitted)",
    });
    expect(calls).toHaveLength(1);
  });

  it("records a denied lsof and run-shell beside what could be read", () => {
    const { run } = scripted([
      [/display-message/, ok("1474 notanumber 3.7c\n")],
      [/^lsof/, fail("lsof: Operation not permitted")],
      [/run-shell/, fail("", 1)],
    ]);
    expect(describeTmuxServer(run)).toEqual({
      tmuxServer: "pid 1474, uptime unreadable, version 3.7c, 0 windows, 0 panes",
      tmuxServerFds: "denied: lsof: Operation not permitted",
      tmuxServerNofile: "failed (exit 1): no output",
    });
  });

  it("counts processes and open files against their limits and finds ctty without a /dev node", () => {
    const dev = fs.mkdtempSync(path.join(os.tmpdir(), "pty-capture-"));
    fs.writeFileSync(path.join(dev, "ttys001"), "");
    const { run } = scripted([
      [/^sysctl/, ok("kern.maxprocperuid: 10666\nkern.maxproc: 16000\nkern.num_files: 13208\nkern.maxfiles: 491520\n")],
      [/^ps -U 501/, ok("1\n2\n3\n")],
      [/^ps -A -o pid=/, ok("1\n2\n3\n4\n5\n")],
      [/^ps -Ao tty=/, ok([
        "??       Ss     1 launchd",
        "ttys001  Ss+  300 sh",
        "ttys001  S+   301 node",
        "ttys007  Ss   400 -zsh",
        "ttys001  Ss   250 Google Chrome Helper",
      ].join("\n"))],
    ]);
    expect(describeMachine(run, 501, dev)).toEqual({
      processes: "user 3/10666, all 5/16000",
      openFiles: "13208/491520",
      cttyWithoutNode: "1 of 2: ttys007",
      ttysWithTwoSessions: "ttys001: sh[300], Google Chrome Helper[250]",
    });
    fs.rmSync(dev, { recursive: true });
  });

  it("marks unreadable counters rather than reporting zero", () => {
    const { run } = scripted([[/^ps/, fail("ps: Operation not permitted")]], fail("sysctl: unknown oid"));
    expect(describeMachine(run, 501)).toEqual({
      processes: "user denied: ps: Operation not permitted/?, all denied: ps: Operation not permitted/?",
      openFiles: "?/?",
      cttyWithoutNode: "denied: ps: Operation not permitted",
      ttysWithTwoSessions: "denied: ps: Operation not permitted",
    });
  });

  it("totals ptmx holders by command", () => {
    const census: PtyCensus = {
      inUse: 62, limit: 511, tmuxServer: { held: 53, panes: 53 },
      holders: [
        { pid: 1474, command: "tmux", count: 53, owner: "tmux server" },
        { pid: 2, command: "iTerm2", count: 2, owner: "outside garden" },
        { pid: 3, command: "iTerm2", count: 1, owner: "outside garden" },
      ],
    };
    expect(holdersByCommand(census)).toBe("tmux: 53 (1 proc); iTerm2: 3 (2 procs)");
    expect(holdersByCommand(null)).toBe("unavailable: no census");
  });
});

describe("capturePtyFailure", () => {
  const census = (): PtyCensus => ({ inUse: 62, limit: 511, tmuxServer: null, holders: [] });
  const ctx = { project: "omi-godot", worker: "odd-fir", failedAt: 1_000 };

  it("ignores every failure that is not a pane fork failure", () => {
    const dispatchKernelLog = vi.fn();
    expect(capturePtyFailure(new Error("tmux swap-pane failed"), ctx, { run: () => ok(), census, dispatchKernelLog })).toBeNull();
    expect(dispatchKernelLog).not.toHaveBeenCalled();
  });

  it("merges the at-failure probes with server and machine state, and dispatches the kernel log read", () => {
    const dispatchKernelLog = vi.fn();
    const err = new PaneForkFailure(new Error(FORK), { freshOpenpty: "ok", throwawayTmux: "x", retry: "ok" });
    const result = capturePtyFailure(err, ctx, { run: () => fail("nope"), census, dispatchKernelLog })!;
    expect(result.cause).toMatch(/^tmux could not open a pseudo-terminal for the pane, below the machine limit \(62\/511 in use/);
    expect(result.data).toMatchObject({
      freshOpenpty: "ok",
      retry: "ok",
      tmuxServer: "unavailable: display-message failed (exit 1): nope",
      cttyWithoutNode: "failed (exit 1): nope",
      ptmxHolders: "none visible",
      kernelLog: 'read after the failure; logged as "kernel log around pane fork failure"',
    });
    expect(dispatchKernelLog).toHaveBeenCalledWith(ctx);
  });

  it("says which probes did not run for a fork failure that bypassed them", () => {
    const result = capturePtyFailure(new Error(FORK), ctx, { run: () => ok(), census, dispatchKernelLog: () => {} })!;
    expect(result.data).toMatchObject({ freshOpenpty: "not probed", throwawayTmux: "not probed", retry: "not probed" });
  });

  it("still reports what tmux said when the census and the dispatch both fail", () => {
    const result = capturePtyFailure(new Error(FORK), ctx, {
      run: () => ok(),
      census: () => { throw new Error("lsof hung"); },
      dispatchKernelLog: () => { throw new Error("spawn EPERM"); },
    })!;
    expect(result.cause).toBe("tmux could not open a pseudo-terminal for the pane");
    expect(result.data.kernelLog).toBe("unavailable: Error: spawn EPERM");
    expect(result.data.ptmxHolders).toBe("unavailable: no census");
  });
});

describe("kernel log read", () => {
  afterEach(() => vi.mocked(log.info).mockClear());

  const failedAt = new Date(2026, 10, 6, 15, 10, 34).getTime();

  it("reads the window from 30s before to 5s after the failure, in local time", () => {
    const { run, calls } = scripted([], ok("Filtering the log data using \"process == \\\"kernel\\\"\"\nTimestamp               Ty Process[PID:TID]\n"));
    expect(readKernelLog(failedAt, run)).toEqual({
      window: "2026-11-06 15:10:04 to 2026-11-06 15:10:39 local",
      kernelLog: "no kernel lines",
    });
    expect(calls[0].line).toBe(
      '/usr/bin/log show --start 2026-11-06 15:10:04 --end 2026-11-06 15:10:39 --predicate process == "kernel" --style compact',
    );
    expect(formatLogShowTime(failedAt - KERNEL_LOG_BEFORE_MS + KERNEL_LOG_AFTER_MS)).toBe("2026-11-06 15:10:09");
  });

  it("keeps the kernel lines, capped, with the total", () => {
    const rows = Array.from({ length: 45 }, (_, i) => `2026-11-06 15:10:3${i % 10}.000 Df kernel[0:1] line ${i}`);
    const result = readKernelLog(failedAt, () => ok(`Timestamp               Ty Process[PID:TID]\n${rows.join("\n")}\n`));
    expect(result.kernelLines).toBe("45");
    expect(result.kernelLog.split(" | ")).toHaveLength(41);
    expect(result.kernelLog).toMatch(/line 0 \| /);
    expect(result.kernelLog).toMatch(/\| \(5 more lines not shown\)$/);
  });

  it("records a denied log read", () => {
    expect(readKernelLog(failedAt, () => fail("log: Operation not permitted")).kernelLog)
      .toBe("denied: log: Operation not permitted");
  });

  it("waits for the window to close, then logs a sibling entry naming the failure", async () => {
    vi.useFakeTimers({ now: failedAt + 1_000 });
    const run = vi.fn<Runner>(() => ok(""));
    const done = runKernelLogCapture(failedAt, "omi-godot", "odd-fir", run);
    await vi.advanceTimersByTimeAsync(KERNEL_LOG_AFTER_MS - 1);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    await done;
    vi.useRealTimers();
    expect(log.info).toHaveBeenCalledWith("workers", "kernel log around pane fork failure", {
      worker: "odd-fir",
      data: expect.objectContaining({
        project: "omi-godot",
        failedAt: new Date(failedAt).toISOString(),
        kernelLog: "no kernel lines",
      }),
    });
  });
});

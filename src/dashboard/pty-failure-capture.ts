// Evidence taken at the moment tmux fails to fork a pane with ENXIO
// ("fork failed: Device not configured"). The count-based census in
// pty-census.ts showed the failures happen far below the machine pty limit, so
// that census alone cannot explain them. This module records what the next
// failure needs to settle; docs/PTY-FORK-FAILURE.md lists the candidate
// causes and which of these fields confirms or rules out each one.
//
// Everything here runs on the failure path only and fails soft: a probe the
// caller's sandbox denies, or a command that is missing, is recorded as such
// rather than left out, so an absent answer is never mistaken for a negative.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { log } from "./log.js";
import { describePtyFailure, takePtyCensus, type PtyCensus } from "./pty-census.js";
import { resolveGardenRunner } from "./runner.js";
import { shellEscape } from "./tmux.js";

const FORK_FAILURE = "fork failed: Device not configured";
const PROBE_TIMEOUT_MS = 5_000;
const PLACEHOLDER = "exec sleep 86400";
export const KERNEL_LOG_BEFORE_MS = 30_000;
export const KERNEL_LOG_AFTER_MS = 5_000;
const KERNEL_LOG_MAX_LINES = 40;

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: NodeJS.ErrnoException;
}

export type Runner = (cmd: string, args: string[], env?: NodeJS.ProcessEnv) => RunResult;

export const defaultRunner: Runner = (cmd, args, env) => {
  const r = spawnSync(cmd, args, {
    encoding: "utf-8",
    timeout: PROBE_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error ?? undefined };
};

export function isPaneForkFailure(err: unknown): boolean {
  return String(err).includes(FORK_FAILURE);
}

// A pane fork failure carrying the probes that had to run before the caller's
// rollback kills the window. The message is the original one, so every
// existing reader of String(err) sees what tmux reported.
export class PaneForkFailure extends Error {
  constructor(readonly original: unknown, readonly probes: Record<string, string>) {
    super(original instanceof Error ? original.message : String(original));
  }
}

function firstLine(text: string): string {
  return text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
}

function outputText(r: RunResult): string {
  return firstLine(r.stderr) || firstLine(r.stdout) || "no output";
}

// EPERM is what a sandbox returns, so its errno text marks a denial.
function failure(prefix: string, text: string): string {
  return text.includes("Operation not permitted") ? `denied: ${text}` : `${prefix}: ${text}`;
}

// "ok", "denied: …", "failed (exit N): …", or "unavailable: …" when the
// command could not run at all.
export function describeRun(r: RunResult): string {
  if (r.error?.code === "ENOENT") return "unavailable: command not found";
  if (r.error?.code === "ETIMEDOUT") return `no result: timed out after ${PROBE_TIMEOUT_MS / 1000}s`;
  if (r.error) return `unavailable: ${r.error.message}`;
  if (r.status === 0) return "ok";
  return failure(`failed (exit ${r.status})`, outputText(r));
}

// A fresh openpty() from a separate process: script(1) opens its pty with the
// same libc openpty() tmux's forkpty() uses.
export function probeFreshOpenpty(run: Runner): string {
  return describeRun(run("/usr/bin/script", ["-q", "/dev/null", "/usr/bin/true"]));
}

// A pane on a throwaway tmux server, created then respawned, mirroring the
// placeholder-then-respawn sequence that fails.
export function probeThrowawayServer(run: Runner): string {
  const env = { ...process.env };
  delete env.TMUX;
  const sock = `garden-probe-${process.pid}`;
  const tmux = (...args: string[]) => run("tmux", ["-L", sock, "-f", "/dev/null", ...args], env);
  try {
    const created = tmux("new-session", "-d", "-s", "probe", "-P", "-F", "#{pane_id}", PLACEHOLDER);
    const paneId = /%\d+/.exec(created.stdout)?.[0];
    // tmux exits 0 even when it cannot create the server socket.
    if (!paneId) {
      return `new-session ${created.status === 0 ? failure("created no pane", outputText(created)) : describeRun(created)}`;
    }
    return `new-session ok; respawn-pane ${describeRun(tmux("respawn-pane", "-k", "-t", paneId, "sh", "-c", PLACEHOLDER))}`;
  } finally {
    tmux("kill-server");
    // kill-server leaves the socket file behind; nothing else removes it.
    const dir = path.join(process.env.TMUX_TMPDIR || "/tmp", `tmux-${process.getuid?.() ?? 0}`);
    try {
      fs.rmSync(path.join(dir, sock), { force: true });
    } catch { /* a leftover socket file is harmless */ }
  }
}

export interface RetryTarget {
  paneId: string;
  cwd: string;
}

// Run while the failed pane still exists. Locality goes first, while whatever
// failed the fork is most likely still in effect. The re-attempt is the same
// respawn-pane against the same pane, with the placeholder command: the fork
// is what is being tested, and the caller's rollback still kills the window.
export function probeAtFailure(target: RetryTarget | null, run: Runner = defaultRunner): Record<string, string> {
  const probe = (fn: () => string) => {
    try {
      return fn();
    } catch (err) {
      return `unavailable: ${String(err)}`;
    }
  };
  return {
    freshOpenpty: probe(() => probeFreshOpenpty(run)),
    throwawayTmux: probe(() => probeThrowawayServer(run)),
    retry: target
      ? probe(() => describeRun(run("tmux", [
        "respawn-pane", "-k", "-c", target.cwd, "-t", target.paneId, "sh", "-c", PLACEHOLDER,
      ])))
      : "not attempted at this call site",
  };
}

// Runs a pane respawn; a pty fork failure comes back as a PaneForkFailure with
// the at-failure probes attached. No work is added when the respawn succeeds.
export function respawnProbingForkFailure(
  respawn: () => void,
  target: RetryTarget | null,
  run: Runner = defaultRunner,
): void {
  try {
    respawn();
  } catch (err) {
    if (!isPaneForkFailure(err)) throw err;
    throw new PaneForkFailure(err, probeAtFailure(target, run));
  }
}

function lines(text: string): string[] {
  return text.split("\n").map((l) => l.trim()).filter(Boolean);
}

export function describeTmuxServer(run: Runner, now = Date.now()): Record<string, string> {
  const info = run("tmux", ["display-message", "-p", "#{pid} #{start_time} #{version}"]);
  const [pidText, startText, version] = info.stdout.trim().split(/\s+/);
  const pid = Number.parseInt(pidText ?? "", 10);
  if (info.status !== 0 || !Number.isInteger(pid)) {
    return { tmuxServer: `unavailable: display-message ${describeRun(info)}` };
  }
  const start = Number.parseInt(startText ?? "", 10);
  const uptime = Number.isInteger(start) ? `up ${Math.round((now / 1000 - start) / 3600)}h` : "uptime unreadable";

  const count = (args: string[]) => {
    const r = run("tmux", args);
    return r.status === 0 ? String(lines(r.stdout).length) : describeRun(r);
  };
  const out: Record<string, string> = {
    tmuxServer: `pid ${pid}, ${uptime}, version ${version ?? "unknown"}, `
      + `${count(["list-windows", "-a", "-F", "x"])} windows, ${count(["list-panes", "-a", "-F", "x"])} panes`,
  };

  const fds = run("lsof", ["-n", "-p", String(pid), "-F", "fn"]);
  if (fds.status === 0) {
    let total = 0;
    let ptmx = 0;
    let numbered = false;
    for (const line of lines(fds.stdout)) {
      if (line.startsWith("f")) {
        numbered = /^f\d+$/.test(line);
        if (numbered) total++;
      } else if (line === "n/dev/ptmx" && numbered) {
        ptmx++;
      }
    }
    out.tmuxServerFds = `${total} open, ${ptmx} on /dev/ptmx`;
  } else {
    out.tmuxServerFds = describeRun(fds);
  }

  // A job the server forks inherits the server's own rlimits.
  const limit = run("tmux", ["run-shell", "ulimit -Sn; ulimit -Hn"]);
  const [soft, hard] = lines(limit.stdout);
  out.tmuxServerNofile = limit.status === 0 && soft
    ? `soft ${soft}, hard ${hard ?? "unknown"}`
    : describeRun(limit);
  return out;
}

function sysctlValues(run: Runner, names: string[]): Map<string, string> {
  const r = run("sysctl", names);
  const values = new Map<string, string>();
  for (const line of lines(r.stdout)) {
    const m = /^([\w.]+):\s*(.*)$/.exec(line);
    if (m) values.set(m[1], m[2]);
  }
  return values;
}

export function describeMachine(run: Runner, uid: number, devDir = "/dev"): Record<string, string> {
  const sys = sysctlValues(run, ["kern.maxprocperuid", "kern.maxproc", "kern.num_files", "kern.maxfiles"]);
  const value = (name: string) => sys.get(name) ?? "?";
  const procs = (args: string[]) => {
    const r = run("ps", args);
    return r.status === 0 ? String(lines(r.stdout).length) : describeRun(r);
  };
  const out: Record<string, string> = {
    processes: `user ${procs(["-U", String(uid), "-o", "pid="])}/${value("kern.maxprocperuid")}, `
      + `all ${procs(["-A", "-o", "pid="])}/${value("kern.maxproc")}`,
    openFiles: `${value("kern.num_files")}/${value("kern.maxfiles")}`,
  };

  // Two ways a session can still reference a pty the kernel has released: its
  // controlling tty has no /dev node, or the minor was reused and two session
  // leaders now name the same tty. A controlling process's exit revokes every
  // vnode with its tty's device number, so the second can revoke a new pane's.
  const ttys = run("ps", ["-Ao", "tty=,stat=,pid=,comm="]);
  if (ttys.status === 0) {
    const names = new Set<string>();
    const leaders = new Map<string, string[]>();
    for (const line of lines(ttys.stdout)) {
      const [tty, stat, pid, ...comm] = line.split(/\s+/);
      if (!/^ttys\d+$/.test(tty)) continue;
      names.add(tty);
      if (stat?.includes("s")) leaders.set(tty, [...(leaders.get(tty) ?? []), `${comm.join(" ")}[${pid}]`]);
    }
    const orphaned = [...names].filter((t) => !fs.existsSync(`${devDir}/${t}`)).sort();
    out.cttyWithoutNode = orphaned.length === 0
      ? `none of ${names.size}`
      : `${orphaned.length} of ${names.size}: ${orphaned.join(" ")}`;
    const shared = [...leaders].filter(([, l]) => l.length > 1).sort(([a], [b]) => a.localeCompare(b));
    out.ttysWithTwoSessions = shared.length === 0
      ? "none"
      : shared.map(([tty, l]) => `${tty}: ${l.join(", ")}`).join("; ");
  } else {
    out.cttyWithoutNode = describeRun(ttys);
    out.ttysWithTwoSessions = out.cttyWithoutNode;
  }
  return out;
}

export function holdersByCommand(census: PtyCensus | null): string {
  if (!census) return "unavailable: no census";
  const byCommand = new Map<string, { ptys: number; procs: number }>();
  for (const h of census.holders) {
    const entry = byCommand.get(h.command) ?? { ptys: 0, procs: 0 };
    entry.ptys += h.count;
    entry.procs += 1;
    byCommand.set(h.command, entry);
  }
  if (byCommand.size === 0) return "none visible";
  return [...byCommand]
    .sort((a, b) => b[1].ptys - a[1].ptys || a[0].localeCompare(b[0]))
    .map(([cmd, { ptys, procs }]) => `${cmd}: ${ptys} (${procs} proc${procs === 1 ? "" : "s"})`)
    .join("; ");
}

export interface FailureContext {
  project: string;
  worker: string;
  failedAt?: number;
}

export interface CaptureDeps {
  run?: Runner;
  census?: () => PtyCensus | null;
  dispatchKernelLog?: (ctx: Required<FailureContext>) => void;
}

// Null for any error that is not a pane fork failure. Otherwise the `cause`
// line (the census count, as before) plus the evidence fields to merge into the
// caller's failure log entry. The kernel log needs the seconds after the
// failure too, so it is read by a detached process that logs a sibling entry.
export function capturePtyFailure(
  err: unknown,
  ctx: FailureContext,
  deps: CaptureDeps = {},
): { cause: string; data: Record<string, string> } | null {
  if (!isPaneForkFailure(err)) return null;
  const run = deps.run ?? defaultRunner;
  const failedAt = ctx.failedAt ?? Date.now();
  let census: PtyCensus | null = null;
  try {
    census = (deps.census ?? takePtyCensus)();
  } catch { /* the cause line below states what tmux reported */ }

  const data: Record<string, string> = err instanceof PaneForkFailure
    ? { ...err.probes }
    : { freshOpenpty: "not probed", throwawayTmux: "not probed", retry: "not probed" };
  const section = (fn: () => Record<string, string>, key: string) => {
    try {
      Object.assign(data, fn());
    } catch (e) {
      data[key] = `unavailable: ${String(e)}`;
    }
  };
  section(() => describeTmuxServer(run, failedAt), "tmuxServer");
  section(() => describeMachine(run, process.getuid?.() ?? 0), "processes");
  data.ptmxHolders = holdersByCommand(census);
  try {
    (deps.dispatchKernelLog ?? dispatchKernelLogCapture)({ ...ctx, failedAt });
    data.kernelLog = "read after the failure; logged as \"kernel log around pane fork failure\"";
  } catch (e) {
    data.kernelLog = `unavailable: ${String(e)}`;
  }
  return { cause: describePtyFailure(census), data };
}

export function dispatchKernelLogCapture(ctx: Required<FailureContext>): void {
  const cmd = `${resolveGardenRunner()} dashboard _pty-kernel-log `
    + `${shellEscape(String(ctx.failedAt))} ${shellEscape(ctx.project)} ${shellEscape(ctx.worker)}`;
  spawn("sh", ["-c", cmd], { detached: true, stdio: "ignore" }).unref();
}

// `log show` reads local wall-clock times.
export function formatLogShowTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function readKernelLog(failedAt: number, run: Runner = defaultRunner): Record<string, string> {
  const start = formatLogShowTime(failedAt - KERNEL_LOG_BEFORE_MS);
  const end = formatLogShowTime(failedAt + KERNEL_LOG_AFTER_MS);
  const window = `${start} to ${end} local`;
  const r = run("/usr/bin/log", [
    "show", "--start", start, "--end", end, "--predicate", 'process == "kernel"', "--style", "compact",
  ]);
  if (r.status !== 0) return { window, kernelLog: describeRun(r) };
  const rows = lines(r.stdout).filter((l) => !l.startsWith("Timestamp") && !l.startsWith("Filtering the log data"));
  if (rows.length === 0) return { window, kernelLog: "no kernel lines" };
  const shown = rows.slice(0, KERNEL_LOG_MAX_LINES);
  const more = rows.length > shown.length ? ` | (${rows.length - shown.length} more lines not shown)` : "";
  // One line, so the pretty logs view can wrap it like any other detail.
  return { window, kernelLines: String(rows.length), kernelLog: shown.join(" | ") + more };
}

// The `_pty-kernel-log` route: wait until the window closes, then read it.
export async function runKernelLogCapture(
  failedAt: number,
  project: string,
  worker: string,
  run: Runner = defaultRunner,
): Promise<void> {
  const wait = failedAt + KERNEL_LOG_AFTER_MS + 1_000 - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  let data: Record<string, string>;
  try {
    data = readKernelLog(failedAt, run);
  } catch (err) {
    data = { kernelLog: `unavailable: ${String(err)}` };
  }
  log.info("workers", "kernel log around pane fork failure", {
    worker,
    data: { project, failedAt: new Date(failedAt).toISOString(), ...data },
  });
}

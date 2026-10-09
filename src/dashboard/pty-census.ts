// Pseudo-terminal census: who holds the machine's ptys, and on whose behalf.
//
// macOS caps allocated ptys machine-wide (kern.tty.ptmx_max, 511 by default).
// Every tmux pane needs one, so when the cap is reached tmux cannot fork a
// pane's shell and every worker spawn fails with "fork failed: Device not
// configured". That error is ENXIO, which the kernel returns at the cap, but
// it is not proof of the cap: during the 2026-10-04 failures a worker counted
// 79 of 511 allocated, 20s before and 5s after a failed spawn. Every spawn
// failure therefore takes a census at that moment and reports the count, so
// the next one settles whether the limit was reached.
//
// The census also names who holds the ptys. The kernel's allocation count comes from
// /dev (each allocated pty has a /dev/ttysNNN node, including ones held by
// processes lsof cannot see), and attribution comes from lsof's view of who
// holds /dev/ptmx open. A holder is attributed to the garden pane it descends
// from, or — for a process reparented away from its dead pane — to the worker
// worktree it is running in. The tmux server holds one pty per pane by design,
// so it is reported against the live pane count: a gap there is a tmux leak.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Above this share of the limit the watchdog alerts. Far enough below the cap
// that the operator learns of a leak days before a spawn fails.
export const PTY_PRESSURE_RATIO = 0.7;

const PTY_NODE = /^ttys\d{3,}$/;
const LSOF_ROW = /^(.+?)\s+(\d+)\s+\S+\s+\S+\s+CHR\s+\d+,(\d+)\s/;
const PANE_ROW = /^(\d+) (.+)$/;

export interface PtyHolder {
  pid: number;
  command: string;
  // Distinct ptys this process holds the master side of.
  count: number;
  // The garden window it serves, "tmux server", or "outside garden".
  owner: string;
}

export interface PtyCensus {
  inUse: number;
  limit: number | null;
  holders: PtyHolder[];
  // The garden tmux server's pty count against its live panes. Equal when
  // healthy; a surplus is ptys tmux kept after their panes went away.
  tmuxServer: { held: number; panes: number } | null;
}

export function countAllocatedPtys(devDir = "/dev"): number {
  return fs.readdirSync(devDir).filter((name) => PTY_NODE.test(name)).length;
}

export function readPtyLimit(): number | null {
  const out = spawnSync("sysctl", ["-n", "kern.tty.ptmx_max"], { encoding: "utf-8" });
  const limit = Number.parseInt(out.stdout ?? "", 10);
  return out.status === 0 && limit > 0 ? limit : null;
}

// Parse `lsof -n /dev/ptmx` into per-process holdings, counting distinct
// pty minors (iTerm2 and its server process share masters, and one process
// may hold the same master on two fds).
export function parsePtmxHolders(lsofOut: string): Map<number, { command: string; minors: Set<string> }> {
  const byPid = new Map<number, { command: string; minors: Set<string> }>();
  for (const line of lsofOut.split("\n").slice(1)) {
    const m = LSOF_ROW.exec(line);
    if (!m) continue;
    const pid = Number(m[2]);
    const entry = byPid.get(pid) ?? { command: m[1].trim(), minors: new Set<string>() };
    entry.minors.add(m[3]);
    byPid.set(pid, entry);
  }
  return byPid;
}

export function parseParents(psOut: string): Map<number, number> {
  const parents = new Map<number, number>();
  for (const line of psOut.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (Number.isInteger(pid) && Number.isInteger(ppid)) parents.set(pid, ppid);
  }
  return parents;
}

export function parsePanes(listPanesOut: string): Map<number, string> {
  const panes = new Map<number, string>();
  for (const line of listPanesOut.split("\n")) {
    const m = PANE_ROW.exec(line.trim());
    if (m) panes.set(Number(m[1]), m[2]);
  }
  return panes;
}

// A worktree path names its worker: ~/.garden/worktrees/<project>/<worker>/…
export function workerFromCwd(cwd: string, worktreeBase: string): string | null {
  const rel = path.relative(worktreeBase, cwd);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const [project, worker] = rel.split(path.sep);
  return project && worker ? `${project}/${worker}` : null;
}

export function attributeHolder(
  pid: number,
  parents: Map<number, number>,
  panes: Map<number, string>,
  cwd: string | undefined,
  worktreeBase: string,
): string {
  const seen = new Set<number>();
  for (let p: number | undefined = pid; p && p > 1 && !seen.has(p); p = parents.get(p)) {
    seen.add(p);
    const window = panes.get(p);
    if (window) return window;
  }
  const worker = cwd ? workerFromCwd(cwd, worktreeBase) : null;
  return worker ? `${worker} (detached)` : "outside garden";
}

function run(cmd: string, args: string[]): string {
  return spawnSync(cmd, args, { encoding: "utf-8" }).stdout ?? "";
}

function readCwds(pids: number[]): Map<number, string> {
  const cwds = new Map<number, string>();
  if (pids.length === 0) return cwds;
  let pid = 0;
  for (const line of run("lsof", ["-a", "-p", pids.join(","), "-d", "cwd", "-F", "pn"]).split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n")) cwds.set(pid, line.slice(1));
  }
  return cwds;
}

// Null where the census cannot be taken: off macOS, where neither the /dev
// naming nor the sysctl applies.
export function takePtyCensus(): PtyCensus | null {
  if (process.platform !== "darwin") return null;
  const holdings = parsePtmxHolders(run("lsof", ["-n", "/dev/ptmx"]));
  const parents = parseParents(run("ps", ["-Ao", "pid=,ppid="]));
  const panes = parsePanes(run("tmux", ["list-panes", "-a", "-F", "#{pane_pid} #{window_name}"]));
  const serverPid = Number.parseInt(run("tmux", ["display-message", "-p", "#{pid}"]), 10);
  const worktreeBase = path.join(process.env.HOME ?? "", ".garden", "worktrees");
  const others = [...holdings.keys()].filter((pid) => pid !== serverPid);
  const cwds = readCwds(others);

  const holders: PtyHolder[] = [...holdings].map(([pid, { command, minors }]) => ({
    pid,
    command,
    count: minors.size,
    owner: pid === serverPid
      ? "tmux server"
      : attributeHolder(pid, parents, panes, cwds.get(pid), worktreeBase),
  }));
  holders.sort((a, b) => b.count - a.count || a.pid - b.pid);
  const server = holdings.get(serverPid);
  return {
    inUse: countAllocatedPtys(),
    limit: readPtyLimit(),
    holders,
    tmuxServer: server ? { held: server.minors.size, panes: panes.size } : null,
  };
}

// The holdings that are not explained by a live pane. A change here is what
// the watchdog logs: tmux's own pane ptys churn with every review and are
// noise, while anything else growing is the leak this census exists to find.
export function unexplainedHoldings(census: PtyCensus): string[] {
  const rows = census.holders
    .filter((h) => h.owner !== "tmux server")
    .map((h) => `${h.command}[${h.pid}] ${h.owner}: ${h.count}`);
  const surplus = census.tmuxServer ? census.tmuxServer.held - census.tmuxServer.panes : 0;
  if (surplus > 0) rows.push(`tmux server surplus over panes: ${surplus}`);
  return rows.sort();
}

export function formatTopHolders(census: PtyCensus, n = 3): string {
  return census.holders.slice(0, n).map((h) => {
    const label = h.owner === "tmux server" && census.tmuxServer
      ? `tmux server (${census.tmuxServer.panes} panes)`
      : `${h.command} pid ${h.pid}, ${h.owner}`;
    return `${label}: ${h.count}`;
  }).join("; ");
}

export function isPtyPressure(census: PtyCensus): boolean {
  return census.limit !== null && census.inUse >= census.limit * PTY_PRESSURE_RATIO;
}

// tmux reports a failed pane fork with the errno text of ENXIO, which on macOS
// means posix_openpt found no free pty. Translate it into what the operator
// can act on, with the census naming who holds them.
export function explainPtyFailure(err: unknown): string | null {
  if (!String(err).includes("fork failed: Device not configured")) return null;
  let census: PtyCensus | null = null;
  try {
    census = takePtyCensus();
  } catch { /* the message below still states what tmux reported */ }
  if (!census) return "tmux could not open a pseudo-terminal for the pane";
  const holders = `top holders: ${formatTopHolders(census)}`;
  if (census.limit === null) return `tmux could not open a pseudo-terminal for the pane (${census.inUse} in use; ${holders})`;
  const usage = `${census.inUse}/${census.limit} in use`;
  return census.inUse >= census.limit
    ? `out of pseudo-terminals (${usage}; ${holders})`
    : `tmux could not open a pseudo-terminal for the pane, below the machine limit (${usage}; ${holders})`;
}

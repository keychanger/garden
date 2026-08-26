// Reaping a removed worker's leftover processes.
//
// Killing a worker's tmux window kills the pane's foreground process group. It
// does NOT kill anything the worker daemonized: a `npm run dev` left running in
// the background reparents to init and survives the pane, the registry entry,
// and the worktree removal. Because its cwd is still inside the deleted
// directory, its next cache flush recreates the path git just deleted — so the
// worktree comes back as a husk that no registry entry claims, and the watchdog
// reports it as an orphan an hour later. That is exactly how
// keychange-ai/mute-wry-dove returned 57 seconds after a clean removal, as an
// empty `.next/cache/webpack` tree, while the dev server itself held port 3333
// for a day (2026-08-25).
//
// So cleanup reaps before it removes. The rule enforced here is the invariant
// that actually matters — no process may be living inside the directory we are
// about to delete — rather than "descendants of the dead pane". Ancestry is the
// wrong test: the process we need to kill has already been reparented away from
// the pane by the time anyone can look, and a cwd sweep catches it regardless.
// It is also idempotent, so the watchdog's cleanup retry re-reaps for free.
//
// The target directory must always be the canonical worktree path Garden
// derives from a validated (project, worker) pair — never a path read out of a
// worker-writable request body. Aiming this at an attacker-chosen directory
// would hand an unsandboxed watchdog a machine-wide process killer.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { log } from "./log.js";

// How long a process may take to honor SIGTERM before it is killed outright.
// Generous enough for a dev server to close its listeners, short enough that
// cleanup (already detached) stays well inside the watchdog's retry window.
const TERM_GRACE_MS = 2_000;
const POLL_MS = 100;

export interface ReapOutcome {
  // Exited on SIGTERM.
  terminated: number[];
  // Needed SIGKILL.
  killed: number[];
  // Still alive after SIGKILL — uninterruptible, or not ours to signal.
  survived: number[];
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Parse `lsof -d cwd -F pn` into the pids whose cwd is inside root.
//
// lsof's -F output is one field per line: `p<pid>` opens a process block and
// `n<path>` carries the value, here the cwd. Anything else (`f`, trailing
// blanks, a warning that slipped onto stdout) is ignored rather than trusted.
//
// Note for anyone extending the lsof call: lsof ORs its selection options
// unless `-a` is given, so adding `-u <uid>` to "narrow" this to our own user
// actually widens it to every fd that user holds — measured at 26s and 24x the
// output, versus 0.24s for the single-criterion form used here.
export function selectReapTargets(
  lsofOutput: string,
  root: string,
  protectedPids: ReadonlySet<number>,
): number[] {
  // Compare against a separator-normalized root, so `<root>` and `<root>/`
  // select the same set and a sibling worktree whose name merely starts with
  // this one's (`<root>-2`) is never swept up with it.
  const base = root.endsWith(path.sep) ? root.slice(0, -path.sep.length) : root;
  const prefix = base + path.sep;
  const targets: number[] = [];
  let pid = Number.NaN;
  for (const line of lsofOutput.split("\n")) {
    if (line.startsWith("p")) {
      pid = Number.parseInt(line.slice(1), 10);
      continue;
    }
    if (!line.startsWith("n")) continue;
    // pid 1 is init and pid 0 is the kernel; neither is ever a worker's child,
    // and signaling them is never what a worktree sweep meant to do.
    if (!Number.isSafeInteger(pid) || pid <= 1) continue;
    const cwd = line.slice(1);
    if (cwd !== base && !cwd.startsWith(prefix)) continue;
    if (protectedPids.has(pid)) continue;
    if (!targets.includes(pid)) targets.push(pid);
  }
  return targets;
}

// Self plus every ancestor, parsed from `ps -Ao pid,ppid`.
//
// `garden workers stop` run from inside the doomed worktree hands its cwd to
// the detached cleanup child, which puts this whole chain in the target set —
// so without this guard the reaper's first victim would be itself, and its
// second the operator's interactive shell.
export function ancestorPids(psOutput: string, self: number): Set<number> {
  const parent = new Map<number, number>();
  for (const line of psOutput.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (match) parent.set(Number(match[1]), Number(match[2]));
  }
  const chain = new Set<number>([self]);
  let current = self;
  // Bounded walk: a malformed or cyclic table must not spin the cleanup.
  for (let depth = 0; depth < 64; depth++) {
    const next = parent.get(current);
    if (next === undefined || next <= 1 || chain.has(next)) break;
    chain.add(next);
    current = next;
  }
  return chain;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Deliver a signal and report which of the three things happened, because they
// mean different things to the caller: "gone" is success, "denied" is the only
// genuine failure, and conflating them would report either as the other.
function trySignal(pid: number, sig: NodeJS.Signals): "sent" | "gone" | "denied" {
  try {
    process.kill(pid, sig);
    return "sent";
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "denied";
  }
}

// Read the process table. Returns null when the tools are unavailable or denied
// — a sandboxed caller gets neither, which is the same reason git cleanup can
// fail there, and is handled the same way: give up quietly and let the
// watchdog's unsandboxed retry do the work.
function readProcessTable(): { cwds: string; ps: string } | null {
  const opts = { encoding: "utf-8" as const, timeout: 10_000, maxBuffer: 16 * 1024 * 1024 };
  // lsof exits nonzero when any process denies inspection, which is routine and
  // not a reason to discard the entries it did return — so read stdout on its
  // own terms instead of letting a nonzero status throw the result away.
  const cwds = spawnSync("lsof", ["-d", "cwd", "-F", "pn"], opts);
  const ps = spawnSync("ps", ["-Ao", "pid,ppid"], opts);
  if (cwds.error || ps.error) return null;
  if (typeof cwds.stdout !== "string" || typeof ps.stdout !== "string") return null;
  if (cwds.stdout === "" || ps.stdout === "") return null;
  return { cwds: cwds.stdout, ps: ps.stdout };
}

// Kill every process living inside `root`. Best-effort by design: the caller's
// contract is the git cleanup, and a reap that could not run must never fail
// the removal it precedes. Returns null when the process table was unreadable.
export function reapWorktreeProcesses(root: string): ReapOutcome | null {
  const table = readProcessTable();
  if (!table) return null;

  // lsof reports resolved paths, so the comparison root must be resolved too. A
  // symlinked component anywhere above the worktree (`/var` → `/private/var` on
  // macOS, or a symlinked HOME) would otherwise match nothing and reap nothing,
  // silently — the sweep would look like it ran and found the tree empty.
  let resolved = root;
  try {
    resolved = fs.realpathSync(root);
  } catch {
    // Already removed: fall back to the literal path. A husk recreated under
    // an unresolved path still matches when no component is a symlink.
  }

  const targets = selectReapTargets(
    table.cwds, resolved, ancestorPids(table.ps, process.pid),
  );
  if (targets.length === 0) return { terminated: [], killed: [], survived: [] };

  for (const pid of targets) trySignal(pid, "SIGTERM");

  const deadline = Date.now() + TERM_GRACE_MS;
  let stubborn = targets.filter(isAlive);
  while (stubborn.length > 0 && Date.now() < deadline) {
    sleepSync(POLL_MS);
    stubborn = stubborn.filter(isAlive);
  }

  // SIGKILL cannot be caught or ignored, so a delivered one IS the kill —
  // there is nothing to poll for afterwards. Re-checking liveness here would
  // report a zombie (exited, not yet reaped by its parent) as a survivor,
  // since it still answers kill(pid, 0). Only a refused signal is a failure.
  const killed: number[] = [];
  const survived: number[] = [];
  for (const pid of stubborn) {
    if (trySignal(pid, "SIGKILL") === "denied") survived.push(pid);
    else killed.push(pid);
  }

  return {
    terminated: targets.filter((pid) => !stubborn.includes(pid)),
    killed,
    survived,
  };
}

// Reap and report. Split from reapWorktreeProcesses so the decision to log
// stays out of the part under test.
export function reapAndLog(project: string, worker: string, root: string): void {
  const outcome = reapWorktreeProcesses(root);
  if (!outcome) {
    log.debug("cleanup", "process reap skipped; process table unreadable", {
      worker,
      data: { project, worktree: root },
    });
    return;
  }
  const total = outcome.terminated.length + outcome.killed.length + outcome.survived.length;
  if (total === 0) return;

  // Worth an info line rather than debug: a worker that leaves processes behind
  // is the operator's signal that something it started outlived it — the very
  // thing that was previously invisible until an orphan alert an hour later.
  log.info("cleanup", "reaped processes still living in the worktree", {
    worker,
    data: {
      project,
      worktree: root,
      terminated: outcome.terminated,
      killed: outcome.killed,
      survived: outcome.survived,
    },
  });
  if (outcome.survived.length > 0) {
    log.warn("cleanup", "processes survived SIGKILL in the worktree", {
      worker,
      data: { project, worktree: root, survived: outcome.survived },
    });
  }
}

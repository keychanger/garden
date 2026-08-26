import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { reapWorktreeProcesses, ancestorPids } from "../../src/dashboard/worker-reap.js";

// The real boundary this feature rests on is the process table: whether an lsof
// cwd sweep actually finds a process that outlived its parent, and whether
// signaling it works. Mocks would prove nothing here — the motivating bug was a
// reparented daemon that every ancestry-based check missed.

// The sweep needs a readable process table, and a sandboxed runner does not
// have one: `garden checks` inside a worker's Seatbelt profile is denied `ps`
// and `lsof` outright — the same denial the shipped reap degrades on by
// returning null and leaving the work to the unsandboxed watchdog retry.
// Skipping there is honest; CI and an unsandboxed machine run the whole file.
function processTableReadable(): boolean {
  const cwds = spawnSync("lsof", ["-d", "cwd", "-F", "pn"], { encoding: "utf-8" });
  const ps = spawnSync("ps", ["-Ao", "pid,ppid"], { encoding: "utf-8" });
  return !cwds.error && !ps.error
    && (cwds.stdout ?? "") !== "" && (ps.stdout ?? "") !== "";
}

const spawned: number[] = [];
const dirs: string[] = [];

function tmpDir(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  dirs.push(dir);
  // Resolve symlinks (/var → /private/var on macOS): lsof reports real paths,
  // and the canonical worktree path the caller passes is likewise real.
  return fs.realpathSync(dir);
}

// A process sitting in `cwd` whose parent has already exited, so it is
// reparented to init — the exact shape of a worker's leftover `npm run dev`
// after its pane is killed, and the shape every ancestry-based check misses.
//
// Deliberately NOT a child of this test process: our own child would linger as
// a zombie after being killed (nothing has waited on it yet), and a zombie
// still answers kill(pid, 0) — so the test would be asserting against a
// liveness signal that does not mean what it means in production.
function detachedSleeper(cwd: string): number {
  const started = spawnSync("sh", ["-c", "sleep 120 >/dev/null 2>&1 & echo $!"], {
    cwd, encoding: "utf-8",
  });
  const pid = Number.parseInt(started.stdout.trim(), 10);
  if (!Number.isSafeInteger(pid)) throw new Error(`no pid from sh: ${started.stdout}`);
  spawned.push(pid);
  return pid;
}

function detachedTermIgnoringProcess(cwd: string): number {
  const started = spawnSync(
    "sh",
    ["-c", `sh -c 'trap "" TERM; while :; do sleep 1; done' >/dev/null 2>&1 & echo $!`],
    { cwd, encoding: "utf-8" },
  );
  const pid = Number.parseInt(started.stdout.trim(), 10);
  if (!Number.isSafeInteger(pid)) throw new Error(`no pid from sh: ${started.stdout}`);
  spawned.push(pid);
  return pid;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForCwd(pid: number): Promise<void> {
  // The child's cwd is set before exec, but lsof needs the process to exist.
  for (let i = 0; i < 50; i++) {
    if (alive(pid)) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`process ${pid} never started`);
}

afterEach(() => {
  for (const pid of spawned.splice(0)) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already reaped */ }
  }
  for (const dir of dirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe.skipIf(!processTableReadable())("reapWorktreeProcesses", () => {
  it("kills a detached process living in the worktree", async () => {
    const worktree = tmpDir("garden-reap-");
    const pid = detachedSleeper(worktree);
    await waitForCwd(pid);

    const outcome = reapWorktreeProcesses(worktree);

    expect(outcome).not.toBeNull();
    expect([...outcome!.terminated, ...outcome!.killed]).toContain(pid);
    expect(outcome!.survived).toEqual([]);
    expect(alive(pid)).toBe(false);
  });

  it("kills a process in a subdirectory of the worktree", async () => {
    const worktree = tmpDir("garden-reap-");
    const nested = path.join(worktree, ".next", "cache", "webpack");
    fs.mkdirSync(nested, { recursive: true });
    const pid = detachedSleeper(nested);
    await waitForCwd(pid);

    const outcome = reapWorktreeProcesses(worktree);

    expect([...outcome!.terminated, ...outcome!.killed]).toContain(pid);
    expect(alive(pid)).toBe(false);
  });

  it("escalates only after re-confirming a TERM-ignoring process cwd", async () => {
    const worktree = tmpDir("garden-reap-");
    const pid = detachedTermIgnoringProcess(worktree);
    await waitForCwd(pid);

    const outcome = reapWorktreeProcesses(worktree);

    expect(outcome!.killed).toContain(pid);
    expect(outcome!.survived).toEqual([]);
  });

  it("leaves a process in a neighboring directory alone", async () => {
    const worktree = tmpDir("garden-reap-");
    const neighbor = tmpDir("garden-reap-");
    const spared = detachedSleeper(neighbor);
    await waitForCwd(spared);

    const outcome = reapWorktreeProcesses(worktree);

    expect(outcome).not.toBeNull();
    expect([...outcome!.terminated, ...outcome!.killed]).not.toContain(spared);
    expect(alive(spared)).toBe(true);
  });

  it("preserves an initiator pid captured before detached cleanup", async () => {
    const worktree = tmpDir("garden-reap-");
    const spared = detachedSleeper(worktree);
    await waitForCwd(spared);

    const outcome = reapWorktreeProcesses(worktree, new Set([spared]));

    expect(outcome).toEqual({ terminated: [], killed: [], survived: [] });
    expect(alive(spared)).toBe(true);
  });

  it("protects its own chain as the real process table reports it", () => {
    // Self-protection, proven against real `ps` output rather than by aiming
    // the reaper at a shared directory — pointing it at this runner's cwd would
    // sweep up any other process sitting in the repo, including an operator's
    // shell. The kill-side guard is the same set this asserts.
    const ps = spawnSync("ps", ["-Ao", "pid,ppid"], { encoding: "utf-8" });
    const chain = ancestorPids(ps.stdout, process.pid);

    expect(chain.has(process.pid)).toBe(true);
    expect(chain.has(process.ppid)).toBe(true);
    expect(chain.has(1)).toBe(false);
  });

  it("reports an empty outcome for a directory nothing lives in", () => {
    const outcome = reapWorktreeProcesses(tmpDir("garden-reap-"));

    expect(outcome).toEqual({ terminated: [], killed: [], survived: [] });
  });
});

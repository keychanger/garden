// FIFO-based poke primitives shared across the poller modules. Lives outside
// poller-state / poller-review / poller-merge / poller-resolve so each can
// depend on these helpers without forming a cycle through poller.ts (the
// coordinator), which itself imports from the lifecycle modules.
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { SESSIONS_DIR } from "../config.js";
import { findWorkerByName } from "./registry.js";
import { log } from "./log.js";
import { shellEscape } from "./tmux.js";

export function signalFifoPath(project: string): string {
  return path.join(SESSIONS_DIR, `${project}-poll-signal`);
}

// Poke the project's poller without blocking. The poller blocks on `read` from
// the FIFO; any byte wakes it for one cycle.
export function triggerProjectPoll(projectName: string): void {
  const fifo = signalFifoPath(projectName);
  try {
    const fd = fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
    fs.writeSync(fd, "\n");
    fs.closeSync(fd);
    log.debug("poller", "triggered poll", { data: { project: projectName } });
  } catch {
    // FIFO not ready or poller not running
  }
}

// Detached subprocess that sleeps then writes one byte to the project's poll
// FIFO. The detach is load-bearing: every caller runs inside the short-lived
// `_poll <project>` Node child the bash poll loop spawns per tick, and that
// child exits as soon as its synchronous lifecycle work returns. An
// in-process `setTimeout(...).unref()` is silently terminated at that exit
// (Node drops unref'd timers when the event loop has no other work), so the
// poke never reaches the FIFO and the bash loop blocks on `read` forever —
// workers stranded in `merge-pending`, `failing → working` debounce never
// fires, etc. Empirically: `node -e "setTimeout(fn, 0).unref()"` exits
// without running fn.
//
// Why `1<>${fifo}` rather than the old `echo > ${fifo}`: `echo > FIFO` opens
// O_WRONLY which blocks at open(2) when no reader exists — when the poller
// window died (test cleanup, dashboard crash) the bash sat orphaned forever,
// accumulating 200+ such orphans over weeks. The `<>` redirect opens R+W,
// which never blocks on FIFOs (the kernel allows the open even with no other
// party); the byte is buffered, the bash exits cleanly. If no reader ever
// arrives, the FIFO is eventually unlinked and the buffer reclaimed — no
// orphan accumulation.
export function scheduleDelayedPoke(projectName: string, delayMs: number): void {
  const fifo = signalFifoPath(projectName);
  const delaySec = Math.max(0, Math.ceil(delayMs / 1000));
  try {
    const child = spawn(
      "bash",
      ["-c", `sleep ${delaySec}; printf '\\n' 1<>${shellEscape(fifo)}`],
      { detached: true, stdio: "ignore" },
    );
    child.unref();
  } catch (err) {
    log.warn("poller", "scheduleDelayedPoke spawn failed", {
      data: { project: projectName, error: String(err) },
    });
  }
}

// Worker liveness from the registry (set by Claude Code hooks). Used by
// lifecycle handlers to defer work that would race the worker's own session.
export function isWorkerClaudeWorking(projectName: string, workerName: string): boolean {
  const entry = findWorkerByName(projectName, workerName);
  return entry?.agentStatus === "working";
}

// Create the FIFO if missing; idempotent. Used by startProjectPoller and any
// caller that wants to trigger before the poller window is up.
export function ensureSignalFifo(fifoPath: string): void {
  try {
    const stat = fs.statSync(fifoPath);
    if (stat.isFIFO()) return;
    fs.unlinkSync(fifoPath);
  } catch { /* doesn't exist */ }
  fs.mkdirSync(path.dirname(fifoPath), { recursive: true });
  // mkfifo is the syscall; node has no direct binding, so shell out.
  execFileSync("mkfifo", [fifoPath]);
}

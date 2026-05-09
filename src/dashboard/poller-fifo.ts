// FIFO-based poke primitives shared across the poller modules. Lives outside
// poller-state / poller-review / poller-merge / poller-resolve so each can
// depend on these helpers without forming a cycle through poller.ts (the
// coordinator), which itself imports from the lifecycle modules.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { SESSIONS_DIR } from "../config.js";
import { findWorkerByName } from "./registry.js";
import { log } from "./log.js";

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

// In-process timer that pokes the poller after delayMs. Replaces the older
// `bash -c "sleep N && echo > FIFO"` watchdog whose `echo > FIFO` blocked
// forever on `open(2)` when the FIFO had no reader (poller window dead, test
// temp dir cleaned up): writes accumulated 200+ orphan bash processes over
// weeks. setTimeout + non-blocking triggerProjectPoll() side-steps the leak —
// the timer dies cleanly with the dashboard process, and the FIFO write fails
// fast when no one is reading.
export function scheduleDelayedPoke(projectName: string, delayMs: number): void {
  setTimeout(() => triggerProjectPoll(projectName), Math.max(0, delayMs)).unref();
}

// Worker liveness from the registry (set by Claude Code hooks). Used by
// lifecycle handlers to defer work that would race the worker's own session.
export function isWorkerClaudeWorking(projectName: string, workerName: string): boolean {
  const entry = findWorkerByName(projectName, workerName);
  return entry?.claudeStatus === "working";
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

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { useTmpHome } from "./helpers.js";

// sweepBootstrapScripts and housekeeping read SESSIONS_DIR, which config.js
// freezes from HOME at import — so import watchdog.js dynamically AFTER
// useTmpHome has redirected HOME (same pattern as log.test.ts's truncateLog).
const env = useTmpHome();

async function importWatchdog() {
  return await import("../src/dashboard/watchdog.js");
}

function writeBootstrap(dir: string, name: string, ageMs: number, nowMs: number): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, "#!/bin/sh\necho bootstrap\n");
  const t = (nowMs - ageMs) / 1000; // utimesSync takes seconds
  fs.utimesSync(file, t, t);
  return file;
}

describe("sweepBootstrapScripts", () => {
  it("deletes bootstrap scripts older than the max age, keeps fresh ones", async () => {
    const { sweepBootstrapScripts, BOOTSTRAP_MAX_AGE_MS } = await importWatchdog();
    const now = 1_000_000_000_000;
    const dir = env.sessionsDir;

    const stale1 = writeBootstrap(dir, "bootstrap-garden-old-elk.sh", BOOTSTRAP_MAX_AGE_MS + 60_000, now);
    const stale2 = writeBootstrap(dir, "bootstrap-lex-old-wren.sh", BOOTSTRAP_MAX_AGE_MS * 100, now);
    const fresh = writeBootstrap(dir, "bootstrap-garden-new-fox.sh", 5_000, now);

    const removed = sweepBootstrapScripts(now);

    expect(removed).toBe(2);
    expect(fs.existsSync(stale1)).toBe(false);
    expect(fs.existsSync(stale2)).toBe(false);
    // A just-written script (about to be consumed by its pane) survives.
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it("only touches bootstrap-*.sh — leaves other session files alone", async () => {
    const { sweepBootstrapScripts, BOOTSTRAP_MAX_AGE_MS } = await importWatchdog();
    const now = 1_000_000_000_000;
    const dir = env.sessionsDir;
    const oldAge = BOOTSTRAP_MAX_AGE_MS + 60_000;

    // Non-matching neighbors that are just as old must be preserved: the
    // registry, the log, context files, and other view scripts all live here.
    const keepers = [
      writeBootstrap(dir, "dashboard.registry.json", oldAge, now),
      writeBootstrap(dir, "dashboard.log", oldAge, now),
      writeBootstrap(dir, "logs-view.sh", oldAge, now),
      writeBootstrap(dir, "dashboard-garden.context", oldAge, now),
      writeBootstrap(dir, "bootstrap-garden-elk.txt", oldAge, now), // wrong suffix
    ];
    const doomed = writeBootstrap(dir, "bootstrap-garden-elk.sh", oldAge, now);

    const removed = sweepBootstrapScripts(now);

    expect(removed).toBe(1);
    expect(fs.existsSync(doomed)).toBe(false);
    for (const k of keepers) expect(fs.existsSync(k)).toBe(true);
  });

  it("returns 0 and does not throw when the sessions dir is unreadable", async () => {
    const { sweepBootstrapScripts } = await importWatchdog();
    fs.rmSync(env.sessionsDir, { recursive: true, force: true });
    expect(sweepBootstrapScripts(1_000_000_000_000)).toBe(0);
  });
});

describe("housekeeping", () => {
  it("trims an oversized dashboard.log and sweeps stale bootstrap scripts together", async () => {
    const { housekeeping, BOOTSTRAP_MAX_AGE_MS } = await importWatchdog();
    const now = 1_000_000_000_000;
    const dir = env.sessionsDir;

    // > 10MB log so truncateLog trims it.
    const logFile = path.join(dir, "dashboard.log");
    fs.writeFileSync(logFile, ("x".repeat(1023) + "\n").repeat(11 * 1024));
    const stale = writeBootstrap(dir, "bootstrap-garden-old-elk.sh", BOOTSTRAP_MAX_AGE_MS + 60_000, now);

    housekeeping(now);

    expect(fs.statSync(logFile).size).toBeLessThan(11 * 1024 * 1024);
    expect(fs.existsSync(stale)).toBe(false);
  });
});

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

// Orphaned-worktree detection. Uses real directories under the tmp HOME because
// the sweep's whole job is reading what is on disk — WORKTREE_BASE is frozen from
// HOME at git.js import, so the dynamic importWatchdog() above is load-bearing.
function makeWorktree(env: { gardenDir: string }, project: string, name: string, opts: {
  idleMs?: number;
  nowMs?: number;
  files?: Record<string, string>;
} = {}): string {
  const dir = path.join(env.gardenDir, "worktrees", project, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(opts.files ?? { "README.md": "hi\n" })) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  if (opts.idleMs !== undefined && opts.nowMs !== undefined) {
    const t = (opts.nowMs - opts.idleMs) / 1000;
    fs.utimesSync(dir, t, t);
  }
  return dir;
}

const NOW = 1_000_000_000_000;

describe("findOrphanedWorktrees", () => {
  it("reports a worktree no registry entry claims, with its size", async () => {
    const { findOrphanedWorktrees, ORPHAN_WORKTREE_GRACE_MS } = await importWatchdog();
    makeWorktree(env, "garden", "lost-pale-fern", {
      idleMs: ORPHAN_WORKTREE_GRACE_MS + 60_000,
      nowMs: NOW,
      files: { "a.txt": "x".repeat(4096) },
    });

    const orphans = findOrphanedWorktrees({ workers: {} }, NOW);

    expect(orphans.map(o => `${o.project}/${o.name}`)).toEqual(["garden/lost-pale-fern"]);
    expect(orphans[0].bytes).toBeGreaterThanOrEqual(4096);
    expect(orphans[0].idleMs).toBeGreaterThan(ORPHAN_WORKTREE_GRACE_MS);
  });

  it("never reports a worktree a registry entry claims", async () => {
    const { findOrphanedWorktrees, ORPHAN_WORKTREE_GRACE_MS } = await importWatchdog();
    makeWorktree(env, "garden", "live-keen-oak", {
      idleMs: ORPHAN_WORKTREE_GRACE_MS * 100, // ancient, but owned
      nowMs: NOW,
    });

    // Matched on (project, name) — deliberately with NO worktreePath set, the
    // shape validate.ts leaves behind when it clears a missing path.
    const registry = {
      workers: { garden: [{ name: "live-keen-oak" }] },
    } as unknown as Parameters<typeof findOrphanedWorktrees>[0];

    expect(findOrphanedWorktrees(registry, NOW)).toEqual([]);
  });

  it("spares a freshly created worktree — a spawn mid-bootstrap is not an orphan", async () => {
    const { findOrphanedWorktrees } = await importWatchdog();
    // No idleMs: just created, so mtime is now.
    makeWorktree(env, "garden", "new-brisk-elm");

    expect(findOrphanedWorktrees({ workers: {} }, NOW + 1000)).toEqual([]);
  });

  it("spares a worktree whose kill cleanup is still running", async () => {
    const { findOrphanedWorktrees, ORPHAN_WORKTREE_GRACE_MS } = await importWatchdog();
    const { workerCleanupMarkerPath } = await import("../src/dashboard/git.js");
    makeWorktree(env, "garden", "dying-swift-ash", {
      idleMs: ORPHAN_WORKTREE_GRACE_MS + 60_000,
      nowMs: NOW,
    });
    // The detached cleanup writes this and removes it when done; it will delete
    // the tree itself, so the sweep must not report it as garbage meanwhile.
    fs.writeFileSync(workerCleanupMarkerPath("garden", "dying-swift-ash"), "");

    expect(findOrphanedWorktrees({ workers: {} }, NOW)).toEqual([]);
  });

  it("finds orphans across several projects", async () => {
    const { findOrphanedWorktrees, ORPHAN_WORKTREE_GRACE_MS } = await importWatchdog();
    const old = { idleMs: ORPHAN_WORKTREE_GRACE_MS + 60_000, nowMs: NOW };
    makeWorktree(env, "garden", "one-old-yew", old);
    makeWorktree(env, "lex", "two-old-fir", old);

    const found = findOrphanedWorktrees({ workers: {} }, NOW)
      .map(o => `${o.project}/${o.name}`).sort();

    expect(found).toEqual(["garden/one-old-yew", "lex/two-old-fir"]);
  });
});

describe("directoryBytes", () => {
  it("stops at the visit cap and says the size is a floor", async () => {
    const { directoryBytes } = await importWatchdog();
    const dir = path.join(env.gardenDir, "walkme");
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(dir, `f${i}`), "xxxx");

    const capped = directoryBytes(dir, 5);
    expect(capped.truncated).toBe(true);

    const full = directoryBytes(dir, 1000);
    expect(full.truncated).toBe(false);
    expect(full.bytes).toBe(12 * 4);
  });
});

describe("alertOrphanedWorktrees", () => {
  it("alerts once per orphan set, not on every hourly sweep", async () => {
    const { alertOrphanedWorktrees, ORPHAN_WORKTREE_GRACE_MS } = await importWatchdog();
    const { readAlerts } = await import("../src/dashboard/alerts.js");
    makeWorktree(env, "garden", "stale-dim-holt", {
      idleMs: ORPHAN_WORKTREE_GRACE_MS + 60_000, nowMs: NOW,
    });

    expect(alertOrphanedWorktrees(NOW)).toBe(1);
    const afterFirst = readAlerts().alerts.length;
    expect(afterFirst).toBe(1);
    expect(readAlerts().alerts[0].project).toBe("garden");
    expect(readAlerts().alerts[0].message).toContain("stale-dim-holt");

    // Same set an hour later: still found, but the operator is not re-nagged.
    expect(alertOrphanedWorktrees(NOW + 3_600_000)).toBe(1);
    expect(readAlerts().alerts.length).toBe(afterFirst);
  });

  it("alerts again once the set changes, and files one alert per project", async () => {
    const { alertOrphanedWorktrees, ORPHAN_WORKTREE_GRACE_MS } = await importWatchdog();
    const { readAlerts } = await import("../src/dashboard/alerts.js");
    const old = { idleMs: ORPHAN_WORKTREE_GRACE_MS + 60_000, nowMs: NOW };
    makeWorktree(env, "garden", "first-worn-birch", old);

    alertOrphanedWorktrees(NOW);
    expect(readAlerts().alerts.length).toBe(1);

    // A second orphan appears, in a different project.
    makeWorktree(env, "lex", "second-thin-reed", old);
    expect(alertOrphanedWorktrees(NOW)).toBe(2);

    // Both projects file an alert for the new set. garden's own orphan did not
    // change, so its second alert is redundant — accepted deliberately: the
    // signature is fleet-wide (one sweep, one decision), and the alternative is
    // a per-project signature map in dashboard state to save one alert on an
    // event that fires only when the orphan set genuinely changes. It is bounded
    // (never the hourly nag the signature exists to prevent), not a loop.
    const projects = readAlerts().alerts.map(a => a.project).sort();
    expect(projects).toEqual(["garden", "garden", "lex"]);
  });

  it("stays silent when nothing is orphaned", async () => {
    const { alertOrphanedWorktrees } = await importWatchdog();
    const { readAlerts } = await import("../src/dashboard/alerts.js");

    expect(alertOrphanedWorktrees(NOW)).toBe(0);
    expect(readAlerts().alerts.length).toBe(0);
  });
});

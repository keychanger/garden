import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { useTmpHome } from "./helpers.js";

// worker-cleanup.ts resolves SESSIONS_DIR through config.js, which freezes it
// from HOME at import — so import dynamically AFTER useTmpHome redirects HOME
// (same pattern as watchdog-housekeeping.test.ts).
const env = useTmpHome();

beforeEach(() => {
  fs.writeFileSync(
    path.join(env.gardenDir, "config.yml"),
    [
      "projects:",
      "  garden:", "    path: /repo",
      "  wolf:", "    path: /repo",
      "  leadingtone-io:", "    path: /repo",
      "",
    ].join("\n"),
  );
});

async function importCleanup() {
  return await import("../src/dashboard/worker-cleanup.js");
}

function age(file: string, ageMs: number, nowMs: number): void {
  const t = (nowMs - ageMs) / 1000; // utimesSync takes seconds
  fs.utimesSync(file, t, t);
}

describe("worker cleanup requests", () => {
  it("round-trips a request through disk", async () => {
    const { writeWorkerCleanupRequest, readWorkerCleanupRequest } = await importCleanup();
    const { workerCleanupMarkerPath } = await import("../src/dashboard/git.js");

    writeWorkerCleanupRequest({
      project: "leadingtone-io",
      worker: "numb-clear-vow",
      repoPath: "/repo",
      worktreePath: "/wt",
      branchName: "numb-clear-vow",
      protectedPids: [123, 456],
      attempts: 0,
    });

    const file = workerCleanupMarkerPath("leadingtone-io", "numb-clear-vow");
    const read = readWorkerCleanupRequest(file);
    expect(read?.worker).toBe("numb-clear-vow");
    expect(read?.worktreePath).toBe("/wt");
    expect(read?.protectedPids).toEqual([123, 456]);
    expect(read?.attempts).toBe(0);
  });

  it("keeps a request in the control tree, out of the worker-writable sessions dir", async () => {
    // Only unsandboxed garden writes one. In the sessions dir any worker could
    // forge a request and have the unsandboxed retry act on it.
    const { writeWorkerCleanupRequest } = await importCleanup();
    const { workerCleanupMarkerPath } = await import("../src/dashboard/git.js");

    writeWorkerCleanupRequest({
      project: "garden", worker: "bold-calm-ash", repoPath: "/repo", branchName: "bold-calm-ash", attempts: 0,
    });

    const file = workerCleanupMarkerPath("garden", "bold-calm-ash");
    expect(path.dirname(file)).toBe(env.controlDir);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readdirSync(env.sessionsDir).filter(n => n.startsWith("worker-cleanup-"))).toEqual([]);
  });

  it("reads an empty legacy marker as no request", async () => {
    // Markers written by the pre-upgrade `sh -c` path are zero-byte files. They
    // must parse as "nothing to do" rather than crash the sweep.
    const { readWorkerCleanupRequest } = await importCleanup();
    const file = path.join(env.sessionsDir, "worker-cleanup-garden-old-elk");
    fs.writeFileSync(file, "");
    expect(readWorkerCleanupRequest(file)).toBeNull();
  });

  it("rejects a request missing required identity", async () => {
    const { isWorkerCleanupRequest } = await importCleanup();
    expect(isWorkerCleanupRequest({ project: "p", worker: "w", repoPath: "/r", attempts: 0 })).toBe(true);
    expect(isWorkerCleanupRequest({ project: "p", worker: "w", attempts: 0 })).toBe(false);
    expect(isWorkerCleanupRequest({ project: "", worker: "w", repoPath: "/r", attempts: 0 })).toBe(false);
    expect(isWorkerCleanupRequest({ project: "p", worker: "w", repoPath: "/r", attempts: -1 })).toBe(false);
    expect(isWorkerCleanupRequest({ project: "p", worker: "w", repoPath: "/r", attempts: Number.NaN })).toBe(false);
    expect(isWorkerCleanupRequest({ project: "p", worker: "w", repoPath: "/r", attempts: 0, branchName: 42 })).toBe(false);
    expect(isWorkerCleanupRequest({ project: "p", worker: "w", repoPath: "/r", attempts: 0, protectedPids: [1] })).toBe(false);
    expect(isWorkerCleanupRequest(null)).toBe(false);
  });
});

describe("dueCleanupRequests", () => {
  const now = 1_000_000_000_000;

  async function seed(project: string, worker: string, ageMs: number) {
    const { writeWorkerCleanupRequest } = await importCleanup();
    const { workerCleanupMarkerPath } = await import("../src/dashboard/git.js");
    writeWorkerCleanupRequest({ project, worker, repoPath: "/repo", branchName: worker, attempts: 0 });
    const file = workerCleanupMarkerPath(project, worker);
    age(file, ageMs, now);
    return file;
  }

  it("returns only requests past the retry window", async () => {
    const { dueCleanupRequests, CLEANUP_RETRY_AFTER_MS } = await importCleanup();
    await seed("garden", "bold-calm-ash", CLEANUP_RETRY_AFTER_MS + 60_000);
    await seed("wolf", "brisk-firm-oak", 5_000);

    const due = dueCleanupRequests(now);
    expect(due.map(r => r.worker)).toEqual(["bold-calm-ash"]);
    // Selection claims the request by mtime, so the next watchdog tick cannot
    // launch a duplicate child while the first one is still running.
    expect(dueCleanupRequests(now + 60_000)).toEqual([]);
  });

  it("retires a request whose validation throws, and still returns the others", async () => {
    // One that threw every time ended the sweep before any request was
    // returned, on every tick, so no stalled cleanup was retried.
    fs.appendFileSync(path.join(env.gardenDir, "config.yml"), "  nopath:\n    displayName: no path\n");
    const { dueCleanupRequests, CLEANUP_RETRY_AFTER_MS } = await importCleanup();
    const poison = await seed("nopath", "bold-calm-ash", CLEANUP_RETRY_AFTER_MS * 2);
    await seed("wolf", "brisk-firm-oak", CLEANUP_RETRY_AFTER_MS * 2);

    expect(dueCleanupRequests(now).map(r => r.worker)).toEqual(["brisk-firm-oak"]);
    expect(fs.existsSync(poison)).toBe(false);
  });

  // Validation resolves each request's project through the config, so a
  // config.yml that does not parse failed every request at once. Retired as
  // "project not configured", each one's worktree was left to leak.
  it("keeps every request while the config does not parse, and retires none", async () => {
    const { dueCleanupRequests, CLEANUP_RETRY_AFTER_MS } = await importCleanup();
    const file = await seed("wolf", "brisk-firm-oak", CLEANUP_RETRY_AFTER_MS * 2);
    fs.appendFileSync(path.join(env.gardenDir, "config.yml"), "   broken: [\n");

    expect(dueCleanupRequests(now)).toEqual([]);
    expect(fs.existsSync(file)).toBe(true);
  });

  it("recovers identity from the body, not the filename", async () => {
    // Both project and worker names contain hyphens, so the filename
    // `worker-cleanup-<project>-<worker>` cannot be parsed back apart.
    const { dueCleanupRequests, CLEANUP_RETRY_AFTER_MS } = await importCleanup();
    await seed("leadingtone-io", "numb-clear-vow", CLEANUP_RETRY_AFTER_MS * 2);

    const due = dueCleanupRequests(now);
    expect(due).toHaveLength(1);
    expect(due[0].project).toBe("leadingtone-io");
    expect(due[0].worker).toBe("numb-clear-vow");
  });

  it("ignores unrelated control files and retires unparseable markers", async () => {
    const { dueCleanupRequests, CLEANUP_RETRY_AFTER_MS } = await importCleanup();
    const oldAge = CLEANUP_RETRY_AFTER_MS * 10;
    const unrelated = ["intake-last-garden", "watchdog.spawn.lock", "claude-usage.json"];
    for (const name of unrelated) {
      const f = path.join(env.controlDir, name);
      fs.writeFileSync(f, "{}");
      age(f, oldAge, now);
    }
    const junk = path.join(env.controlDir, "worker-cleanup-garden-junk");
    fs.writeFileSync(junk, "not json");
    age(junk, oldAge, now);

    expect(dueCleanupRequests(now)).toEqual([]);
    expect(fs.existsSync(junk)).toBe(false);
    for (const name of unrelated) expect(fs.existsSync(path.join(env.controlDir, name))).toBe(true);
  });

  it("never runs a request an older build left in the sessions dir, and retires it once stale", async () => {
    // Any worker can write the sessions dir, so a request found there cannot
    // be told from a forged one. Dispatched or adopted, it would still hand
    // the unsandboxed retry a target a worker chose.
    const { dueCleanupRequests, CLEANUP_RETRY_AFTER_MS } = await importCleanup();
    const legacy = (worker: string, ageMs: number): string => {
      const file = path.join(env.sessionsDir, `worker-cleanup-wolf-${worker}`);
      fs.writeFileSync(file, JSON.stringify({
        project: "wolf", worker, repoPath: "/repo", branchName: worker, attempts: 0,
      }));
      age(file, ageMs, now);
      return file;
    };
    const stale = legacy("brisk-firm-oak", CLEANUP_RETRY_AFTER_MS * 2);
    // Young enough that an older build's cleanup may still be running it.
    const fresh = legacy("bold-calm-ash", 5_000);
    const lock = `${stale}.lock`;
    fs.writeFileSync(lock, `${process.pid}:2b3c4d5e-6f70-4a8b-9c0d-1e2f3a4b5c6d`);
    age(lock, CLEANUP_RETRY_AFTER_MS * 2, now);

    expect(dueCleanupRequests(now)).toEqual([]);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(lock)).toBe(true);
    expect(fs.readdirSync(env.controlDir).filter(n => n.startsWith("worker-cleanup-"))).toEqual([]);
    // The drop is visible: the log names the request it retired.
    const logged = fs.readFileSync(path.join(env.sessionsDir, "dashboard.log"), "utf8")
      .split("\n").filter(Boolean).map(line => JSON.parse(line) as { level: string; data?: { file?: string } });
    expect(logged.some(e => e.level === "warn" && e.data?.file === stale)).toBe(true);
  });

  it("never opens what sits in the sessions dir under a request's name", async () => {
    // The sweep used to read each one there, so a FIFO a worker planted under
    // that name blocked the unsandboxed watchdog's tick until something wrote
    // to it. Retirement goes by name and mtime alone.
    const { dueCleanupRequests, CLEANUP_RETRY_AFTER_MS } = await importCleanup();
    const file = path.join(env.sessionsDir, "worker-cleanup-wolf-brisk-firm-oak");
    fs.writeFileSync(file, JSON.stringify({
      project: "wolf", worker: "brisk-firm-oak", repoPath: "/repo", branchName: "brisk-firm-oak", attempts: 0,
    }));
    age(file, CLEANUP_RETRY_AFTER_MS * 2, now);
    const read = vi.spyOn(fs, "readFileSync");
    const opened = vi.spyOn(fs, "openSync");
    let touched: string[];
    try {
      dueCleanupRequests(now);
      touched = [...read.mock.calls, ...opened.mock.calls].map(([p]) => String(p))
        .filter(p => path.dirname(p) === env.sessionsDir && path.basename(p).startsWith("worker-cleanup-"));
    } finally {
      read.mockRestore();
      opened.mockRestore();
    }
    expect(touched).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("leaves a request's lock, its reclaim salvage and write temps alone", async () => {
    // All three share the request's name as a prefix. The lock of a cleanup
    // still running past the retry window was read as an unreadable request
    // and deleted, which let the re-dispatched child run alongside it; a temp
    // left by an interrupted write parsed as a request and was re-dispatched
    // every window.
    const { dueCleanupRequests, CLEANUP_RETRY_AFTER_MS } = await importCleanup();
    const marker = await seed("garden", "bold-calm-ash", CLEANUP_RETRY_AFTER_MS * 2);
    const lock = `${marker}.lock`;
    const salvage = `${lock}.reclaiming.0b9f5a4e-3c2d-4e1f-9a8b-7c6d5e4f3a2b`;
    const temp = `${marker}.1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f.tmp`;
    fs.writeFileSync(lock, `${process.pid}:2b3c4d5e-6f70-4a8b-9c0d-1e2f3a4b5c6d`);
    fs.writeFileSync(salvage, `${process.pid}:3c4d5e6f-7081-4b9c-8d1e-2f3a4b5c6d7e`);
    fs.copyFileSync(marker, temp);
    for (const f of [lock, salvage, temp]) age(f, CLEANUP_RETRY_AFTER_MS * 2, now);

    const due = dueCleanupRequests(now).map(r => r.worker);
    expect(fs.existsSync(lock)).toBe(true);
    expect(fs.existsSync(salvage)).toBe(true);
    expect(due).toEqual(["bold-calm-ash"]);
  });
});

describe("buildCleanupCommand", () => {
  it("shell-escapes both identity arguments", async () => {
    const { buildCleanupCommand } = await importCleanup();
    const cmd = buildCleanupCommand("/usr/bin/node /opt/garden/cli.js", "lead'ing", "numb-clear-vow");
    expect(cmd).toContain("dashboard _worker-cleanup");
    // A quote in a project name must not break out of the composed sh -c string.
    expect(cmd).not.toContain("lead'ing ");
    expect(cmd).toContain(String.raw`'lead'\''ing'`);
    // A name with nothing to escape passes through bare.
    expect(cmd).toMatch(/ numb-clear-vow$/);
  });
});

describe("sweepWorkerCleanups (watchdog)", () => {
  // The watchdog is the fleet's one always-unsandboxed recurring process, so
  // its re-dispatch is what rescues a cleanup whose original attempt was denied.
  // `true` stands in for the garden runner: the sweep's job is to select and
  // dispatch, and spawning a real cleanup here would be testing git again.
  const now = 1_000_000_000_000;

  it("re-dispatches only requests past the retry window", async () => {
    const { writeWorkerCleanupRequest, CLEANUP_RETRY_AFTER_MS } = await importCleanup();
    const { workerCleanupMarkerPath } = await import("../src/dashboard/git.js");
    const { sweepWorkerCleanups } = await import("../src/dashboard/watchdog.js");

    writeWorkerCleanupRequest({
      project: "leadingtone-io", worker: "numb-clear-vow",
      repoPath: "/repo", branchName: "numb-clear-vow", attempts: 1,
    });
    age(workerCleanupMarkerPath("leadingtone-io", "numb-clear-vow"), CLEANUP_RETRY_AFTER_MS * 2, now);
    writeWorkerCleanupRequest({
      project: "garden", worker: "brisk-firm-oak",
      repoPath: "/repo", branchName: "brisk-firm-oak", attempts: 0,
    });

    expect(sweepWorkerCleanups(now, "true")).toBe(1);
  });

  it("is a no-op when nothing is pending", async () => {
    const { sweepWorkerCleanups } = await import("../src/dashboard/watchdog.js");
    expect(sweepWorkerCleanups(now, "true")).toBe(0);
  });
});

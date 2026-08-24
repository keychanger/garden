import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { useTmpHome } from "./helpers.js";

// worker-cleanup.ts resolves SESSIONS_DIR through config.js, which freezes it
// from HOME at import — so import dynamically AFTER useTmpHome redirects HOME
// (same pattern as watchdog-housekeeping.test.ts).
const env = useTmpHome();

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
      attempts: 0,
    });

    const file = workerCleanupMarkerPath("leadingtone-io", "numb-clear-vow");
    const read = readWorkerCleanupRequest(file);
    expect(read?.worker).toBe("numb-clear-vow");
    expect(read?.worktreePath).toBe("/wt");
    expect(read?.attempts).toBe(0);
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
    await seed("garden", "stale-one", CLEANUP_RETRY_AFTER_MS + 60_000);
    await seed("wolf", "fresh-one", 5_000);

    const due = dueCleanupRequests(now);
    expect(due.map(r => r.worker)).toEqual(["stale-one"]);
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

  it("ignores unrelated session files and unparseable markers", async () => {
    const { dueCleanupRequests, CLEANUP_RETRY_AFTER_MS } = await importCleanup();
    const oldAge = CLEANUP_RETRY_AFTER_MS * 10;
    for (const name of ["dashboard.registry.json", "dashboard.log", "bootstrap-garden-elk.sh"]) {
      const f = path.join(env.sessionsDir, name);
      fs.writeFileSync(f, "{}");
      age(f, oldAge, now);
    }
    const junk = path.join(env.sessionsDir, "worker-cleanup-garden-junk");
    fs.writeFileSync(junk, "not json");
    age(junk, oldAge, now);

    expect(dueCleanupRequests(now)).toEqual([]);
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
      project: "garden", worker: "just-dispatched",
      repoPath: "/repo", branchName: "just-dispatched", attempts: 0,
    });

    expect(sweepWorkerCleanups(now, "true")).toBe(1);
  });

  it("is a no-op when nothing is pending", async () => {
    const { sweepWorkerCleanups } = await import("../src/dashboard/watchdog.js");
    expect(sweepWorkerCleanups(now, "true")).toBe(0);
  });
});

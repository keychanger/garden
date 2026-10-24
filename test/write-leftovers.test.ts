import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { useTmpHome } from "./helpers.js";

// The sweep reads SESSIONS_DIR and CONTROL_DIR, which paths.js freezes from
// HOME at import, so the module is imported after useTmpHome redirects HOME.
const env = useTmpHome();

async function importSweep() {
  return await import("../src/dashboard/write-leftovers.js");
}

// The two name shapes an interrupted write leaves: atomicWriteFile's temp and a
// lock reclaim's salvage, each carrying a randomUUID.
const UUID_A = "3b241101-e2bb-4255-8caf-4136c566a962";
const UUID_B = "9f8e7d6c-5b4a-4c3d-9e2f-1a0b9c8d7e6f";
const NOW = 1_000_000_000_000;

function writeAged(dir: string, name: string, ageMs: number): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, "left behind\n");
  const t = (NOW - ageMs) / 1000; // utimesSync takes seconds
  fs.utimesSync(file, t, t);
  return file;
}

describe("sweepWriteLeftovers", () => {
  it("deletes write temps and lock salvages older than an hour in both trees, keeps fresh ones", async () => {
    const { sweepWriteLeftovers, WRITE_LEFTOVER_MAX_AGE_MS } = await importSweep();
    const old = WRITE_LEFTOVER_MAX_AGE_MS + 60_000;
    const settingsDir = path.join(env.controlDir, "claude-settings");
    fs.mkdirSync(settingsDir, { recursive: true });

    const doomed = [
      writeAged(env.sessionsDir, `intake-last-board.${UUID_A}.tmp`, old),
      writeAged(env.sessionsDir, `dashboard.registry.json.lock.reclaiming.${UUID_A}`, old),
      writeAged(env.controlDir, `claude-usage.json.${UUID_A}.tmp`, old),
      writeAged(settingsDir, `0f1e.json.${UUID_A}.tmp`, old),
    ];
    // Still inside the window a write or a reclaim could be in.
    const fresh = [
      writeAged(env.sessionsDir, `dashboard.state.json.${UUID_B}.tmp`, 5_000),
      writeAged(env.controlDir, `claude-usage.lock.reclaiming.${UUID_B}`, 5_000),
    ];

    expect(sweepWriteLeftovers(NOW)).toBe(doomed.length);
    for (const f of doomed) expect(fs.existsSync(f)).toBe(false);
    for (const f of fresh) expect(fs.existsSync(f)).toBe(true);
  });

  it("matches only those two shapes, regular files, and the sessions dir's top level", async () => {
    const { sweepWriteLeftovers, WRITE_LEFTOVER_MAX_AGE_MS } = await importSweep();
    const old = WRITE_LEFTOVER_MAX_AGE_MS + 60_000;
    const inbox = path.join(env.sessionsDir, "handoff-requests");
    fs.mkdirSync(inbox, { recursive: true });

    const keepers = [
      writeAged(env.sessionsDir, "dashboard.registry.json", old),
      writeAged(env.sessionsDir, "notes.tmp", old),
      writeAged(env.sessionsDir, `${UUID_A}.tmp`, old),
      writeAged(env.sessionsDir, `notes.${UUID_A}.tmp.bak`, old),
      // The checks semaphore's salvage carries a pid, not a uuid.
      writeAged(env.sessionsDir, "checks-slot-0.lock.reclaiming.4242", old),
      writeAged(env.controlDir, `reports.reclaiming.${UUID_A}.json`, old),
      // A worker-writable subdirectory is not descended into.
      writeAged(inbox, `${UUID_B}.req.json.${UUID_A}.tmp`, old),
    ];
    // A link named like a temp is left alone, and so is what it points at.
    const target = writeAged(env.home, "precious.txt", old);
    const link = path.join(env.sessionsDir, `precious.txt.${UUID_B}.tmp`);
    fs.symlinkSync(target, link);
    const t = (NOW - old) / 1000;
    fs.lutimesSync(link, t, t);

    expect(sweepWriteLeftovers(NOW)).toBe(0);
    for (const f of keepers) expect(fs.existsSync(f)).toBe(true);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("left behind\n");
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

let tmpHome: string;
let originalHome: string | undefined;

type SemaphoreModule = typeof import("../src/checks-semaphore.js");

// SESSIONS_DIR is captured from HOME at config.ts load time, so the module
// under test must be imported after HOME points at the tmp dir.
async function loadModule(): Promise<SemaphoreModule> {
  return import("../src/checks-semaphore.js");
}

beforeEach(() => {
  vi.resetModules();
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "garden-checks-test-"));
  originalHome = process.env.HOME;
  process.env.HOME = tmpHome;
});

afterEach(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("defaultChecksSlots", () => {
  it("derives one slot per 8 cores with a floor of 1", async () => {
    const { defaultChecksSlots } = await loadModule();
    expect(defaultChecksSlots(4)).toBe(1);
    expect(defaultChecksSlots(8)).toBe(1);
    expect(defaultChecksSlots(12)).toBe(1);
    expect(defaultChecksSlots(16)).toBe(2);
    expect(defaultChecksSlots(24)).toBe(3);
    expect(defaultChecksSlots(1)).toBe(1);
  });

  it("defaults cores to the machine's available parallelism", async () => {
    const { defaultChecksSlots } = await loadModule();
    expect(defaultChecksSlots()).toBe(
      Math.max(1, Math.floor(os.availableParallelism() / 8)),
    );
  });
});

describe("tryAcquireChecksSlot / releaseChecksSlot", () => {
  it("claims distinct slots until all are held, then returns null", async () => {
    const mod = await loadModule();
    expect(mod.tryAcquireChecksSlot(2)).toBe(0);
    expect(mod.tryAcquireChecksSlot(2)).toBe(1);
    expect(mod.tryAcquireChecksSlot(2)).toBe(null);
  });

  it("stamps the slot file with the owning pid", async () => {
    const mod = await loadModule();
    const slot = mod.tryAcquireChecksSlot(1);
    expect(slot).toBe(0);
    const content = fs.readFileSync(mod.checksSlotPath(0), "utf8");
    expect(content.split("\n")[0]).toBe(String(process.pid));
  });

  it("steals a slot whose owner pid is dead", async () => {
    const mod = await loadModule();
    fs.mkdirSync(path.dirname(mod.checksSlotPath(0)), { recursive: true });
    // A pid from a long-dead process: max pid on macOS/Linux stays well below
    // 2^22, so this can never be a live process.
    fs.writeFileSync(mod.checksSlotPath(0), "99999999\n2026-01-01T00:00:00Z\n");
    expect(mod.tryAcquireChecksSlot(1)).toBe(0);
    expect(fs.readFileSync(mod.checksSlotPath(0), "utf8").split("\n")[0]).toBe(
      String(process.pid),
    );
  });

  it("steals a slot whose file is unparseable", async () => {
    const mod = await loadModule();
    fs.mkdirSync(path.dirname(mod.checksSlotPath(0)), { recursive: true });
    fs.writeFileSync(mod.checksSlotPath(0), "not-a-pid\n");
    expect(mod.tryAcquireChecksSlot(1)).toBe(0);
  });

  it("leaves no salvage file behind after stealing a dead slot", async () => {
    // The steal renames the abandoned file to a private `.reclaiming.<pid>`
    // salvage name (atomic, so two racers can't both reclaim) and then unlinks
    // it. A leaked salvage file would signal the atomic-steal path regressed.
    const mod = await loadModule();
    const dir = path.dirname(mod.checksSlotPath(0));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(mod.checksSlotPath(0), "99999999\n2026-01-01T00:00:00Z\n");
    expect(mod.tryAcquireChecksSlot(1)).toBe(0);
    const residue = fs.readdirSync(dir).filter((f) => f.includes(".reclaiming."));
    expect(residue).toEqual([]);
  });

  it("does not steal a slot a live holder reclaimed between the owner-read and the rename", async () => {
    const mod = await loadModule();
    const slotFile = mod.checksSlotPath(0);
    fs.mkdirSync(path.dirname(slotFile), { recursive: true });
    // Dead owner, so the initial owner check clears the steal.
    fs.writeFileSync(slotFile, "99999999\n2026-01-01T00:00:00Z\n");
    // Model the race: our rename moves the file, but a live holder had already
    // reclaimed it in the gap — make the salvaged file show THIS (live) pid the
    // instant after the rename lands.
    const realRename = fs.renameSync.bind(fs);
    const spy = vi.spyOn(fs, "renameSync").mockImplementation((from: fs.PathLike, to: fs.PathLike) => {
      realRename(from, to);
      if (String(to).includes(".reclaiming.")) fs.writeFileSync(to, String(process.pid));
    });

    // The only slot now "belongs" to a live holder, so it must not be stolen.
    expect(mod.tryAcquireChecksSlot(1)).toBe(null);
    spy.mockRestore();

    // Restored, not left dangling as a salvage file.
    const residue = fs.readdirSync(path.dirname(slotFile)).filter((f) => f.includes(".reclaiming."));
    expect(residue).toEqual([]);
    expect(fs.existsSync(slotFile)).toBe(true);
  });

  it("respects a slot held by a live process it does not own", async () => {
    const mod = await loadModule();
    fs.mkdirSync(path.dirname(mod.checksSlotPath(0)), { recursive: true });
    // pid 1 (launchd/init) is always alive and owned by root — processAlive
    // sees EPERM and treats it as live.
    fs.writeFileSync(mod.checksSlotPath(0), "1\n2026-01-01T00:00:00Z\n");
    expect(mod.tryAcquireChecksSlot(1)).toBe(null);
  });

  it("release removes only a slot this process owns", async () => {
    const mod = await loadModule();
    expect(mod.tryAcquireChecksSlot(1)).toBe(0);
    mod.releaseChecksSlot(0);
    expect(fs.existsSync(mod.checksSlotPath(0))).toBe(false);

    fs.writeFileSync(mod.checksSlotPath(0), "1\n2026-01-01T00:00:00Z\n");
    mod.releaseChecksSlot(0);
    expect(fs.existsSync(mod.checksSlotPath(0))).toBe(true);
  });
});

describe("acquireChecksSlot", () => {
  it("waits for a held slot and claims it once released", async () => {
    const mod = await loadModule();
    expect(mod.tryAcquireChecksSlot(1)).toBe(0);
    setTimeout(() => mod.releaseChecksSlot(0), 80);
    const waits: number[] = [];
    const slot = await mod.acquireChecksSlot(1, {
      pollMs: 20,
      maxWaitMs: 5_000,
      onWait: (ms) => waits.push(ms),
    });
    expect(slot).toBe(0);
    expect(waits.length).toBeGreaterThan(0);
  });

  it("fails open (returns null) when maxWaitMs elapses", async () => {
    const mod = await loadModule();
    fs.mkdirSync(path.dirname(mod.checksSlotPath(0)), { recursive: true });
    fs.writeFileSync(mod.checksSlotPath(0), "1\n2026-01-01T00:00:00Z\n");
    const slot = await mod.acquireChecksSlot(1, { pollMs: 20, maxWaitMs: 100 });
    expect(slot).toBe(null);
  });
});

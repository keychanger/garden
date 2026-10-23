import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Pass-through by default; the pid-reuse tests stand in for ps, whose answer
// depends on when this test process started and which a sandbox denies.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

import { spawnSync } from "node:child_process";

// ps -o etime= for any pid: [[dd-]hh:]mm:ss since that process started.
function psReportsElapsed(etime: string): void {
  vi.mocked(spawnSync).mockImplementation(((cmd: string) => {
    if (cmd !== "ps") throw new Error(`unexpected spawn: ${cmd}`);
    return { pid: 0, output: [], stdout: `${etime}\n`, stderr: "", status: 0, signal: null };
  }) as typeof spawnSync);
}

function backdate(file: string, ageMs: number): void {
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(file, t, t);
}

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
  // The reclaim-race test spies on fs.renameSync. An assertion that throws
  // before its mockRestore would otherwise leak the mock into every later
  // test in this file, burying the real failure under unrelated ones.
  vi.restoreAllMocks();
  // restoreAllMocks leaves a vi.fn's implementation in place.
  vi.mocked(spawnSync).mockReset();
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

    // Restored, not left dangling as a salvage file — and restored with the
    // LIVE holder's pid. Mere existence is not enough: a slot file bearing the
    // dead pid would be stolen by the very next claimant, so the live holder
    // would still end up sharing its slot.
    const residue = fs.readdirSync(path.dirname(slotFile)).filter((f) => f.includes(".reclaiming."));
    expect(residue).toEqual([]);
    expect(fs.existsSync(slotFile)).toBe(true);
    expect(fs.readFileSync(slotFile, "utf8").split("\n")[0]).toBe(String(process.pid));
  });

  it("respects a slot held by a live process it does not own", async () => {
    const mod = await loadModule();
    fs.mkdirSync(path.dirname(mod.checksSlotPath(0)), { recursive: true });
    fs.writeFileSync(mod.checksSlotPath(0), `${process.ppid}\n2026-01-01T00:00:00Z\n`);
    expect(mod.tryAcquireChecksSlot(1)).toBe(null);
    // A young claim cannot be a reused pid, so it is not worth a ps.
    expect(vi.mocked(spawnSync)).not.toHaveBeenCalled();
  });

  it("steals a slot whose owner pid now names a process that started after the claim", async () => {
    // A killed run leaves its slot behind, and once its pid is handed to a
    // later process kill(0) answers for that one. A machine under 16 cores has
    // one slot, so every checks run then waited the full 45 minutes.
    const mod = await loadModule();
    const slotFile = mod.checksSlotPath(0);
    fs.mkdirSync(path.dirname(slotFile), { recursive: true });
    fs.writeFileSync(slotFile, `${process.pid}\n2026-01-01T00:00:00Z\n`);
    backdate(slotFile, 60 * 60_000);
    psReportsElapsed("05:00");
    expect(mod.tryAcquireChecksSlot(1)).toBe(0);
  });

  it("respects an old slot whose live owner predates the claim, or cannot be dated", async () => {
    // A suite holds its slot for as long as it runs. ps counts whole seconds
    // rounded down, so an owner that claimed in its first second can read as
    // starting up to a second after. ps is denied inside a worker sandbox,
    // and then the pid's own answer stands.
    const mod = await loadModule();
    const slotFile = mod.checksSlotPath(0);
    fs.mkdirSync(path.dirname(slotFile), { recursive: true });
    fs.writeFileSync(slotFile, `${process.ppid}\n2026-01-01T00:00:00Z\n`);
    for (const [ageMs, etime] of [[60 * 60_000, "1-00:00:00"], [60_000, "00:59"]] as const) {
      backdate(slotFile, ageMs);
      psReportsElapsed(etime);
      expect(mod.tryAcquireChecksSlot(1), etime).toBe(null);
    }
    vi.mocked(spawnSync).mockImplementation((() => ({
      pid: 0, output: [], stdout: "", stderr: "", status: null, signal: null,
      error: Object.assign(new Error("spawnSync ps EPERM"), { code: "EPERM" }),
    })) as typeof spawnSync);
    expect(mod.tryAcquireChecksSlot(1)).toBe(null);
    expect(fs.readFileSync(slotFile, "utf8").split("\n")[0]).toBe(String(process.ppid));
  });

  it("does not steal a slot its claimant has not stamped yet", async () => {
    // The claimant creates the file, then writes its pid. Stealing in between
    // left both runs believing they held the slot.
    const mod = await loadModule();
    const slotFile = mod.checksSlotPath(0);
    fs.mkdirSync(path.dirname(slotFile), { recursive: true });
    fs.writeFileSync(slotFile, "");
    expect(mod.tryAcquireChecksSlot(1)).toBe(null);
    expect(fs.readFileSync(slotFile, "utf8")).toBe("");
    // One killed before it wrote its pid is abandoned, not a wedge.
    backdate(slotFile, 60_000);
    expect(mod.tryAcquireChecksSlot(1)).toBe(0);
  });

  it("respects a slot held by a process it is not allowed to signal", async () => {
    // EPERM is the one refusal that proves the owner is alive: the pid belongs
    // to another user. Reading it as dead would steal a running suite's slot.
    const mod = await loadModule();
    fs.mkdirSync(path.dirname(mod.checksSlotPath(0)), { recursive: true });
    fs.writeFileSync(mod.checksSlotPath(0), `4242\n2026-01-01T00:00:00Z\n`);
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    });
    expect(mod.tryAcquireChecksSlot(1)).toBe(null);
    expect(fs.readFileSync(mod.checksSlotPath(0), "utf8").split("\n")[0]).toBe("4242");
  });

  it("takes a slot whose owner pid is 1 or below, which no checks run has", async () => {
    // The slots sit in the worker-writable sessions dir, and kill(0) answers
    // for launchd (1), our own process group (0) and every process (-1), so a
    // slot forged with one of them would otherwise be held forever.
    const mod = await loadModule();
    fs.mkdirSync(path.dirname(mod.checksSlotPath(0)), { recursive: true });
    for (const pid of ["1", "0", "-1"]) {
      fs.writeFileSync(mod.checksSlotPath(0), `${pid}\n2026-01-01T00:00:00Z\n`);
      expect(mod.tryAcquireChecksSlot(1), pid).toBe(0);
      mod.releaseChecksSlot(0);
    }
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
    fs.writeFileSync(mod.checksSlotPath(0), `${process.ppid}\n2026-01-01T00:00:00Z\n`);
    const slot = await mod.acquireChecksSlot(1, { pollMs: 20, maxWaitMs: 100 });
    expect(slot).toBe(null);
  });
});

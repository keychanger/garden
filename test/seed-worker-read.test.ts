// seedWorker against the real filesystem: the seed is read through
// readSeedFile, so a link planted in place of a seed is refused before
// anything is pasted. continue.test.ts covers delivery with the read mocked.
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { useTmpHome } from "./helpers.js";

vi.mock("../src/dashboard/tmux.js", async (orig) => ({
  ...(await orig<typeof import("../src/dashboard/tmux.js")>()),
  pasteAndSubmit: vi.fn(),
}));
vi.mock("../src/dashboard/registry.js", async (orig) => ({
  ...(await orig<typeof import("../src/dashboard/registry.js")>()),
  findWorkerByName: vi.fn(() => undefined),
}));
vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const env = useTmpHome();

async function load() {
  return {
    ...(await import("../src/dashboard/continue.js")),
    ...(await import("../src/dashboard/tmux.js")),
    ...(await import("../src/dashboard/registry.js")),
    ...(await import("../src/dashboard/log.js")),
  };
}

describe("seedWorker's read", () => {
  it("pastes nothing when a link stands where the seed should be", async () => {
    const { seedWorker, pasteAndSubmit, findWorkerByName, log } = await load();
    const sibling = path.join(env.gardenDir, "control", "handoff", "seeds", "sibling.txt");
    fs.mkdirSync(path.dirname(sibling), { recursive: true });
    fs.writeFileSync(sibling, "another worker's protected briefing");
    const planted = path.join(env.sessionsDir, "seeds", "bead-1.md");
    fs.mkdirSync(path.dirname(planted), { recursive: true });
    fs.symlinkSync(sibling, planted);

    seedWorker("proj", "bold-ash", planted);

    expect(log.warn).toHaveBeenCalledWith("workers", "seed failed to read message file", expect.anything());
    expect(findWorkerByName).not.toHaveBeenCalled();
    expect(pasteAndSubmit).not.toHaveBeenCalled();
  });

  it("goes on to deliver a seed garden wrote", async () => {
    const { seedWorker, log } = await load();
    const { writeSeedFile } = await import("../src/dashboard/seed-files.js");
    const file = writeSeedFile("do the thing", "grow");

    seedWorker("proj", "bold-ash", file);

    expect(log.info).toHaveBeenCalledWith("workers", "seed dispatching", expect.objectContaining({ worker: "bold-ash" }));
  });
});

// Handoff recovery dispatches a seed again while its protected copy is on disk,
// and cannot tell whether the dead dispatcher had already started a seeder.
describe("seedWorker's claim", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stands down while another live seeder holds the seed's claim", async () => {
    const { seedWorker, findWorkerByName, log } = await load();
    const { writeSeedFile } = await import("../src/dashboard/seed-files.js");
    const file = writeSeedFile("do the thing", "handoff");
    // Another process, alive and started before its claim was written.
    const seeder = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      fs.writeFileSync(`${file}.seeder`, String(seeder.pid));

      seedWorker("proj", "bold-ash", file);

      expect(log.info).toHaveBeenCalledWith("workers", "seed held by another seeder", expect.anything());
      expect(findWorkerByName).not.toHaveBeenCalled();
      expect(fs.readFileSync(file, "utf8")).toBe("do the thing");
    } finally {
      seeder.kill();
    }
  });

  it("takes over a claim whose seeder is gone, and removes it with the seed", async () => {
    const { seedWorker, log } = await load();
    const { writeSeedFile } = await import("../src/dashboard/seed-files.js");
    const file = writeSeedFile("do the thing", "handoff");
    fs.writeFileSync(`${file}.seeder`, "999999999");

    // No registered worker, so the delivery ends at once and cleans up.
    seedWorker("proj", "bold-ash", file);

    expect(log.info).toHaveBeenCalledWith("workers", "seed dispatching", expect.objectContaining({ worker: "bold-ash" }));
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(`${file}.seeder`)).toBe(false);
  });
});

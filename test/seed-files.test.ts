import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { useTmpHome } from "./helpers.js";

// paths.ts freezes HOME at import, so import after useTmpHome redirects it.
const env = useTmpHome();

async function seedFiles() {
  return await import("../src/dashboard/seed-files.js");
}

describe("seed files", () => {
  it("writes a seed into the control tree, readable only by the operator", async () => {
    const { writeSeedFile, readSeedFile } = await seedFiles();
    const file = writeSeedFile("do the thing", "grow");

    expect(path.dirname(file)).toBe(path.join(env.gardenDir, "control", "seeds"));
    expect(path.basename(file)).toMatch(/^grow-[0-9a-f-]+\.txt$/);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(readSeedFile(file)).toBe("do the thing");
  });

  it("refuses a seed over the size limit before writing anything", async () => {
    const { writeSeedFile, MAX_SEED_BYTES } = await seedFiles();
    expect(() => writeSeedFile("x".repeat(MAX_SEED_BYTES + 1), "grow")).toThrow(/over the 1048576-byte limit/);
    expect(fs.existsSync(path.join(env.gardenDir, "control", "seeds"))).toBe(false);
  });

  it("still reads a seed an older build wrote to the sessions dir", async () => {
    const { readSeedFile } = await seedFiles();
    const legacy = path.join(env.sessionsDir, "seeds", "grow-seed-proj-1.txt");
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, "older build's seed");

    expect(readSeedFile(legacy)).toBe("older build's seed");
  });

  it("reads the protected copy the handoff dispatcher makes in the control tree", async () => {
    const { readSeedFile } = await seedFiles();
    const copy = path.join(env.gardenDir, "control", "handoff", "seeds", "0b0d7a6e-1c4c-4d3a-9e1f-2a6c1d9f0e11.txt");
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    fs.writeFileSync(copy, "[handoff from garden/parent]\n\nbrief");

    expect(readSeedFile(copy)).toBe("[handoff from garden/parent]\n\nbrief");
  });

  it("reads nothing outside the seed roots", async () => {
    const { readSeedFile } = await seedFiles();
    const elsewhere = path.join(env.home, "notes.txt");
    fs.writeFileSync(elsewhere, "not a seed");

    expect(readSeedFile(elsewhere)).toBeNull();
  });

  it("never follows a symlink planted where a seed should be", async () => {
    // The seeder runs unsandboxed and pastes the text into a worker's pane, so
    // a followed link would hand that worker a file its sandbox cannot read.
    const { readSeedFile } = await seedFiles();
    const planted = path.join(env.sessionsDir, "seeds", "bead-1.md");
    fs.mkdirSync(path.dirname(planted), { recursive: true });
    // Into the control tree: a seed root itself, so only refusing the link stops it.
    const sibling = path.join(env.gardenDir, "control", "handoff", "seeds", "sibling.txt");
    fs.mkdirSync(path.dirname(sibling), { recursive: true });
    fs.writeFileSync(sibling, "another worker's protected briefing");
    fs.symlinkSync(sibling, planted);
    expect(readSeedFile(planted)).toBeNull();

    fs.rmSync(planted);
    const secret = path.join(env.home, "secret.txt");
    fs.writeFileSync(secret, "operator-only");
    fs.symlinkSync(secret, planted);
    expect(readSeedFile(planted)).toBeNull();
  });
});

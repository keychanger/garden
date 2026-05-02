import { describe, it, expect, vi, beforeEach } from "vitest";
import { captureConsoleLog } from "./helpers.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("../src/config.js", () => ({
  tryGetProject: vi.fn(),
  SESSIONS_DIR: "",
}));

vi.mock("../src/dashboard/workers.js", () => ({
  newWorker: vi.fn(),
}));

import { handoff } from "../src/commands/handoff.js";
import { tryGetProject } from "../src/config.js";
import { newWorker } from "../src/dashboard/workers.js";

const cfg = await import("../src/config.js") as unknown as { SESSIONS_DIR: string };

let tmpDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-handoff-test-"));
  cfg.SESSIONS_DIR = tmpDir;
  vi.mocked(tryGetProject).mockReturnValue({ name: "other", path: "/repo/other" });
  vi.mocked(newWorker).mockReturnValue("bold-ash");
  delete process.env.GARDEN_PROJECT;
  delete process.env.GARDEN_WORKER;
});

describe("garden handoff command", () => {
  it("rejects missing target project", async () => {
    await expect(handoff([])).rejects.toThrow(/Usage: garden handoff/);
  });

  it("rejects flag-shaped first arg as a missing project name", async () => {
    await expect(handoff(["-m", "msg"])).rejects.toThrow(/Usage: garden handoff/);
  });

  it("rejects unknown target project with a remediation hint", async () => {
    vi.mocked(tryGetProject).mockReturnValue(undefined);
    await expect(handoff(["ghost", "-m", "x"])).rejects.toThrow(/Unknown project 'ghost'/);
    expect(vi.mocked(newWorker)).not.toHaveBeenCalled();
  });

  it("rejects -m without a value", async () => {
    await expect(handoff(["other", "-m"])).rejects.toThrow(/-m requires a message argument/);
  });

  it("rejects empty briefing from -m", async () => {
    await expect(handoff(["other", "-m", "   "])).rejects.toThrow(/Empty briefing/);
  });

  it("writes the seed file under SESSIONS_DIR/seeds and passes its path to newWorker", async () => {
    await captureConsoleLog(() => handoff(["other", "-m", "Take this over"]));
    const seedsDir = path.join(tmpDir, "seeds");
    expect(fs.existsSync(seedsDir)).toBe(true);
    const files = fs.readdirSync(seedsDir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^seed-\d+-[a-z0-9]+\.txt$/);

    const newWorkerCall = vi.mocked(newWorker).mock.calls[0][0];
    expect(newWorkerCall).toEqual({
      projectName: "other",
      seedMessageFile: path.join(seedsDir, files[0]),
    });
  });

  it("prefixes the seed with [handoff from <project>/<worker>] when env vars are set", async () => {
    process.env.GARDEN_PROJECT = "src";
    process.env.GARDEN_WORKER = "blue-pine";
    await captureConsoleLog(() => handoff(["other", "-m", "do the thing"]));
    const seedsDir = path.join(tmpDir, "seeds");
    const seedFile = path.join(seedsDir, fs.readdirSync(seedsDir)[0]);
    const body = fs.readFileSync(seedFile, "utf8");
    expect(body).toMatch(/^\[handoff from src\/blue-pine\]/);
    expect(body).toContain("do the thing");
  });

  it("falls back to the bare [handoff] prefix when env vars are missing", async () => {
    await captureConsoleLog(() => handoff(["other", "-m", "do the thing"]));
    const seedsDir = path.join(tmpDir, "seeds");
    const body = fs.readFileSync(path.join(seedsDir, fs.readdirSync(seedsDir)[0]), "utf8");
    expect(body).toMatch(/^\[handoff\]/);
  });

  it("unlinks the seed file and reports failure when newWorker bails out", async () => {
    vi.mocked(newWorker).mockReturnValue(null);
    await expect(handoff(["other", "-m", "msg"])).rejects.toThrow(/Failed to spawn worker/);
    const seedsDir = path.join(tmpDir, "seeds");
    expect(fs.readdirSync(seedsDir)).toEqual([]);
  });

  it("prints the new worker name on success so the operator knows where it landed", async () => {
    const lines = await captureConsoleLog(() => handoff(["other", "-m", "msg"]));
    expect(lines.join("\n")).toContain("other/bold-ash");
  });
});

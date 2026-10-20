// The intake spawn seam's real implementation: every intake test injects its
// own spawn, so this is the one place the bead seed's location is pinned.
import { describe, it, expect, vi } from "vitest";

vi.mock("../src/dashboard/workers.js", () => ({
  newWorker: vi.fn(() => "bold-ash"),
  stopWorkerByName: vi.fn(),
}));
vi.mock("../src/dashboard/seed-files.js", () => ({
  writeSeedFile: vi.fn(() => "/control/seeds/bead-1.txt"),
}));
vi.mock("../src/dashboard/registry.js", async (orig) => ({
  ...(await orig<typeof import("../src/dashboard/registry.js")>()),
  updateWorkerTask: vi.fn(),
}));

import { spawnBeadWorker } from "../src/dashboard/poller-intake.js";
import { newWorker } from "../src/dashboard/workers.js";
import { writeSeedFile } from "../src/dashboard/seed-files.js";

describe("spawnBeadWorker", () => {
  it("stages the bead's briefing as a control-tree seed and spawns on it", () => {
    expect(spawnBeadWorker("proj", { seed: "close bd-1 when done", task: "bd-1", bead: "bd-1" })).toBe("bold-ash");
    expect(writeSeedFile).toHaveBeenCalledWith("close bd-1 when done", "bead");
    expect(newWorker).toHaveBeenCalledWith(expect.objectContaining({
      projectName: "proj", seedMessageFile: "/control/seeds/bead-1.txt", bead: "bd-1", background: true,
    }));
  });
});

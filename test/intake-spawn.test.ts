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
import { updateWorkerTask } from "../src/dashboard/registry.js";

describe("spawnBeadWorker", () => {
  it("stages the bead's briefing as a control-tree seed and spawns on it", () => {
    expect(spawnBeadWorker("proj", { seed: "close bd-1 when done", task: "bd-1", bead: "bd-1" })).toBe("bold-ash");
    expect(writeSeedFile).toHaveBeenCalledWith("close bd-1 when done", "bead");
    expect(newWorker).toHaveBeenCalledWith(expect.objectContaining({
      projectName: "proj", seedMessageFile: "/control/seeds/bead-1.txt", bead: "bd-1", background: true,
    }));
  });

  // A bead's title comes from the worker-writable .beads store; the status row
  // prints the task as stored.
  it("stamps the task without the terminal control sequences a bead title carries", () => {
    spawnBeadWorker("proj", { seed: "s", task: "bead bd-2: \x1b]2;owned\x07Fix \x1b[31mthe\x1b[0m parser", bead: "bd-2" });
    expect(updateWorkerTask).toHaveBeenCalledWith("proj", "bold-ash", "bead bd-2: Fix the parser");
  });
});

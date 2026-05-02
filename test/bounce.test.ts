import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { useTmpHome, captureConsoleLog } from "./helpers.js";

vi.mock("../src/dashboard/workers.js", () => ({
  bounceWorker: vi.fn(),
}));

const env = useTmpHome();

function seedRegistry(project: string, worker: string) {
  fs.writeFileSync(
    path.join(env.sessionsDir, "dashboard.registry.json"),
    JSON.stringify({ workers: { [project]: [{ name: worker, sessionId: "s", task: "" }] } }),
  );
}

describe("garden bounce", () => {
  it("throws when called without a worker name", async () => {
    const { bounce } = await import("../src/commands/bounce.js");
    await expect(bounce([])).rejects.toThrow("Usage: garden bounce <worker>");
  });

  it("throws when no worker matches", async () => {
    seedRegistry("proj", "alpha");
    const { bounce } = await import("../src/commands/bounce.js");
    await expect(bounce(["ghost"])).rejects.toThrow("No worker found with name 'ghost'");
  });

  it("throws when the name is ambiguous", async () => {
    fs.writeFileSync(
      path.join(env.sessionsDir, "dashboard.registry.json"),
      JSON.stringify({
        workers: {
          a: [{ name: "shared", sessionId: "s1", task: "" }],
          b: [{ name: "shared", sessionId: "s2", task: "" }],
        },
      }),
    );
    const { bounce } = await import("../src/commands/bounce.js");
    await expect(bounce(["shared"])).rejects.toThrow(/Multiple workers match 'shared'/);
  });

  it("calls bounceWorker with the matched project and worker", async () => {
    seedRegistry("proj", "alpha");
    const { bounceWorker } = await import("../src/dashboard/workers.js");
    const { bounce } = await import("../src/commands/bounce.js");
    await captureConsoleLog(() => bounce(["alpha"]));
    expect(bounceWorker).toHaveBeenCalledWith("proj", "alpha");
  });
});

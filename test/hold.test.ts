import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { useTmpHome, captureConsoleLog } from "./helpers.js";

vi.mock("../src/dashboard/workers.js", () => ({
  holdWorker: vi.fn(() => ({ ok: true, sendEscape: true, message: "Held alpha." })),
}));

const env = useTmpHome();

function seedRegistry(workers: Record<string, string[]>) {
  fs.writeFileSync(
    path.join(env.sessionsDir, "dashboard.registry.json"),
    JSON.stringify({ workers: Object.fromEntries(
      Object.entries(workers).map(([p, names]) => [p, names.map(name => ({ name, sessionId: "s", task: "" }))]),
    ) }),
  );
}

describe("garden hold", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws when called without a worker name", async () => {
    const { hold } = await import("../src/commands/hold.js");
    await expect(hold([])).rejects.toThrow("Usage: garden hold <worker>");
  });

  it("throws when no worker matches the name", async () => {
    seedRegistry({ proj: ["alpha"] });
    const { hold } = await import("../src/commands/hold.js");
    await expect(hold(["ghost"])).rejects.toThrow("No worker found with name 'ghost'");
  });

  it("throws when the name is ambiguous across projects", async () => {
    seedRegistry({ a: ["shared"], b: ["shared"] });
    const { hold } = await import("../src/commands/hold.js");
    await expect(hold(["shared"])).rejects.toThrow(/Multiple workers match 'shared'/);
  });

  it("delegates to holdWorker for the resolved project and prints its message", async () => {
    seedRegistry({ proj: ["alpha"] });
    const { hold } = await import("../src/commands/hold.js");
    const { holdWorker } = await import("../src/dashboard/workers.js");

    const lines = await captureConsoleLog(() => hold(["alpha"]));

    expect(vi.mocked(holdWorker)).toHaveBeenCalledWith("proj", "alpha");
    expect(lines.some(l => l.includes("Held alpha."))).toBe(true);
  });
});

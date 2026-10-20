import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { captureConsoleLog, useTmpHome } from "./helpers.js";

vi.mock("../src/dashboard/workers.js", () => ({ newWorker: vi.fn(() => "keen-fix-owl") }));

// paths freeze HOME at import, so modules load after useTmpHome redirects it.
const env = useTmpHome();

function capture(name: string, body: string): string {
  const dir = path.join(env.gardenDir, "control", "diag");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return file;
}

describe("garden diag handoff", () => {
  it("briefs the fixer from the status pane's capture, as a control-tree seed", async () => {
    capture("diag-snap-100-1.txt", "## cur\nduplicate row\n");
    const { diag } = await import("../src/commands/diag.js");
    const { newWorker } = await import("../src/dashboard/workers.js");

    await captureConsoleLog(() => diag(["handoff"]));

    const seed = vi.mocked(newWorker).mock.calls[0][0]!.seedMessageFile!;
    expect(path.dirname(seed)).toBe(path.join(env.gardenDir, "control", "seeds"));
    expect(fs.readFileSync(seed, "utf8")).toContain("duplicate row");
  });

  it("refuses a capture that is a link, whose target would reach the briefing", async () => {
    const secret = path.join(env.home, "secret.txt");
    fs.writeFileSync(secret, "operator-only");
    const dir = path.join(env.gardenDir, "control", "diag");
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(secret, path.join(dir, "diag-snap-100-1.txt"));
    const { diag } = await import("../src/commands/diag.js");

    await expect(diag(["handoff"])).rejects.toThrow(/is not a regular file/);
  });
});

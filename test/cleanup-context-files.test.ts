// The dashboard-exit sweep: every context file goes, wherever a build put it.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { useTmpHome } from "./helpers.js";

// paths freeze HOME at import, so create.js loads after useTmpHome redirects it.
const env = useTmpHome();

describe("cleanupContextFiles", () => {
  it("removes the control tree's context files and the ones older builds left in sessions", async () => {
    const contexts = path.join(env.gardenDir, "control", "contexts");
    fs.mkdirSync(contexts, { recursive: true });
    const current = path.join(contexts, "abc123.context");
    const legacy = path.join(env.sessionsDir, "dashboard-garden-bold-ash.context");
    const registry = path.join(env.sessionsDir, "dashboard.registry.json");
    for (const file of [current, legacy, registry]) fs.writeFileSync(file, "x");

    const { cleanupContextFiles } = await import("../src/dashboard/create.js");
    cleanupContextFiles();

    expect(fs.existsSync(current)).toBe(false);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.existsSync(registry)).toBe(true);
  });
});

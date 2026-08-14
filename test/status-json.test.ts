// Pins the piped `garden status` JSON shape — the read-only mirror contract
// board consumes (DELEGATION.md "The mirror"). The bead-intake liveness
// fields (lastIntakeAt / lastIntakeError, Decision 11) ride this transport,
// emitted only for beadIntake projects; board never reads garden's session
// directory.
import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { useTmpHome, captureConsoleLog } from "./helpers.js";

vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// The operator's workstation may have a live `garden` tmux session; the
// piped-JSON shape under test must not depend on it.
vi.mock("../src/session.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  dashboardExists: () => false,
}));

// output.ts snapshots TTY-ness at module load; make sure the pipe path wins.
delete process.env.GARDEN_PRETTY;

const env = useTmpHome();

async function setupProjects(): Promise<void> {
  const cfg = await import("../src/config.js");
  for (const name of ["alpha", "beta"]) {
    fs.mkdirSync(path.join(env.home, name), { recursive: true });
  }
  fs.mkdirSync(cfg.GARDEN_DIR, { recursive: true });
  cfg.saveConfig({
    projects: {
      alpha: { path: path.join(env.home, "alpha") },
      beta: { path: path.join(env.home, "beta"), beadIntake: true },
    },
    plots: { all: { projects: ["alpha", "beta"] } },
  });
}

async function runStatusJson(): Promise<Array<Record<string, unknown>>> {
  const { status } = await import("../src/commands/status.js");
  const lines = await captureConsoleLog(() => status([]));
  return JSON.parse(lines.join("\n")) as Array<Record<string, unknown>>;
}

describe("garden status piped JSON", () => {
  it("emits the base shape, with intake fields only for beadIntake projects", async () => {
    await setupProjects();
    const { intakeStampPath } = await import("../src/dashboard/intake-paths.js");
    const { writeIntakeError } = await import("../src/dashboard/intake-paths.js");
    fs.writeFileSync(intakeStampPath("beta"), "x");
    writeIntakeError("beta", "bd exploded");

    const parsed = await runStatusJson();
    expect(parsed).toHaveLength(2);

    const alpha = parsed.find(p => p.name === "alpha")!;
    expect(Object.keys(alpha).sort()).toEqual(
      ["index", "isActive", "name", "projectBranch", "workers"],
    );
    expect(alpha.index).toBe(1);
    expect(alpha.isActive).toBe(false);
    expect(alpha.workers).toEqual([]);

    const beta = parsed.find(p => p.name === "beta")!;
    expect(typeof beta.lastIntakeAt).toBe("string");
    expect(() => new Date(beta.lastIntakeAt as string).toISOString()).not.toThrow();
    expect(beta.lastIntakeError).toBe("bd exploded");
  });

  it("omits the intake fields when no pass has ever run", async () => {
    await setupProjects();
    const parsed = await runStatusJson();
    const beta = parsed.find(p => p.name === "beta")!;
    expect(beta.lastIntakeAt).toBeUndefined();
    expect(beta.lastIntakeError).toBeUndefined();
  });
});

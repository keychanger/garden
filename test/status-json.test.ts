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
// A stand-in tmux server: records every tmux exec and answers the reads
// `garden status` makes. Off (no dashboard) unless a test turns it on.
const tmuxServer = vi.hoisted(() => ({
  up: false,
  calls: [] as string[][],
  windows: [] as string[],
  panes: [] as Array<{ win: string; id: string; title: string }>,
}));
// The operator's workstation may have a live `garden` tmux session; the
// piped-JSON shape under test must not depend on it.
vi.mock("../src/session.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  dashboardExists: () => tmuxServer.up,
}));
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const execFileSync = (cmd: string, args: string[] = [], opts?: object) => {
    if (cmd !== "tmux") return real.execFileSync(cmd, args, opts as never);
    if (!tmuxServer.up) throw new Error("no tmux server");
    tmuxServer.calls.push(args);
    const at = (flag: string) => args[args.indexOf(flag) + 1] ?? "";
    if (args[0] === "list-windows") {
      return tmuxServer.windows.map((w, i) => (at("-F").includes("window_index") ? `${i} ${w}` : w)).join("\n");
    }
    if (args[0] === "list-panes" && args.includes("-s")) {
      return tmuxServer.panes.map(p => `${p.win}\t${p.id}\t${p.title}`).join("\n");
    }
    if (args[0] === "list-panes") return tmuxServer.panes.find(p => `garden-dashboard:${p.win}` === at("-t"))?.id ?? "";
    if (args[0] === "display-message") return tmuxServer.panes.find(p => p.id === at("-t"))?.title ?? "";
    return "";
  };
  return { ...real, default: { ...real, execFileSync }, execFileSync };
});

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

  // board polls this command, so its cost recurs on board's cadence. It used to
  // read each worker's pane title with up to three tmux execs, and list the
  // session's windows and parse config.yml once per project.
  it("reads every worker's pane title, the window list and config once each", async () => {
    await setupProjects();
    const { REGISTRY_FILE } = await import("../src/dashboard/registry.js");
    const names = { alpha: ["a1", "a2", "a3"], beta: ["b1", "b2", "b3"] };
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify({
      workers: Object.fromEntries(Object.entries(names).map(([project, workers]) => [
        project, workers.map(name => ({ name, sessionId: name, task: "old", agentStatus: "working" })),
      ])),
    }));
    tmuxServer.windows = ["main", ...Object.entries(names).flatMap(([p, ws]) => ws.map(w => `_${p}-worker-${w}`))];
    tmuxServer.panes = Object.entries(names).flatMap(([p, ws]) =>
      ws.map((w, i) => ({ win: `_${p}-worker-${w}`, id: `%${p === "alpha" ? i + 1 : i + 11}`, title: `title ${w}` })));
    tmuxServer.calls = [];
    tmuxServer.up = true;
    const { CONFIG_PATH } = await import("../src/config.js");
    const read = vi.spyOn(fs, "readFileSync");
    try {
      const parsed = await runStatusJson();
      expect(tmuxServer.calls.map(c => c[0]).sort()).toEqual(["list-panes", "list-windows"]);
      expect(read.mock.calls.filter(c => c[0] === CONFIG_PATH)).toHaveLength(1);
      for (const project of parsed) {
        const workers = project.workers as Array<{ name: string; activity: string | null }>;
        expect(workers.map(w => w.activity).sort()).toEqual(
          names[project.name as "alpha" | "beta"].map(w => `title ${w}`));
      }
    } finally {
      read.mockRestore();
      tmuxServer.up = false;
    }
  });

  it("omits the intake fields when no pass has ever run", async () => {
    await setupProjects();
    const parsed = await runStatusJson();
    const beta = parsed.find(p => p.name === "beta")!;
    expect(beta.lastIntakeAt).toBeUndefined();
    expect(beta.lastIntakeError).toBeUndefined();
  });
});

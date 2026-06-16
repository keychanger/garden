import { describe, it, expect, vi, beforeEach } from "vitest";

// The buildWorkflowPickerPlan helper is pure: it just constructs the menu
// rows. Test it directly without mocking. plantGrowFromPicker has side
// effects (newWorker, fs, log), so we mock those for those tests.

vi.mock("node:fs", () => ({
  default: {
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
  },
}));

vi.mock("../src/config.js", () => ({
  tryGetProject: vi.fn(),
  SESSIONS_DIR: "/tmp/garden-sessions-test",
  GARDEN_DIR: "/tmp/garden-test",
}));

vi.mock("../src/dashboard/workers.js", () => ({
  newWorker: vi.fn(() => "tall-fern"),
}));

vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/dashboard/tmux.js", () => ({
  shellEscape: vi.fn((s: string) =>
    /^[a-zA-Z0-9_./:=-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`),
  tmuxDisplay: vi.fn(),
}));

import {
  buildWorkflowPickerPlan, plantGrowFromPicker,
} from "../src/dashboard/trellis-picker.js";
import { newWorker } from "../src/dashboard/workers.js";
import { tryGetProject } from "../src/config.js";
import { tmuxDisplay } from "../src/dashboard/tmux.js";
import fs from "node:fs";

const RUNNER = "/usr/local/bin/garden";

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── buildWorkflowPickerPlan ──────────────────────────────────────────────

describe("buildWorkflowPickerPlan", () => {
  it("returns three rows in d/t/g order", () => {
    const plan = buildWorkflowPickerPlan("proj", RUNNER);
    expect(plan.items).toHaveLength(3);
    expect(plan.items[0].key).toBe("d");
    expect(plan.items[1].key).toBe("t");
    expect(plan.items[2].key).toBe("g");
  });

  it("includes the project name in the title", () => {
    const plan = buildWorkflowPickerPlan("myproject", RUNNER);
    expect(plan.title).toContain("myproject");
  });

  it("default row dispatches the existing _new-worker subcommand", () => {
    const plan = buildWorkflowPickerPlan("proj", RUNNER);
    const def = plan.items[0];
    expect(def.label).toMatch(/default/i);
    expect(def.label).toMatch(/⌥n/);
    expect(def.command).toBe(`${RUNNER} dashboard _new-worker`);
  });

  it("trellis row dispatches the existing _trellis-picker submenu with the project arg", () => {
    const plan = buildWorkflowPickerPlan("proj", RUNNER);
    const trellis = plan.items[1];
    expect(trellis.label).toMatch(/trellis/i);
    expect(trellis.command).toContain("_trellis-picker");
    expect(trellis.command).toContain("proj");
  });

  it("grow row uses tmux command-prompt for the seed input with %% substitution", () => {
    const plan = buildWorkflowPickerPlan("proj", RUNNER);
    const grow = plan.items[2];
    expect(grow.label).toMatch(/grow/i);
    expect(grow.command).toContain("command-prompt");
    expect(grow.command).toContain("Task description");
    expect(grow.command).toContain("_grow-plant");
    expect(grow.command).toContain("%%");
  });

  it("shell-escapes the project name when it contains unsafe characters", () => {
    const plan = buildWorkflowPickerPlan("proj with space", RUNNER);
    // shellEscape wraps in single quotes when characters would otherwise
    // break the shell command.
    const trellis = plan.items[1];
    expect(trellis.command).toContain("'proj with space'");
  });
});

// ─── plantGrowFromPicker ──────────────────────────────────────────────────

describe("plantGrowFromPicker", () => {
  it("rejects when the project is unknown", () => {
    vi.mocked(tryGetProject).mockReturnValue(undefined);
    plantGrowFromPicker("ghost", "harden auth");
    expect(tmuxDisplay).toHaveBeenCalledWith(
      expect.stringContaining("Unknown project"),
    );
    expect(newWorker).not.toHaveBeenCalled();
  });

  it("rejects an empty seed and does not call newWorker", () => {
    vi.mocked(tryGetProject).mockReturnValue({ path: "/repo/proj" });
    plantGrowFromPicker("proj", "   ");
    expect(tmuxDisplay).toHaveBeenCalledWith(
      expect.stringContaining("non-empty"),
    );
    expect(newWorker).not.toHaveBeenCalled();
  });

  it("plants a grow worker with default maxIterations: 5 when project config has no override", () => {
    vi.mocked(tryGetProject).mockReturnValue({ path: "/repo/proj" });
    plantGrowFromPicker("proj", "harden auth flow");
    expect(newWorker).toHaveBeenCalledWith(expect.objectContaining({
      projectName: "proj",
      workflow: "grow",
      grow: { seed: "harden auth flow", maxIterations: 5 },
      seedMessageFile: expect.stringMatching(/seed-grow-proj-\d+\.txt$/),
    }));
  });

  it("uses project.maxGrowIterations when set", () => {
    vi.mocked(tryGetProject).mockReturnValue({
      path: "/repo/proj",
      maxGrowIterations: 8,
    });
    plantGrowFromPicker("proj", "harden auth flow");
    expect(newWorker).toHaveBeenCalledWith(expect.objectContaining({
      grow: { seed: "harden auth flow", maxIterations: 8 },
    }));
  });

  it("trims whitespace from the seed before persisting", () => {
    vi.mocked(tryGetProject).mockReturnValue({ path: "/repo/proj" });
    plantGrowFromPicker("proj", "  harden auth flow  \n");
    expect(newWorker).toHaveBeenCalledWith(expect.objectContaining({
      grow: { seed: "harden auth flow", maxIterations: 5 },
    }));
  });

  it("writes the iter-1 seed prompt to a seed file under SESSIONS_DIR/seeds", () => {
    vi.mocked(tryGetProject).mockReturnValue({ path: "/repo/proj" });
    plantGrowFromPicker("proj", "polish things");
    expect(fs.mkdirSync).toHaveBeenCalledWith(
      expect.stringMatching(/seeds$/),
      { recursive: true },
    );
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringMatching(/seed-grow-proj-\d+\.txt$/),
      expect.stringContaining("polish things"),
    );
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("Grow loop, iteration 1 of"),
    );
  });

  it("cleans up the seed file when newWorker fails", () => {
    vi.mocked(tryGetProject).mockReturnValue({ path: "/repo/proj" });
    vi.mocked(newWorker).mockReturnValueOnce(null);
    plantGrowFromPicker("proj", "polish");
    expect(fs.unlinkSync).toHaveBeenCalledWith(
      expect.stringMatching(/seed-grow-proj-\d+\.txt$/),
    );
    expect(tmuxDisplay).toHaveBeenCalledWith(
      expect.stringContaining("Failed to plant grow worker"),
    );
  });
});

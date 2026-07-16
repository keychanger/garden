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
  // Mirrors the real helper: a menu item command must be run-shell wrapped so
  // tmux dispatches it to the shell instead of parsing it as a tmux command.
  menuRunShell: vi.fn((s: string) => `run-shell "${s.replace(/[\\$"`]/g, "\\$&")}"`),
}));

import {
  buildWorkflowPickerPlan, buildComposeBaseSubmenuPlan,
  buildComposeCrewSubmenuPlan, plantGrowFromPicker,
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
  it("returns the d/t/g workflow rows, a separator, then the b/c composer rows", () => {
    const rows = buildWorkflowPickerPlan("proj", RUNNER).rows;
    expect(rows[0].key).toBe("d");
    expect(rows[1].key).toBe("t");
    expect(rows[2].key).toBe("g");
    expect(rows[3].sep).toBe(true);
    expect(rows[4].key).toBe("b");
    expect(rows[5].key).toBe("c");
  });

  it("includes the project name in the title", () => {
    expect(buildWorkflowPickerPlan("myproject", RUNNER).title).toContain("myproject");
  });

  it("the default row consumes the draft via _compose-default (NOT the draft-free _new-worker)", () => {
    const def = buildWorkflowPickerPlan("proj", RUNNER).rows[0];
    expect(def.label).toMatch(/default/i);
    expect(def.run).toContain("dashboard _compose-default");
    expect(def.run).toContain("proj");
  });

  it("trellis + grow rows are pre-wrapped tmux commands (_trellis-picker, _grow-plant %%)", () => {
    const rows = buildWorkflowPickerPlan("proj", RUNNER).rows;
    expect(rows[1].tmux).toContain("_trellis-picker");
    expect(rows[1].tmux!.startsWith("run-shell ")).toBe(true);
    expect(rows[2].tmux).toContain("command-prompt");
    expect(rows[2].tmux).toContain("_grow-plant");
    expect(rows[2].tmux).toContain("%%");
  });

  it("the composer rows dispatch the base/crew submenus and show the staged draft", () => {
    const rows = buildWorkflowPickerPlan("proj", RUNNER, { base: "v2-api", crew: "all-codex" }).rows;
    expect(rows[4].run).toContain("_compose-base-submenu");
    expect(rows[4].label).toContain("v2-api");
    expect(rows[5].run).toContain("_compose-crew-submenu");
    expect(rows[5].label).toContain("all-codex");
  });

  it("reflects a staged draft in the title bracket", () => {
    const plan = buildWorkflowPickerPlan("proj", RUNNER, { base: "v2-api" });
    expect(plan.title).toContain("base v2-api");
  });

  it("shell-escapes the project name when it contains unsafe characters", () => {
    const rows = buildWorkflowPickerPlan("proj with space", RUNNER).rows;
    expect(rows[1].tmux).toContain("'proj with space'");
  });
});

// ─── buildComposeBaseSubmenuPlan ──────────────────────────────────────────

describe("buildComposeBaseSubmenuPlan", () => {
  it("renders one row per branch plus a trailing clear row", () => {
    const rows = buildComposeBaseSubmenuPlan("proj", ["main", "v2-api"], undefined, RUNNER).rows;
    expect(rows).toHaveLength(3); // 2 branches + clear
    expect(rows[0].label).toBe("main");
    expect(rows[1].label).toBe("v2-api");
    expect(rows[2].label).toMatch(/clear/i);
    expect(rows[2].key).toBe("0");
  });

  it("stages the chosen branch via _spawn-draft <project> base <branch>", () => {
    const rows = buildComposeBaseSubmenuPlan("proj", ["v2-api"], undefined, RUNNER).rows;
    expect(rows[0].run).toContain("_spawn-draft");
    expect(rows[0].run).toContain("proj");
    expect(rows[0].run).toContain("base");
    expect(rows[0].run).toContain("v2-api");
  });

  it("marks the current branch with a check and leaves others unmarked", () => {
    const rows = buildComposeBaseSubmenuPlan("proj", ["main", "v2-api"], "v2-api", RUNNER).rows;
    expect(rows[0].label).toBe("main");
    expect(rows[1].label).toContain("✓");
  });

  it("numbers the first nine rows 1..9 then drops the quick-key", () => {
    const branches = Array.from({ length: 11 }, (_, i) => `b${i + 1}`);
    const rows = buildComposeBaseSubmenuPlan("proj", branches, undefined, RUNNER).rows;
    expect(rows[0].key).toBe("1");
    expect(rows[8].key).toBe("9");
    expect(rows[9].key).toBe("");
    expect(rows[10].key).toBe("");
    // Clear row still keeps its own 0 key.
    expect(rows.at(-1)!.key).toBe("0");
  });

  it("the clear row stages an empty value to reset to the project default", () => {
    const rows = buildComposeBaseSubmenuPlan("proj", [], undefined, RUNNER).rows;
    expect(rows).toHaveLength(1);
    const clear = rows[0];
    expect(clear.key).toBe("0");
    expect(clear.run).toContain("_spawn-draft");
    expect(clear.run).toContain("base");
    // shellEscape("") renders an empty single-quoted literal.
    expect(clear.run).toMatch(/base\s+''\s*$/);
  });

  it("names the project in the title", () => {
    expect(buildComposeBaseSubmenuPlan("proj", [], undefined, RUNNER).title).toContain("proj");
  });
});

// ─── buildComposeCrewSubmenuPlan ──────────────────────────────────────────

describe("buildComposeCrewSubmenuPlan", () => {
  it("renders one row per crew plus a trailing clear row that mentions the crew default", () => {
    const rows = buildComposeCrewSubmenuPlan("proj", ["all-claude", "all-codex"], undefined, RUNNER).rows;
    expect(rows).toHaveLength(3);
    expect(rows[0].label).toBe("all-claude");
    expect(rows[1].label).toBe("all-codex");
    expect(rows[2].label).toMatch(/clear/i);
    expect(rows[2].label).toMatch(/crew/i);
    expect(rows[2].key).toBe("0");
  });

  it("stages the chosen crew via _spawn-draft <project> crew <crew>", () => {
    const rows = buildComposeCrewSubmenuPlan("proj", ["all-codex"], undefined, RUNNER).rows;
    expect(rows[0].run).toContain("_spawn-draft");
    expect(rows[0].run).toContain("crew");
    expect(rows[0].run).toContain("all-codex");
  });

  it("marks the current crew with a check", () => {
    const rows = buildComposeCrewSubmenuPlan("proj", ["all-claude", "all-codex"], "all-codex", RUNNER).rows;
    expect(rows[0].label).toBe("all-claude");
    expect(rows[1].label).toContain("✓");
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

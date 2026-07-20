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
  buildComposeCrewSubmenuPlan, buildComposeModelSubmenuPlan,
  buildComposeEffortSubmenuPlan, draftLaunchOpts, plantGrowFromPicker, plantBotanistFromPicker,
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
  it("returns the d/o/t/h workflow rows, a separator, then the m/e/c/b composer rows", () => {
    const rows = buildWorkflowPickerPlan("proj", RUNNER).rows;
    expect(rows[0].key).toBe("d");
    expect(rows[1].key).toBe("o"); // botanist ('b' is the base-branch composer row)
    expect(rows[2].key).toBe("t");
    expect(rows[3].key).toBe("h"); // hoop — the grow workflow's operator-facing name
    expect(rows[4].sep).toBe(true);
    expect(rows[5].key).toBe("m");
    expect(rows[6].key).toBe("e");
    expect(rows[7].key).toBe("c");
    expect(rows[8].key).toBe("b");
  });

  it("binds every quick-key at most once", () => {
    // tmux display-menu silently gives a repeated key to the first row that
    // claims it, so a collision makes a row unreachable rather than erroring.
    const keys = buildWorkflowPickerPlan("proj", RUNNER).rows
      .filter(r => !r.sep).map(r => r.key);
    expect(new Set(keys).size).toBe(keys.length);
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

  it("botanist + trellis + hoop rows are pre-wrapped tmux commands", () => {
    const rows = buildWorkflowPickerPlan("proj", RUNNER).rows;
    expect(rows[1].tmux).toContain("command-prompt");
    expect(rows[1].tmux).toContain("_botanist-plant");
    expect(rows[1].tmux).toContain("%%");
    expect(rows[2].tmux).toContain("_trellis-picker");
    expect(rows[2].tmux!.startsWith("run-shell ")).toBe(true);
    expect(rows[3].tmux).toContain("command-prompt");
    expect(rows[3].tmux).toContain("_grow-plant");
    expect(rows[3].tmux).toContain("%%");
  });

  it("the composer rows dispatch the model/effort/crew/base submenus and show the staged draft", () => {
    const rows = buildWorkflowPickerPlan("proj", RUNNER, {
      model: "sonnet", effort: "xhigh", crew: "all-codex", base: "v2-api",
    }).rows;
    expect(rows[5].run).toContain("_compose-model-submenu");
    expect(rows[5].label).toContain("sonnet");
    expect(rows[6].run).toContain("_compose-effort-submenu");
    expect(rows[6].label).toContain("xhigh");
    expect(rows[7].run).toContain("_compose-crew-submenu");
    expect(rows[7].label).toContain("all-codex");
    expect(rows[8].run).toContain("_compose-base-submenu");
    expect(rows[8].label).toContain("v2-api");
  });

  it("reflects a staged draft in the title bracket, reading like the spoken recipe", () => {
    const plan = buildWorkflowPickerPlan("proj", RUNNER, { model: "sonnet", effort: "xhigh", crew: "all-claude" });
    // model and effort bare (sonnet · xhigh), crew labeled.
    expect(plan.title).toContain("sonnet · xhigh · crew all-claude");
  });

  it("shell-escapes the project name when it contains unsafe characters", () => {
    const rows = buildWorkflowPickerPlan("proj with space", RUNNER).rows;
    expect(rows[1].tmux).toContain("'proj with space'");
  });
});

// ─── buildComposeModelSubmenuPlan ─────────────────────────────────────────

describe("buildComposeModelSubmenuPlan", () => {
  it("renders one row per model plus a trailing clear row", () => {
    const rows = buildComposeModelSubmenuPlan("proj", ["opus", "sonnet", "fable"], undefined, RUNNER).rows;
    expect(rows).toHaveLength(4);
    expect(rows[0].label).toBe("opus");
    expect(rows[2].label).toBe("fable");
    expect(rows.at(-1)!.label).toMatch(/clear/i);
    expect(rows.at(-1)!.key).toBe("0");
  });

  it("stages the chosen model via _spawn-draft <project> model <model>", () => {
    const rows = buildComposeModelSubmenuPlan("proj", ["fable"], undefined, RUNNER).rows;
    expect(rows[0].run).toContain("_spawn-draft");
    expect(rows[0].run).toContain("model");
    expect(rows[0].run).toContain("fable");
  });

  it("marks the current model with a check", () => {
    const rows = buildComposeModelSubmenuPlan("proj", ["opus", "sonnet"], "sonnet", RUNNER).rows;
    expect(rows[0].label).toBe("opus");
    expect(rows[1].label).toContain("✓");
  });
});

// ─── buildComposeEffortSubmenuPlan ────────────────────────────────────────

describe("buildComposeEffortSubmenuPlan", () => {
  it("renders the rungs plus a clear row, with ultra carrying a descriptive suffix", () => {
    const rows = buildComposeEffortSubmenuPlan("proj", ["low", "high", "xhigh", "ultra"], undefined, RUNNER).rows;
    expect(rows).toHaveLength(5);
    expect(rows[0].label).toBe("low");
    expect(rows.at(-2)!.label).toMatch(/^ultra — max effort/);
    expect(rows.at(-1)!.label).toMatch(/clear/i);
  });

  it("stages the chosen effort via _spawn-draft <project> effort <level>", () => {
    const rows = buildComposeEffortSubmenuPlan("proj", ["xhigh"], undefined, RUNNER).rows;
    expect(rows[0].run).toContain("_spawn-draft");
    expect(rows[0].run).toContain("effort");
    expect(rows[0].run).toContain("xhigh");
  });

  it("stages the ultra sentinel (mapped to ultracode by the consumer)", () => {
    const rows = buildComposeEffortSubmenuPlan("proj", ["ultra"], undefined, RUNNER).rows;
    expect(rows[0].run).toContain("effort");
    expect(rows[0].run).toContain("ultra");
  });
});

// ─── draftLaunchOpts ──────────────────────────────────────────────────────

describe("draftLaunchOpts", () => {
  it("passes a plain effort rung through as effort", () => {
    expect(draftLaunchOpts({ model: "sonnet", effort: "xhigh" })).toEqual({ model: "sonnet", effort: "xhigh" });
  });

  it("maps the ultra rung to ultracode (never a bare effort value)", () => {
    expect(draftLaunchOpts({ model: "fable", effort: "ultra" })).toEqual({ model: "fable", ultracode: true });
  });

  it("returns an empty object for a draft with no model/effort", () => {
    expect(draftLaunchOpts({ base: "v2-api" })).toEqual({});
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

// ─── plantBotanistFromPicker ──────────────────────────────────────────────

describe("plantBotanistFromPicker", () => {
  it("rejects when the project is unknown", () => {
    vi.mocked(tryGetProject).mockReturnValue(undefined);
    plantBotanistFromPicker("ghost", "design notification levels");
    expect(tmuxDisplay).toHaveBeenCalledWith(expect.stringContaining("Unknown project"));
    expect(newWorker).not.toHaveBeenCalled();
  });

  it("rejects an empty seed", () => {
    vi.mocked(tryGetProject).mockReturnValue({ path: "/repo/proj" });
    plantBotanistFromPicker("proj", "   ");
    expect(tmuxDisplay).toHaveBeenCalledWith(expect.stringContaining("non-empty"));
    expect(newWorker).not.toHaveBeenCalled();
  });

  it("plants a botanist with the botanist workflow and a botanist seed file", () => {
    vi.mocked(tryGetProject).mockReturnValue({ path: "/repo/proj" });
    plantBotanistFromPicker("proj", "design notification levels");
    expect(newWorker).toHaveBeenCalledWith(expect.objectContaining({
      projectName: "proj",
      workflow: "botanist",
      seedMessageFile: expect.stringMatching(/botanist-seed-proj-\d+\.txt$/),
    }));
    // A botanist does not loop — no grow sub-object.
    const call = vi.mocked(newWorker).mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(call.grow).toBeUndefined();
  });

  it("writes the botanist framing seed and cleans it up when newWorker fails", () => {
    vi.mocked(tryGetProject).mockReturnValue({ path: "/repo/proj" });
    vi.mocked(newWorker).mockReturnValueOnce(null);
    plantBotanistFromPicker("proj", "design X");
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringMatching(/botanist-seed-proj-\d+\.txt$/),
      expect.stringContaining("botanist"),
    );
    expect(fs.unlinkSync).toHaveBeenCalledWith(
      expect.stringMatching(/botanist-seed-proj-\d+\.txt$/),
    );
    expect(tmuxDisplay).toHaveBeenCalledWith(expect.stringContaining("Failed to plant botanist"));
  });
});

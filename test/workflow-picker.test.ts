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
  // The plant paths resolve the draft's build member, which reads the garden
  // config for the member list. An empty config yields the builtin members
  // (the registered harnesses) and no providers.
  loadConfig: vi.fn(() => ({ projects: {}, providers: {} })),
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

// stageSpawnDraft re-opens the picker (the form feel), which would shell out to
// tmux; the draft store is faked so the staged patch is directly assertable.
vi.mock("../src/dashboard/menu.js", () => ({ runMenu: vi.fn() }));
vi.mock("../src/dashboard/runner.js", () => ({ resolveGardenRunner: vi.fn(() => "garden") }));
vi.mock("../src/dashboard/spawn-draft.js", () => ({
  readSpawnDraft: vi.fn(() => ({})),
  writeSpawnDraft: vi.fn(),
  consumeSpawnDraft: vi.fn(() => ({})),
}));

import {
  buildWorkflowPickerPlan, buildComposeBaseSubmenuPlan,
  buildComposeCrewSubmenuPlan, buildComposeModelSubmenuPlan,
  buildComposeEffortSubmenuPlan, buildComposeMemberSubmenuPlan, draftLaunchOpts,
  composerModels, composerEfforts, effectiveBuildMember, claudeOnlyLaunchOpts,
  providerModelAliases, memberProvider,
  plantGrowFromPicker, plantBotanistFromPicker, stageSpawnDraft,
} from "../src/dashboard/trellis-picker.js";
import { newWorker } from "../src/dashboard/workers.js";
import { tryGetProject, loadConfig } from "../src/config.js";
import { tmuxDisplay } from "../src/dashboard/tmux.js";
import { readSpawnDraft, writeSpawnDraft } from "../src/dashboard/spawn-draft.js";
import fs from "node:fs";

const RUNNER = "/usr/local/bin/garden";

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── buildWorkflowPickerPlan ──────────────────────────────────────────────

describe("buildWorkflowPickerPlan", () => {
  it("returns the d/o/t/h workflow rows, a separator, then the w/m/e/c/b composer rows", () => {
    const rows = buildWorkflowPickerPlan("proj", RUNNER).rows;
    expect(rows[0].key).toBe("d");
    expect(rows[1].key).toBe("o"); // botanist ('b' is the base-branch composer row)
    expect(rows[2].key).toBe("t");
    expect(rows[3].key).toBe("h"); // hoop — the grow workflow's operator-facing name
    expect(rows[4].sep).toBe(true);
    expect(rows[5].key).toBe("w"); // build member — who builds ('b' is base, 'm' is model)
    expect(rows[6].key).toBe("m");
    expect(rows[7].key).toBe("e");
    expect(rows[8].key).toBe("c");
    expect(rows[9].key).toBe("b");
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

  it("trellis + hoop rows are pre-wrapped tmux commands", () => {
    const rows = buildWorkflowPickerPlan("proj", RUNNER).rows;
    expect(rows[2].tmux).toContain("_trellis-picker");
    expect(rows[2].tmux!.startsWith("run-shell ")).toBe(true);
    expect(rows[3].tmux).toContain("command-prompt");
    expect(rows[3].tmux).toContain("_grow-plant");
    expect(rows[3].tmux).toContain("%%");
  });

  it("the botanist row spawns instantly — no command-prompt for a design brief", () => {
    const row = buildWorkflowPickerPlan("proj", RUNNER).rows[1];
    expect(row.run).toContain("dashboard _botanist-plant");
    expect(row.run).toContain("proj");
    expect(row.tmux).toBeUndefined();
  });

  it("the composer rows dispatch the build/model/effort/crew/base submenus and show the staged draft", () => {
    const rows = buildWorkflowPickerPlan("proj", RUNNER, {
      member: "codex", model: "gpt-5.6-sol", effort: "xhigh", crew: "all-codex", base: "v2-api",
    }).rows;
    expect(rows[5].run).toContain("_compose-member-submenu");
    expect(rows[5].label).toContain("codex");
    expect(rows[6].run).toContain("_compose-model-submenu");
    expect(rows[6].label).toContain("gpt-5.6-sol");
    expect(rows[7].run).toContain("_compose-effort-submenu");
    expect(rows[7].label).toContain("xhigh");
    expect(rows[8].run).toContain("_compose-crew-submenu");
    expect(rows[8].label).toContain("all-codex");
    expect(rows[9].run).toContain("_compose-base-submenu");
    expect(rows[9].label).toContain("v2-api");
  });

  it("reflects a staged draft in the title bracket, reading like the spoken recipe", () => {
    const plan = buildWorkflowPickerPlan("proj", RUNNER, { model: "sonnet", effort: "xhigh", crew: "all-claude" });
    // model and effort bare (sonnet · xhigh), crew labeled.
    expect(plan.title).toContain("sonnet · xhigh · crew all-claude");
  });

  it("leads the title bracket with the build member — the recipe reads codex · gpt-5.6-sol", () => {
    const plan = buildWorkflowPickerPlan("proj", RUNNER, { member: "codex", model: "gpt-5.6-sol", effort: "high" });
    expect(plan.title).toContain("codex · gpt-5.6-sol · high");
  });

  it("shell-escapes the project name when it contains unsafe characters", () => {
    const rows = buildWorkflowPickerPlan("proj with space", RUNNER).rows;
    expect(rows[1].run).toContain("'proj with space'");
  });

  it("re-opens on the dim just staged, so a choice doesn't walk the cursor back to the top", () => {
    // tmux's -C indexes every item, separator included — the row positions
    // asserted above are the indexes.
    expect(buildWorkflowPickerPlan("proj", RUNNER, {}, "member").startingChoice).toBe(5);
    expect(buildWorkflowPickerPlan("proj", RUNNER, {}, "model").startingChoice).toBe(6);
    expect(buildWorkflowPickerPlan("proj", RUNNER, {}, "effort").startingChoice).toBe(7);
    expect(buildWorkflowPickerPlan("proj", RUNNER, {}, "crew").startingChoice).toBe(8);
    expect(buildWorkflowPickerPlan("proj", RUNNER, {}, "base").startingChoice).toBe(9);
  });

  it("opens at the top when nothing was staged (the ⌥⇧N hotkey path)", () => {
    expect(buildWorkflowPickerPlan("proj", RUNNER).startingChoice).toBeUndefined();
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

  it("opens on the staged value, and at the top when nothing is staged or the value is gone", () => {
    expect(buildComposeModelSubmenuPlan("proj", ["opus", "sonnet"], "sonnet", RUNNER).startingChoice).toBe(1);
    expect(buildComposeModelSubmenuPlan("proj", ["opus"], undefined, RUNNER).startingChoice).toBeUndefined();
    // A staged value the member's vocabulary no longer offers (harness changed).
    expect(buildComposeModelSubmenuPlan("proj", ["opus"], "gpt-5.6-sol", RUNNER).startingChoice).toBeUndefined();
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

// ─── buildComposeMemberSubmenuPlan ────────────────────────────────────────

describe("buildComposeMemberSubmenuPlan", () => {
  it("renders one row per member plus a trailing clear row", () => {
    const rows = buildComposeMemberSubmenuPlan("proj", ["claude", "codex"], undefined, RUNNER).rows;
    expect(rows).toHaveLength(3);
    expect(rows[0].label).toBe("claude");
    expect(rows[1].label).toBe("codex");
    expect(rows.at(-1)!.label).toMatch(/clear/i);
    expect(rows.at(-1)!.key).toBe("0");
  });

  it("stages the chosen member via _spawn-draft <project> member <member>", () => {
    const rows = buildComposeMemberSubmenuPlan("proj", ["codex"], undefined, RUNNER).rows;
    expect(rows[0].run).toContain("_spawn-draft");
    expect(rows[0].run).toContain("member");
    expect(rows[0].run).toContain("codex");
  });

  it("marks the current member with a check", () => {
    const rows = buildComposeMemberSubmenuPlan("proj", ["claude", "codex"], "codex", RUNNER).rows;
    expect(rows[1].label).toContain("✓");
  });
});

// ─── harness-scoped model/effort vocabularies ─────────────────────────────

describe("composerModels / composerEfforts", () => {
  it("offers Anthropic aliases for a claude-code build member", () => {
    expect(composerModels("claude-code")).toContain("opus");
    expect(composerModels("claude-code")).toContain("fable");
  });

  it("offers Codex slugs — never Anthropic aliases — for a codex build member", () => {
    const models = composerModels("codex");
    expect(models.length).toBeGreaterThan(0);
    expect(models).not.toContain("opus");
    expect(models.every(m => m.startsWith("gpt-"))).toBe(true);
  });

  it("offers the claude-code ladder ending in the ultracode sentinel for claude", () => {
    expect(composerEfforts("claude-code")).toEqual(["low", "medium", "high", "xhigh", "ultra"]);
  });

  it("offers Codex's own reasoning rungs — which include max — for codex", () => {
    expect(composerEfforts("codex")).toContain("max");
  });

  it("offers a provider's mapped aliases — not the full Anthropic list — for a provider member", () => {
    // A provider serves only what its modelMap names. Offering `fable` to a
    // backend that never mapped it would send an alias it cannot resolve.
    expect(composerModels("claude-code", ["opus", "haiku"])).toEqual(["opus", "haiku"]);
  });

  it("falls back to the Anthropic aliases when a provider maps nothing", () => {
    // An empty map means the endpoint serves its own default, so the standard
    // alias list is the honest offer rather than an empty submenu.
    expect(composerModels("claude-code", [])).toEqual(["opus", "sonnet", "haiku", "fable"]);
  });
});

// ─── providerModelAliases ─────────────────────────────────────────────────

describe("providerModelAliases", () => {
  const config = {
    providers: {
      deepseek: { modelMap: { opus: "deepseek-v4-pro", haiku: "deepseek-v4-flash" } },
      bare: {},
    },
  } as never;

  it("returns the aliases the provider actually maps", () => {
    expect(providerModelAliases("deepseek", config)).toEqual(["opus", "haiku"]);
  });

  it("returns nothing for a provider with no modelMap, or an unknown one", () => {
    expect(providerModelAliases("bare", config)).toEqual([]);
    expect(providerModelAliases("ghost", config)).toEqual([]);
  });
});

// ─── memberProvider ───────────────────────────────────────────────────────

describe("memberProvider", () => {
  const config = { projects: {}, providers: { deepseek: {} } } as never;

  it("names the backend a provider member builds against", () => {
    expect(memberProvider("deepseek", config)).toBe("deepseek");
  });

  it("returns nothing for a harness member — those run first-party", () => {
    expect(memberProvider("claude", config)).toBeUndefined();
    expect(memberProvider("codex", config)).toBeUndefined();
  });
});

// ─── effectiveBuildMember ─────────────────────────────────────────────────

describe("effectiveBuildMember", () => {
  const config = { projects: {}, providers: {} } as never;

  it("prefers an explicitly staged member over everything else", () => {
    expect(effectiveBuildMember({ harness: "codex" }, { member: "claude" }, config)).toBe("claude");
  });

  it("falls back to the project default when nothing is staged", () => {
    expect(effectiveBuildMember({ harness: "codex" }, {}, config)).toBe("codex");
    expect(effectiveBuildMember({}, {}, config)).toBe("claude");
  });

  it("reads a staged crew's worker half when no member is staged", () => {
    // This is the fix for "I only see Anthropic models": the dims follow the
    // crew's builder, not the project's.
    expect(effectiveBuildMember({}, { crew: "codex-claude" }, config)).toBe("codex");
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

  it("passes codex rungs through untranslated — its 'ultra' is a reasoning level, not the ultracode preset", () => {
    expect(draftLaunchOpts({ model: "gpt-5.6-sol", effort: "ultra" }, "codex"))
      .toEqual({ model: "gpt-5.6-sol", effort: "ultra" });
    expect(draftLaunchOpts({ effort: "max" }, "codex")).toEqual({ effort: "max" });
  });
});

// ─── stageSpawnDraft ──────────────────────────────────────────────────────

describe("stageSpawnDraft", () => {
  beforeEach(() => {
    vi.mocked(tryGetProject).mockReturnValue({ path: "/repo/proj" } as ReturnType<typeof tryGetProject>);
    vi.mocked(readSpawnDraft).mockReturnValue({});
  });

  it("rejects an unknown field without writing", () => {
    stageSpawnDraft("proj", "bogus", "x");
    expect(vi.mocked(writeSpawnDraft)).not.toHaveBeenCalled();
    expect(vi.mocked(tmuxDisplay)).toHaveBeenCalledWith("Unknown draft field 'bogus'.");
  });

  it("stages base/model/effort verbatim, touching nothing else", () => {
    stageSpawnDraft("proj", "model", "sonnet");
    expect(vi.mocked(writeSpawnDraft)).toHaveBeenCalledWith("proj", { model: "sonnet" });
  });

  // The load-bearing guard: `sonnet` and the ultracode `ultra` name nothing
  // Codex can run, so carrying them across a harness change would stage a
  // recipe that cannot launch. Clearing drops both to the account default.
  it("clears a staged model/effort when the build member changes harness", () => {
    vi.mocked(readSpawnDraft).mockReturnValue({ model: "sonnet", effort: "ultra" });
    stageSpawnDraft("proj", "member", "codex");
    expect(vi.mocked(writeSpawnDraft)).toHaveBeenCalledWith(
      "proj", { member: "codex", model: "", effort: "" },
    );
  });

  it("clears them on the way back to claude too", () => {
    vi.mocked(readSpawnDraft).mockReturnValue({ member: "codex", model: "gpt-5.6-sol" });
    stageSpawnDraft("proj", "member", "claude");
    expect(vi.mocked(writeSpawnDraft)).toHaveBeenCalledWith(
      "proj", { member: "claude", model: "", effort: "" },
    );
  });

  // Clearing the member falls back to the project default. Same harness in and
  // out means the staged vocabulary is still valid, so it must survive.
  it("keeps model/effort when the member changes but the harness does not", () => {
    vi.mocked(readSpawnDraft).mockReturnValue({ member: "claude", model: "sonnet", effort: "xhigh" });
    stageSpawnDraft("proj", "member", "");
    expect(vi.mocked(writeSpawnDraft)).toHaveBeenCalledWith("proj", { member: "" });
  });

  // A provider member shares the claude-code HARNESS but not its model
  // vocabulary — each backend serves only the aliases its own modelMap names.
  // Keying the clear on harness alone would carry a DeepSeek-only alias onto
  // first-party claude, or onto a second provider that never mapped it.
  it("clears model/effort when the member changes provider under one harness", () => {
    vi.mocked(loadConfig).mockReturnValue({
      projects: {}, providers: { deepseek: {} },
    } as unknown as ReturnType<typeof loadConfig>);
    vi.mocked(readSpawnDraft).mockReturnValue({ member: "deepseek", model: "haiku" });
    stageSpawnDraft("proj", "member", "claude");
    expect(vi.mocked(writeSpawnDraft)).toHaveBeenCalledWith(
      "proj", { member: "claude", model: "", effort: "" },
    );
  });

  // A crew supplies the build member when none is staged, so switching crews
  // can move the harness just as staging a member can.
  it("clears model/effort when a staged crew moves the build harness", () => {
    vi.mocked(readSpawnDraft).mockReturnValue({ model: "sonnet" });
    stageSpawnDraft("proj", "crew", "codex-claude");
    expect(vi.mocked(writeSpawnDraft)).toHaveBeenCalledWith(
      "proj", { crew: "codex-claude", model: "", effort: "" },
    );
  });

  it("keeps them for a crew whose worker half builds with the same harness", () => {
    vi.mocked(readSpawnDraft).mockReturnValue({ model: "sonnet" });
    stageSpawnDraft("proj", "crew", "claude-codex");
    expect(vi.mocked(writeSpawnDraft)).toHaveBeenCalledWith("proj", { crew: "claude-codex" });
  });

  // An explicitly staged member outranks the crew's worker half, so a crew
  // change under a pinned member cannot move the harness.
  it("keeps them when a staged member already outranks the incoming crew", () => {
    vi.mocked(readSpawnDraft).mockReturnValue({ member: "codex", model: "gpt-5.6-sol" });
    stageSpawnDraft("proj", "crew", "claude-codex");
    expect(vi.mocked(writeSpawnDraft)).toHaveBeenCalledWith("proj", { crew: "claude-codex" });
  });

  it("stages without clearing when the project is unknown (no harness to compare)", () => {
    vi.mocked(tryGetProject).mockReturnValue(undefined);
    vi.mocked(readSpawnDraft).mockReturnValue({ model: "sonnet" });
    stageSpawnDraft("proj", "member", "codex");
    expect(vi.mocked(writeSpawnDraft)).toHaveBeenCalledWith("proj", { member: "codex" });
  });
});

// ─── claudeOnlyLaunchOpts ─────────────────────────────────────────────────

describe("claudeOnlyLaunchOpts", () => {
  it("passes the dims through when the draft builds with claude", () => {
    expect(claudeOnlyLaunchOpts({}, { model: "sonnet", effort: "xhigh" }))
      .toEqual({ model: "sonnet", effort: "xhigh" });
  });

  it("drops model and effort when the draft stages a foreign build member", () => {
    // grow/botanist are claude-code-only, so a codex-staged model would
    // otherwise reach a Claude worker as `--model gpt-5.6-sol`.
    expect(claudeOnlyLaunchOpts({}, { member: "codex", model: "gpt-5.6-sol", effort: "max" }))
      .toEqual({});
  });

  it("drops them for a foreign member inherited from a staged crew", () => {
    expect(claudeOnlyLaunchOpts({}, { crew: "codex-claude", model: "gpt-5.6-sol" })).toEqual({});
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
    plantBotanistFromPicker("ghost");
    expect(tmuxDisplay).toHaveBeenCalledWith(expect.stringContaining("Unknown project"));
    expect(newWorker).not.toHaveBeenCalled();
  });

  it("plants a botanist with no seed message — the brief arrives in the pane", () => {
    vi.mocked(tryGetProject).mockReturnValue({ path: "/repo/proj" });
    plantBotanistFromPicker("proj");
    expect(newWorker).toHaveBeenCalledWith(expect.objectContaining({
      projectName: "proj",
      workflow: "botanist",
    }));
    // No plant-time message (the system prompt carries the design posture),
    // and a botanist does not loop — no grow sub-object.
    const call = vi.mocked(newWorker).mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(call.seedMessageFile).toBeUndefined();
    expect(call.grow).toBeUndefined();
  });

  it("reports the failure when newWorker fails", () => {
    vi.mocked(tryGetProject).mockReturnValue({ path: "/repo/proj" });
    vi.mocked(newWorker).mockReturnValueOnce(null);
    plantBotanistFromPicker("proj");
    expect(tmuxDisplay).toHaveBeenCalledWith(expect.stringContaining("Failed to plant botanist"));
  });
});

import { describe, it, expect } from "vitest";
import { buildPickerPlan } from "../src/dashboard/trellis-picker.js";
import type { TrellisFileInfo } from "../src/dashboard/trellis-tag.js";

const RUNNER = "/usr/local/bin/garden";

function mkInfo(overrides: Partial<TrellisFileInfo> & { name: string }): TrellisFileInfo {
  return {
    path: `/tmp/${overrides.name}.md`,
    retired: false,
    hasSentinel: true,
    version: 1,
    summary: "—",
    ...overrides,
  };
}

describe("buildPickerPlan", () => {
  it("zero active trellises → empty-state with [a] author and [n] scaffold", () => {
    const plan = buildPickerPlan("proj", [], RUNNER);
    expect(plan.directPlant).toBeUndefined();
    expect(plan.title).toMatch(/No active trellises/);
    const labels = plan.items.map(i => i.label);
    expect(labels.some(l => /author/.test(l))).toBe(true);
    expect(labels.some(l => /scaffold/i.test(l))).toBe(true);
    // No retired trellises → no [r] revive action.
    expect(labels.some(l => /revive/i.test(l))).toBe(false);
  });

  it("zero active + some retired → empty-state with [r] revive added", () => {
    const trellises = [
      mkInfo({ name: "old1", retired: true }),
      mkInfo({ name: "old2", retired: true }),
    ];
    const plan = buildPickerPlan("proj", trellises, RUNNER);
    expect(plan.directPlant).toBeUndefined();
    const reviveItem = plan.items.find(i => /revive/i.test(i.label));
    expect(reviveItem).toBeDefined();
    expect(reviveItem!.label).toContain("(2)"); // count of retired
  });

  it("one active → directPlant short-circuit, no menu items", () => {
    const trellises = [mkInfo({ name: "auth-rewrite" })];
    const plan = buildPickerPlan("proj", trellises, RUNNER);
    expect(plan.directPlant).toEqual({ project: "proj", name: "auth-rewrite" });
    expect(plan.items).toEqual([]);
  });

  it("one active + retired in the wings → still short-circuits to directPlant", () => {
    // Spec: "skip the picker entirely; plant immediately. The picker
    // exists for choice — there is no choice here." Retired trellises
    // are not part of the active count.
    const trellises = [
      mkInfo({ name: "live" }),
      mkInfo({ name: "old", retired: true }),
    ];
    const plan = buildPickerPlan("proj", trellises, RUNNER);
    expect(plan.directPlant).toEqual({ project: "proj", name: "live" });
  });

  it("multiple active → menu rows, retired filtered out", () => {
    const trellises = [
      mkInfo({ name: "alpha", summary: "alpha intent" }),
      mkInfo({ name: "beta",  summary: "beta intent" }),
      mkInfo({ name: "old",   retired: true }),
    ];
    const plan = buildPickerPlan("proj", trellises, RUNNER);
    expect(plan.directPlant).toBeUndefined();
    expect(plan.title).toMatch(/Plant a trellis vine on proj/);
    expect(plan.items).toHaveLength(2);
    expect(plan.items[0].label).toContain("alpha");
    expect(plan.items[0].label).toContain("alpha intent");
    expect(plan.items[1].label).toContain("beta");
    // No retired trellis in the picker itself.
    expect(plan.items.some(i => /old/.test(i.label))).toBe(false);
  });

  it("menu items invoke _trellis-plant <project> <name> via the runner", () => {
    const trellises = [
      mkInfo({ name: "alpha" }),
      mkInfo({ name: "beta" }),
    ];
    const plan = buildPickerPlan("proj", trellises, RUNNER);
    expect(plan.items[0].command).toContain("_trellis-plant");
    expect(plan.items[0].command).toContain("proj");
    expect(plan.items[0].command).toContain("alpha");
    expect(plan.items[1].command).toContain("beta");
    // tmux parses a menu item's command as a tmux command, so the runner
    // dispatch must be run-shell wrapped (not a bare `${runner} …`, which
    // fails with "unknown command: <runner>").
    expect(plan.items[0].command.startsWith("run-shell ")).toBe(true);
    expect(plan.items[0].command.startsWith(RUNNER)).toBe(false);
  });

  it("menu items number 1..9 then drop the quick-key for the rest", () => {
    const trellises = Array.from({ length: 12 }, (_, i) =>
      mkInfo({ name: `t${i + 1}` }),
    );
    const plan = buildPickerPlan("proj", trellises, RUNNER);
    expect(plan.items[0].key).toBe("1");
    expect(plan.items[8].key).toBe("9");
    expect(plan.items[9].key).toBe("");
    expect(plan.items[11].key).toBe("");
  });

  it("flags missing-sentinel trellises in the menu label", () => {
    const trellises = [mkInfo({ name: "loose", hasSentinel: false }), mkInfo({ name: "ok" })];
    const plan = buildPickerPlan("proj", trellises, RUNNER);
    const looseItem = plan.items.find(i => i.label.startsWith("loose"));
    expect(looseItem!.label).toMatch(/no sentinel/i);
  });

  it("truncates very long labels with an ellipsis", () => {
    const longSummary = "x".repeat(200);
    const trellises = [
      mkInfo({ name: "feat", summary: longSummary }),
      mkInfo({ name: "other" }),
    ];
    const plan = buildPickerPlan("proj", trellises, RUNNER);
    const featItem = plan.items.find(i => i.label.startsWith("feat"));
    expect(featItem!.label.length).toBeLessThanOrEqual(80);
    expect(featItem!.label).toMatch(/…$/);
  });

  it("scaffold action uses tmux command-prompt for name input", () => {
    const plan = buildPickerPlan("proj", [], RUNNER);
    const scaffoldItem = plan.items.find(i => i.key === "n")!;
    expect(scaffoldItem.command).toMatch(/command-prompt/);
    expect(scaffoldItem.command).toContain("Trellis name");
    expect(scaffoldItem.command).toContain("trellis new");
  });
});

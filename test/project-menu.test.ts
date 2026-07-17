// The ⌥, project config menu's pure plan builders. Assert structure + dispatch
// strings without tmux. header is stubbed so importing the module is cheap.
import { describe, it, expect, vi } from "vitest";

vi.mock("../src/dashboard/header.js", () => ({ refreshDashboard: vi.fn() }));

const {
  buildProjectMenuPlan, buildEnumSubmenuPlan, buildProjectBranchSubmenuPlan, buildHolisticSubmenuPlan,
  buildProjectModelSubmenuPlan, buildProjectEffortSubmenuPlan,
} = await import("../src/dashboard/project-menu.js");

const view = {
  project: "lex", runner: "garden",
  base: "v2-api", crew: "all-codex", ciGate: true, holistic: "shadow", logColor: "auto",
  model: "sonnet", effort: "high",
  checks: "npm test", postMerge: "npm run build",
};

describe("buildProjectMenuPlan", () => {
  it("surfaces free-form values (checks, post-merge) in the title", () => {
    const t = buildProjectMenuPlan(view).title;
    expect(t).toContain("lex");
    expect(t).toContain("npm test");
    expect(t).toContain("npm run build");
  });

  it("is narrowed to the everyday knobs — no roles / profile / provider / yaml-editor rows", () => {
    const labels = buildProjectMenuPlan(view).rows.map(r => r.label).join(" | ");
    expect(labels).toContain("base branch");
    expect(labels).toContain("crew");
    expect(labels).toContain("model");
    expect(labels).toContain("effort");
    expect(labels).toContain("CI gate");
    expect(labels).toContain("holistic review");
    expect(labels).toContain("log color");
    expect(labels).not.toMatch(/roles/i);
    expect(labels).not.toMatch(/claude profile/i);
    expect(labels).not.toMatch(/^.*provider.*$/im);
    expect(labels).not.toMatch(/config\.yml/i);
  });

  it("shows each knob's current value and routes to its submenu", () => {
    const rows = buildProjectMenuPlan(view).rows;
    const label = (n: string) => rows.find(r => r.label.includes(n))!;
    expect(label("base branch").label).toContain("v2-api");
    expect(label("base branch").run).toBe("garden dashboard _config-branch-submenu lex");
    expect(label("crew").run).toBe("garden dashboard _crew-picker lex");
    expect(label("model").label).toContain("sonnet");
    expect(label("model").run).toBe("garden dashboard _config-model-submenu lex");
    expect(label("effort").label).toContain("high");
    expect(label("effort").run).toBe("garden dashboard _config-effort-submenu lex");
    expect(label("holistic review").label).toContain("shadow");
    expect(label("log color").run).toBe("garden dashboard _config-color-submenu lex");
  });

  it("renders an unpinned effective base as a default rather than not set", () => {
    const row = buildProjectMenuPlan({ ...view, base: "main (default)" }).rows
      .find(r => r.label.includes("base branch"))!;
    expect(row.label).toContain("main (default)");
    expect(row.label).not.toContain("(not set)");
  });

  it("the CI gate row toggles the current value", () => {
    const on = buildProjectMenuPlan(view).rows.find(r => r.label.includes("CI gate"))!;
    expect(on.label).toContain("on");
    expect(on.run).toBe("garden dashboard _config-set lex requireCiSuccess false");   // on -> flips to false
    const off = buildProjectMenuPlan({ ...view, ciGate: false }).rows.find(r => r.label.includes("CI gate"))!;
    expect(off.run).toBe("garden dashboard _config-set lex requireCiSuccess true");
  });
});

describe("buildEnumSubmenuPlan", () => {
  it("lists options (current marked) + an unset row, dispatching _config-set", () => {
    const plan = buildEnumSubmenuPlan("lex", "provider", "Provider", ["deepseek", "ollama"], "deepseek", "garden", "unset — first-party");
    expect(plan.rows[0].label).toBe("deepseek  ✓");
    expect(plan.rows[0].run).toBe("garden dashboard _config-set lex provider deepseek");
    expect(plan.rows.at(-1)!.label).toContain("unset");
    expect(plan.rows.at(-1)!.run).toBe("garden dashboard _config-set lex provider ''");
  });
});

describe("buildProjectBranchSubmenuPlan", () => {
  it("dispatches _config-set baseBranch", () => {
    const plan = buildProjectBranchSubmenuPlan("lex", ["v2-api", "main"], "v2-api", "garden");
    expect(plan.rows[0].run).toBe("garden dashboard _config-set lex baseBranch v2-api");
    expect(plan.rows.at(-1)!.run).toBe("garden dashboard _config-set lex baseBranch ''");
  });
});

describe("buildHolisticSubmenuPlan", () => {
  it("offers off/shadow/fix (current marked)", () => {
    const plan = buildHolisticSubmenuPlan("lex", "shadow", "garden");
    expect(plan.rows.map(r => r.label).join(" ")).toMatch(/off.*shadow.*fix/);
    expect(plan.rows.find(r => r.label.startsWith("shadow"))!.label).toContain("✓");
  });
});

describe("buildProjectModelSubmenuPlan", () => {
  it("lists the alias choices (current marked) + an account-default unset, dispatching _config-set model", () => {
    const plan = buildProjectModelSubmenuPlan("lex", "sonnet", "garden");
    const choiceLabels = plan.rows.slice(0, -1).map(r => r.label.replace(/\s+✓$/, ""));
    expect(choiceLabels).toEqual(["opus", "sonnet", "haiku", "fable"]);
    expect(plan.rows.find(r => r.label.startsWith("sonnet"))!.label).toContain("✓");
    expect(plan.rows[0].run).toBe("garden dashboard _config-set lex model opus");
    expect(plan.rows.at(-1)!.label).toContain("account/provider default");
    expect(plan.rows.at(-1)!.run).toBe("garden dashboard _config-set lex model ''");
  });
});

describe("buildProjectEffortSubmenuPlan", () => {
  it("offers the four rungs plus ultra (current marked), dispatching _config-set effort", () => {
    const plan = buildProjectEffortSubmenuPlan("lex", "ultra", "garden");
    expect(plan.rows.map(r => r.label).join(" ")).toMatch(/low.*medium.*high.*xhigh.*ultra/);
    expect(plan.rows.find(r => r.label.startsWith("ultra"))!.label).toContain("✓");
    expect(plan.rows.find(r => r.label.startsWith("xhigh"))!.run).toBe("garden dashboard _config-set lex effort xhigh");
    expect(plan.rows.at(-1)!.run).toBe("garden dashboard _config-set lex effort ''");
  });
});

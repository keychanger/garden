// The ⌥, project config menu's pure plan builders. Assert structure + dispatch
// strings without tmux. header is stubbed so importing the module is cheap.
import { describe, it, expect, vi } from "vitest";

vi.mock("../src/dashboard/header.js", () => ({ refreshDashboard: vi.fn() }));

const {
  buildProjectMenuPlan, buildEnumSubmenuPlan, buildProjectBranchSubmenuPlan,
  buildRoleSubmenuPlan, buildRoleHarnessSubmenuPlan, buildHolisticSubmenuPlan,
} = await import("../src/dashboard/project-menu.js");

const view = {
  project: "lex", runner: "garden",
  base: "v2-api", crew: "all-codex", reviewer: "codex", resolver: "claude-code", ciFix: "claude-code",
  ciGate: true, holistic: "shadow", profile: "imp", provider: "(not set)", logColor: "auto",
  checks: "npm test", postMerge: "npm run build",
};

describe("buildProjectMenuPlan", () => {
  it("surfaces free-form values (checks, post-merge) in the title", () => {
    const t = buildProjectMenuPlan(view).title;
    expect(t).toContain("lex");
    expect(t).toContain("npm test");
    expect(t).toContain("npm run build");
  });

  it("shows each knob's current value and routes to its submenu", () => {
    const rows = buildProjectMenuPlan(view).rows;
    const label = (n: string) => rows.find(r => r.label.includes(n))!;
    expect(label("base branch").label).toContain("v2-api");
    expect(label("base branch").run).toBe("garden dashboard _config-branch-submenu lex");
    expect(label("crew").run).toBe("garden dashboard _crew-picker lex");
    expect(label("roles").label).toContain("reviewer=codex");
    expect(label("holistic review").label).toContain("shadow");
    expect(label("edit config.yml").run).toBe("garden dashboard _config-edit");
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

describe("buildRoleSubmenuPlan + buildRoleHarnessSubmenuPlan", () => {
  it("the role submenu opens a per-role harness submenu", () => {
    const plan = buildRoleSubmenuPlan("lex", { reviewer: "codex", resolver: "claude-code", ciFix: "claude-code" }, "garden");
    const rev = plan.rows.find(r => r.label.includes("reviewer"))!;
    expect(rev.label).toContain("codex");
    expect(rev.run).toBe("garden dashboard _config-role-harness lex reviewer");
  });

  it("the harness submenu dispatches _config-role-set with the chosen harness + unset", () => {
    const plan = buildRoleHarnessSubmenuPlan("lex", "reviewer", ["claude-code", "codex"], "codex", "garden");
    expect(plan.rows.find(r => r.label.startsWith("codex"))!.label).toContain("✓");
    expect(plan.rows.find(r => r.label.startsWith("claude-code"))!.run).toBe("garden dashboard _config-role-set lex reviewer claude-code");
    expect(plan.rows.at(-1)!.run).toBe("garden dashboard _config-role-set lex reviewer ''");
  });
});

describe("buildHolisticSubmenuPlan", () => {
  it("offers off/shadow/fix (current marked)", () => {
    const plan = buildHolisticSubmenuPlan("lex", "shadow", "garden");
    expect(plan.rows.map(r => r.label).join(" ")).toMatch(/off.*shadow.*fix/);
    expect(plan.rows.find(r => r.label.startsWith("shadow"))!.label).toContain("✓");
  });
});

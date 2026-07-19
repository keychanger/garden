// The ⌥; garden settings menu's pure plan builders — structure + dispatch
// strings, no tmux. Mirrors project-menu.test.ts.
import { describe, it, expect, vi } from "vitest";

vi.mock("../src/dashboard/header.js", () => ({ refreshDashboard: vi.fn() }));

const {
  buildGardenMenuPlan, buildChecksSlotsSubmenuPlan, buildMaxReviewsSubmenuPlan,
  buildBranchSubmenuPlan,
} = await import("../src/dashboard/garden-menu.js");

describe("buildGardenMenuPlan", () => {
  it("shows each setting and routes it to its submenu", () => {
    const plan = buildGardenMenuPlan({
      runner: "garden",
      checksSlots: "4 (hardware default; unset)",
      maxReviews: "3",
      buildBranch: "main",
    });
    const row = (n: string) => plan.rows.find(r => r.label.includes(n))!;
    // The menu is no longer limits-only, so the title dropped "machine-wide".
    expect(plan.title).toBe("Garden settings");
    expect(row("checks slots").label).toContain("4 (hardware default; unset)");
    expect(row("checks slots").run).toBe("garden dashboard _garden-checks-submenu");
    expect(row("max reviews").label).toContain("3");
    expect(row("max reviews").run).toBe("garden dashboard _garden-reviews-submenu");
    expect(row("build branch").label).toContain("main");
    expect(row("build branch").run).toBe("garden dashboard _garden-branch-submenu");
  });
});

describe("buildBranchSubmenuPlan", () => {
  it("lists the install repo's own branches with the current one marked", () => {
    const plan = buildBranchSubmenuPlan(["main", "dev", "spike"], "dev", "garden");
    expect(plan.rows.map(r => r.label)).toEqual(["main", "dev  ✓", "spike"]);
    expect(plan.rows[1].run).toBe("garden dashboard _garden-branch-set dev");
  });

  it("falls back to main/dev when the install is not in a checkout", () => {
    // A packaged build can still express the intent; it just cannot enumerate.
    const plan = buildBranchSubmenuPlan([], "main", "garden");
    expect(plan.rows.map(r => r.label)).toEqual(["main  ✓", "dev"]);
  });
});

describe("buildChecksSlotsSubmenuPlan", () => {
  it("lists presets (current marked) + an unset row that clears the override", () => {
    const plan = buildChecksSlotsSubmenuPlan(2, 4, "garden");
    expect(plan.title).toContain("hardware default: 4");
    expect(plan.rows.find(r => r.label.startsWith("2"))!.label).toContain("✓");
    expect(plan.rows[0].run).toBe("garden dashboard _garden-limit-set checksSlots 1");
    expect(plan.rows.at(-1)!.label).toContain("hardware default (4)");
    expect(plan.rows.at(-1)!.run).toBe("garden dashboard _garden-limit-set checksSlots unset");
  });

  it("marks nothing when the override is unset", () => {
    const plan = buildChecksSlotsSubmenuPlan(undefined, 4, "garden");
    expect(plan.rows.slice(0, -1).every(r => !r.label.includes("✓"))).toBe(true);
  });
});

describe("buildMaxReviewsSubmenuPlan", () => {
  it("lists presets + an unlimited unset row, dispatching _garden-limit-set", () => {
    const plan = buildMaxReviewsSubmenuPlan(3, "garden");
    expect(plan.rows.find(r => r.label.startsWith("3"))!.label).toContain("✓");
    expect(plan.rows.at(-1)!.label).toContain("unlimited");
    expect(plan.rows.at(-1)!.run).toBe("garden dashboard _garden-limit-set maxConcurrentReviews unset");
  });

  it("treats a live 0 (unlimited) as no marked preset", () => {
    const plan = buildMaxReviewsSubmenuPlan(0, "garden");
    expect(plan.rows.slice(0, -1).every(r => !r.label.includes("✓"))).toBe(true);
  });
});

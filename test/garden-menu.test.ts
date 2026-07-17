// The ⌥; garden settings menu's pure plan builders — structure + dispatch
// strings, no tmux. Mirrors project-menu.test.ts.
import { describe, it, expect, vi } from "vitest";

vi.mock("../src/dashboard/header.js", () => ({ refreshDashboard: vi.fn() }));

const {
  buildGardenMenuPlan, buildChecksSlotsSubmenuPlan, buildMaxReviewsSubmenuPlan,
} = await import("../src/dashboard/garden-menu.js");

describe("buildGardenMenuPlan", () => {
  it("shows both limits and routes each to its submenu", () => {
    const plan = buildGardenMenuPlan({
      runner: "garden",
      checksSlots: "4 (hardware default; unset)",
      maxReviews: "3",
    });
    const row = (n: string) => plan.rows.find(r => r.label.includes(n))!;
    expect(plan.title).toMatch(/machine-wide/i);
    expect(row("checks slots").label).toContain("4 (hardware default; unset)");
    expect(row("checks slots").run).toBe("garden dashboard _garden-checks-submenu");
    expect(row("max reviews").label).toContain("3");
    expect(row("max reviews").run).toBe("garden dashboard _garden-reviews-submenu");
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

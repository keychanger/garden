import { describe, it, expect } from "vitest";
import { formatTrellisBracket } from "../src/commands/status.js";

describe("formatTrellisBracket", () => {
  it("returns empty string for default-workflow workers (no trellis info)", () => {
    expect(formatTrellisBracket(undefined)).toBe("");
  });

  it("renders the active-loop layout with iteration counter and drift count", () => {
    const out = formatTrellisBracket({
      name: "auth-rewrite",
      iteration: 4,
      maxIterations: 30,
      driftCount: 3,
      aligned: false,
    });
    expect(out).toContain("trellis: auth-rewrite");
    expect(out).toContain("4/30");
    expect(out).toContain("3 drift");
  });

  it("hides drift segment when driftCount is 0", () => {
    const out = formatTrellisBracket({
      name: "auth",
      iteration: 1,
      maxIterations: 30,
      driftCount: 0,
      aligned: false,
    });
    expect(out).not.toContain("drift");
    expect(out).toContain("1/30");
  });

  it("renders ✓ aligned, N iters when aligned terminal reached", () => {
    const out = formatTrellisBracket({
      name: "auth",
      iteration: 7,
      maxIterations: 30,
      driftCount: 0,
      aligned: true,
    });
    expect(out).toContain("✓ aligned");
    expect(out).toContain("7 iters");
    expect(out).not.toContain("/30");
  });

  it("singularizes 'iter' when aligned at 1 iteration", () => {
    const out = formatTrellisBracket({
      name: "tiny",
      iteration: 1,
      maxIterations: 30,
      driftCount: 0,
      aligned: true,
    });
    expect(out).toContain("1 iter]");
    expect(out).not.toContain("1 iters");
  });

  it("renders 'flagged' badge when failingReason=trellis-flagged", () => {
    const out = formatTrellisBracket({
      name: "auth",
      iteration: 4,
      maxIterations: 30,
      driftCount: 0,
      aligned: false,
      failingReason: "trellis-flagged",
    });
    expect(out).toContain("flagged");
    expect(out).not.toContain("4/30");
  });

  it("renders 'budget exhausted' when failingReason=iteration-budget", () => {
    const out = formatTrellisBracket({
      name: "auth",
      iteration: 30,
      maxIterations: 30,
      driftCount: 0,
      aligned: false,
      failingReason: "iteration-budget",
    });
    expect(out).toContain("budget exhausted");
  });

  it("renders 'stagnated' badge when failingReason=stagnation", () => {
    const out = formatTrellisBracket({
      name: "auth",
      iteration: 12,
      maxIterations: 30,
      driftCount: 0,
      aligned: false,
      failingReason: "stagnation",
    });
    expect(out).toContain("stagnated");
  });

  it("color-thresholds the iteration counter at 80% (yellow)", () => {
    const out = formatTrellisBracket({
      name: "auth",
      iteration: 24,
      maxIterations: 30, // 80%
      driftCount: 0,
      aligned: false,
    });
    expect(out).toContain("\x1b[33m"); // yellow
    expect(out).toContain("24/30");
  });

  it("color-thresholds the iteration counter at 95% (red)", () => {
    const out = formatTrellisBracket({
      name: "auth",
      iteration: 29,
      maxIterations: 30, // ~96.6%
      driftCount: 0,
      aligned: false,
    });
    expect(out).toContain("\x1b[31m"); // red
  });

  it("does not colorize when below 80% of cap", () => {
    const out = formatTrellisBracket({
      name: "auth",
      iteration: 5,
      maxIterations: 30,
      driftCount: 0,
      aligned: false,
    });
    expect(out).not.toContain("\x1b[33m");
    expect(out).not.toContain("\x1b[31m");
  });
});

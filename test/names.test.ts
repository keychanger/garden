import { describe, it, expect, vi, afterEach } from "vitest";
import { generateWorkerName, isGeneratedWorkerName } from "../src/dashboard/names.js";

describe("generateWorkerName", () => {
  it("returns adjective-adjective-noun format", () => {
    const name = generateWorkerName([]);
    expect(name).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);
  });

  it("works with empty existing list", () => {
    const name = generateWorkerName([]);
    expect(name.length).toBeGreaterThan(0);
  });

  it("never returns a name in the existing list", () => {
    const existing = ["bold-keen-ash", "brave-dark-bay", "bright-calm-birch"];
    for (let i = 0; i < 50; i++) {
      const name = generateWorkerName(existing);
      expect(existing).not.toContain(name);
    }
  });

  it("generates distinct names across calls", () => {
    const names = new Set<string>();
    for (let i = 0; i < 20; i++) {
      names.add(generateWorkerName([]));
    }
    expect(names.size).toBeGreaterThan(1);
  });

  it("generates names its own recognizer accepts", () => {
    for (let i = 0; i < 20; i++) {
      expect(isGeneratedWorkerName(generateWorkerName([]))).toBe(true);
    }
  });

  it("falls back to exhaustive search when random path collides", () => {
    // Math.random()=0 always picks index 0: "arch-arch-arc"
    // Put that name in the existing list to force the exhaustive fallback
    const spy = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const name = generateWorkerName(["arch-arch-arc"]);
      expect(name).not.toBe("arch-arch-arc");
      // Exhaustive search starts at adj[0]-adj[0]-noun[0] ("arch-arch-arc"),
      // finds it used, then moves to noun[1] ("arch-arch-ash")
      expect(name).toBe("arch-arch-ash");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("isGeneratedWorkerName", () => {
  it("recognizes vocabulary triples", () => {
    expect(isGeneratedWorkerName("rich-wee-bay")).toBe(true);
    expect(isGeneratedWorkerName("bleak-hoar-glow")).toBe(true);
    expect(isGeneratedWorkerName("bold-keen-ash")).toBe(true);
  });

  it("rejects operator branch names", () => {
    expect(isGeneratedWorkerName("main")).toBe(false);
    expect(isGeneratedWorkerName("develop")).toBe(false);
    expect(isGeneratedWorkerName("feat/task-remove")).toBe(false);
    expect(isGeneratedWorkerName("fix-worker-signal")).toBe(false);
    expect(isGeneratedWorkerName("release-2-0")).toBe(false);
  });

  it("rejects near-misses on shape or vocabulary", () => {
    expect(isGeneratedWorkerName("rich-wee")).toBe(false); // two parts
    expect(isGeneratedWorkerName("rich-wee-bay-x")).toBe(false); // four parts
    expect(isGeneratedWorkerName("bay-rich-wee")).toBe(false); // noun first
    expect(isGeneratedWorkerName("")).toBe(false);
  });
});

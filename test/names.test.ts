import { describe, it, expect } from "vitest";
import { generateWorkerName } from "../src/dashboard/names.js";

describe("generateWorkerName", () => {
  it("returns adjective-noun format", () => {
    const name = generateWorkerName([]);
    expect(name).toMatch(/^[a-z]+-[a-z]+$/);
  });

  it("works with empty existing list", () => {
    const name = generateWorkerName([]);
    expect(name.length).toBeGreaterThan(0);
  });

  it("never returns a name in the existing list", () => {
    const existing = ["bold-ash", "brave-bay", "bright-birch"];
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

  it("throws when all names are exhausted", () => {
    const ADJECTIVES = [
      "bold", "brave", "bright", "brisk", "broad", "calm", "clean", "clear",
      "cold", "cool", "crisp", "dark", "deep", "dense", "dry", "dusk", "fair",
      "fast", "fierce", "fine", "firm", "flat", "fond", "fresh", "full", "glad",
      "gold", "grand", "gray", "green", "grim", "harsh", "high", "keen", "kind",
      "late", "lean", "light", "live", "long", "loud", "low", "mild", "neat",
      "new", "north", "old", "pale", "plain", "proud", "pure", "quick", "raw",
      "red", "rich", "rough", "round", "sharp", "slim", "slow", "smooth", "soft",
      "south", "stark", "still", "strong", "sure", "sweet", "swift", "tall",
      "taut", "thin", "tight", "tough", "true", "vast", "warm", "weak", "west",
      "wide", "wild", "wise", "young",
    ];
    const NOUNS = [
      "ash", "bay", "birch", "blade", "blaze", "bloom", "bolt", "bone", "brook",
      "cave", "cliff", "cloud", "coal", "colt", "core", "crane", "creek", "crow",
      "dawn", "deer", "dew", "dove", "drake", "drift", "dusk", "elm", "fawn",
      "fern", "finch", "flame", "flint", "ford", "fox", "frost", "gale", "gem",
      "glen", "grove", "hare", "hawk", "haze", "heath", "hound", "jade", "jay",
      "lake", "lark", "leaf", "lynx", "marsh", "mint", "mist", "moss", "moth",
      "oak", "pass", "peak", "pike", "pine", "pond", "quail", "rain", "reef",
      "ridge", "rock", "root", "rose", "sage", "shade", "shore", "sky", "slate",
      "snow", "spark", "spring", "star", "stone", "storm", "stream", "thorn",
      "tide", "trail", "vale", "vine", "wren",
    ];
    const allNames: string[] = [];
    for (const adj of ADJECTIVES) {
      for (const noun of NOUNS) {
        allNames.push(`${adj}-${noun}`);
      }
    }
    expect(() => generateWorkerName(allNames)).toThrow("All worker names exhausted");
  });
});

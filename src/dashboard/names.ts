// Worker name generation: memorable adjective-noun pairs for worker identity.

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

export function generateWorkerName(existingNames: string[]): string {
  const used = new Set(existingNames);

  for (let i = 0; i < 100; i++) {
    const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
    const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
    const name = `${adj}-${noun}`;
    if (!used.has(name)) return name;
  }

  for (const adj of ADJECTIVES) {
    for (const noun of NOUNS) {
      const name = `${adj}-${noun}`;
      if (!used.has(name)) return name;
    }
  }

  throw new Error("All worker names exhausted");
}

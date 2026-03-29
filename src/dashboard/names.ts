// Worker name generation: memorable adjective-adjective-noun triples for worker identity.

const ADJECTIVES = [
  "arch", "bare", "black", "bleak", "blithe", "blue", "blunt", "bold",
  "brash", "brave", "brief", "bright", "brisk", "broad", "brown", "burnt",
  "calm", "clean", "clear", "close", "cold", "cool", "coy", "crisp",
  "damp", "dark", "deep", "deft", "dense", "dim", "dour", "drawn",
  "dry", "dull", "dusk", "east", "faint", "fair", "far", "fast",
  "fell", "fey", "fierce", "fine", "firm", "flat", "fleet", "flush",
  "fond", "frail", "free", "fresh", "full", "gaunt", "glad", "glib",
  "gold", "grand", "grave", "gray", "green", "grim", "gruff", "hale",
  "hard", "harsh", "high", "hoar", "hot", "hushed", "keen", "kind",
  "lank", "late", "lean", "light", "lithe", "live", "lone", "long",
  "lorn", "lost", "loud", "low", "lush", "meek", "mild", "mute",
  "neat", "new", "north", "numb", "old", "pale", "plain", "plush",
  "proud", "pure", "quick", "rapt", "rare", "raw", "red", "rich",
  "ripe", "rough", "round", "rust", "sharp", "sheer", "shrewd", "shy",
  "sleek", "slight", "slim", "slow", "sly", "smooth", "snug", "soft",
  "south", "spare", "sparse", "spry", "stark", "steep", "stern", "stiff",
  "still", "stout", "strong", "sure", "sweet", "swift", "tall", "taut",
  "thick", "thin", "tight", "tough", "trim", "true", "vain", "vast",
  "wan", "warm", "weak", "wee", "west", "wet", "white", "wide",
  "wild", "wise", "worn", "wry", "young",
];

const NOUNS = [
  "arc", "ash", "bane", "bark", "bay", "bear", "beech", "birch",
  "blade", "blaze", "blight", "bloom", "bolt", "bone", "boon", "bough",
  "brine", "brink", "brook", "brush", "bud", "burr", "cave", "chaff",
  "char", "chime", "clay", "cliff", "cloud", "coal", "colt", "copse",
  "core", "cove", "crane", "creek", "crest", "crow", "crux", "cusp",
  "dale", "dawn", "deer", "dew", "doom", "dove", "drake", "drift",
  "drone", "dune", "dusk", "dust", "edge", "eel", "elk", "elm",
  "fall", "fate", "fawn", "fern", "field", "finch", "fish", "flame",
  "flare", "flaw", "flint", "flock", "foam", "ford", "fox", "frost",
  "gale", "gem", "ghost", "gleam", "glee", "glen", "glint", "glow",
  "glyph", "gorge", "grist", "grouse", "grove", "gull", "hare", "hawk",
  "haze", "heath", "hedge", "hex", "hill", "holt", "hound", "howl",
  "hum", "hush", "ice", "isle", "jade", "jay", "jest", "jolt",
  "knell", "knoll", "lake", "larch", "lark", "leaf", "ledge", "lime",
  "lodge", "loon", "lore", "luck", "lull", "lynx", "marsh", "mead",
  "mere", "mink", "mint", "mirth", "mist", "moon", "moor", "moss",
  "moth", "mote", "myth", "newt", "night", "oak", "oath", "pang",
  "pass", "peak", "peal", "perch", "pike", "pine", "pith", "plume",
  "pond", "pulse", "quail", "quartz", "quest", "rain", "reed", "reef",
  "ridge", "rill", "rock", "rook", "root", "rose", "rune", "rush",
  "rye", "sage", "sap", "scree", "sedge", "shade", "shale", "sheen",
  "shoal", "shore", "shroud", "sky", "slate", "sloe", "snow", "song",
  "soot", "spark", "spell", "spore", "spring", "spruce", "stalk", "star",
  "stem", "stir", "stone", "stork", "storm", "strand", "stream", "sun",
  "surge", "swale", "swan", "swell", "tale", "tarn", "thorn", "thrush",
  "tide", "toll", "tor", "trace", "trail", "trout", "twig", "vale",
  "vine", "vole", "vow", "wake", "weald", "weed", "whim", "wind",
  "wing", "wisp", "woe", "wolf", "wood", "wrath", "wren", "yew",
];

export function generateWorkerName(existingNames: string[]): string {
  const used = new Set(existingNames);

  for (let i = 0; i < 100; i++) {
    const adj1 = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
    const adj2 = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
    const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
    const name = `${adj1}-${adj2}-${noun}`;
    if (!used.has(name)) return name;
  }

  for (const adj1 of ADJECTIVES) {
    for (const adj2 of ADJECTIVES) {
      for (const noun of NOUNS) {
        const name = `${adj1}-${adj2}-${noun}`;
        if (!used.has(name)) return name;
      }
    }
  }

  throw new Error("All worker names exhausted");
}

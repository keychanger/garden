// Palette of log colors used to colorize project names in `garden logs`.
// Colors are assigned per-project and persisted in config.yml so they're
// stable across rehashing as the project list grows.
//
// `green` is reserved for the garden project itself (the most-frequent
// context) and is never handed out by `pickLogColor`. Reds are absent so
// project color never collides with error coloring in the same output.

export const RESERVED_LOG_COLOR_PROJECT = "garden";
export const RESERVED_LOG_COLOR_KEY = "green";

const PALETTE: Record<string, string> = {
  green: "\x1b[38;5;84m",
  cyan: "\x1b[38;5;39m",
  skyblue: "\x1b[38;5;75m",
  lavender: "\x1b[38;5;141m",
  pink: "\x1b[38;5;213m",
  orange: "\x1b[38;5;208m",
  gold: "\x1b[38;5;220m",
  lime: "\x1b[38;5;156m",
  turquoise: "\x1b[38;5;50m",
  violet: "\x1b[38;5;99m",
  magenta: "\x1b[38;5;177m",
  yellow: "\x1b[38;5;184m",
  mint: "\x1b[38;5;121m",
};

export const ASSIGNABLE_LOG_COLOR_KEYS: readonly string[] =
  Object.keys(PALETTE).filter((k) => k !== RESERVED_LOG_COLOR_KEY);

export function isValidLogColorKey(key: string): boolean {
  return key in PALETTE;
}

export function logColorAnsi(key: string): string | null {
  return PALETTE[key] ?? null;
}

// Pick the next assignable color for a new project. Walks the palette in
// declared order and returns the first key not already in `taken`. If every
// assignable key is in use, falls back to the least-used one (palette order
// breaks ties), keeping assignments balanced as the project count grows past
// the palette size.
export function pickLogColor(taken: readonly string[]): string {
  const useCount = new Map<string, number>();
  for (const key of ASSIGNABLE_LOG_COLOR_KEYS) useCount.set(key, 0);
  for (const key of taken) {
    if (useCount.has(key)) useCount.set(key, useCount.get(key)! + 1);
  }
  let best = ASSIGNABLE_LOG_COLOR_KEYS[0];
  let bestCount = useCount.get(best)!;
  for (const key of ASSIGNABLE_LOG_COLOR_KEYS) {
    const count = useCount.get(key)!;
    if (count < bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return best;
}

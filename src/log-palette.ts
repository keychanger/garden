// Persisted per-project log colors for `garden logs`. Colors are assigned at
// project registration so they stay stable as the project list grows. Green
// shades are reserved for garden itself (only `green` is in the palette; other
// greens like lime/mint are excluded entirely); reds are omitted so project
// color never collides with error coloring.

export const RESERVED_LOG_COLOR_PROJECT = "garden";
export const RESERVED_LOG_COLOR_KEY = "green";

// 256-color indices. Rendered as ANSI (`\x1b[38;5;Nm`) in pane content and
// as tmux styles (`colour<N>`) in border/status-bar formats.
const PALETTE: Record<string, number> = {
  green: 84,
  cyan: 39,
  skyblue: 75,
  lavender: 141,
  pink: 213,
  orange: 208,
  gold: 220,
  peach: 216,
  turquoise: 50,
  violet: 99,
  magenta: 177,
  yellow: 184,
  periwinkle: 105,
};

export const ASSIGNABLE_LOG_COLOR_KEYS: readonly string[] =
  Object.keys(PALETTE).filter((k) => k !== RESERVED_LOG_COLOR_KEY);

export function isValidLogColorKey(key: string): boolean {
  return key in PALETTE;
}

export function logColorAnsi(key: string): string | null {
  const index = PALETTE[key];
  return index === undefined ? null : `\x1b[38;5;${index}m`;
}

// tmux style color name (`colour<N>`) for border/status-bar formats.
export function logColorTmux(key: string): string | null {
  const index = PALETTE[key];
  return index === undefined ? null : `colour${index}`;
}

// Falls back to least-used (not first-unused) so colors stay balanced when projects exceed palette size.
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

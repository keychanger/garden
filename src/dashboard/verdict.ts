// Verdict parsing primitive: scans the trailing lines of a headless agent's
// output for a standalone verdict token from a caller-supplied vocabulary.
// Used by the reviewer (CLEAN/FIXED/FAILED) and resolver (DONE/FAILED).
// See WORKFLOWS.md Component 2 for the full contract.
//
// The function is pure, type-parameterized so callers get type-safe verdict
// discriminants, and has no I/O. The vocabulary is read-only at the type
// level so workflows can declare it `as const`.
//
// Default scanLines: 20 — matches the current reviewer's VERDICT_SCAN_LINES.
// Reviewers sometimes write the verdict and then add trailing summary, or
// forget the fenced verdict entirely; looking at the last 20 lines handles
// the first case. The resolver caller passes scanLines: 1 to preserve its
// stricter "last non-empty line only" behavior.

const VERDICT_LINE = /^([A-Za-z_]+)[.\s!]*$/;

export interface VerdictResult<V extends string> {
  verdict: V;
  /** Everything before the verdict line, joined and trimmed. May be empty —
   *  callers that want a placeholder (e.g. "No additional comments.") supply
   *  it themselves. */
  body: string;
}

export interface ParseVerdictOptions {
  /** How many trailing non-empty lines to scan for the verdict. Defaults
   *  to 20 (matches the current reviewer's VERDICT_SCAN_LINES). The
   *  resolver caller passes 1 to preserve its current "last non-empty
   *  line only" behavior. */
  scanLines?: number;
}

export function parseLastLineVerdict<V extends string>(
  output: string,
  vocabulary: readonly V[],
  options?: ParseVerdictOptions,
): VerdictResult<V> | null {
  const scanLines = options?.scanLines ?? 20;
  const lines = output.split("\n");

  let lastLineIdx = lines.length - 1;
  while (lastLineIdx >= 0 && !lines[lastLineIdx].trim()) lastLineIdx--;
  if (lastLineIdx < 0) return null;

  const scanStart = Math.max(0, lastLineIdx - scanLines + 1);
  for (let i = lastLineIdx; i >= scanStart; i--) {
    const match = lines[i].trim().match(VERDICT_LINE);
    if (!match) continue;
    const token = match[1].toUpperCase() as V;
    if (!vocabulary.includes(token)) continue;
    const body = lines.slice(0, i).join("\n").trim();
    return { verdict: token, body };
  }

  return null;
}

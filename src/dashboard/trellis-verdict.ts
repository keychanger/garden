// Trellis verdict vocabulary and parsers. See WORKFLOWS.md "Reviewer prompt
// and verdict".
//
// Two parsers live here:
//   - parseTrellisVerdict: thin wrapper over parseLastLineVerdict scoped
//     to the trellis vocabulary. Returns the verdict + raw body.
//   - parseDriftList: reads the structured drift block above a DRIFT
//     verdict line. Each drift item is a numbered bullet of the form
//     `1. [<tag>] <body> (trellis line N)`. Returns parsed items plus
//     a count of `present` claims (used by trellisAlignedCount).
//
// The drift parser tolerates loose formatting — markdown numbering quirks,
// extra whitespace, missing line numbers — because reviewers are LLMs and
// will not always emit pixel-perfect output. It refuses only when the
// block contains zero recognizable items, in which case the caller treats
// the verdict as unparseable.
import { parseLastLineVerdict } from "./verdict.js";

export const TRELLIS_VERDICTS = ["ALIGNED", "DRIFT", "FAILED", "FLAGGED"] as const;
export type TrellisVerdict = (typeof TRELLIS_VERDICTS)[number];

export interface TrellisVerdictResult {
  verdict: TrellisVerdict;
  body: string;
}

// A claim-tally line ("Aligned: 4", "aligned: 4 / partial: 1 / absent: 2") the
// reviewer writes while enumerating present claims — NOT the ALIGNED verdict.
// VERDICT_LINE would otherwise read "Aligned:" as the ALIGNED token via its ':'
// separator branch, so a reviewer that enumerates a tally but omits the verdict
// line would falsely converge the vine. The `\d+\s*(?:\/|$)` boundary is what
// separates a tally (bare number, then end-of-line or a `/` delimiter) from a
// digit-decorated genuine verdict ("ALIGNED: 0 drift", "ALIGNED = 7 present"),
// which carries a WORD after the number and must survive as ALIGNED.
const ALIGNED_COUNT_LINE = /^\s*aligned\s*[:=]\s*\d+\s*(?:\/|$)/i;

// Wrapper around parseLastLineVerdict typed to the trellis vocabulary.
// Returns null when the output ends with no recognizable trellis verdict
// — the caller's existing unparseable-verdict retry path handles it.
export function parseTrellisVerdict(output: string): TrellisVerdictResult | null {
  const parsed = parseLastLineVerdict(output, TRELLIS_VERDICTS);
  if (!parsed) return null;
  if (parsed.verdict === "ALIGNED") {
    // The bottom-most vocab match was ALIGNED — but it may be a claim tally
    // ("Aligned: 4") misread as the verdict. Blank every tally line and
    // re-scan: a genuine verdict above still wins, and a reviewer that wrote
    // only a tally (omitted the verdict) falls through to null, which routes to
    // the caller's fail-safe unparseable-verdict path rather than a false
    // convergence. Scoped to ALIGNED so DRIFT/FAILED/FLAGGED — and the DRIFT
    // alignedCount pipeline that reads a tally above a DRIFT line — are
    // untouched.
    const scrubbed = output.split("\n")
      .map(line => (ALIGNED_COUNT_LINE.test(line) ? "" : line))
      .join("\n");
    if (scrubbed !== output) {
      const reparsed = parseLastLineVerdict(scrubbed, TRELLIS_VERDICTS);
      if (!reparsed) return null;
      return { verdict: reparsed.verdict, body: reparsed.body };
    }
  }
  return { verdict: parsed.verdict, body: parsed.body };
}

export interface DriftItem {
  /** Bracket tag — typically `surface`, `tests`, or `docs` per the
   *  spec's recommended sections, but the parser accepts any tag the
   *  reviewer emits. Lowercased. */
  tag: string;
  /** The drift's prose body — everything between the closing `]` and
   *  the trailing `(trellis line N)` reference. */
  body: string;
  /** Trellis line number cited by the reviewer, when present. The
   *  reviewer is asked to include it; missing numbers don't fail the
   *  parse — just leave undefined. */
  line?: number;
  /** The raw numbered-bullet text (ready to feed back into the worker's
   *  continue prompt without reformatting). */
  raw: string;
}

export interface DriftListParseResult {
  items: DriftItem[];
  /** Count of "Aligned" claims the reviewer enumerated above the verdict
   *  block — see WORKFLOWS.md "Logs": `alignedCount` is the running count
   *  of claims marked `present`. The reviewer is asked to enumerate
   *  these in its three-way diff section; the parser scans for lines of
   *  the form "Aligned: N" or "N aligned" preceding the verdict. */
  alignedCount?: number;
}

// Numbered drift bullet. Matches:
//   `1. [surface] foo() exists but takes no `timeout` arg (trellis line 47)`
//   `12) [tests] no test for the timeout behavior`
//   `   3.    [docs]   CLAUDE.md unchanged`
const DRIFT_BULLET = /^\s*\d+[.)]\s*\[([^\]]+)\]\s*(.+?)\s*$/;
// Trailing line citation. Captured from the body. Optional.
const LINE_CITATION = /\(\s*trellis\s+line\s+(\d+)\s*\)/i;

// Aligned-count pre-block. The reviewer is asked to enumerate present /
// partial / absent claims; we look for an explicit "Aligned: N" or
// "N aligned items" line before the drift bullets. Optional — undefined
// when not stated.
const ALIGNED_COUNT = /(?:^|\b)(?:aligned\s*[:=]?\s*|aligned\s+items?\s*[:=]?\s*)(\d+)\b|\b(\d+)\s+aligned\b/i;

// Parse the body that comes back from a DRIFT verdict. The body is the
// reviewer's full output above the verdict line; this scans it for
// numbered drift bullets and an aligned count.
export function parseDriftList(body: string): DriftListParseResult {
  const items: DriftItem[] = [];
  for (const line of body.split("\n")) {
    const match = DRIFT_BULLET.exec(line);
    if (!match) continue;
    const tag = match[1].trim().toLowerCase();
    let bodyText = match[2].trim();
    let lineNum: number | undefined;
    const cite = LINE_CITATION.exec(bodyText);
    if (cite) {
      lineNum = Number.parseInt(cite[1], 10);
      // Strip the citation from the body to keep the prompt-rendered
      // form clean.
      bodyText = bodyText.replace(LINE_CITATION, "").trim().replace(/\s{2,}/g, " ");
    }
    items.push({ tag, body: bodyText, line: lineNum, raw: line.trim() });
  }
  const alignedMatch = ALIGNED_COUNT.exec(body);
  const alignedCount = alignedMatch
    ? Number.parseInt(alignedMatch[1] ?? alignedMatch[2], 10)
    : undefined;
  return { items, alignedCount };
}

// Render a drift item as a single line for the continue prompt. Mirror
// of the reviewer's output format so the worker sees the same shape it
// produced — line citation re-attached when present.
export function renderDriftItem(item: DriftItem, index: number): string {
  const cite = item.line !== undefined ? ` (trellis line ${item.line})` : "";
  return `${index + 1}. [${item.tag}] ${item.body}${cite}`;
}

// Extract cited clauses from a FLAGGED verdict body. The reviewer is
// asked to "cite the clauses with line numbers and describe the
// contradiction." This scans for line citations and returns them in
// occurrence order — used by the alert text and the resume diagnostic.
// Tolerant: strings without recognizable citations return an empty list,
// and the caller falls back to using the body verbatim.
export function parseFlaggedClauses(body: string): string[] {
  const clauses: string[] = [];
  const re = /\(\s*trellis\s+line\s+(\d+)\b[^)]*\)|trellis\s+line\s+(\d+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const num = m[1] ?? m[2];
    clauses.push(`trellis line ${num}`);
  }
  return Array.from(new Set(clauses));
}

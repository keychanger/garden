// Trellis file discovery + plant pre-flight. See WORKFLOWS.md "The trellis
// document" and "Plant-time pre-flight".
//
// A trellis file is a markdown document carrying:
// 1. The spec sentinel ("the code is wrong") in its first ~2KB so
//    findSpecFiles() classifies it as authoritative.
// 2. The trellis tag (`<!-- trellis: vN -->`) within the first 200 bytes,
//    distinguishing it from system specs (STATUS.md / TRACKS.md).
// 3. Optionally a retirement comment (`<!-- retired: YYYY-MM-DD ... -->`)
//    appended once the feature has landed and the operator wants the
//    trellis filtered from the picker.
import fs from "node:fs";
import path from "node:path";
import { tryGetProject } from "../config.js";

// Distinct from a system spec: matches `<!-- trellis: v1 -->`,
// `<!--trellis:v2-->`, `<!--   trellis:   v10   -->`. Future format
// versions bump the number; tooling can branch on it.
export const TRELLIS_TAG_REGEX = /<!--\s*trellis:\s*v(\d+)\s*-->/;

// Optional, separate comment appended on retire. Date is the only required
// field; the rest of the line is operator-freeform.
export const TRELLIS_RETIREMENT_REGEX = /<!--\s*retired:\s*\d{4}-\d{2}-\d{2}\b.*?-->/;

// The literal sentinel for the spec convention. Mirrors findSpecFiles in
// prompt-compose.ts; duplicated here so the picker can detect "spec
// sentinel missing" without depending on prompt-compose's signature.
export const SPEC_SENTINEL = "the code is wrong";

// Bytes scanned for the trellis tag. Per spec — keeping it small means an
// accidental occurrence of `<!-- trellis: v... -->` deep inside a doc
// won't be misclassified.
const TAG_SCAN_BYTES = 200;

// Bytes scanned for the spec sentinel and retirement comment. Larger
// window than the tag because retirement comments may sit several lines
// below the tag, after subsequent operator-amended history.
const HEADER_SCAN_BYTES = 2000;

export interface TrellisFileInfo {
  /** Filename without the `.md` extension. The picker and the CLI use
   *  this as the trellis's identity. */
  name: string;
  /** Resolved absolute path to the file. */
  path: string;
  /** True when the retirement comment is present. */
  retired: boolean;
  /** True when the spec sentinel is present in the header bytes. The
   *  reviewer's authority instructions degrade without it; the picker
   *  warns at plant time. */
  hasSentinel: boolean;
  /** Trellis format version from the tag (1 in v1). */
  version: number;
  /** One-line picker summary. Resolution order per spec:
   *  1. First non-blank line under an `## Intent` heading, if present.
   *  2. Otherwise, first non-blank prose paragraph after the title and
   *     trellis tag.
   *  3. Otherwise, an em dash placeholder. */
  summary: string;
}

const SUMMARY_PLACEHOLDER = "—";

// Return the configured trellis directory for a project (absolute), or
// null when the project isn't registered. Defaults to ".garden/trellises"
// relative to the project root per WORKFLOWS.md "File location".
export function trellisDirFor(projectName: string): string | null {
  const project = tryGetProject(projectName);
  if (!project) return null;
  const rel = project.trellisDir ?? ".garden/trellises";
  return path.resolve(project.path, rel);
}

// Scan a single file for the trellis tag + companions. Returns null when
// the file isn't a trellis (no tag), or when the file can't be read.
export function readTrellisFile(filePath: string): TrellisFileInfo | null {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
  const tagMatch = content.slice(0, TAG_SCAN_BYTES).match(TRELLIS_TAG_REGEX);
  if (!tagMatch) return null;
  const version = Number.parseInt(tagMatch[1], 10);
  const header = content.slice(0, HEADER_SCAN_BYTES);
  const retired = TRELLIS_RETIREMENT_REGEX.test(header);
  const hasSentinel = header.includes(SPEC_SENTINEL);
  const name = path.basename(filePath, ".md");
  const summary = resolveSummary(content);
  return { name, path: filePath, retired, hasSentinel, version, summary };
}

// Enumerate trellis files in the project's trellisDir. Sorted: active
// first (alpha), then retired (alpha). Returns empty when the directory
// doesn't exist or the project isn't registered.
export function findTrellisFiles(projectName: string): TrellisFileInfo[] {
  const dir = trellisDirFor(projectName);
  if (!dir) return [];
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: TrellisFileInfo[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const info = readTrellisFile(path.join(dir, entry));
    if (info) out.push(info);
  }
  out.sort((a, b) => {
    if (a.retired !== b.retired) return a.retired ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
  return out;
}

// Look up a single trellis by name within the project's trellisDir. The
// CLI uses this for `--trellis <name>` resolution and for `validateTrellisPlant`.
export function findTrellisByName(
  projectName: string,
  name: string,
): TrellisFileInfo | null {
  const dir = trellisDirFor(projectName);
  if (!dir) return null;
  // Allow the name to be supplied with or without the .md suffix.
  const stem = name.endsWith(".md") ? name.slice(0, -3) : name;
  return readTrellisFile(path.join(dir, `${stem}.md`));
}

export type ValidateTrellisPlantResult =
  | { ok: true; info: TrellisFileInfo; warnings: string[] }
  | { ok: false; error: string };

// Plant-time pre-flight per WORKFLOWS.md "Plant-time pre-flight". The picker
// (phase 5) and the CLI both call this so behavior is shared. Returns
// either an `ok` result with an info handle and an array of soft warnings
// (e.g. missing sentinel), or an error string suitable for direct display.
//
// Refusal cases (returns ok: false):
//   - Project not registered.
//   - trellisDir missing or named trellis not found in it.
//   - Trellis is retired (the picker pre-filters; the CLI must refuse).
//
// Warning cases (returns ok: true with warnings):
//   - Spec sentinel missing — reviewer authority instructions degrade.
//   - `checks` config not set — verdicts are stronger when the reviewer
//     can run a test suite, but the loop functions without one.
export function validateTrellisPlant(
  projectName: string,
  trellisName: string,
): ValidateTrellisPlantResult {
  const project = tryGetProject(projectName);
  if (!project) {
    return { ok: false, error: `Unknown project: ${projectName}` };
  }
  const info = findTrellisByName(projectName, trellisName);
  if (!info) {
    const available = findTrellisFiles(projectName)
      .filter(t => !t.retired)
      .map(t => t.name);
    const tail = available.length > 0
      ? ` Available: ${available.join(", ")}`
      : ` No trellises found in ${trellisDirFor(projectName)}; create one with 'garden trellis new ${projectName} <name>'.`;
    return {
      ok: false,
      error: `Trellis '${trellisName}' not found in project '${projectName}'.${tail}`,
    };
  }
  if (info.retired) {
    return {
      ok: false,
      error: `Trellis '${trellisName}' is retired; revive with 'garden trellis revive ${projectName} ${trellisName}' first.`,
    };
  }
  const warnings: string[] = [];
  if (!info.hasSentinel) {
    warnings.push(
      `Trellis '${trellisName}' is missing the '${SPEC_SENTINEL}' spec sentinel; ` +
      `the reviewer's authority instructions will degrade. Add it with ` +
      `'garden trellis amend ${projectName} ${trellisName}' before the next iteration.`,
    );
  }
  if (!project.checks) {
    warnings.push(
      `Project '${projectName}' has no 'checks' config; reviewer can't run a test suite. ` +
      `Set with 'garden config ${projectName} checks "<command>"' for stronger verdicts.`,
    );
  }
  return { ok: true, info, warnings };
}

// --- Helpers -------------------------------------------------------------

function resolveSummary(content: string): string {
  const lines = content.split("\n");

  // 1. First non-blank line under an `## Intent` heading.
  const intentIdx = lines.findIndex(l => /^\s*##\s+Intent\b/.test(l));
  if (intentIdx >= 0) {
    for (let i = intentIdx + 1; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed) continue;
      // Stop scanning when we hit the next heading without finding prose.
      if (/^#/.test(trimmed)) break;
      return trimmed;
    }
  }

  // 2. First non-blank prose paragraph after the title and trellis tag.
  //    Skip the title (`# ...`), the trellis tag comment, and any blank
  //    lines, then take the first non-blank, non-heading line.
  let inTitle = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (TRELLIS_TAG_REGEX.test(trimmed)) continue;
    if (/^#\s/.test(trimmed)) {
      // Title (single hash). Skip and continue to next non-blank line.
      inTitle = true;
      continue;
    }
    if (/^##/.test(trimmed)) {
      // Sub-heading. The summary is whichever prose follows next, but
      // only if we haven't yet emitted a heading that opens a section
      // we should not summarize from. For the recommended sections the
      // first sub-heading is "Intent", which case 1 already handled.
      // Be defensive: if we hit any sub-heading, fall through to step 3.
      break;
    }
    // Skip standalone HTML comments (anything beyond the trellis tag).
    if (/^<!--.*-->$/.test(trimmed)) continue;
    if (inTitle) return trimmed;
  }

  // 3. Em dash placeholder.
  return SUMMARY_PLACEHOLDER;
}

// Per-project diaries: free-form operator notes stored outside any repo
// at ~/.garden/diary/<project>.md. Operator-private — never committed,
// never shown to workers or reviewers.
import fs from "node:fs";
import path from "node:path";
import { GARDEN_DIR } from "./config.js";

export const DIARY_DIR = path.join(GARDEN_DIR, "diary");

export function diaryFilePath(projectName: string): string {
  fs.mkdirSync(DIARY_DIR, { recursive: true });
  return path.join(DIARY_DIR, `${projectName}.md`);
}

// Whether a project's diary holds any non-whitespace content. Drives the
// status-pane diary glyph (see commands/status.ts). Reads the file directly
// (no mkdir side effect, unlike diaryFilePath) and stat-caches the result on
// mtimeMs+size so a burst of status re-bakes under the hook firehose doesn't
// re-read every project's diary each time — mirrors readDashState's cache. An
// empty or whitespace-only file (e.g. a stray newline) counts as no content.
const contentCache = new Map<string, { mtimeMs: number; size: number; hasContent: boolean }>();

export function diaryHasContent(projectName: string): boolean {
  const file = path.join(DIARY_DIR, `${projectName}.md`);
  try {
    const stat = fs.statSync(file);
    const cached = contentCache.get(projectName);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.hasContent;
    }
    const hasContent = fs.readFileSync(file, "utf-8").trim().length > 0;
    contentCache.set(projectName, { mtimeMs: stat.mtimeMs, size: stat.size, hasContent });
    return hasContent;
  } catch {
    contentCache.delete(projectName);
    return false;
  }
}

/** Test-only: clear the diary-content cache between cases. */
export function _resetDiaryContentCacheForTest(): void {
  contentCache.clear();
}

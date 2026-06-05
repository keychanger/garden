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

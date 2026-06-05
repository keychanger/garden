// Per-project scratch pads: free-form operator notes stored outside any
// repo at ~/.garden/pads/<project>.md. Operator-private — never committed,
// never shown to workers or reviewers.
import fs from "node:fs";
import path from "node:path";
import { GARDEN_DIR } from "./config.js";

export const PADS_DIR = path.join(GARDEN_DIR, "pads");

export function padFilePath(projectName: string): string {
  fs.mkdirSync(PADS_DIR, { recursive: true });
  return path.join(PADS_DIR, `${projectName}.md`);
}

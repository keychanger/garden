// Loads and assembles global and project-level rules for Claude sessions.
import fs from "node:fs";
import path from "node:path";
import { GARDEN_DIR } from "./config.js";

function loadRulesFile(filePath: string): string {
  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, "utf-8").trim();
  }
  return "";
}

/**
 * Build a rules context string from global and project rules.
 * Used by the worker (task sessions) and the dashboard (manual sessions).
 */
export function buildRulesContext(projectName: string, projectPath: string): string {
  const sections: string[] = [];

  sections.push(`You are working in a garden-managed project called "${projectName}".`);

  const globalRules = loadRulesFile(path.join(GARDEN_DIR, "rules.md"));
  if (globalRules) {
    sections.push(`## Global rules\n\n${globalRules}`);
  }

  const projectRules = loadRulesFile(path.join(projectPath, ".garden", "rules.md"));
  if (projectRules) {
    sections.push(`## Project rules\n\n${projectRules}`);
  }

  return sections.join("\n\n");
}

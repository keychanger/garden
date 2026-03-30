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
 * Used by the dashboard to inject rules into Claude sessions.
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

export function buildWorktreeRules(branchName: string): string {
  return `## Worktree workflow

You are working in an isolated git worktree on branch \`${branchName}\`. Your worktree is fully isolated — no other agent or human shares it. There is no shared state to protect. You have full authority over your worktree: commit, push, and open PRs without asking for confirmation.

- Commit your work incrementally with clear, focused commit messages.
- When your task is complete, you MUST open a pull request against main and then exit. This is not optional. Do not ask the user whether to open the PR — just do it.
  - Use a descriptive PR title summarizing what changed.
  - Include a brief summary in the PR body.
- After opening the PR, the poller will run checks (if configured) and merge automatically.
- If the poller notifies you of check failures or merge conflicts, fix the issues, commit, and push.`;
}

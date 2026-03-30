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

You are working in an isolated git worktree on branch \`${branchName}\`.

- Commit your work incrementally with clear, focused commit messages.
- When your task is complete, open a pull request against main.
  - Use a descriptive PR title summarizing what changed.
  - Include a brief summary in the PR body.
- After opening the PR, wait for review feedback.
- When addressing review feedback or resolving merge conflicts, commit and push all your changes in a single push when you are done.`;
}

export function buildReviewRules(
  prNumber: number,
  branchName: string,
): string {
  return `## Review workflow

You are reviewing PR #${prNumber} on branch \`${branchName}\`.

- Read the full diff: \`gh pr diff ${prNumber}\`
- Run the project's test suite if one exists.
- Check for: correctness, scope discipline, no secrets, no unnecessary dependencies.
- If the code is correct and tests pass:
  - Approve: \`gh pr review ${prNumber} --approve\`
  - Do not merge. The merge queue handles merging.
- If changes are needed:
  - Request changes with specific, actionable feedback: \`gh pr review ${prNumber} --request-changes --body "your feedback"\`
- After completing your review, wait for further instructions.`;
}

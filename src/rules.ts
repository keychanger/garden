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

export function buildWorktreeRules(branchName: string, baseBranch = "main"): string {
  return `## Worktree workflow

You are working in an isolated git worktree on branch \`${branchName}\`. Your worktree is fully isolated — no other agent or human shares it. There is no shared state to protect. You have full authority over your worktree: commit and push without asking for confirmation.

**Branch rule (load-bearing):** You are already on branch \`${branchName}\`. Commit directly to it. **Do NOT** create a new feature branch with \`git checkout -b\` or \`git switch -c\`. The poller maps you to exactly one branch by name; if you commit on a side branch, the poller will force-push the stale named ref instead of your work and the merge will silently fail in a loop. This applies even if \`${branchName}\` has already been merged before — more commits on the same branch are reviewed and merged again as a fresh cycle. If a global rule says "always create a feature branch", that rule does not apply to you: you are the worker, and \`${branchName}\` IS your feature branch.

- Commit your work incrementally. Your commit messages are the primary way reviewers understand your intent — write them for an audience that has never seen your task description. The first commit should explain what problem you are solving and your approach. Subsequent commits should explain why each change was made, not just what changed.
- When your task is complete, push your branch. The poller will automatically rebase, review, and merge your changes into ${baseBranch}.
- If the poller notifies you of review feedback, check failures, or merge conflicts, fix the issues, commit, and push.
- Do NOT exit after pushing. Stay alive and wait for further instructions or poller notifications. Garden will terminate your session when appropriate.`;
}

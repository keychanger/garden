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
- When your task is complete, commit and push your branch — this applies to *every* file you created or changed (docs, CLAUDE.md, scripts, configs), not just code. Writing a file to disk is not delivery; until it is pushed, the poller never sees it and your work is invisible. Before you end your turn, confirm \`git status\` is clean and \`git log @{u}..HEAD\` is empty — if either shows pending work, commit and push it. The poller will automatically rebase, review, and merge your changes into ${baseBranch}.
- If the poller notifies you of review feedback, check failures, or merge conflicts, fix the issues, commit, and push.
- Do NOT exit after pushing. Stay alive and wait for further instructions or poller notifications. Garden will terminate your session when appropriate.
- Your identity is in the shell env: \`$GARDEN_WORKER\`, \`$GARDEN_PROJECT\`, \`$GARDEN_BRANCH\`, \`$GARDEN_BASE_BRANCH\`. Run \`garden whoami\` for your registry entry (state, siblings, task) and \`garden logs -w $GARDEN_WORKER\` for your own log history — useful when picking up after a review or resolver cycle.

**Do NOT sleep or loop-poll to watch the poller work.** The poller is driven by Claude Code's Stop hook — it only advances \`working → reviewing\` after your turn ends. Constructs like \`for i in 1..6; do sleep 10; check state; done\`, \`until rg prState=reviewing; do sleep N; done\`, or any other long bash sleep that waits for a state transition keep your turn alive and block the very event you are waiting on. It is a deadlock. If you want the poller to pick up your commits, **end your turn.** It will wake you with a new prompt when there is something for you to act on. Short sleeps (a few seconds) to let a subprocess settle are fine; sleeping to observe the poller is not.

**Auto-continue across phases.** After your branch is reviewed and merged, garden automatically sends a "please proceed" prompt to your pane so multi-phase work keeps building on the merged base without operator intervention. When you have completed *everything* the operator asked for, write a sentinel file at \`~/.garden/sessions/$GARDEN_PROJECT-$GARDEN_WORKER.done\` before ending your turn — its presence tells garden not to auto-continue on the next merge. If you receive an auto-continue prompt and there is genuinely nothing left to do, just say so briefly and end your turn; one wasted turn is fine, but silently stopping mid-task is not.`;
}

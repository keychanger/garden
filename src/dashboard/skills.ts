// Per-worker Claude Code skills installed under <worktree>/.claude/skills/.
//
// Skills are user/agent-invocable instructions that Claude evaluates against
// their description when deciding which tool to use. They give us a structured
// place to put behaviors that shouldn't pollute the main system prompt — the
// description acts as a trigger condition, the body is loaded only on
// invocation. See https://docs.anthropic.com/claude-code/skills.
//
// Currently bundled: `done` — invoked by the worker when it has completed
// every part of the operator's original request, before ending its turn.
// Writes the .garden-done sentinel so the post-merge auto-continue check
// sees it and skips the continuation prompt, leaving the worker in `merged`
// (the operator's "this work is finished, you can clean it up" signal).
import fs from "node:fs";
import path from "node:path";

export const DONE_SKILL_FILENAME = "done.md";

// The skill markdown — frontmatter declares the trigger; body is loaded on
// invocation. Kept here as a single source of truth so installClaudeHooks
// (used for existing workers on refresh/bounce) and the worktree bootstrap
// script (which writes settings.json inline at worker-creation time, before
// the worktree exists) emit byte-identical content.
export const DONE_SKILL_CONTENT = `---
name: done
description: Use when you have completed everything the operator asked for and are about to end your turn. Writes the .garden-done sentinel so garden marks the work as merged-and-complete on the next merge instead of auto-continuing into a new phase.
---

# Done

Invoke this skill at the end of any turn where you believe you have finished every part of the operator's original request. It writes the sentinel file that tells garden's poller "this worker is done; do not auto-continue on the next merge."

## What it does

Runs \`touch .garden-done\` at the root of your worktree (your CWD). On the next merge of your branch, garden's poller checks for this file:

- **File present**: the auto-continue prompt is suppressed. Your worker stays in the \`merged\` state on the dashboard — the operator's "this work is complete, the worker can be cleaned up" signal.
- **File absent**: garden assumes there's another phase coming and sends a "please proceed" prompt to your pane.

## When to use

- You have completed every part of the operator's original request.
- You have committed and pushed all your changes (\`git status\` clean, \`git log @{u}..HEAD\` empty).
- No review failure is pending. (If your branch is in \`failing\` state, fix the feedback instead.)

## When NOT to use

- You are in the middle of a multi-phase task and just finished one phase — garden will auto-continue you into the next phase; that is the intended flow.
- You hit a problem you cannot solve. Tell the operator instead; silently declaring "done" hides incomplete work.
- A review came back \`failing\` and you have not addressed the feedback yet.
- The operator's request includes future-tense work ("once the previous phase merges, do X") — finish X first.

## How to invoke

From your worktree CWD:

\`\`\`bash
touch .garden-done
\`\`\`

That is the entire invocation. Verify with \`ls -la .garden-done\`. Then end your turn with a one- or two-sentence acknowledgement that the work is complete. Do **not** \`git add\` the file — it is per-worker state, excluded from git via the worktree's \`info/exclude\` at bootstrap time.

## Recovery

If you wrote \`.garden-done\` and the operator gives you more work afterward, they can run \`garden resume <worker>\` to clear the sentinel and re-arm the auto-continue chain. They can also simply prompt you again — if your reply turn produces new commits, the normal review/merge cycle takes over and the sentinel is re-evaluated on the next merge.
`;

export function installClaudeSkills(targetDir: string): void {
  const skillsDir = path.join(targetDir, ".claude", "skills");
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.writeFileSync(path.join(skillsDir, DONE_SKILL_FILENAME), DONE_SKILL_CONTENT);
}

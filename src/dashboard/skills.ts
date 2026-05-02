// Garden-bundled Claude Code skills installed under <worktree>/.claude/skills/.
// Skill descriptions act as Claude's trigger condition during planning, more reliable than instructions buried in the system prompt.
import fs from "node:fs";
import path from "node:path";

// Claude Code discovers a project skill at .claude/skills/<name>/SKILL.md (directory + SKILL.md), not .claude/skills/<name>.md.
export const DONE_SKILL_DIRNAME = "done";
export const DONE_SKILL_FILENAME = "SKILL.md";

// Single source of truth: the bootstrap script inlines this string before the worktree exists, and installClaudeHooks rewrites it on refresh/bounce.
export const DONE_SKILL_CONTENT = `---
name: done
description: Use when you have completed everything the operator asked for and are about to end your turn. Writes the .garden-done sentinel so garden marks the work as done on the next merge (status pane shows green "done") instead of auto-continuing into a new phase.
---

# Done

Invoke this skill at the end of any turn where you believe you have finished every part of the operator's original request. It writes the sentinel file that tells garden's poller "this worker is done; do not auto-continue on the next merge."

## What it does

Runs \`touch .garden-done\` at the root of your worktree (your CWD). On the next merge of your branch, garden's poller checks for this file:

- **File present**: the auto-continue prompt is suppressed. Your worker enters the \`done\` state on the dashboard (bold green check) — the operator's "this work is complete, the worker can be cleaned up" signal.
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

export const HANDOFF_SKILL_DIRNAME = "handoff";
export const HANDOFF_SKILL_FILENAME = "SKILL.md";

export const HANDOFF_SKILL_CONTENT = `---
name: handoff
description: Use when the operator instructs you to hand the current task off to a fresh worker — typically on a different project (cross-repo work), or on the same project to reset accumulated context. Spawns a new named garden worker that participates in the normal review/merge flow, seeds it with a detailed briefing you compose, swaps its pane into view, and leaves you free to mark yourself done. Do NOT invoke without an explicit operator instruction.
---

# Handoff

Invoke this skill when the operator tells you to pass the current task to a new worker. The skill spawns a fresh worker on the target project and seeds its first turn with a briefing you write. After the handoff succeeds you write the \`.garden-done\` sentinel and end your turn — the new worker takes over from there.

## What it does

Runs \`garden handoff <target-project>\` from your worktree CWD, reading a multi-line briefing from stdin via heredoc. Garden:

1. Creates a new worker on \`<target-project>\` — a normal named worker with its own git worktree, fresh Claude session, and own poller. It participates in the standard review/merge flow.
2. Swaps the new worker's pane into view exactly like ⌥n would: your pane gets parked under your project and the operator's right-pane now shows the new worker. For cross-project handoff, the dashboard's active project (and active plot, if needed) follows along to the target.
3. Seeds the new worker's first prompt with your briefing, prefixed \`[handoff from <your-project>/<your-name>]\` so the new worker knows it received a handoff (not a normal user prompt).
4. Prints the new worker's name to stdout — report it to the operator before you end your turn.

## When to use

- The operator told you to hand off (e.g., "hand this to a fresh worker on garden-app", "spin up a new worker on this repo to take over", "pass this off"). The instruction is explicit.
- The new worker genuinely benefits from a fresh start: cross-project work you can't do in your current worktree, or context-reset on the same project after a long session.

## When NOT to use

- The operator did not ask. Self-handing-off is not the intended pattern. If you think a fresh worker would help, **ask the operator** — do not invoke unilaterally.
- The work is already finished. Use the \`done\` skill instead.
- You are mid-phase in your own task. Finish what you're doing (or commit a clean stopping point) first.
- The target project does not exist or is not registered with garden. Confirm it with \`garden plot show <plot>\` or by asking the operator.

## How to invoke

From your worktree CWD, with a heredoc for the briefing:

\`\`\`bash
garden handoff <target-project> <<'EOF'
<one-paragraph summary of the task and where the work currently stands>

Context the new worker needs:
- <key file paths, commit SHAs, branch names>
- <any prior decisions or constraints>
- <gotchas, things to avoid>

Next steps:
1. <concrete first action>
2. <second action>
3. <...>

If anything is ambiguous, ask the operator before proceeding.
EOF
\`\`\`

For a one-line briefing you can use \`-m\`:

\`\`\`bash
garden handoff <target-project> -m "Take over the failing-tests investigation on branch foo. See commit abc123 for context."
\`\`\`

The briefing is the new worker's only initial signal — invest in it. Include file paths, commit hashes, decisions made, and what specifically remains. The new worker has no memory of your conversation.

## After handoff

1. Confirm the command succeeded (it prints the new worker's name).
2. Tell the operator which worker you handed off to.
3. Run \`touch .garden-done\` to mark yourself done — the handoff is your terminal action.
4. End your turn.

If \`garden handoff\` fails (unknown project, etc.), report the error to the operator and do not write \`.garden-done\`.
`;

export function installClaudeSkills(targetDir: string): void {
  const skillsRoot = path.join(targetDir, ".claude", "skills");
  // Heal the legacy flat-file layout so refreshes/bounces of pre-fix workers stop shadowing the new directory layout.
  fs.rmSync(path.join(skillsRoot, "done.md"), { force: true });
  writeSkill(skillsRoot, DONE_SKILL_DIRNAME, DONE_SKILL_FILENAME, DONE_SKILL_CONTENT);
  writeSkill(skillsRoot, HANDOFF_SKILL_DIRNAME, HANDOFF_SKILL_FILENAME, HANDOFF_SKILL_CONTENT);
}

function writeSkill(skillsRoot: string, dirname: string, filename: string, content: string): void {
  const skillDir = path.join(skillsRoot, dirname);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, filename), content);
}

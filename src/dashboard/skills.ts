// Garden-bundled Claude Code skills installed under <worktree>/.claude/skills/.
// Skill descriptions act as Claude's trigger condition during planning, more reliable than instructions buried in the system prompt.
import fs from "node:fs";
import path from "node:path";
import { atomicWriteFile } from "./atomic-write.js";

// Claude Code discovers a project skill at .claude/skills/<name>/SKILL.md (directory + SKILL.md), not .claude/skills/<name>.md.
export const DONE_SKILL_DIRNAME = "done";
export const DONE_SKILL_FILENAME = "SKILL.md";

// Single source of truth: the bootstrap script inlines this string before the worktree exists, and installClaudeHooks rewrites it on refresh/bounce.
export const DONE_SKILL_CONTENT = `---
name: done
description: Use ONLY when the operator's full original request — every phase, not just the current one — is complete. When that gate is met, invoke at the end of the same turn that pushed your final commit; this saves a round-trip versus waiting for the post-merge "please proceed" prompt. Writes the .garden-done sentinel so the next merge transitions straight to "done" instead of auto-continuing. Do NOT invoke mid-phase — multi-phase work is the default, and the auto-continue prompt is the intended way to advance between phases.
---

# Done

Invoke this skill ONLY when you have finished every part of the operator's original request — every phase, not just the current one. When that condition is met, you may invoke at the end of the same turn that pushed your final commit (saves a round-trip versus waiting for the post-merge "please proceed" prompt to remind you). It writes the sentinel file that tells garden's poller "this worker is done; do not auto-continue on the next merge."

If you are mid-phase, or there is more work the operator asked for that has not landed yet, do **not** invoke this skill. The post-merge auto-continue prompt is the intended way to advance between phases — let it fire.

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

## Before invoking — doc walk-through

Before \`touch .garden-done\`, walk the project's documentation:

- If your work introduced a new "add one of these" extension point — a kind of thing where someone might add another later (a command, a workflow, an agent type, a plugin, a hook) — does \`CLAUDE.md\` have an "Adding a new X" how-to to anchor it? \`CLAUDE.md\` is the canonical place. If the project doesn't have one, suggest creating one rather than silently skipping.
- If your work introduced a new core concept (a thing on par with the project's existing nouns), is it described in the project's architecture or overview document, where one exists? Don't create such a doc just for this — only update if it already exists.
- If your work referenced or completed a design / spec document written in future tense, is the tense correct now?

Fix gaps before touching the sentinel. Skip questions whose target doc doesn't exist; don't manufacture docs unless the operator has asked.

## How to invoke

From your worktree CWD:

\`\`\`bash
touch .garden-done
\`\`\`

That is the entire invocation. Verify with \`ls -la .garden-done\`. Then end your turn with a one- or two-sentence acknowledgement that the work is complete. Do **not** \`git add\` the file — it is per-worker state, excluded from git via the worktree's \`info/exclude\` at bootstrap time.

## Recovery

If you wrote \`.garden-done\` and the operator gives you more work afterward, just keep working — their \`UserPromptSubmit\` automatically clears both the \`done\` state and the on-disk sentinel, so a no-commits Stop in the new turn will not re-trip \`done\`. If, after working through their new prompt, you decide you are *still* finished, re-run \`touch .garden-done\` and end your turn — the skill is cheap to re-invoke. \`garden resume <worker>\` is the manual escape hatch for clearing the sentinel without prompting the worker.
`;

export const TRELLIS_AUTHOR_SKILL_DIRNAME = "trellis-author";
export const TRELLIS_AUTHOR_SKILL_FILENAME = "SKILL.md";

// Bundled with every worker — including default-workflow workers — so an
// operator can ask any worker to formalize a feature as a trellis without
// switching panes. Skill descriptions act as Claude's planning-time
// trigger condition; this one fires on operator intent.
export const TRELLIS_AUTHOR_SKILL_CONTENT = `---
name: trellis-author
description: Use when the operator asks you to formalize a feature as a trellis — a frozen design document that drives garden's spec-driven loop workflow. The skill walks through scope sizing, the required spine (title, sentinel, trellis tag), recommended sections (Intent, Surface, Behavior, Tests, Docs, Out of scope), and a self-review pass for ambiguity. Use when the operator says things like "let's write a trellis for X", "formalize this as a trellis", or "set up a trellis-driven loop on this feature". Do NOT invoke unprompted.
---

# Trellis author

Invoke this skill when the operator wants to formalize a feature as a **trellis** — a markdown design document that becomes the source of truth for a feature-scoped, spec-driven loop. The trellis workflow then plants a worker (a "vine") bound to the trellis; the vine iterates on the implementation while the reviewer compares each iteration's diff against the trellis until they align.

A good trellis is small, concrete, and bounded. It describes *what the feature does* — not *how* — and uses an explicit "Out of scope" section to prevent the loop from chasing adjacent improvements.

## What it does

Walks you through authoring a trellis at \`<project>/.garden/trellises/<name>.md\` (or wherever the project's \`trellisDir\` config points). Output is a markdown file that:

1. Carries the spec sentinel \`the code is wrong\` so the reviewer treats it as authoritative.
2. Carries the trellis tag \`<!-- trellis: v1 -->\` so the picker and CLI recognize it as a trellis (distinct from system specs like STATUS.md).
3. Has the recommended sections (Intent, Surface, Behavior, Tests, Docs, Out of scope) populated with feature-specific content the reviewer can grep against.
4. Has been self-reviewed for ambiguity, contradiction, and completeness.

After authoring, commit the trellis to the project's main branch. Then the operator can plant a vine via \`garden workers new <project> --workflow trellis --trellis <name>\` (or via the \`⌥⇧n\` picker in the dashboard).

## When to use

- The operator explicitly asks you to write or formalize a trellis (e.g., "let's spec this as a trellis", "write a trellis for the auth-rewrite", "scaffold a trellis-driven loop on X").
- The feature is genuinely *one feature* — a bounded set of related changes the reviewer can verify against the document. Multi-month projects do not fit; decompose them into a sequence of trellises.
- The operator wants the agent to iterate against a stable design target rather than a one-shot task. The trellis loop's value comes from the reviewer's three-way diff (trellis ↔ code, ↔ tests, ↔ docs) catching drift across iterations.

## When NOT to use

- The operator asked for a one-shot change. A 50-line bug fix does not need a trellis.
- The "feature" is actually a project (multiple subsystems, multiple weeks). Decompose first.
- The work has no clear convergence criterion. The reviewer needs concrete claims to verify; "make the API better" cannot be drift-checked.
- The operator did not ask. Authoring a trellis unprompted is overkill — say so and offer the option.

## How to invoke

The skill is a guided author. Walk the operator (and yourself) through these phases:

### 1. Scope sizing

Before writing anything, confirm:

- **One feature.** Name it in a sentence. If you can't name it without "and", split it.
- **Bounded.** What is *not* included? The trellis's "Out of scope" section is load-bearing — without it, the loop chases adjacent improvements.
- **Convergence criterion.** What does \`ALIGNED\` look like? If you can't sketch a reviewer's checklist of present/partial/absent claims, the trellis isn't ready to write.

If any of these is unclear, ask the operator before drafting.

### 2. Spine

Every trellis has three required pieces in the file's header:

\`\`\`markdown
# <Feature name>

Intent paragraph including the literal phrase "the code is wrong" so the reviewer treats this document as authoritative.

<!-- trellis: v1 -->
\`\`\`

The title is on line 1. The sentinel must appear in the first ~2KB. The tag must appear in the first 200 bytes. \`garden trellis new <project> <name>\` scaffolds these correctly — prefer it over hand-crafting the file.

### 3. Recommended sections

The reviewer treats the trellis as prose, but the following sections make the three-way diff tractable:

- **Intent** — one paragraph: what the feature does and why. The reviewer judges this loosely.
- **Surface** — concrete API/CLI/UI surface that must exist. Function signatures, command flags, file paths. The reviewer verifies via grep + signature checks. Be specific: "exports \`foo(timeout?: number)\` from \`src/foo.ts\`" beats "has a foo function with timeout support".
- **Behavior** — invariants the feature must satisfy. Mix of objective ("error path returns \`{ok: false, reason}\`") and judgment-graded ("errors should be specific and structured"). Number them so drift items can cite them.
- **Tests** — concrete test cases that should exist. File paths or test names. The reviewer verifies via grep on test files.
- **Docs** — concrete documentation that should exist or update. Paths + section titles. Don't request docs the project doesn't already maintain.
- **Out of scope** — explicit non-goals. Lists every adjacent improvement the reviewer should bounce back as drift, not accept as part of the trellis.

### 4. Self-review pass

Before saving, walk the trellis end-to-end:

- **Ambiguity.** Pick three claims at random. Could two reasonable readers disagree on whether they're satisfied? If yes, rewrite for concreteness.
- **Contradiction.** Read every Surface claim against every Behavior claim. Any conflict? Either the trellis is wrong (rewrite) or you've discovered a real design tension (resolve before planting).
- **Completeness.** For each Surface claim, is there a corresponding Tests claim? For each Behavior claim, is the test path clear? Gaps here become drift the loop will keep flagging.
- **Out of scope.** Is the boundary tight enough that the worker won't keep "fixing" adjacent code? The most common failure mode is a too-loose boundary.

A trellis that survives a self-review pass cleanly produces a small, fast loop. A trellis that doesn't will burn iterations on rework.

### 5. Commit and report

Commit the trellis to the project's main branch (not the worker's branch — the trellis lives on main as authority). Use a clear commit message: \`trellis: <name> — <one-line summary>\`. After committing, tell the operator the trellis path and offer to plant a vine: \`garden workers new <project> --workflow trellis --trellis <name>\`.

## After authoring

The trellis is now a durable artifact. It outlives any vine that consumes it; multiple vines can be planted on the same trellis (competitive bake-off), and a converged trellis remains as a design record for the feature. The operator decides when to retire it via \`garden trellis retire\`.
`;

export const HANDOFF_SKILL_DIRNAME = "handoff";
export const HANDOFF_SKILL_FILENAME = "SKILL.md";

export const HANDOFF_SKILL_CONTENT = `---
name: handoff
description: Use when the operator instructs you to hand off work to one or more fresh workers — a single pass-the-baton handoff, or a fan-out where you delegate several deferred items in parallel. Targets can be the same project (context reset) or a different project (cross-repo). Spawns named garden workers that participate in the normal review/merge flow, seeds each with a briefing you compose, and leaves you to mark yourself done. Do NOT invoke without an explicit operator instruction.
---

# Handoff

Invoke this skill when the operator tells you to pass work to fresh workers. The skill spawns one or more new workers and seeds each one's first turn with a briefing you write. After all handoffs succeed you write the \`.garden-done\` sentinel and end your turn.

This covers two shapes:

- **Pass-the-baton (1:1):** the operator wants the current task continued in a fresh worker (different project for cross-repo work, or same project to reset accumulated context).
- **Fan-out (1:N):** at the close of a phased plan you have several independent deferred items the operator wants delegated. You call \`garden handoff\` once per item, then mark yourself done. Each new worker reviews and merges independently in parallel.

## What it does

Runs \`garden handoff <target-project>\` from your worktree CWD, reading a multi-line briefing from stdin via heredoc. Garden:

1. Creates a new worker on \`<target-project>\` — a normal named worker with its own git worktree, fresh Claude session, and own poller. It participates in the standard review/merge flow.
2. Leaves the operator's view alone. The new worker is created in a hidden window — your pane is *not* parked, the dashboard's active project/plot is *not* switched, and whatever pane the operator is focused on stays put. This applies to single handoffs and fan-outs alike. The operator reaches the new worker(s) via ⌥<n> on the target project + ⌥w to cycle to them.
3. Seeds the new worker's first prompt with your briefing, prefixed \`[handoff from <your-project>/<your-name>]\` so the new worker knows it received a handoff (not a normal user prompt).
4. Prints the new worker's name to stdout — report it (or the full list, on fan-out) to the operator before you end your turn.

## When to use

- The operator told you to hand off (e.g., "hand this to a fresh worker on garden-app", "spin up a new worker to take over", "delegate the deferred items"). The instruction is explicit.
- **Pass-the-baton:** the new worker genuinely benefits from a fresh start — cross-project work you can't do in your current worktree, or context-reset on the same project after a long session.
- **Fan-out:** the deferred items are *independent* (no ordering dependency between them) and each is *substantial enough* that briefing-cost is small relative to task size. A 10-line follow-up where your in-flight context is the actual value should be a final commit, not a handoff.

## When NOT to use

- The operator did not ask. Self-handing-off is not the intended pattern. If you think a fresh worker would help, **ask the operator** — do not invoke unilaterally.
- The work is already finished and there is nothing to delegate. Use the \`done\` skill instead.
- You are mid-phase in your own task. Finish what you're doing (or commit a clean stopping point) first.
- The deferred items have ordering dependencies on each other (do them yourself in sequence, or hand off only the first and let it fan out further if needed).
- An item is small enough that the briefing would be longer than the work. Just do it before marking done.
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

### Callback mode (\`--expect-callback\`)

Pass \`--expect-callback\` when you want to know how the handoff turned out — typically a pass-the-baton handoff where the operator asked you to wait for the result before proceeding, or a debugging request where the child's findings unblock your own next step.

\`\`\`bash
garden handoff <target-project> --expect-callback <<'EOF'
<briefing>
EOF
\`\`\`

What this does:

- Records a parent → child link on the new worker's registry entry.
- When the child reaches its first terminal \`prState\` (\`merged\`, \`done\`, or \`failing\`), garden fires a one-shot \`[garden] Handoff callback: …\` prompt at *your* pane summarizing the outcome. You can then take the next step (or call \`done\` yourself).
- The child can optionally stage a freeform note for you via \`garden reply -m "<text>"\` (or \`--replace\` to overwrite an earlier draft, or stdin for multi-line). Whatever's staged at terminal time gets folded into the callback prompt.

When NOT to use callback mode:

- Fan-out (1:N) where you have no further work pending the results — just hand off and \`done\`. The operator gets the merge notifications via the dashboard; you don't need to relay them.
- You intend to invoke \`done\` immediately. The callback can't reach a pane whose worker already declared done. (The dispatch is still safe — it'll just silently no-op — but you've lost the signal.)
- The child task is long-running and you have nothing to do in the meantime. Marking yourself \`done\` and letting the operator follow the child directly is simpler than parking a live pane for hours.

### Replying from the child side

If you *are* the child worker (your seed message says \`[handoff from <project>/<name> — callback requested]\`), you can drop a note for the parent at any point before your terminal state. The parent sees it folded into the callback prompt — useful for surfacing findings, blockers, or "look at commit XYZ".

\`\`\`bash
garden reply -m "Root cause is in src/foo.ts:42 — the retry loop is unbounded."
\`\`\`

Multiple \`garden reply\` calls accumulate (joined by blank lines). Use \`--replace\` to clobber an earlier draft. The note is cleared after the callback fires.

For fan-out, run the command once per item, each with its own briefing scoped to that item alone:

\`\`\`bash
garden handoff myproject <<'EOF'
[item 1 briefing — self-contained, no references to other handoffs]
EOF

garden handoff myproject <<'EOF'
[item 2 briefing — self-contained]
EOF
\`\`\`

The briefing is the new worker's only initial signal — invest in it. Include file paths, commit hashes, decisions made, and what specifically remains. The new worker has no memory of your conversation. Each fan-out briefing must stand alone — a sibling worker won't be visible to the others.

## After handoff

1. Confirm every \`garden handoff\` invocation succeeded (each prints the new worker's name).
2. Tell the operator which worker(s) you handed off to.
3. Run \`touch .garden-done\` to mark yourself done — handoff is your terminal action, even after a fan-out. \`done\` here means *this worker has nothing more to do*, not that the project is done; the spawned workers continue independently.
4. End your turn.

If any \`garden handoff\` fails (unknown project, etc.), report the error to the operator and do not write \`.garden-done\` — the operator will decide whether to retry, drop that item, or take a different route.
`;

export const GROW_SKILL_DIRNAME = "grow";
export const GROW_SKILL_FILENAME = "SKILL.md";

// Bundled with every worker — the brainstorm-then-grow flow's primary DX.
// The operator types `/grow [N]` (or asks the worker to "harden this for N
// passes") in the worker pane; this skill instructs the worker to summarize
// the conversation into a goal file and run `garden workers grow` to flip
// the workflow from default to grow.
export const GROW_SKILL_CONTENT = `---
name: grow
description: Use when the operator wants to convert this active worker into a grow loop after they've finished (or are mid-way through) a real piece of work — N additional polish/hardening passes after the current work merges. Triggers on phrases like "/grow N", "harden this for N passes", "do an improvement pass on what we just did", or "convert this to a grow worker". Do NOT invoke unprompted.
---

# Convert this worker into a grow loop

The operator wants this worker to keep iterating on the work we've done in this session — N additional polish/hardening passes after the current work merges. Each pass cold-respawns with fresh Claude context; the seed (a distilled goal) is what carries forward.

Convert is irreversible from this skill: you can amend the goal mid-loop by editing \`.garden/grow-goal.md\`, but you cannot un-convert. Confirm intent before running the CLI.

## What it does

Walks you through:

1. Pick the iteration budget N (default 5).
2. Summarize what we've decided in this session into a 1-3 paragraph goal that anchors every future iteration.
3. Write the goal to \`.garden/grow-goal.md\` at your worktree root.
4. Run \`garden workers grow $GARDEN_WORKER --goal-file .garden/grow-goal.md --max-iterations <N>\` to flip the workflow.
5. Continue — finish your in-flight work (or end your turn if you're already done) and the next push triggers iter 1 of the grow loop.

## When to use

- The operator typed \`/grow [N]\` or asked you to harden / polish / do additional passes on what we just did.
- The work is real: a planned feature, a bug fix with surrounding tests, a refactor with documentation. Hardening trivial work is wasteful — if the operator just asked for a typo fix, gently push back.
- The conversation contains a coherent goal you can summarize without ambiguity.

## When NOT to use

- The operator did not ask. Self-conversion is not the intended pattern.
- This worker is already on a non-default workflow (\`garden whoami\` shows \`workflow: grow\` or \`trellis\`). The CLI rejects re-conversion. Tell the operator to either edit \`.garden/grow-goal.md\` directly (for grow) or amend the trellis (for trellis).
- The current work is not yet committed and you are mid-debug. Convert *after* you have a clean stopping point — iter 1's review picks up whatever you push, so don't push half-broken state.

## How to invoke

### 1. Decide N

The operator's instruction names it. \`/grow 3\` → use 3. \`/grow\` with no number, or "harden this" without a number → use 5 (the default).

### 2. Summarize the goal

Write a 1-3 paragraph goal capturing what we've decided in this session:

- **What is the work?** A sentence summarizing the feature/fix/refactor.
- **What is in scope?** Bullet list of the concrete changes we agreed on (files, functions, behaviors).
- **What is out of scope?** Bullet list of adjacent improvements the loop should NOT chase. This is the equivalent of trellis's "Out of scope" section — without it, future iterations drift toward "while I'm here" cleanups.
- **What does done look like?** A sentence on the convergence criterion. "All checks pass and the API matches the spec above" is fine; "the auth feels good" is not.

Write as if future-you (with no conversation history, in iter 2's fresh context) needs to understand the goal from this paragraph alone. Names of files, function signatures, command flags, test names — concrete enough that the next iteration can verify against the diff.

### 3. Write to .garden/grow-goal.md

\`\`\`bash
mkdir -p .garden
cat > .garden/grow-goal.md <<'EOF'
<your summary here>
EOF
\`\`\`

The directory may not exist — \`mkdir -p\` first. Do NOT \`git add\` this file; it is gitignored via the worktree's \`.git/info/exclude\` and lives outside version control by design.

### 4. Run the convert CLI

\`\`\`bash
garden workers grow $GARDEN_WORKER --goal-file .garden/grow-goal.md --max-iterations <N>
\`\`\`

Use the Bash tool. The CLI prints \`Converted worker <project>/<name> to grow (up to <N> iterations).\` Relay it to the operator so they know the flip succeeded.

If the CLI errors with "already on the 'grow' workflow", the worker was already converted — point the operator at \`.garden/grow-goal.md\` for amends and stop.

If the CLI errors with "already on the 'trellis' workflow", the worker is a trellis vine — re-conversion isn't supported. Tell the operator and stop.

### 5. Continue your work

- **If you were mid-implementation:** resume from where you paused. Finish your current work, commit, push. The push triggers iter 1 of the now-grow loop on its next merge.
- **If your initial work was already done (and merged) before the operator typed \`/grow\`:** end your turn. The convert command detects the fully-merged branch and dispatches iter 1 directly — the worker pane will receive the iter-1 prompt within a few seconds.

After this skill returns, the worker is on the grow workflow and behaves like any other grow worker for all subsequent iterations.

## Mid-loop amend

If the operator wants to refine the goal between iterations, they edit \`.garden/grow-goal.md\` directly. The next iteration's continue prompt re-reads the file at dispatch time, so the amendment takes effect on iter K+1 without any garden command. Convert is one-shot; amend is unbounded.
`;

export function installClaudeSkills(targetDir: string): void {
  const skillsRoot = path.join(targetDir, ".claude", "skills");
  // Heal the legacy flat-file layout so refreshes/bounces of pre-fix workers stop shadowing the new directory layout.
  fs.rmSync(path.join(skillsRoot, "done.md"), { force: true });
  writeSkill(skillsRoot, DONE_SKILL_DIRNAME, DONE_SKILL_FILENAME, DONE_SKILL_CONTENT);
  writeSkill(skillsRoot, HANDOFF_SKILL_DIRNAME, HANDOFF_SKILL_FILENAME, HANDOFF_SKILL_CONTENT);
  writeSkill(skillsRoot, TRELLIS_AUTHOR_SKILL_DIRNAME, TRELLIS_AUTHOR_SKILL_FILENAME, TRELLIS_AUTHOR_SKILL_CONTENT);
  writeSkill(skillsRoot, GROW_SKILL_DIRNAME, GROW_SKILL_FILENAME, GROW_SKILL_CONTENT);
}

function writeSkill(skillsRoot: string, dirname: string, filename: string, content: string): void {
  atomicWriteFile(path.join(skillsRoot, dirname, filename), content);
}

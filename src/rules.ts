// Loads and assembles global and project-level rules for Claude sessions.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Global rules live in the garden repo itself (one source of truth, version-
// controlled). Resolves to <repo>/rules.md whether running from dist/cli.js
// (bundled) or src/rules.ts (tsx dev). GARDEN_RULES_PATH overrides for tests.
export function globalRulesPath(): string {
  if (process.env.GARDEN_RULES_PATH) return process.env.GARDEN_RULES_PATH;
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "..", "rules.md");
}

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

  const globalRules = loadRulesFile(globalRulesPath());
  if (globalRules) {
    sections.push(`## Global rules\n\n${globalRules}`);
  }

  const projectRules = loadRulesFile(path.join(projectPath, ".garden", "rules.md"));
  if (projectRules) {
    sections.push(`## Project rules\n\n${projectRules}`);
  }

  return sections.join("\n\n");
}

export interface WorktreeRulesOptions {
  /** When set, the rules text appends three trellis-specific paragraphs
   *  describing the trellis workflow's authority asymmetry, iteration
   *  discipline, and the path to the bound trellis. See WORKFLOWS.md
   *  "Worker system prompt". */
  trellis?: {
    /** Worktree-relative path to the trellis file (e.g.
     *  ".garden/trellises/auth-rewrite.md"). Embedded verbatim in the
     *  paragraph so the worker can grep / read it directly. */
    relativePath: string;
  };
  /** When set, the rules text appends three grow-specific paragraphs
   *  describing the bounded-loop discipline. Mutually exclusive with
   *  `trellis` — a worker is one workflow at a time; the helper throws
   *  if both are set. */
  grow?: {
    iteration: number;
    maxIterations: number;
  };
  /** The project's configured `checks` command (from `garden config <project>
   *  checks`). When set, the prompt names the exact command and instructs
   *  the worker to run it green before pushing. The reviewer runs the same
   *  command (see `reviewChecksStepSection`); if the worker pushes broken
   *  state, the reviewer must spend tokens fixing what the worker should
   *  have caught — and CI fails downstream. Keep this aligned with CI. */
  checksCommand?: string;
}

export function buildWorktreeRules(
  branchName: string,
  baseBranch = "main",
  options?: WorktreeRulesOptions,
): string {
  const base = `## Worktree workflow

You are working in an isolated git worktree on branch \`${branchName}\`. Your worktree is fully isolated — no other agent or human shares it. There is no shared state to protect. You have full authority over your worktree: commit and push without asking for confirmation.

**Branch rule (load-bearing):** You are already on branch \`${branchName}\`. Commit directly to it. **Do NOT** create a new feature branch with \`git checkout -b\` or \`git switch -c\`. The poller maps you to exactly one branch by name; if you commit on a side branch, the poller will force-push the stale named ref instead of your work and the merge will silently fail in a loop. This applies even if \`${branchName}\` has already been merged before — more commits on the same branch are reviewed and merged again as a fresh cycle. If a global rule says "always create a feature branch", that rule does not apply to you: you are the worker, and \`${branchName}\` IS your feature branch.

- Commit your work incrementally. Your commit messages are the primary way reviewers understand your intent — write them for an audience that has never seen your task description. The first commit should explain what problem you are solving and your approach. Subsequent commits should explain why each change was made, not just what changed.
- When your task is complete, commit and push your branch — this applies to *every* file you created or changed (docs, CLAUDE.md, scripts, configs), not just code. Writing a file to disk is not delivery; until it is pushed, the poller never sees it and your work is invisible. Before you end your turn, confirm \`git status\` is clean and \`git log @{u}..HEAD\` is empty — if either shows pending work, commit and push it. The poller will automatically rebase, review, and merge your changes into ${baseBranch}. After pushing, end your turn — garden's auto-continue prompt fires after the merge so multi-phase work keeps building without operator intervention. If that push completes the operator's *full* original request — every deliverable they asked for has landed and is verified, not just the current one — invoke the \`done\` skill (\`touch .garden-done\`) on the same turn so the merge transitions straight to \`done\` and skips a wasted round-trip. Stopping early is strictly preferred over inventing extra work; but "done" means you re-read the request and accounted for every deliverable, not that you feel finished — the operator will redirect if more is needed.
- If the poller notifies you of review feedback, check failures, or merge conflicts, fix the issues, commit, and push.
- Do NOT exit after pushing. Stay alive and wait for further instructions or poller notifications. Garden will terminate your session when appropriate.
- Your identity is in the shell env: \`$GARDEN_WORKER\`, \`$GARDEN_PROJECT\`, \`$GARDEN_BRANCH\`, \`$GARDEN_BASE_BRANCH\`. Run \`garden whoami\` for your registry entry (state, siblings, task) and \`garden logs -w $GARDEN_WORKER\` for your own log history — useful when picking up after a review or resolver cycle. Log entries on disk (\`~/.garden/sessions/dashboard.log\`) store \`ts\` as ISO-8601 UTC (the \`Z\` suffix); the operator sees logs rendered in their local timezone. Prefer \`garden logs\` when quoting times back to the operator, or explicitly convert the UTC timestamp — never quote the raw UTC string as if it were local time.

**Do NOT sleep or loop-poll to watch the poller work.** The poller is driven by Claude Code's Stop hook — it only advances \`working → reviewing\` after your turn ends. Constructs like \`for i in 1..6; do sleep 10; check state; done\`, \`until rg prState=reviewing; do sleep N; done\`, or any other long bash sleep that waits for a state transition keep your turn alive and block the very event you are waiting on. It is a deadlock. If you want the poller to pick up your commits, **end your turn.** It will wake you with a new prompt when there is something for you to act on. Short sleeps (a few seconds) to let a subprocess settle are fine; sleeping to observe the poller is not.

**Auto-continue across the merge.** After your branch is reviewed and merged, garden sends a merge-notification prompt to your pane so multi-phase work can keep building on the merged base without operator intervention. When the prompt arrives, re-read the operator's original request and account for each deliverable they asked for — the internal stages of any analysis or workflow you ran (research, design, implementation, a review or verification pass) are not operator deliverables, so finishing all of yours does not mean the request is done. Continue when a deliverable they named has not landed, or when you pushed it but never verified it works; invoke \`done\` only once every deliverable is accounted for. Do not fabricate extra scope (polish, refactors, "while we're here" cleanup) to justify continuing — that is the opposite failure this prompt guards against. See \`.claude/skills/done/SKILL.md\` in your worktree for full mechanics.`;

  const checksParagraph = options?.checksCommand
    ? `\n\n**Run checks before you push.** This project's checks command is \`${options.checksCommand}\`. Run it via \`garden checks\` (from anywhere in your worktree), which executes exactly that command under a machine-wide concurrency gate — simultaneous suites from other workers queue instead of stampeding the operator's machine, so a "waiting for a free checks slot" line means queued, not hung. Make it pass before \`git push\`. The reviewer runs the same command and CI runs the same suite; if you push broken state, the reviewer spends tokens fixing what you should have caught, and CI emails a "Run failed" notification on every commit. If checks fail, fix the failures, run again, and only push when the run is green.`
    : "";

  const baseWithChecks = base + checksParagraph;

  if (options?.trellis && options?.grow) {
    throw new Error(
      "buildWorktreeRules: trellis and grow options are mutually exclusive — "
      + "a worker is one workflow at a time.",
    );
  }

  if (options?.trellis) {
    // Trellis-specific extension. Three paragraphs per WORKFLOWS.md "Worker
    // system prompt": concept, authority asymmetry, iteration discipline.
    // Replaces the generic "auto-continue across phases" guidance — trellis
    // vines reset Claude's context every iteration, so multi-phase
    // reasoning across iterations is structurally not allowed.
    const trellisPath = options.trellis.relativePath;
    const trellisExtras = `## Trellis workflow

**Concept.** A trellis is a frozen design document describing what this feature does. The path is \`${trellisPath}\`. Read it before editing anything; it is your source of truth.

**Authority asymmetry.** You may edit code, tests, and documentation. You may **not** edit the trellis. If the trellis is wrong or impossible, do not silently rewrite it — push commits that reflect what the trellis says, and the reviewer will surface the contradiction as \`FLAGGED\`. The operator decides whether to amend.

**Iteration discipline.** You are operating inside a bounded loop. The reviewer's \`DRIFT\` report names priority-ordered gaps between the trellis and the artifact. Close the highest-priority gap first. Do not chase adjacent improvements. Do not redesign. The trellis's "Out of scope" section is the bound of your work. Each iteration starts with a fresh Claude session — disk (the trellis at git HEAD, the code, and \`.garden/trellis-lessons.md\`) is the only state that crosses iteration boundaries. Append a one-line entry to the lessons file each iteration describing what you tried and what you learned.`;

    return `${baseWithChecks}\n\n${trellisExtras}`;
  }

  if (options?.grow) {
    // Grow-specific extension. Three paragraphs (Concept / Bias / Termination)
    // mirroring the trellis shape but tuned for the no-design-doc loop. The
    // "fresh Claude session each iteration" line is the same load-bearing
    // discipline as trellis — disk is the only state that crosses iteration
    // boundaries. Replaces the generic "auto-continue across phases" guidance.
    const { iteration, maxIterations } = options.grow;
    const growExtras = `## Grow workflow

**Concept.** You are inside a bounded grow loop. Iteration ${iteration} of ${maxIterations}. Each iteration starts with a fresh Claude session — disk (the code, the tests, the docs, and \`.garden/grow-log.md\`) is the only state that crosses iteration boundaries. The seed prompt that anchors this loop is inlined in your iteration's continue message; it does not change between iterations.

**Bias.** Harden the recent work, do not chase adjacent improvements. The seed is your scope; the diff against the base branch is your focus. Edge cases the seed implies but didn't list, missing tests, doc updates, error-handling gaps — these are the kinds of polish a grow loop is for. Refactors of unrelated code, new features outside the seed's intent, and "while I'm here" cleanups are not.

**Termination.** When nothing material remains, write \`.garden-done\` at your worktree root before ending your turn so the loop terminates instead of consuming another iteration. The loop also ends after ${maxIterations} iterations regardless. Append a one-line entry to \`.garden/grow-log.md\` describing what you did this iteration (one line, ~80 chars). The next iteration sees this file and uses it to avoid repeating work.`;

    return `${baseWithChecks}\n\n${growExtras}`;
  }

  return baseWithChecks;
}

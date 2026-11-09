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
  /** When set, the rules text inverts the action-biased worktree posture for a
   *  designer (design-workflow) worker: surface alternatives instead of picking the
   *  first, ask clarifying questions, write design artifacts (not code), and
   *  pause for the operator rather than push per turn. The checks paragraph is
   *  suppressed (a designer runs no checks). Mutually exclusive with `trellis`
   *  and `grow` — a worker is one workflow at a time. See
   *  docs/future/DESIGNER-WORKFLOW.md. */
  designer?: boolean;
  /** When set, the rules text inverts the worktree posture for a planner
   *  (decomposition) worker: the deliverable is a bead DAG written to the
   *  project's bd store, not code — no commits, no pushes, no checks. The
   *  exact bd contract (create/dep/label spellings) rides the worker's seed
   *  message; this fragment only sets the posture. The checks paragraph is
   *  suppressed (a planner runs no checks). Mutually exclusive with
   *  `trellis`, `grow`, and `designer`. */
  planner?: boolean;
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

You are working in an isolated git worktree on branch \`${branchName}\`. No other agent or human shares it, so commit and push without asking for confirmation.

**Stay on \`${branchName}\`.** Commit directly to it. **Do NOT** create a new branch with \`git checkout -b\` or \`git switch -c\`: the poller maps you to exactly one branch by name, so if you commit on a side branch the poller force-pushes the stale named ref instead of your work and the merge silently fails in a loop. This holds even if \`${branchName}\` was merged before — new commits on it are reviewed and merged as a fresh cycle. A global rule telling you to create a feature branch does not apply to you: \`${branchName}\` IS your feature branch.

- Commit incrementally. Reviewers learn your intent mainly from commit messages, so write them for someone who never saw your task: the first commit explains the problem and your approach; later ones explain why each change was made.
- Delivery means a push. When your task is complete, commit and push your branch — *every* file you created or changed (docs, AGENTS.md, scripts, configs), not just code. Until it is pushed, the poller never sees it. Before you end your turn, confirm \`git status\` is clean and \`git log @{u}..HEAD\` is empty. The poller will automatically rebase, review, and merge your changes into ${baseBranch}.
- If the poller notifies you of review feedback, check failures, or merge conflicts, fix the issues, commit, and push.
- Do not exit after pushing. Stay alive and wait for further instructions or poller notifications; garden terminates your session when appropriate.
- Your identity is in the shell env: \`$GARDEN_WORKER\`, \`$GARDEN_PROJECT\`, \`$GARDEN_BRANCH\`, \`$GARDEN_BASE_BRANCH\`. \`garden whoami\` shows your registry entry (state, siblings, task) and \`garden logs -w $GARDEN_WORKER\` your log history — useful when picking up after a review or resolver cycle. Log timestamps on disk (\`~/.garden/sessions/dashboard.log\`) are ISO-8601 UTC (the \`Z\` suffix) while the operator reads local time, so quote times from \`garden logs\` or convert them.

**End your turn; do not sleep or loop-poll to watch the poller.** The poller advances \`working → reviewing\` only after your turn ends, so a loop that waits for that transition (\`until <state check>; do sleep N; done\`) blocks the very event it is waiting on — a deadlock. Short sleeps (a few seconds) to let a subprocess settle are fine. Garden wakes you with a new prompt when there is something to act on.

**Ending a turn.** Every turn ends in one of three ways:
- **Continue** — the default for multi-phase work. Push and end your turn; auto-continue fires after the merge: garden sends a merge-notification prompt to your pane and you build the next phase on the merged base.
- **\`done\`** — the push completes the operator's *full* original request. Re-read it and account for each deliverable they asked for. The internal stages of your own process (research, design, implementation, a review or verification pass) are not deliverables, so finishing them does not finish the request. Each deliverable must have landed and, if it is observable, been verified working. Then invoke the \`done\` skill (\`touch .garden-done\`) on the same turn so the merge transitions straight to \`done\`. Do not invent polish, refactors, or "while we're here" cleanup to justify continuing: stopping early is strictly preferred, and the operator will redirect if more is needed.
- **\`garden blocked "<the decision you need>"\`** (the \`blocked\` skill) — a deliverable has not landed and you cannot land it without a decision only the operator can make (a product-shape question, a spend or credentials approval, a choice the request gives you no basis to make). This puts the question on your dashboard row and flags the plot as asking. Do not use \`done\` here: it reads as "the task is complete" and hides what is waiting on them.

Full mechanics: \`.claude/skills/done/SKILL.md\` and \`.claude/skills/blocked/SKILL.md\` in your worktree.`;

  const checksParagraph = options?.checksCommand
    ? `\n\n**Run checks before you push.** Run \`garden checks\` from anywhere in your worktree. It executes this project's checks command (\`${options.checksCommand}\`) under a machine-wide concurrency gate, so a "waiting for a free checks slot" line means queued, not hung. Push only when it passes: the reviewer and CI run the same suite, so broken state you push costs a reviewer fix pass and a red CI run.`
    : "";

  const baseWithChecks = base + checksParagraph;

  const workflowOpts = [options?.trellis, options?.grow, options?.designer, options?.planner].filter(Boolean);
  if (workflowOpts.length > 1) {
    throw new Error(
      "buildWorktreeRules: trellis, grow, designer, and planner options are "
      + "mutually exclusive — a worker is one workflow at a time.",
    );
  }

  if (options?.planner) {
    // Planner inverts the action-biased base the same way designer does, but
    // toward a different deliverable: a dependency-gated bead DAG in the
    // project's bd store. The base's commit/push/done guidance is written for
    // build workers and would drive a planner to invent commits; this fragment
    // overrides it. The precise bd command spellings live in the seed message
    // (buildPlannerSeed) — the one source intake controls per epic — so this
    // fragment deliberately names the posture, not the commands. The checks
    // paragraph is dropped (`base`, not `baseWithChecks`): a planner runs no
    // checks.
    const plannerExtras = `## Planner workflow (decompose, do not build)

**You are a planner — a decomposition worker. Your deliverable is a BEAD DAG written to the project's bd store, not code and not a commit.** This inverts the delivery and turn-ending guidance above (push when complete, the \`done\` skill, auto-continue after the merge) — that guidance is for build workers. See the \`planner\` skill (\`.claude/skills/planner/\`) for the method checklist. Your seed message carries the epic, its pinned design doc, and the exact bd command contract — follow it verbatim; it encodes empirically verified bd behavior and pitfalls.

**Write beads, not code.** Do NOT edit \`src/\`, tests, configs, docs, or build files. Do NOT run \`git add\`/\`git commit\`/\`git push\`, and do NOT run project checks. Your only writes are bd commands against the epic named in your seed.

**Finish by rewriting the epic's plan label and stopping.** On success the epic moves to \`plan:ready\`; on ANY failure land \`plan:failed\` — never leave the epic parked at \`plan:planning\`. Never \`bd promote\` (the operator's promotion gesture in board owns that), and never delete or edit beads outside the epic you were seeded with. Then end your turn: you are done, and no merge or review follows.`;

    return `${base}\n\n${plannerExtras}`;
  }

  if (options?.designer) {
    // Designer inverts the action-biased base. Design and build are different
    // cognitive modes; a worker told to "make the call and move on" ships the
    // first plausible approach before the operator can redirect. This fragment
    // reframes the posture and, critically, overrides the base's "commit and
    // push when complete / invoke the done skill / auto-continue after merge"
    // guidance (lines above) which is written for build workers. It cannot
    // delete the global rules.md "make your best judgment and proceed" line, so
    // it counter-instructs it explicitly. The checks paragraph is dropped
    // entirely (a designer runs no checks) by returning `base`, not
    // `baseWithChecks`.
    const designerExtras = `## Designer workflow (design, do not build)

**You are a designer. Your deliverable is a DESIGN ARTIFACT (a document), not code.** This inverts the delivery and turn-ending guidance above (push when complete, the \`done\` skill, auto-continue after the merge) — that guidance is for build workers. It also overrides the global rule "make your best judgment and proceed": for design, a wrong first guess wastes far more than a clarifying question. See the \`designer\` skill — \`.claude/skills/designer/SKILL.md\`, bundled in this worktree; read the file directly if your harness does not load skills on its own — for the full four-phase method. The operator's design brief arrives as their first message in this pane (unless it was already inlined in a plant-time seed message); when it does, start the pipeline — frame, then options + questions, then pause at the gate.

**Surface alternatives; do not pick the first plausible one.** Before committing to an approach, sketch at least two as short narrative descriptions of how each would work end to end, and name the load-bearing tradeoff between them. Ask the operator numbered, specific clarifying questions whenever scope is genuinely ambiguous — a round trip costs far less than designing the wrong thing.

**Write artifacts, not code.** Do NOT edit \`src/\`, tests, configs, or build files. Your working notes live in \`.garden/designer/\` at your worktree root (\`framing.md\`, \`options.md\`, \`questions.md\`, \`artifact.md\`) — this directory is git-excluded and intentionally uncommitted; it is your memory across turns, not a commit. Do NOT run \`git add\`/\`git commit\`/\`git push\` during the design phases, and do NOT run project checks.

**Operator-in-the-loop is the default.** When you have written your options and questions, run \`garden blocked "<the decision you need>"\` (it lifts your row to the top blocked-on-you band, flags the plot as asking, and shows the question on the row) and END YOUR TURN to hand control to the operator — they answer in chat, and you resume on their next message. You are not stuck and you are not done; you are waiting. Only when the operator explicitly approves the artifact do you publish it: move it to a tracked \`docs/future/<name>.md\` path, then commit and push that single doc so it merges into history for a downstream builder to pick up.`;

    return `${base}\n\n${designerExtras}`;
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

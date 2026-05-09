// `garden workers <subcommand>` — worker lifecycle CLI.
import fs from "node:fs";
import path from "node:path";
import { tryGetProject, SESSIONS_DIR } from "../config.js";
import { newWorker } from "../dashboard/workers.js";
import { buildGrowIteration1Seed, GROW_GOAL_FILE_REL } from "../dashboard/grow-continue.js";
import {
  readRegistry, findWorkerByName, updateWorkerFields,
  type WorkerEntry,
} from "../dashboard/registry.js";
import { validateTrellisPlant } from "../dashboard/trellis-tag.js";

export async function workers(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === "new") {
    await newCommand(args.slice(1));
    return;
  }
  if (sub === "grow") {
    await growCommand(args.slice(1));
    return;
  }
  throw new Error(
    `Usage:\n`
    + `  garden workers new <project> [--workflow trellis|grow] [--trellis <name>] `
    + `[--seed <text> | --seed-file <path>] [--model opus|sonnet] [--max-iterations N]\n`
    + `  garden workers grow [<worker>] [--seed <text> | --seed-file <path> | --goal-file <path>] `
    + `[--max-iterations N]`,
  );
}

async function newCommand(args: string[]): Promise<void> {
  // Positional: <project>. Flags: --workflow, --trellis, --max-iterations.
  // Workflow defaults to "default"; trellis is required only when workflow is "trellis".
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = args[i + 1];
      if (val === undefined || val.startsWith("--")) {
        throw new Error(`--${key} requires a value`);
      }
      flags.set(key, val);
      i++;
    } else {
      positional.push(a);
    }
  }

  const projectName = positional[0];
  if (!projectName) {
    throw new Error(
      "Usage: garden workers new <project> [--workflow trellis --trellis <name>] [--max-iterations N]",
    );
  }
  const project = tryGetProject(projectName);
  if (!project) {
    throw new Error(`Unknown project '${projectName}'. Run 'garden list' to see registered projects.`);
  }

  const workflow = flags.get("workflow") ?? "default";
  if (workflow !== "default" && workflow !== "trellis" && workflow !== "grow") {
    throw new Error(`--workflow must be 'default', 'trellis', or 'grow', got '${workflow}'`);
  }

  if (workflow === "default") {
    if (flags.has("trellis")) {
      throw new Error("--trellis can only be used with --workflow trellis");
    }
    if (flags.has("seed") || flags.has("seed-file")) {
      throw new Error("--seed and --seed-file can only be used with --workflow grow");
    }
    if (flags.has("max-iterations")) {
      throw new Error("--max-iterations can only be used with --workflow trellis or grow");
    }
    if (flags.has("model")) {
      throw new Error(
        "--model is currently only supported with --workflow trellis. " +
        "Default workflow workers run on the account default model.",
      );
    }
    const newName = newWorker({ projectName, workflow });
    if (!newName) {
      throw new Error(
        `Failed to spawn worker on '${projectName}'. Is the dashboard running? Check 'garden health'.`,
      );
    }
    console.log(`Created worker ${projectName}/${newName}.`);
    return;
  }

  if (workflow === "grow") {
    if (flags.has("trellis")) {
      throw new Error("--trellis can only be used with --workflow trellis");
    }
    if (flags.has("model")) {
      throw new Error(
        "--model is not supported with --workflow grow. "
        + "Grow loops run on the account default model.",
      );
    }
    if (flags.has("seed") && flags.has("seed-file")) {
      throw new Error("--seed and --seed-file are mutually exclusive; pass exactly one.");
    }
    let seed: string | undefined;
    if (flags.has("seed")) {
      seed = flags.get("seed")!;
    } else if (flags.has("seed-file")) {
      const seedFilePath = flags.get("seed-file")!;
      try {
        seed = fs.readFileSync(seedFilePath, "utf-8");
      } catch (err) {
        throw new Error(`--seed-file '${seedFilePath}' could not be read: ${String(err)}`);
      }
    } else {
      throw new Error(
        "--workflow grow requires a seed: pass --seed <text> or --seed-file <path>.",
      );
    }
    seed = seed.trim();
    if (!seed) {
      throw new Error("--workflow grow requires a non-empty seed prompt.");
    }

    let maxIter = 5;
    if (project.maxGrowIterations !== undefined) maxIter = project.maxGrowIterations;
    if (flags.has("max-iterations")) {
      const raw = flags.get("max-iterations")!;
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n) || n < 1) {
        throw new Error(`--max-iterations must be a positive integer, got '${raw}'`);
      }
      maxIter = n;
    }

    // Build the iter-1 seed prompt — sent at plant time via seedMessageFile
    // (not via auto-continue, which fires post-merge for iter ≥ 2). The
    // operator's seed text becomes the durable goal stored on
    // entry.grow.seed; iter ≥ 2 prompts inline that text verbatim. The
    // plant-time prompt wraps it with grow framing so the worker paces
    // itself across the bounded loop.
    const seedFile = path.join(
      SESSIONS_DIR, "seeds",
      `grow-seed-${projectName}-${Date.now()}.txt`,
    );
    fs.mkdirSync(path.dirname(seedFile), { recursive: true });
    fs.writeFileSync(seedFile, buildGrowIteration1Seed(seed, maxIter));

    const newName = newWorker({
      projectName,
      workflow: "grow",
      grow: { seed, maxIterations: maxIter },
      seedMessageFile: seedFile,
    });
    if (!newName) {
      try { fs.unlinkSync(seedFile); } catch { /* ignore */ }
      throw new Error(
        `Failed to spawn grow worker on '${projectName}'. `
        + `Is the dashboard running? Check 'garden health'.`,
      );
    }
    console.log(
      `Started grow loop ${projectName}/${newName} (up to ${maxIter} iterations).`,
    );
    return;
  }

  // workflow === "trellis"
  const trellisName = flags.get("trellis");
  if (!trellisName) {
    throw new Error("--workflow trellis requires --trellis <name>");
  }

  let workerModel: "opus" | "sonnet" | undefined;
  if (flags.has("model")) {
    const raw = flags.get("model")!;
    if (raw !== "opus" && raw !== "sonnet") {
      throw new Error(`--model must be 'opus' or 'sonnet', got '${raw}'`);
    }
    workerModel = raw;
  }

  // Pre-flight: validates the trellis exists, isn't retired, has the
  // sentinel (warn), and the project has `checks` configured (warn).
  const result = validateTrellisPlant(projectName, trellisName);
  if (!result.ok) {
    throw new Error(result.error);
  }
  for (const w of result.warnings) {
    console.error(`warning: ${w}`);
  }

  // Resolve max iterations: --max-iterations > project.maxTrellisIterations > 30
  let maxIter = 30;
  if (project.maxTrellisIterations !== undefined) maxIter = project.maxTrellisIterations;
  if (flags.has("max-iterations")) {
    const raw = flags.get("max-iterations")!;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 1) {
      throw new Error(`--max-iterations must be a positive integer, got '${raw}'`);
    }
    maxIter = n;
  }

  // Build the iteration-1 seed prompt. The worker's first prompt is
  // sent at plant time via the bootstrap (not via auto-continue). It's
  // shorter than the continue prompt because there's no prior drift list
  // and no lessons file yet — the worker creates the lessons file as it
  // works. Phrasing intentionally minimal; iterate during real-vine usage.
  const trellisRelative = path.relative(project.path, result.info.path);
  const seed = buildIteration1Seed(trellisName, trellisRelative, maxIter);
  const seedFile = path.join(
    SESSIONS_DIR, "seeds",
    `trellis-seed-${projectName}-${trellisName}-${Date.now()}.txt`,
  );
  fs.mkdirSync(path.dirname(seedFile), { recursive: true });
  fs.writeFileSync(seedFile, seed);

  const newName = newWorker({
    projectName,
    workflow: "trellis",
    trellis: {
      name: trellisName,
      path: result.info.path,
      maxIterations: maxIter,
      workerModel,
    },
    seedMessageFile: seedFile,
  });
  if (!newName) {
    try { fs.unlinkSync(seedFile); } catch { /* ignore */ }
    throw new Error(
      `Failed to spawn vine on '${projectName}'. Is the dashboard running? Check 'garden health'.`,
    );
  }
  const modelTag = workerModel ? ` model=${workerModel}` : "";
  console.log(
    `Planted vine ${projectName}/${newName} on trellis '${trellisName}' (${maxIter} iterations max${modelTag}).`,
  );
}

function buildIteration1Seed(
  trellisName: string,
  trellisRelative: string,
  maxIter: number,
): string {
  return [
    `[garden] You are a trellis vine bound to \`${trellisRelative}\`. Read it before editing — it is your source of truth.`,
    "",
    `Iteration 1 of ${maxIter}.`,
    "",
    "This is your first iteration. There is no prior drift list and no lessons file yet — you will create `.garden/trellis-lessons.md` as you work.",
    "",
    "Read the trellis end-to-end. It describes the feature's intent, surface, behavior, tests, and documentation. Implement what it says, in priority order. The reviewer will compare your work against the trellis after you push and emit one of:",
    "",
    "- `ALIGNED` — you matched every claim. The loop ends.",
    "- `DRIFT` — your work is mergeable but incomplete; the reviewer will list priority-ordered gaps for the next iteration.",
    "- `FAILED` — checks/rebase/rules failed and the reviewer couldn't fix them.",
    "- `FLAGGED` — the trellis itself is contradictory or impossible. The loop pauses pending operator action.",
    "",
    "After your changes, append a one-line entry to `.garden/trellis-lessons.md` describing what you tried and what you learned. Commit and push when ready.",
    "",
    "You may not edit the trellis. If it is wrong or impossible, push commits that reflect what it says — the reviewer will surface the contradiction as `FLAGGED` and the operator will decide whether to amend.",
  ].join("\n");
}

// `garden workers grow [<worker>] ...` — convert an active default worker
// into a grow worker. Self-resolves the worker via $GARDEN_WORKER when no
// positional arg is given (mirrors `garden whoami`). The brainstorm-then-
// grow flow: operator opens a default worker, brainstorms + plans + executes,
// then types `/grow N` in the pane. The skill body summarizes the
// conversation into `.garden/grow-goal.md`, then runs this command to flip
// the workflow.
async function growCommand(args: string[]): Promise<void> {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = args[i + 1];
      if (val === undefined || val.startsWith("--")) {
        throw new Error(`--${key} requires a value`);
      }
      flags.set(key, val);
      i++;
    } else {
      positional.push(a);
    }
  }

  // Resolve worker via explicit arg or $GARDEN_WORKER fallback (mirrors
  // src/commands/whoami.ts:25-56).
  const explicitWorker = positional[0];
  const workerName = explicitWorker ?? process.env.GARDEN_WORKER;
  if (!workerName) {
    throw new Error(
      "Not in a worker shell (GARDEN_WORKER not set). "
      + "Pass a worker name: garden workers grow <worker> ...",
    );
  }

  // Resolve project: $GARDEN_PROJECT fast path → registry scan fallback.
  let projectName: string | undefined = process.env.GARDEN_PROJECT;
  let entry: WorkerEntry | undefined;
  if (projectName) {
    entry = findWorkerByName(projectName, workerName);
  }
  if (!entry) {
    const registry = readRegistry();
    for (const [p, entries] of Object.entries(registry.workers)) {
      const match = entries.find(e => e.name === workerName);
      if (match) {
        projectName = p;
        entry = match;
        break;
      }
    }
  }
  if (!entry || !projectName) {
    throw new Error(`Worker '${workerName}' not found in registry.`);
  }

  // Re-conversion is rejected — operators amend an in-flight grow loop's
  // goal by editing the file directly. Trellis is not convertible to grow
  // (different anchoring semantics).
  const currentWorkflow = entry.workflow ?? "default";
  if (currentWorkflow !== "default") {
    throw new Error(
      `Worker '${workerName}' is already on the '${currentWorkflow}' workflow. `
      + `Re-conversion is not supported; edit .garden/grow-goal.md directly to amend the goal mid-loop.`,
    );
  }
  if (!entry.worktreePath) {
    throw new Error(
      `Worker '${workerName}' has no worktreePath in the registry. Cannot write the goal file.`,
    );
  }

  const project = tryGetProject(projectName);
  if (!project) {
    throw new Error(`Unknown project '${projectName}'.`);
  }

  // Resolve seed: --seed xor --seed-file xor --goal-file (one required).
  // --seed-file and --goal-file are aliases — both read the same kind of
  // file. The slash skill uses --goal-file (matches the on-disk filename);
  // operators scripting the CLI can use whichever spelling they prefer.
  const seedFlags = ["seed", "seed-file", "goal-file"].filter(k => flags.has(k));
  if (seedFlags.length > 1) {
    throw new Error(
      `--seed, --seed-file, and --goal-file are mutually exclusive; pass exactly one. `
      + `Got: ${seedFlags.map(f => "--" + f).join(", ")}`,
    );
  }
  if (seedFlags.length === 0) {
    throw new Error(
      "Pass exactly one of --seed <text>, --seed-file <path>, or --goal-file <path>.",
    );
  }
  let seed: string;
  if (flags.has("seed")) {
    seed = flags.get("seed")!;
  } else {
    const filePath = flags.get("seed-file") ?? flags.get("goal-file")!;
    try {
      seed = fs.readFileSync(filePath, "utf-8");
    } catch (err) {
      throw new Error(`Could not read '${filePath}': ${String(err)}`);
    }
  }
  seed = seed.trim();
  if (!seed) {
    throw new Error("Seed must be non-empty.");
  }

  // Resolve max iterations: --max-iterations > project.maxGrowIterations > 5.
  let maxIter = 5;
  if (project.maxGrowIterations !== undefined) maxIter = project.maxGrowIterations;
  if (flags.has("max-iterations")) {
    const raw = flags.get("max-iterations")!;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 1) {
      throw new Error(`--max-iterations must be a positive integer, got '${raw}'`);
    }
    maxIter = n;
  }

  // Write the goal file. Idempotent — if --goal-file already pointed at
  // .garden/grow-goal.md inside the worktree, this overwrites it with the
  // (re-trimmed) content. Imported lazily to avoid any circular dependency
  // with the grow-continue module's at-import-time exports.
  const { writeGrowGoalFile } = await import("../dashboard/grow-continue.js");
  if (!writeGrowGoalFile(entry.worktreePath, seed)) {
    throw new Error(
      `Failed to write goal file at ${path.join(entry.worktreePath, ".garden", "grow-goal.md")}.`,
    );
  }

  // Flip the workflow. Iteration starts at 0; the next launchReview will
  // increment to 1 via the existing growLoopHooks path.
  updateWorkerFields(projectName, workerName, {
    workflow: "grow",
    grow: {
      seed,
      iteration: 0,
      maxIterations: maxIter,
    },
  });

  console.log(
    `Converted worker ${projectName}/${workerName} to grow `
    + `(up to ${maxIter} iterations). Goal at .garden/grow-goal.md.`,
  );
}

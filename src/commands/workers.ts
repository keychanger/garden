// `garden workers <subcommand>` — worker lifecycle CLI.
import fs from "node:fs";
import path from "node:path";
import { tryGetProject, SESSIONS_DIR, loadConfig } from "../config.js";
import { newWorker } from "../dashboard/workers.js";
import { WORKER_EFFORT_LEVELS, isWorkerEffort } from "../dashboard/create.js";
import { isRegisteredHarness, harnessNames, canonicalHarnessName } from "../dashboard/harness/core.js";
import { getCrew, listCrews } from "../dashboard/crew.js";
import { buildGrowIteration1Seed, GROW_GOAL_FILE_REL } from "../dashboard/grow-continue.js";
import { buildBotanistSeed } from "../dashboard/botanist-prompts.js";
import {
  readRegistry, findWorkerByName, updateWorkerFields,
  type WorkerEntry,
} from "../dashboard/registry.js";
import { validateTrellisPlant } from "../dashboard/trellis-tag.js";
import { dispatchDelayedSeed } from "../dashboard/continue.js";
import { resolveGardenRunner } from "../dashboard/runner.js";
import {
  countCommitsAheadOfBase, isWorktreeDirty, syncWorktreeToBase,
} from "../dashboard/git.js";

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
    + `  garden workers new <project> [--workflow trellis|grow|botanist] [--base <branch>] [--trellis <name>] `
    + `[--seed <text> | --seed-file <path>] [--model <alias-or-id>] [--effort low|medium|high|xhigh|ultra] [--harness <name>] [--max-iterations N]\n`
    + `  garden workers grow [<worker>] [--seed <text> | --seed-file <path> | --goal-file <path>] `
    + `[--max-iterations N]`,
  );
}

// --model accepts an Anthropic alias ("opus"/"sonnet" — resolved through the
// provider's modelMap on provider-backed projects) or any concrete model id
// the backend accepts; garden does not maintain a model list to validate
// against (docs/MULTI-MODEL.md "Layer 2"). It is interpolated into launch
// commands via shellEscape, so the only hard requirement is non-emptiness.
function requireModelValue(raw: string): string {
  const model = raw.trim();
  if (!model) throw new Error("--model requires a non-empty value");
  return model;
}

// --effort accepts the four reasoning rungs or "ultra" (the ultracode preset:
// max effort + dynamic workflows). Maps to newWorker's effort/ultracode fields
// — the two are mutually exclusive, so exactly one is returned. Default/grow
// only; trellis resolves its own model and carries no effort.
function parseEffortFlag(raw: string): { effort?: string; ultracode?: boolean } {
  const value = raw.trim();
  if (value === "ultra") return { ultracode: true };
  if (isWorkerEffort(value)) return { effort: value };
  throw new Error(`--effort must be one of: ${[...WORKER_EFFORT_LEVELS, "ultra"].join(", ")}, got '${raw}'`);
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
  if (workflow !== "default" && workflow !== "trellis" && workflow !== "grow" && workflow !== "botanist") {
    throw new Error(`--workflow must be 'default', 'trellis', 'grow', or 'botanist', got '${workflow}'`);
  }

  // Worker harness (agent CLI). Default workflow only in v1 — trellis/grow
  // model resolution and cold-respawn identity are not yet exercised against a
  // foreign harness.
  // Accept the "claude" alias for the claude-code harness (the crew member
  // name) and canonicalize at the boundary so this pre-check, the persisted
  // entry, and the log line all use the registry name.
  const rawHarness = flags.get("harness");
  const harness = rawHarness === undefined ? undefined : canonicalHarnessName(rawHarness);
  if (harness && !isRegisteredHarness(harness)) {
    throw new Error(`--harness must be one of: ${harnessNames().join(", ")}, got '${harness}'`);
  }
  if (harness && workflow !== "default" && workflow !== "botanist") {
    throw new Error(`--harness is only supported with --workflow default or botanist (got '${workflow}').`);
  }

  // Per-worker base-branch override (all workflows). Precedence over the
  // project's configured baseBranch; validated/published at spawn via the
  // newWorker branchExistsOnOrigin + tryPublishBranch chain.
  const base = flags.get("base");
  if (base !== undefined && !base.trim()) {
    throw new Error("--base requires a non-empty branch name");
  }

  // Per-worker crew (default workflow only, mutually exclusive with --harness):
  // sets the build harness (its worker member) + the live review family.
  const crew = flags.get("crew");
  if (crew !== undefined) {
    const cfg = loadConfig();
    const spec = getCrew(crew, cfg);
    if (!spec) {
      throw new Error(`--crew must be one of: ${listCrews(cfg).map(c => c.name).join(", ")}, got '${crew}'`);
    }
    if (spec.worker.provider) {
      throw new Error(
        `--crew '${crew}' has a provider-backed worker member (${spec.worker.name}); per-worker provider is not supported. `
        + `Set the provider at project level (garden config <p> provider) or pick an all-harness crew.`,
      );
    }
    if (harness) {
      throw new Error("--crew and --harness are mutually exclusive (a crew already selects the worker harness).");
    }
    if (workflow !== "default") {
      throw new Error(`--crew is only supported with --workflow default (got '${workflow}').`);
    }
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
    const model = flags.has("model") ? requireModelValue(flags.get("model")!) : undefined;
    const effortOpts = flags.has("effort") ? parseEffortFlag(flags.get("effort")!) : {};
    const newName = newWorker({ projectName, workflow, model, ...effortOpts, ...(harness ? { harness } : {}), ...(base ? { base } : {}), ...(crew ? { crew } : {}) });
    if (!newName) {
      throw new Error(
        `Failed to spawn worker on '${projectName}'. Is the dashboard running? Check 'garden health'.`,
      );
    }
    const effortLabel = effortOpts.ultracode ? "effort=ultra" : effortOpts.effort ? `effort=${effortOpts.effort}` : "";
    const suffix = [model ? `model=${model}` : "", effortLabel, harness ? `harness=${harness}` : "", base ? `base=${base}` : "", crew ? `crew=${crew}` : ""].filter(Boolean).join(", ");
    console.log(`Created worker ${projectName}/${newName}${suffix ? ` (${suffix})` : ""}.`);
    return;
  }

  if (workflow === "grow") {
    if (flags.has("trellis")) {
      throw new Error("--trellis can only be used with --workflow trellis");
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

    const model = flags.has("model") ? requireModelValue(flags.get("model")!) : undefined;
    const effortOpts = flags.has("effort") ? parseEffortFlag(flags.get("effort")!) : {};
    const newName = newWorker({
      projectName,
      workflow: "grow",
      model,
      ...effortOpts,
      grow: { seed, maxIterations: maxIter },
      seedMessageFile: seedFile,
      ...(base ? { base } : {}),
    });
    if (!newName) {
      try { fs.unlinkSync(seedFile); } catch { /* ignore */ }
      throw new Error(
        `Failed to spawn grow worker on '${projectName}'. `
        + `Is the dashboard running? Check 'garden health'.`,
      );
    }
    const effortLabel = effortOpts.ultracode ? ", effort=ultra" : effortOpts.effort ? `, effort=${effortOpts.effort}` : "";
    console.log(
      `Started grow loop ${projectName}/${newName} (up to ${maxIter} iterations${model ? `, model=${model}` : ""}${effortLabel}).`,
    );
    return;
  }

  if (workflow === "botanist") {
    if (flags.has("trellis")) {
      throw new Error("--trellis can only be used with --workflow trellis");
    }
    if (flags.has("max-iterations")) {
      throw new Error("--max-iterations can only be used with --workflow trellis or grow");
    }
    // --crew is already rejected for any non-default workflow by the shared
    // guard above (a botanist runs no reviewer, so its own review crew is moot;
    // the downstream builder's crew is a separate --handoff-crew, Phase 4).
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
        "--workflow botanist requires a seed: pass --seed <text> or --seed-file <path>.",
      );
    }
    seed = seed.trim();
    if (!seed) {
      throw new Error("--workflow botanist requires a non-empty seed prompt.");
    }

    // Plant-time framing prompt, delivered via seedMessageFile (like grow's
    // iter-1 seed). A botanist does not loop, so the seed is not stored on the
    // entry; it only kicks off the frame → options pipeline.
    const seedFile = path.join(
      SESSIONS_DIR, "seeds",
      `botanist-seed-${projectName}-${Date.now()}.txt`,
    );
    fs.mkdirSync(path.dirname(seedFile), { recursive: true });
    fs.writeFileSync(seedFile, buildBotanistSeed(seed));

    // Designer model/effort default to Opus / xhigh via the workflow definition
    // (newWorker resolution); --model / --effort override per run.
    const model = flags.has("model") ? requireModelValue(flags.get("model")!) : undefined;
    const effortOpts = flags.has("effort") ? parseEffortFlag(flags.get("effort")!) : {};
    const newName = newWorker({
      projectName,
      workflow: "botanist",
      model,
      ...effortOpts,
      ...(harness ? { harness } : {}),
      ...(base ? { base } : {}),
      seedMessageFile: seedFile,
    });
    if (!newName) {
      try { fs.unlinkSync(seedFile); } catch { /* ignore */ }
      throw new Error(
        `Failed to spawn botanist on '${projectName}'. Is the dashboard running? Check 'garden health'.`,
      );
    }
    const effortLabel = effortOpts.ultracode ? ", effort=ultra" : effortOpts.effort ? `, effort=${effortOpts.effort}` : "";
    console.log(
      `Started botanist ${projectName}/${newName}${model ? ` (model=${model}${effortLabel})` : effortLabel ? ` (${effortLabel.slice(2)})` : ""}${harness ? ` [harness=${harness}]` : ""}.`,
    );
    return;
  }

  // workflow === "trellis"
  if (flags.has("effort")) {
    throw new Error("--effort is only supported with --workflow default, grow, or botanist (trellis resolves its own model).");
  }
  const trellisName = flags.get("trellis");
  if (!trellisName) {
    throw new Error("--workflow trellis requires --trellis <name>");
  }

  let workerModel: string | undefined;
  if (flags.has("model")) {
    workerModel = requireModelValue(flags.get("model")!);
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
    ...(base ? { base } : {}),
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

  // Reject extra positional args — `garden workers grow w1 w2 --seed x`
  // would otherwise silently use w1 and discard w2. The user almost
  // certainly meant something specific; bail rather than guess.
  if (positional.length > 1) {
    throw new Error(
      `Unexpected extra arguments: ${positional.slice(1).map(a => `'${a}'`).join(", ")}. `
      + `Usage: garden workers grow [<worker>] [--seed <text> | --seed-file <path> | --goal-file <path>] [--max-iterations N]`,
    );
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

  if (!entry.worktreePath) {
    throw new Error(
      `Worker '${workerName}' has no worktreePath in the registry. Cannot write the goal file.`,
    );
  }

  // Re-conversion is rejected. The right amend path differs by current
  // workflow: grow workers amend by editing the goal file directly (next
  // iteration re-reads it); trellis vines amend via `garden trellis amend`
  // against the trellis doc. Telling a trellis user to edit grow-goal.md
  // would point them at a file that doesn't exist for their workflow.
  const currentWorkflow = entry.workflow ?? "default";
  if (currentWorkflow === "grow") {
    throw new Error(
      `Worker '${workerName}' is already on the 'grow' workflow. `
      + `Re-conversion is not supported; edit ${path.join(entry.worktreePath, ".garden", "grow-goal.md")} directly to amend the goal — the next iteration's continue prompt re-reads it at dispatch time.`,
    );
  }
  if (currentWorkflow === "trellis") {
    throw new Error(
      `Worker '${workerName}' is a trellis vine — trellis vines are not convertible to grow. `
      + `Amend the trellis with \`garden trellis amend\`, or kill the vine in the dashboard `
      + `(focus the pane and press ⌥x) and start fresh with \`garden workers new ... --workflow grow\`.`,
    );
  }
  if (currentWorkflow !== "default") {
    throw new Error(
      `Worker '${workerName}' is on workflow '${currentWorkflow}', not 'default'. `
      + `Conversion to grow is only supported from the default workflow.`,
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
      throw new Error(
        `Could not read '${filePath}': ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  seed = seed.trim();
  if (!seed) {
    throw new Error("Seed must be non-empty.");
  }

  // Resolve max iterations: --max-iterations > project.maxGrowIterations > 5.
  // Strict integer parsing: parseInt would silently accept '5.7' (→ 5) or
  // '5xyz' (→ 5), corrupting the budget without surfacing the typo. The
  // /^-?\d+$/ guard rejects fractional, scientific, hex, and trailing-junk
  // inputs before parseInt sees them.
  let maxIter = 5;
  if (project.maxGrowIterations !== undefined) maxIter = project.maxGrowIterations;
  if (flags.has("max-iterations")) {
    const raw = flags.get("max-iterations")!;
    if (!/^-?\d+$/.test(raw)) {
      throw new Error(`--max-iterations must be a positive integer, got '${raw}'`);
    }
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 1) {
      throw new Error(`--max-iterations must be a positive integer, got '${raw}'`);
    }
    maxIter = n;
  }

  // Decide which dispatch path applies BEFORE any state mutation, so a
  // precondition failure (dirty tree) leaves the worker on its original
  // workflow rather than half-converted (which the re-conversion guard
  // above would then block).
  //
  //  - ahead > 0: worker still has commits to push. The upcoming merge
  //    fires growAutoContinueAfterMerge, which dispatches iter-1. Status
  //    quo — convert just flips the workflow and exits.
  //
  //  - ahead === 0: branch is fully merged into base. No future merge
  //    means no grow auto-continue. The convert command must dispatch
  //    iter-1 directly, mirroring the plant-time path in newCommand.
  //    First fast-forwards the worktree to origin/<base> so iter-1 starts
  //    on the latest base (siblings may have merged since this branch
  //    landed).
  //
  //  - null (count unavailable, e.g. path isn't a git worktree): treat
  //    as ahead > 0 / status quo. We can't determine pending work, so
  //    don't try to dispatch.
  const baseBranch = entry.baseBranch ?? "main";
  const ahead = countCommitsAheadOfBase(entry.worktreePath, baseBranch);
  const dispatchIter1 = ahead === 0;

  if (dispatchIter1) {
    // Pre-flight the dirty check before any state mutation. syncWorktreeToBase
    // below also checks dirty, but doing it up front means a dirty tree never
    // leaves the worker half-converted (which the re-conversion guard at the
    // top of growCommand would then block on a retry).
    if (isWorktreeDirty(entry.worktreePath)) {
      throw new Error(
        `Worktree at ${entry.worktreePath} has uncommitted changes — clean up `
        + `(commit, stash, or discard) and re-run \`garden workers grow\`. `
        + `Aborting before flipping the workflow so re-running picks up cleanly.`,
      );
    }
  }

  // Write the goal file. Idempotent — if --goal-file already pointed at
  // .garden/grow-goal.md inside the worktree, this overwrites it with the
  // (re-trimmed) content. Imported lazily to avoid any circular dependency
  // with the grow-continue module's at-import-time exports. Filesystem
  // errors (EACCES on a read-only worktree, ENOSPC, missing worktree dir)
  // are caught here so the operator sees the cause rather than a generic
  // "failed to write" — diagnosing a read-only mount or full disk from a
  // boolean is impossible.
  const { writeGrowGoalFile } = await import("../dashboard/grow-continue.js");
  const goalPath = path.join(entry.worktreePath, ".garden", "grow-goal.md");
  try {
    writeGrowGoalFile(entry.worktreePath, seed);
  } catch (err) {
    throw new Error(
      `Failed to write goal file at ${goalPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Flip the workflow. Iteration starts at 0; the next launchReview (or
  // the iter-1 dispatch below) will move it to 1 via growLoopHooks.
  updateWorkerFields(projectName, workerName, {
    workflow: "grow",
    grow: {
      seed,
      iteration: 0,
      maxIterations: maxIter,
    },
  });

  if (!dispatchIter1) {
    console.log(
      `Converted worker ${projectName}/${workerName} to grow `
      + `(up to ${maxIter} iterations). Goal at .garden/grow-goal.md. `
      + `Iter-1 fires on the next merge.`,
    );
    return;
  }

  // ahead === 0: branch is fully merged. Fast-forward to origin/<base>
  // (covers sibling merges that landed after this branch did), then
  // dispatch the iter-1 seed prompt the same way `workers new --workflow
  // grow` does. Without this, the worker would sit idle on
  // workflow=grow,iteration=0 indefinitely — there's no future merge to
  // fire growAutoContinueAfterMerge.
  const sync = syncWorktreeToBase(entry.worktreePath, baseBranch);
  if (!sync.ok) {
    throw new Error(
      `Could not fast-forward worktree at ${entry.worktreePath} to origin/${baseBranch}: ${sync.reason}${sync.error ? ` (${sync.error})` : ""}. `
      + `Workflow has been flipped to grow; resolve the git issue and re-run iter-1 manually `
      + `(or amend ${path.join(entry.worktreePath, ".garden", "grow-goal.md")} and bounce the worker).`,
    );
  }

  const seedFile = path.join(
    SESSIONS_DIR, "seeds",
    `grow-seed-${projectName}-${Date.now()}.txt`,
  );
  fs.mkdirSync(path.dirname(seedFile), { recursive: true });
  fs.writeFileSync(seedFile, buildGrowIteration1Seed(seed, maxIter));
  dispatchDelayedSeed(resolveGardenRunner(), projectName, workerName, seedFile);

  console.log(
    `Converted worker ${projectName}/${workerName} to grow `
    + `(up to ${maxIter} iterations). Goal at .garden/grow-goal.md. `
    + `Worktree fast-forwarded to origin/${baseBranch}; iter-1 dispatching now.`,
  );
}

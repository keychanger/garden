// `garden workers <subcommand>` — worker lifecycle CLI.
import fs from "node:fs";
import path from "node:path";
import { tryGetProject, SESSIONS_DIR } from "../config.js";
import { newWorker } from "../dashboard/workers.js";
import { buildGrowIteration1Seed } from "../dashboard/grow-continue.js";
import { validateTrellisPlant } from "../dashboard/trellis-tag.js";

export async function workers(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === "new") {
    await newCommand(args.slice(1));
    return;
  }
  throw new Error(
    `Usage: garden workers new <project> [--workflow trellis|grow] `
    + `[--trellis <name>] [--seed <text> | --seed-file <path>] `
    + `[--model opus|sonnet] [--max-iterations N]`,
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

// `garden workers <subcommand>` — worker lifecycle CLI. Phase 2 ships the
// `new` subcommand with trellis support; other subcommands defer to v1.5
// or beyond. The picker hotkey (⌥⇧n) in phase 5 will be the daily-driver
// path; `garden workers new` is the script-friendly equivalent.
import fs from "node:fs";
import path from "node:path";
import { tryGetProject, SESSIONS_DIR } from "../config.js";
import { newWorker } from "../dashboard/workers.js";
import { validateTrellisPlant } from "../dashboard/trellis-tag.js";

export async function workers(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === "new") {
    await newCommand(args.slice(1));
    return;
  }
  throw new Error(
    `Usage: garden workers new <project> [--workflow trellis --trellis <name>] [--max-iterations N]`,
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
  if (workflow !== "default" && workflow !== "trellis") {
    throw new Error(`--workflow must be 'default' or 'trellis', got '${workflow}'`);
  }

  if (workflow === "default") {
    if (flags.has("trellis")) {
      throw new Error("--trellis can only be used with --workflow trellis");
    }
    if (flags.has("max-iterations")) {
      throw new Error("--max-iterations can only be used with --workflow trellis");
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

  // workflow === "trellis"
  const trellisName = flags.get("trellis");
  if (!trellisName) {
    throw new Error("--workflow trellis requires --trellis <name>");
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
    },
    seedMessageFile: seedFile,
  });
  if (!newName) {
    try { fs.unlinkSync(seedFile); } catch { /* ignore */ }
    throw new Error(
      `Failed to spawn vine on '${projectName}'. Is the dashboard running? Check 'garden health'.`,
    );
  }
  console.log(
    `Planted vine ${projectName}/${newName} on trellis '${trellisName}' (${maxIter} iterations max).`,
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

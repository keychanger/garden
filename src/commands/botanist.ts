// `garden botanist <subcommand>` — botanist (design) worker CLI.
//
// Today the only subcommand is `publish`: a botanist invokes it from its own
// pane after the operator approves the design artifact. It moves the artifact to
// a tracked docs/ path, commits it, and marks the worker done; the poller then
// merges it with no reviewer (see handleWorking's skip-review path). Self-resolves
// the worker via $GARDEN_WORKER, mirroring `garden workers grow` / `garden whoami`.
import { readRegistry, findWorkerByName, type WorkerEntry } from "../dashboard/registry.js";
import { publishBotanistArtifact, BOTANIST_PUBLISH_ROOT } from "../dashboard/botanist-publish.js";

export async function botanist(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === "publish") {
    await publishCommand(args.slice(1));
    return;
  }
  throw new Error(
    "Usage:\n"
    + `  garden botanist publish [<worker>] --to ${BOTANIST_PUBLISH_ROOT}<name>.md [--dry-run]`,
  );
}

async function publishCommand(args: string[]): Promise<void> {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--dry-run") {
      dryRun = true;
    } else if (a.startsWith("--")) {
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

  if (positional.length > 1) {
    throw new Error(
      `Unexpected extra arguments: ${positional.slice(1).map(a => `'${a}'`).join(", ")}. `
      + `Usage: garden botanist publish [<worker>] --to ${BOTANIST_PUBLISH_ROOT}<name>.md [--dry-run]`,
    );
  }

  const to = flags.get("to");
  if (!to) {
    throw new Error(
      `--to is required: the tracked destination for the artifact, e.g. --to ${BOTANIST_PUBLISH_ROOT}future/<name>.md`,
    );
  }

  // Resolve worker via explicit arg or $GARDEN_WORKER (mirrors growCommand).
  const workerName = positional[0] ?? process.env.GARDEN_WORKER;
  if (!workerName) {
    throw new Error(
      "Not in a worker shell (GARDEN_WORKER not set). Pass a worker name: garden botanist publish <worker> --to ...",
    );
  }

  // Resolve project: $GARDEN_PROJECT fast path → registry scan fallback.
  let projectName: string | undefined = process.env.GARDEN_PROJECT;
  let entry: WorkerEntry | undefined;
  if (projectName) entry = findWorkerByName(projectName, workerName);
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
  if (entry.workflow !== "botanist") {
    throw new Error(
      `Worker '${workerName}' is not a botanist (workflow: ${entry.workflow ?? "default"}). `
      + `garden botanist publish only applies to botanist workers.`,
    );
  }
  if (!entry.worktreePath) {
    throw new Error(`Worker '${workerName}' has no worktreePath in the registry.`);
  }

  const result = publishBotanistArtifact(entry.worktreePath, to, { dryRun });
  if (!result.ok) {
    throw new Error(result.message);
  }
  console.log(result.message);
}

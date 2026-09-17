// `garden handoff <project> [-m]` — spawns a fresh worker on <project>, seeds
// its first prompt with a briefing (-m or stdin). Prefix degrades to
// "[handoff]" when env vars are absent.
//
// Implementation: the worker pane that runs this CLI is sandboxed by Claude
// Code, which blocks the tmux server socket. We can't call tmux directly. So
// the CLI writes a request to ~/.garden/sessions/handoff-requests/ (sandbox-
// allowed), pokes one or more project pollers, and waits on the durable receipt
// the unsandboxed poller writes once newWorker returns. The whole round-trip
// is typically <500ms.
import fs from "node:fs";
import path from "node:path";
import { tryGetProject, SESSIONS_DIR, loadConfig } from "../config.js";
import {
  submitHandoffRequest, waitForHandoffResponse, withdrawPendingHandoffRequest,
} from "../dashboard/handoff-dispatch.js";
import { triggerProjectPoll } from "../dashboard/poller-fifo.js";
import { getCrew, listCrews } from "../dashboard/crew.js";
import { findWorkerByName } from "../dashboard/registry.js";
import { WORKER_EFFORT_LEVELS } from "../dashboard/worker-effort.js";
import { requireModelValue, parseEffortFlag } from "./launch-flags.js";

const HANDOFF_CLAIM_TIMEOUT_MS = 15_000;
const HANDOFF_PROCESSING_TIMEOUT_MS = 75_000;

export async function handoff(args: string[]): Promise<void> {
  const targetProject = args[0];
  if (!targetProject || targetProject.startsWith("-")) {
    throw new Error(
      `Usage: garden handoff <target-project> [options] [-m "message"]\n`
      + "       garden handoff <target-project> [options] < message-file\n"
      + "       garden handoff <target-project> [options] <<'EOF' ... EOF\n"
      + "\n"
      + "  --ultracode        create the new worker in ultracode mode (Opus + max effort + dynamic workflows)\n"
      + "  --crew <name>      spawn the new worker under this crew (build member + review family); without it,\n"
      + "                     the worker inherits the crew stamped on the calling worker's own entry, if any\n"
      + "  --model <m>        pin the new worker's model (an alias like 'opus', or a concrete model id);\n"
      + "                     outranks the crew's builder seat and the target project's default\n"
      + `  --effort <rung>    pin the new worker's reasoning rung: ${[...WORKER_EFFORT_LEVELS, "ultra"].join(", ")}\n`
      + "                     ('ultra' is the ultracode preset, so it cannot be combined with --ultracode)\n"
      + "  --bead <id>        stamp the bead id on the new worker's registry entry (the bead↔worker join;\n"
      + "                     makes no bd claim — the worker's own briefed claim is the claim)\n"
      + "  --expect-callback  receive a one-shot prompt at this pane when the child reaches a terminal state",
    );
  }

  if (!tryGetProject(targetProject)) {
    throw new Error(`Unknown project '${targetProject}'. Run 'garden list' to see registered projects.`);
  }

  const flags = parseHandoffFlags(args.slice(1));
  const expectCallback = flags.has("--expect-callback");
  const ultracode = flags.has("--ultracode");
  const bead = flags.get("--bead");
  if (bead && bead.length > 128) {
    throw new Error("--bead id must be 128 characters or fewer.");
  }

  let crew = flags.get("--crew");
  if (crew) {
    const cfg = loadConfig();
    if (!getCrew(crew, cfg)) {
      throw new Error(`Unknown crew '${crew}'. Available: ${listCrews(cfg).map((c) => c.name).join(", ")}.`);
    }
  }

  const modelRaw = flags.get("--model");
  const model = modelRaw ? requireModelValue(modelRaw) : undefined;
  if (model && model.length > 128) {
    throw new Error("--model must be 128 characters or fewer.");
  }
  const effortRaw = flags.get("--effort");
  if (effortRaw !== undefined && ultracode) {
    throw new Error(
      "--effort and --ultracode are mutually exclusive: the ultracode preset already fixes "
      + "max effort. Use --effort ultra for the preset, or --ultracode on its own.",
    );
  }
  // "ultra" names the ultracode preset rather than a rung, so at most one of
  // the two fields below is ever set — the same split `workers new` makes.
  const effortOpts = effortRaw !== undefined ? parseEffortFlag(effortRaw) : {};
  const effort = effortOpts.effort;
  const ultracodeRequested = ultracode || effortOpts.ultracode === true;

  const briefing = await readBriefing(flags.get("-m"));
  if (!briefing.trim()) {
    throw new Error("Empty briefing. Pass -m \"<text>\" or pipe a message via stdin.");
  }

  const sourceProject = process.env.GARDEN_PROJECT;
  const sourceWorker = process.env.GARDEN_WORKER;
  if (expectCallback && !(sourceProject && sourceWorker)) {
    throw new Error(
      "--expect-callback requires running inside a garden worker pane "
      + "(GARDEN_PROJECT and GARDEN_WORKER must be set). There's no parent "
      + "to call back to from a bare shell.",
    );
  }
  // Without --crew, the child inherits the crew stamped on THIS worker's
  // entry. A designer's design seat came from that crew, so its builder gets
  // the same crew's build and review halves with nothing in the brief to
  // say so; a default worker spawned with --crew passes its crew along the
  // same way. A worker with no per-worker crew forwards nothing, and the
  // child resolves the target project's own binding.
  let inheritedCrew = false;
  if (!crew && sourceProject && sourceWorker) {
    const own = findWorkerByName(sourceProject, sourceWorker)?.crew;
    if (own) {
      crew = own;
      inheritedCrew = true;
    }
  }
  const callbackTag = expectCallback ? " — callback requested" : "";
  const prefix = sourceProject && sourceWorker
    ? `[handoff from ${sourceProject}/${sourceWorker}${callbackTag}]`
    : "[handoff]";
  const seedMessage = `${prefix}\n\n${briefing.trimEnd()}`;

  const seedsDir = path.join(SESSIONS_DIR, "seeds");
  fs.mkdirSync(seedsDir, { recursive: true });
  const seedFile = path.join(
    seedsDir,
    `seed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`,
  );
  fs.writeFileSync(seedFile, seedMessage);

  const reqId = submitHandoffRequest({
    targetProject,
    seedFile,
    expectCallback,
    parentProject: sourceProject,
    parentWorker: sourceWorker,
    ultracode: ultracodeRequested,
    crew,
    bead,
    model,
    effort,
  });

  // Poke any poller that might be listening. The target's poller is the
  // natural pick, but if no worker exists on the target yet it won't be
  // running; the source project's poller (always running for a live worker)
  // serves as a fallback. Poking extra pollers is harmless — each pending
  // handoff is claimed once via atomic rename, so there's no double-spawn.
  const projectsToPoke = new Set<string>([targetProject]);
  if (sourceProject) projectsToPoke.add(sourceProject);
  // As a last resort, poke every configured project. Cheap — silently no-ops
  // when no FIFO/poller is present.
  for (const projectName of Object.keys(loadConfig().projects)) {
    projectsToPoke.add(projectName);
  }
  for (const projectName of projectsToPoke) {
    triggerProjectPoll(projectName);
  }

  const resp = await waitForHandoffResponse(
    reqId,
    HANDOFF_CLAIM_TIMEOUT_MS,
    HANDOFF_PROCESSING_TIMEOUT_MS,
  );
  if (!resp) {
    const withdrawn = withdrawPendingHandoffRequest(reqId);
    if (withdrawn) {
      try { fs.unlinkSync(seedFile); } catch { /* ignore */ }
    }
    const recoveryNote = withdrawn
      ? ""
      : " The request was already claimed and may still recover; check the dashboard before resubmitting.";
    throw new Error(
      `Handoff to '${targetProject}' timed out before dispatch completed. `
      + `Garden waits ${HANDOFF_CLAIM_TIMEOUT_MS / 1000}s for a poller to claim the request `
      + `and up to ${HANDOFF_PROCESSING_TIMEOUT_MS / 1000}s for worker creation after that. `
      + "Is the dashboard running with at least one active project poller? "
      + `Check 'garden health'.${recoveryNote}`,
    );
  }
  if (resp.error) {
    try { fs.unlinkSync(seedFile); } catch { /* ignore */ }
    throw new Error(`Handoff to '${targetProject}' failed: ${resp.error}`);
  }
  if (!resp.workerName) {
    try { fs.unlinkSync(seedFile); } catch { /* ignore */ }
    throw new Error(`Handoff to '${targetProject}' returned no worker name.`);
  }

  const notes = [
    ultracodeRequested ? "ultracode mode" : null,
    crew ? `crew ${crew}${inheritedCrew ? " (inherited)" : ""}` : null,
    model ? `model ${model}` : null,
    effort ? `effort ${effort}` : null,
    expectCallback ? "callback requested on terminal state" : null,
    bead ? `bead ${bead}` : null,
  ].filter(Boolean);
  const suffix = notes.length ? ` (${notes.join("; ")})` : "";
  console.log(`Handed off to ${targetProject}/${resp.workerName}.${suffix}`);
}

function parseHandoffFlags(args: string[]): Map<string, string> {
  const missingMessages: Record<string, string> = {
    "--bead": "--bead requires a bead id argument.",
    "--crew": "--crew requires a crew name argument.",
    "--model": "--model requires a value (an alias like 'opus', or a concrete model id).",
    "--effort": `--effort requires a value (${[...WORKER_EFFORT_LEVELS, "ultra"].join(", ")}).`,
    "-m": "-m requires a message argument.",
  };
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const boolean = flag === "--expect-callback" || flag === "--ultracode";
    if (flags.has(flag) || (!boolean && !Object.hasOwn(missingMessages, flag))) {
      throw new Error(
        `Unknown or repeated handoff option '${flag}'. Supported once each: `
        + "--expect-callback, --ultracode, --crew <name>, --model <alias-or-id>, "
        + "--effort <rung>, --bead <id>, -m \"<message>\".",
      );
    }
    if (boolean) {
      flags.set(flag, "");
      continue;
    }
    const value = args[++i];
    if (value === undefined || (flag !== "-m" && (!value.trim() || value.trimStart().startsWith("-")))) {
      throw new Error(missingMessages[flag]);
    }
    flags.set(flag, flag === "-m" ? value : value.trim());
  }
  return flags;
}

async function readBriefing(message: string | undefined): Promise<string> {
  if (message !== undefined) return message;

  if (process.stdin.isTTY) {
    throw new Error(
      "No briefing supplied. Pass -m \"<text>\" or pipe a message via stdin "
      + "(e.g. heredoc: garden handoff <project> <<'EOF' ... EOF).",
    );
  }
  return await readStdin();
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

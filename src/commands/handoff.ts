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

const HANDOFF_CLAIM_TIMEOUT_MS = 15_000;
const HANDOFF_PROCESSING_TIMEOUT_MS = 75_000;

export async function handoff(args: string[]): Promise<void> {
  const targetProject = args[0];
  if (!targetProject || targetProject.startsWith("-")) {
    throw new Error(
      "Usage: garden handoff <target-project> [--expect-callback] [--ultracode] [--crew <name>] [--bead <id>] [-m \"message\"]\n"
      + "       garden handoff <target-project> [--expect-callback] [--ultracode] [--crew <name>] [--bead <id>] < message-file\n"
      + "       garden handoff <target-project> [--expect-callback] [--ultracode] [--crew <name>] [--bead <id>] <<'EOF' ... EOF\n"
      + "\n"
      + "  --ultracode  create the new worker in ultracode mode (Opus + max effort + dynamic workflows)\n"
      + "  --crew <n>   spawn the new worker under this crew (build member + review family); without it,\n"
      + "               the worker inherits the crew stamped on the calling worker's own entry, if any\n"
      + "  --bead <id>  stamp the bead id on the new worker's registry entry (the bead↔worker join;\n"
      + "               makes no bd claim — the worker's own briefed claim is the claim)",
    );
  }

  if (!tryGetProject(targetProject)) {
    throw new Error(`Unknown project '${targetProject}'. Run 'garden list' to see registered projects.`);
  }

  const rest = args.slice(1);
  const callbackIdx = rest.indexOf("--expect-callback");
  const expectCallback = callbackIdx !== -1;
  if (expectCallback) rest.splice(callbackIdx, 1);

  // --ultracode: create the child in Claude Code's ultracode mode (Opus +
  // max effort + the dynamic-workflow keyword trigger). No further knobs;
  // the recipe is fixed. Strip it before the briefing is read from `rest`.
  const ultracodeIdx = rest.indexOf("--ultracode");
  const ultracode = ultracodeIdx !== -1;
  if (ultracode) rest.splice(ultracodeIdx, 1);

  // --bead <id>: stamp the bead field on the new worker's registry entry —
  // the registry→bd join board's chips and the removal-time unclaim read.
  // Makes NO bd claim (the worker's own briefed claim is the claim).
  // Value-carrying: splice BOTH tokens out before readBriefing scans rest
  // for -m, or the id would be read as the -m message.
  const beadIdx = rest.indexOf("--bead");
  let bead: string | undefined;
  if (beadIdx !== -1) {
    const value = rest[beadIdx + 1];
    if (!value || !value.trim() || value.startsWith("-")) {
      throw new Error("--bead requires a bead id argument.");
    }
    bead = value.trim();
    if (bead.length > 128) {
      throw new Error("--bead id must be 128 characters or fewer.");
    }
    rest.splice(beadIdx, 2);
  }

  // --crew <name>: the crew the child spawns under (its build member and
  // review family). Value-carrying, so both tokens come out before the
  // briefing scan, like --bead. Validated here, in the caller's process,
  // rather than left to resolve as an inert dangling name at spawn.
  const crewIdx = rest.indexOf("--crew");
  let crew: string | undefined;
  if (crewIdx !== -1) {
    const value = rest[crewIdx + 1];
    if (!value || !value.trim() || value.startsWith("-")) {
      throw new Error("--crew requires a crew name argument.");
    }
    crew = value.trim();
    const cfg = loadConfig();
    if (!getCrew(crew, cfg)) {
      throw new Error(`Unknown crew '${crew}'. Available: ${listCrews(cfg).map((c) => c.name).join(", ")}.`);
    }
    rest.splice(crewIdx, 2);
  }

  const briefing = await readBriefing(rest);
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
    ultracode,
    crew,
    bead,
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
    ultracode ? "ultracode mode" : null,
    crew ? `crew ${crew}${inheritedCrew ? " (inherited)" : ""}` : null,
    expectCallback ? "callback requested on terminal state" : null,
    bead ? `bead ${bead}` : null,
  ].filter(Boolean);
  const suffix = notes.length ? ` (${notes.join("; ")})` : "";
  console.log(`Handed off to ${targetProject}/${resp.workerName}.${suffix}`);
}

async function readBriefing(rest: string[]): Promise<string> {
  // -m "<text>" wins if supplied. Otherwise read stdin.
  const mIdx = rest.indexOf("-m");
  if (mIdx !== -1) {
    const text = rest[mIdx + 1];
    if (!text) throw new Error("-m requires a message argument.");
    return text;
  }

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

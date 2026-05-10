// `garden handoff <project> [-m]` — spawns a fresh worker on <project>, seeds
// its first prompt with a briefing (-m or stdin). Prefix degrades to
// "[handoff]" when env vars are absent.
//
// Implementation: the worker pane that runs this CLI is sandboxed by Claude
// Code, which blocks the tmux server socket. We can't call tmux directly. So
// the CLI writes a request to ~/.garden/sessions/handoff-requests/ (sandbox-
// allowed), pokes one or more project pollers, and waits on a response file
// the unsandboxed poller writes once newWorker returns. The whole round-trip
// is typically <500ms.
import fs from "node:fs";
import path from "node:path";
import { tryGetProject, SESSIONS_DIR, loadConfig } from "../config.js";
import {
  submitHandoffRequest, waitForHandoffResponse,
} from "../dashboard/handoff-dispatch.js";
import { triggerProjectPoll } from "../dashboard/poller-fifo.js";

const HANDOFF_TIMEOUT_MS = 15_000;

export async function handoff(args: string[]): Promise<void> {
  const targetProject = args[0];
  if (!targetProject || targetProject.startsWith("-")) {
    throw new Error(
      "Usage: garden handoff <target-project> [-m \"message\"]\n"
      + "       garden handoff <target-project> < message-file\n"
      + "       garden handoff <target-project> <<'EOF' ... EOF",
    );
  }

  if (!tryGetProject(targetProject)) {
    throw new Error(`Unknown project '${targetProject}'. Run 'garden list' to see registered projects.`);
  }

  const briefing = await readBriefing(args.slice(1));
  if (!briefing.trim()) {
    throw new Error("Empty briefing. Pass -m \"<text>\" or pipe a message via stdin.");
  }

  const sourceProject = process.env.GARDEN_PROJECT;
  const sourceWorker = process.env.GARDEN_WORKER;
  const prefix = sourceProject && sourceWorker
    ? `[handoff from ${sourceProject}/${sourceWorker}]`
    : "[handoff]";
  const seedMessage = `${prefix}\n\n${briefing.trimEnd()}`;

  const seedsDir = path.join(SESSIONS_DIR, "seeds");
  fs.mkdirSync(seedsDir, { recursive: true });
  const seedFile = path.join(
    seedsDir,
    `seed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`,
  );
  fs.writeFileSync(seedFile, seedMessage);

  const reqId = submitHandoffRequest({ targetProject, seedFile });

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

  const resp = await waitForHandoffResponse(reqId, HANDOFF_TIMEOUT_MS);
  if (!resp) {
    try { fs.unlinkSync(seedFile); } catch { /* ignore */ }
    throw new Error(
      `Handoff to '${targetProject}' timed out after ${HANDOFF_TIMEOUT_MS / 1000}s. `
      + "Is the dashboard running with at least one active project poller? "
      + "Check 'garden health'.",
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

  console.log(`Handed off to ${targetProject}/${resp.workerName}.`);
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

// `garden handoff <target-project> [-m "<msg>"]` spawns a fresh worker on the
// target project and seeds its first prompt with a briefing read from -m or
// stdin. Invoked from a worker pane via the `handoff` skill, but works from
// any shell that has the GARDEN_PROJECT/GARDEN_WORKER env vars (or without —
// the prefix degrades to a generic "[handoff]").
import fs from "node:fs";
import path from "node:path";
import { tryGetProject, SESSIONS_DIR } from "../config.js";
import { newWorker } from "../dashboard/workers.js";

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
  // Filename is unique per call (timestamp + random) — the worker name is not
  // known until newWorker returns, but the dispatchDelayedSeed call wires the
  // path through directly so the filename only needs to be unique on disk.
  const seedFile = path.join(
    seedsDir,
    `seed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`,
  );
  fs.writeFileSync(seedFile, seedMessage);

  const newName = newWorker({ projectName: targetProject, seedMessageFile: seedFile });
  if (!newName) {
    try { fs.unlinkSync(seedFile); } catch { /* ignore */ }
    throw new Error(
      `Failed to spawn worker on '${targetProject}'. `
      + "Is the dashboard running? Check 'garden health'.",
    );
  }

  console.log(
    `Handed off to ${targetProject}/${newName}. `
    + "The new worker's pane is in a hidden tmux window — "
    + "navigate via ⌥p / ⌥1-9 (or 'garden plot') when ready.",
  );
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

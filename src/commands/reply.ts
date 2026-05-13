// `garden reply [-m "<text>"]` — child-worker companion to `garden handoff
// --expect-callback`. Stores a freeform note on the child's own registry
// entry; transitionState folds it into the callback prompt the next time
// the child reaches a terminal prState (merged/done/failing).
//
// Idempotency / overwrite behavior: multiple reply calls append to the
// existing note with a blank line between, so an agent that drops a few
// staged notes during its work doesn't have to manage the buffer itself.
// `--replace` clobbers the buffer if a fresh-start is needed. The note is
// cleared after the callback fires.
//
// No env: this command must be run inside a worker pane (GARDEN_PROJECT +
// GARDEN_WORKER set) — there's nothing to attach the note to otherwise.
// Pre-flight: the worker's registry entry must declare a parent and have
// callback expected; otherwise the note would never be delivered and we
// should fail loudly rather than silently store a dead-letter.
import { findWorkerByName, updateWorkerFields } from "../dashboard/registry.js";

export async function reply(args: string[]): Promise<void> {
  const project = process.env.GARDEN_PROJECT;
  const worker = process.env.GARDEN_WORKER;
  if (!project || !worker) {
    throw new Error(
      "garden reply must run inside a worker pane "
      + "(GARDEN_PROJECT and GARDEN_WORKER must be set).",
    );
  }

  const replaceIdx = args.indexOf("--replace");
  const replace = replaceIdx !== -1;
  const rest = replace ? args.filter((_, i) => i !== replaceIdx) : args;

  const note = await readNote(rest);
  if (!note.trim()) {
    throw new Error("Empty reply. Pass -m \"<text>\" or pipe a message via stdin.");
  }

  const entry = findWorkerByName(project, worker);
  if (!entry) {
    throw new Error(`No registry entry for ${project}/${worker}. Are you running inside a garden worker pane?`);
  }
  if (!entry.handoffCallbackExpected || !entry.parentProject || !entry.parentWorker) {
    throw new Error(
      `Worker ${project}/${worker} has no parent expecting a callback. `
      + "garden reply only works for workers spawned via `garden handoff --expect-callback`.",
    );
  }

  const existing = entry.handoffReplyNote ?? "";
  const next = replace || !existing.trim()
    ? note.trimEnd()
    : `${existing.trimEnd()}\n\n${note.trimEnd()}`;

  updateWorkerFields(project, worker, { handoffReplyNote: next });
  console.log(`Reply note staged for ${entry.parentProject}/${entry.parentWorker}.`);
}

async function readNote(rest: string[]): Promise<string> {
  const mIdx = rest.indexOf("-m");
  if (mIdx !== -1) {
    const text = rest[mIdx + 1];
    if (!text) throw new Error("-m requires a message argument.");
    return text;
  }
  if (process.stdin.isTTY) {
    throw new Error(
      "No reply text supplied. Pass -m \"<text>\" or pipe a message via stdin.",
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

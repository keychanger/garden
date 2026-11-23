// `garden history [<worker>]` — read a worker's whole conversation, oldest
// first, in a pager. The ⌥h pane is a summary sized for a narrow column; this
// is the reading view: every operator prompt in full, each handoff briefing,
// and what the agent finally said at the end of each exchange, under the same
// action summary the pane shows. The pager opens at the top, so the first
// thing on screen is the prompt that started the conversation.
//
// With no argument it resolves the dashboard's focused worker (`.`). Piped, it
// emits the parsed turns as JSON.
import { spawnSync } from "node:child_process";
import { output, isTTY } from "../output.js";
import { resolveWorkerArg } from "./resolve-worker.js";
import { getHarnessCore } from "../dashboard/harness/core.js";
import { formatConversationPane } from "../dashboard/conversation.js";

export async function history(args: string[]): Promise<void> {
  const { project, worker, entry } = resolveWorkerArg(args[0] ?? ".");
  const core = getHarnessCore(entry.harness);
  const transcriptPath = core.resolveTranscriptPath(entry);
  const turns = core.readTurns(transcriptPath);

  if (!isTTY) {
    output({ project, worker, transcriptPath, turns });
    return;
  }

  const prompts = turns.filter(t => t.role !== "assistant").length;
  const lines = [
    "",
    ` \x1b[1m${project}/${worker}\x1b[0m  \x1b[2m${prompts} prompt${prompts === 1 ? "" : "s"} · ${transcriptPath ?? "no transcript"}\x1b[0m`,
    "",
    ...(turns.length > 0
      ? formatConversationPane(turns, { width: process.stdout.columns || 100, full: true })
      : [" \x1b[2mno conversation yet\x1b[0m"]),
    "",
  ];
  const text = lines.join("\n") + "\n";
  // -R renders the colors; -X leaves the conversation on screen after quitting.
  const pager = spawnSync("less", ["-R", "-X"], { input: text, stdio: ["pipe", "inherit", "inherit"] });
  if (pager.error) process.stdout.write(text);
}

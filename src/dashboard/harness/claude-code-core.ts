// The light half of the Claude Code adapter: command dialects, prompt
// delivery, transient-error shapes, transcript reading, session identity.
// Split from claude-code.ts deliberately: an adapter OBJECT retains every
// method it references, so bundling installRuntimeConfig (skills content,
// sandbox rendering, runner resolution) into the same object would drag
// ~35kb into dist/hook.js, whose per-tool-call cold start is a guarded
// invariant. The split plus package.json's "sideEffects": false keeps the
// hook bundle at its pre-adapter size; the guard test
// (test/integration/hook-bundle.real.test.ts) pins it. See the
// hook-firehose history in CLAUDE.md.
import crypto from "node:crypto";
import { readConversation, resolveTranscriptPath } from "../conversation.js";
import type { WorkerEntry } from "../registry.js";
import { shellEscape, pasteAndSubmit } from "../tmux.js";
import type { AgentCommandOptions, HarnessCore, HeadlessCommandOptions } from "./types.js";

// `claude -p` error prefix (`API Error: <5xx|429|529> ...`) or the JSON error
// types Anthropic emits (`overloaded_error`, `rate_limit_error`). The match
// is anchored to line-start and a fixed error-code set so a reviewer who
// merely discusses "API errors" in body text can't trip the detection — that
// reviewer's verdict line would also have parsed if it followed the format,
// and only unparsed verdicts reach this function.
function isTransientError(output: string): boolean {
  const lines = output.split("\n");
  const tail: string[] = [];
  for (let i = lines.length - 1; i >= 0 && tail.length < 5; i--) {
    const t = lines[i].trim();
    if (t) tail.push(t);
  }
  for (const line of tail) {
    if (/^API Error:\s*(5\d{2}|429|529)\b/.test(line)) return true;
    if (/"type"\s*:\s*"(overloaded_error|rate_limit_error|api_error)"/.test(line)) return true;
  }
  return false;
}

export const claudeCodeCore: HarnessCore = {
  name: "claude-code",
  // Tier A: the full normalized lifecycle, harness-enforced sandbox, native
  // skills, caller-assigned resumable session ids.
  capabilities: {
    turnEnd: true,
    promptSubmitted: true,
    toolActivity: true,
    askingSignal: true,
    resume: true,
    sandbox: true,
    skills: true,
  },

  // Claude Code accepts a caller-supplied session UUID (--session-id) and
  // resumes by the same id (--resume), so garden mints the identity.
  allocateSessionId(): string {
    return crypto.randomUUID();
  },

  // `--rc` surfaces the session in the Claude app's remote sessions;
  // `--append-system-prompt-file` delivers the composed garden rules.
  // Byte-parity with the pre-adapter inline commands relies on sessionId
  // staying inside shellEscape's unquoted charset (UUIDs do) — a session
  // id outside it would render quoted where the legacy path was raw.
  buildAgentCommand(opts: AgentCommandOptions): string {
    const modelFlag = opts.model ? ` --model ${shellEscape(opts.model)}` : "";
    const sessionFlag = opts.resume
      ? `--resume ${shellEscape(opts.sessionId)}`
      : `--session-id ${shellEscape(opts.sessionId)}`;
    return `${opts.envPrefix}claude --rc${modelFlag} ${sessionFlag} `
      + `--append-system-prompt-file ${shellEscape(opts.contextFile)}`;
  },

  // The one-shot print mode: prompt on stdin, final answer (and any error
  // tail isTransientError inspects) on the redirected stdout+stderr.
  buildHeadlessCommand(opts: HeadlessCommandOptions): string {
    const modelFlag = opts.model ? ` --model ${shellEscape(opts.model)}` : "";
    return `${opts.inlineEnv}${opts.envPrefix}claude -p${modelFlag}`
      + ` < ${shellEscape(opts.promptFile)} > ${shellEscape(opts.resultFile)} 2>&1`;
  },

  // tmux paste-then-Enter, with the double-Enter cold-start quirk handled
  // inside pasteAndSubmit (tmux.ts).
  deliverPrompt(paneId: string, text: string): void {
    pasteAndSubmit(paneId, text);
  },

  isTransientError,

  resolveTranscriptPath(entry: WorkerEntry): string | null {
    return resolveTranscriptPath(entry);
  },

  readTurns(transcriptPath: string | null, maxTurns?: number) {
    return maxTurns === undefined
      ? readConversation(transcriptPath)
      : readConversation(transcriptPath, maxTurns);
  },
};

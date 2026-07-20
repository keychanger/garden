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

// The non-effort half of the ultracode preset: enable Claude Code's
// dynamic-workflow keyword trigger (the standing "ultracode is on" opt-in).
// Delivered as an extra `--settings` source rather than baked into the
// generated .claude/settings.json, so garden's hook/sandbox/permissions
// generator stays worker-agnostic. Effort is set alongside via `--effort max`.
const ULTRACODE_SETTINGS_JSON = '{"ultracodeKeywordTrigger":"on"}';

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

// A session/usage-quota cutoff — the operator's rolling window is exhausted and
// the reviewer's Claude was cut off before emitting a verdict. Distinct from
// isTransientError (a seconds-scale API blip): this needs an hours-scale wait
// for the window to reset. Anchored to the line-START of the ground-truth
// message ("You've hit your session limit · resets 3:40pm (America/Denver)")
// so a verdict body that merely discusses a "session limit" cannot trip it; the
// separator after "limit" varies (·, comma), so the reset hint is extracted
// separately rather than baked into the anchor. Only the verified "you've hit
// your ... limit" phrasing is matched — the unverified "usage limit reached"
// family is deliberately left out until a real sample is captured.
const SESSION_LIMIT_LINE = /^you['’]?ve\s+hit\s+your\s+(?:session|usage)\s+limit\b/i;

function quotaLimitResetHint(output: string): string | null {
  const lines = output.split("\n");
  const tail: string[] = [];
  for (let i = lines.length - 1; i >= 0 && tail.length < 5; i--) {
    const t = lines[i].trim();
    if (t) tail.push(t);
  }
  for (const line of tail) {
    if (SESSION_LIMIT_LINE.test(line)) {
      const reset = line.match(/reset(?:s|ting)?\s+(?:at\s+)?(.+?)\s*$/i);
      return reset ? reset[1].trim() : "";
    }
  }
  return null;
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
    // Ultracode preset: max effort plus the dynamic-workflow keyword trigger.
    // `--effort max` is the session-effort flag; `ultracodeKeywordTrigger` has
    // no dedicated flag, so it rides in via `--settings <json>` (an additional
    // settings source Claude Code merges over .claude/settings.json). The
    // paired Opus pin arrives through `opts.model`, not here.
    const ultracodeFlags = opts.ultracode
      ? ` --effort max --settings ${shellEscape(ULTRACODE_SETTINGS_JSON)}`
      : "";
    // General reasoning-effort rung (low/medium/high/xhigh). Ultracode already
    // fixes `--effort max`, so it wins and effort is suppressed to avoid a
    // duplicate flag. Absent effort renders nothing — byte-identical to the
    // pre-effort launch command for every existing worker.
    const effortFlag = opts.effort && !opts.ultracode ? ` --effort ${shellEscape(opts.effort)}` : "";
    const sessionFlag = opts.resume
      ? `--resume ${shellEscape(opts.sessionId)}`
      : `--session-id ${shellEscape(opts.sessionId)}`;
    return `${opts.envPrefix}claude --rc${modelFlag}${effortFlag}${ultracodeFlags} ${sessionFlag} `
      + `--append-system-prompt-file ${shellEscape(opts.contextFile)}`;
  },

  // The one-shot print mode: prompt on stdin, final answer (and any error
  // tail isTransientError inspects) on the redirected stdout+stderr.
  buildHeadlessCommand(opts: HeadlessCommandOptions): string {
    const modelFlag = opts.model ? ` --model ${shellEscape(opts.model)}` : "";
    // `--effort` is a top-level claude flag, so it composes with `-p` exactly
    // as it does with the interactive launch (verified against 2.1.215).
    const effortFlag = opts.effort ? ` --effort ${shellEscape(opts.effort)}` : "";
    return `${opts.inlineEnv}${opts.envPrefix}claude -p${modelFlag}${effortFlag}`
      + ` < ${shellEscape(opts.promptFile)} > ${shellEscape(opts.resultFile)} 2>&1`;
  },

  // tmux paste-then-Enter, with the double-Enter cold-start quirk handled
  // inside pasteAndSubmit (tmux.ts).
  deliverPrompt(paneId: string, text: string): void {
    pasteAndSubmit(paneId, text);
  },

  isTransientError,
  quotaLimitResetHint,

  resolveTranscriptPath(entry: WorkerEntry): string | null {
    return resolveTranscriptPath(entry);
  },

  readTurns(transcriptPath: string | null, maxTurns?: number) {
    return maxTurns === undefined
      ? readConversation(transcriptPath)
      : readConversation(transcriptPath, maxTurns);
  },
};

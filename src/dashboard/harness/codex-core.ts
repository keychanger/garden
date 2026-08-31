// The light half of the Codex adapter (HarnessCore): command dialects,
// transient-error shapes, transcript reading, session identity. Split from
// codex.ts (the heavy installRuntimeConfig) exactly like claude-code-core.ts
// vs claude-code.ts, so the hook bundle stays lean — this module carries no
// skills/sandbox/config-rendering content.
//
// Every Codex fact here was live-verified against codex 0.142.5 (2026-07-01);
// see docs/MULTI-MODEL.md "Phase 4". The reviewer-critical method is
// buildHeadlessCommand: `codex exec` performs full agentic review and prints
// its final message (ending in the garden verdict token) to STDOUT, with the
// progress/token trailer on STDERR — so the result file captures stdout only
// (stderr to a sidecar), not `2>&1` which would make the token count the last
// line and break parseLastLineVerdict. The interactive worker-role methods
// (buildAgentCommand, deliverPrompt, readTurns, resolveTranscriptPath) are
// implemented soundly here but are exercised and refined in the worker-path
// slices (this adapter is registered but selectable by nothing in Slice A).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveBeadsDir } from "../../config.js";
import { promptTurn, readTurnsFromTail, summarizeTurn } from "../conversation.js";
import type { ToolUse, Turn } from "../conversation.js";
import type { WorkerEntry } from "../registry.js";
import { shellEscape, pasteAndSubmit } from "../tmux.js";
import { resolveHookRunner } from "../runner.js";
import type { AgentCommandOptions, HarnessCore, HeadlessCommandOptions } from "./types.js";

export const CODEX_AWAITING_TASK = "awaiting task";

// Codex's TUI input glyph (U+203A), the counterpart to Claude Code's `❯`.
// NOT sufficient on its own to mean "composer": Codex reuses it as the
// selection cursor in its startup dialogs, where the row reads
// `› 1. Yes, continue` (the directory-trust prompt — observed 2026-08-25
// booting a real Codex against an untrusted cwd). So the ready probe pairs it
// with the placeholder Codex paints into an EMPTY composer, which is what a
// pre-seed worker's box always holds.
//
// Pairing them is deliberately precise rather than permissive, because the two
// failure directions are not symmetric. A false negative costs the 180s
// agentStatus backstop — exactly the behavior that predates this probe. A false
// positive pastes the briefing into a menu, where Enter picks a menu item and
// the seed is lost to a retry. A future Codex whose placeholder text differs
// therefore degrades to the backstop, never to a misdirected paste.
const CODEX_PROMPT_MARKER = "\u203a";
const CODEX_COMPOSER_PLACEHOLDER = "Ask Codex to do anything";

// Garden's lifecycle hooks for a Codex WORKER, injected into the launch command
// as `-c` config overrides rather than a .codex/hooks.json file. Verified
// 2026-07-06 (codex 0.142.5): a linked git worktree does NOT load hooks from a
// worktree-local .codex/hooks.json — Codex resolves project hooks at the REPO
// ROOT (the main checkout), so a file written into the worktree never fires.
// A `-c`-injected hooks table DOES fire per turn, and injection sidesteps the
// whole repo-root-file problem (never clobbers a repo's own hooks, never mutates
// the operator's main checkout, travels with the launch like the sandbox flags).
// Wire-event mapping matches garden's dispatcher: Codex's PreToolUse fires for
// every tool -> posttooluse (a working heartbeat); PermissionRequest is the real
// blocked-on-operator -> pretooluse (asking). Requires
// --dangerously-bypass-hook-trust on the launch (garden's hooks are untrusted).
const CODEX_HOOK_EVENTS: ReadonlyArray<readonly [string, string]> = [
  ["SessionStart", "sessionstart"],
  ["UserPromptSubmit", "prompt"],
  ["Stop", "stop"],
  ["PostToolUse", "posttooluse"],
  ["PreToolUse", "posttooluse"],
  ["PermissionRequest", "pretooluse"],
];

// The `-c` flags injecting garden's hook relay. hookRunner is the shell-ready
// runner command (node + dist/hook.js); Codex shell-splits the hook `command`
// string, so `<runner> <wire>` runs `dist/hook.js <wire>` exactly like the
// claude settings.json path. Each dynamic value is shell-escaped for the
// launch command line.
function codexHookFlags(hookRunner: string): string {
  return CODEX_HOOK_EVENTS.map(([event, wire]) => {
    const toml = `hooks.${event}=[{ hooks = [{ type = "command", command = "${hookRunner} ${wire}", timeout = 5 }] }]`;
    return `-c ${shellEscape(toml)}`;
  }).join(" ");
}

// $CODEX_HOME is Codex's CLAUDE_CONFIG_DIR analog (relocates sessions/, auth,
// config). Defaults to ~/.codex. Exported for codex-models.ts, which reads the
// model catalog Codex caches in the same directory.
export function codexHome(): string {
  return process.env.CODEX_HOME || path.join(process.env.HOME || os.homedir(), ".codex");
}

// The stderr sidecar for a headless result file. `codex exec` streams
// progress + the token-count trailer to stderr; keeping it out of the result
// file leaves a pristine last line for parseLastLineVerdict. isTransientError
// (once wired by the poller) inspects this sidecar rather than the verdict.
export function codexStderrSidecar(resultFile: string): string {
  return `${resultFile}.stderr`;
}

// Sandbox flags for an autonomous Codex worker launch. Codex enforces its own
// `workspace-write` sandbox: cwd and /tmp are writable by default, network is
// off by default, and approvals are disabled (`-a never`) so the worker never
// blocks on a prompt. Garden layers on:
//   - network_access=true — a worker must `git push` to origin. Verified
//     against codex 0.142.5: macOS Seatbelt honors this (the older
//     openai/codex#10390 silent-ignore bug is fixed). Codex network is
//     boolean — no per-domain allowlist — so garden's Claude-side domain
//     allowlist (sandbox.ts) maps to "on"; filesystem confinement to the
//     worktree is what the sandbox actually enforces for a Codex worker.
//   - writable_roots — garden's shared extra roots beyond cwd + /tmp. Mirrors
//     the HOME-based entries of sandbox.ts DEFAULT_ALLOW_WRITE (npm/cache/
//     registry writes during checks), the resolved beads store for an intake
//     project, plus the worktree's shared git common dir (worktreeGitDir). A
//     garden worker runs in a *linked* worktree whose real git dir is the main
//     checkout's `.git` — outside cwd — so without that root a Codex worker
//     could not commit or push (claude-code's sandbox auto-grants the git dir;
//     Codex workspace-write does not). The HOME roots are constant across
//     workers; the bead and git roots are per-project.
// Every dynamic value is shell-escaped: the result is spliced into the launch
// command string.
function codexSandboxFlags(
  project: AgentCommandOptions["launchPlan"]["runtimeProject"],
  worktreeGitDir?: string,
): string {
  const home = process.env.HOME || os.homedir();
  const writableRoots = [
    path.join(home, ".npm"),
    path.join(home, ".cache"),
    path.join(home, ".garden", "sessions"),
  ];
  if (project.beadIntake) writableRoots.push(resolveBeadsDir(project));
  if (worktreeGitDir) writableRoots.push(worktreeGitDir);
  const rootsToml = `sandbox_workspace_write.writable_roots=[${writableRoots.map(r => JSON.stringify(r)).join(", ")}]`;
  return "-s workspace-write -a never"
    + ` -c ${shellEscape("sandbox_workspace_write.network_access=true")}`
    + ` -c ${shellEscape(rootsToml)}`;
}

// Codex/OpenAI transient backend errors (rate limit / 5xx / overload /
// stream drop) worth a retry, vs. a genuine review failure. Scanned over the
// last few non-empty lines of the STDERR sidecar (where codex exec emits
// errors), anchored to error-shaped phrasing so a reviewer merely discussing
// "rate limits" in a verdict body can't trip it. Provisional pending a
// captured real Codex error sample (the Slice-3 live TODO in the plan) — the
// shapes below are the documented OpenAI/Codex error strings.
function isTransientError(output: string): boolean {
  const lines = output.split("\n");
  const tail: string[] = [];
  for (let i = lines.length - 1; i >= 0 && tail.length < 5; i--) {
    const t = lines[i].trim();
    if (t) tail.push(t);
  }
  for (const line of tail) {
    if (/^(ERROR|error):.*\b(429|5\d{2})\b/.test(line)) return true;
    if (/^(ERROR|error):.*(rate.?limit|overloaded|server error|temporarily unavailable|stream (error|disconnected))/i.test(line)) return true;
    if (/"type"\s*:\s*"(rate_limit_error|server_error|overloaded_error|api_error)"/.test(line)) return true;
  }
  return false;
}

// A session/usage-quota cutoff for Codex — the ChatGPT-subscription rolling
// window or an API-key hard billing quota (insufficient_quota). Contract as
// claudeCodeCore.quotaLimitResetHint: null = not quota; non-null string = quota
// hit, string is the reset hint. The caller runs this BEFORE isTransientError,
// so a "429 ... insufficient_quota" is treated as a quota wait rather than the
// seconds-scale transient retry its bare 429 would otherwise trip.
//
// The subscription usage-limit line is VALIDATED against a real capture (codex
// exec 0.144.5, 2026-07-16 — a ChatGPT-subscription account out of quota, with
// stdout empty and this on stderr):
//   ERROR: You've hit your usage limit. Upgrade to Plus to continue using Codex
//   (https://chatgpt.com/explore/plus), or try again at Jul 31st, 2026 11:43 AM.
// Codex phrases the reset as "try again at <date>" / "try again in <duration>"
// (NOT "resets …" as claude-code does), so the extraction tries both. The
// insufficient_quota JSON shape (API-key hard billing) is still inferred from the
// documented OpenAI error, not a capture. All patterns are error-shaped and
// line-start / structured so a verdict body discussing a "usage limit" can't trip.
function quotaLimitResetHint(output: string): string | null {
  const lines = output.split("\n");
  const tail: string[] = [];
  for (let i = lines.length - 1; i >= 0 && tail.length < 5; i--) {
    const t = lines[i].trim();
    if (t) tail.push(t);
  }
  for (const line of tail) {
    if (/"(?:type|code)"\s*:\s*"insufficient_quota"/.test(line)) return "";
    if (/^(?:ERROR|error):?.*\b(?:usage|quota)\s+limit\b/i.test(line)) {
      // Codex names the reset as "try again at <date>" / "try again in <dur>";
      // also accept a "reset(s) at/in <x>" phrasing defensively. A trailing "."
      // (Codex ends the sentence with one) is stripped from the hint.
      const reset =
        line.match(/reset(?:s|ting)?\s+(?:at\s+|in\s+)?(.+?)[.\s]*$/i)
        ?? line.match(/try\s+again\s+(?:at|in)\s+(.+?)[.\s]*$/i);
      return reset ? reset[1].trim() : "";
    }
  }
  return null;
}

export const codexCore: HarnessCore = {
  name: "codex",
  // Tier A intent: Codex's hook surface covers the full lifecycle
  // (SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/PermissionRequest/
  // Stop). toolActivity is declared true though Codex's PreToolUse/PostToolUse
  // coverage is partial (not all shell calls) — the worker-path slices tune
  // stale-detection for that. sandbox: Codex enforces its own (--sandbox
  // modes). skills: false — garden folds its bundled skill content into the
  // AGENTS.md rules for Codex rather than installing native skill files.
  capabilities: {
    turnEnd: true,
    promptSubmitted: true,
    toolActivity: true,
    askingSignal: true,
    resume: true,
    sandbox: true,
    skills: false,
    providerProfiles: false,
    workerWorkflows: ["default"],
    headlessRoles: ["reviewer", "resolver", "ciFix"],
  },

  // Codex assigns its OWN session id (thread_id) at launch — garden cannot
  // mint or pass one. The empty sentinel signals "recover post-launch" to the
  // worker-path lifecycle (from the hook payload's transcript_path / the
  // rollout filename). capabilities.resume stays true: resume is by the
  // recovered thread_id, not a garden-minted UUID.
  allocateSessionId(): string {
    return "";
  },

  // Interactive worker launch (worker-path; refined + live-verified there).
  // No --session-id (Codex assigns its own id) and no system-prompt flag —
  // garden's rules reach Codex via AGENTS.md (installRuntimeConfig). The
  // event relay REQUIRES --dangerously-bypass-hook-trust: garden's
  // programmatically-injected hook config is untrusted, so without the bypass
  // Codex silently skips every hook and no turn-end/status reaches the
  // poller (verified 2026-07-06: Stop fires per turn interactively with the
  // bypass). Resume is the `codex resume <session-id>` subcommand.
  //
  // Sandbox: an autonomous worker runs under Codex's own `workspace-write`
  // sandbox (see codexSandboxFlags) — NOT the headless reviewer's
  // --dangerously-bypass-approvals-and-sandbox, which is safe only because the
  // reviewer is short-lived and garden owns its trust boundary. A looping
  // worker running unbounded model-generated commands must stay confined.
  buildAgentCommand(opts: AgentCommandOptions): string {
    const plan = opts.launchPlan;
    // plan.ultracode is a claude-code preset with no Codex analog and stays a
    // no-op. plan.effort DOES map: Codex's reasoning rung is the
    // `model_reasoning_effort` config key, so it rides the same `-c` override
    // channel as the hooks and sandbox rather than a flag. The rung vocabulary
    // is per-model and comes from Codex's own catalog (CODEX_EFFORT_LEVELS,
    // codex-models.ts) — it is NOT WORKER_EFFORT_LEVELS, so no value mapping
    // happens here; the composer offers the Codex rungs directly and this
    // passes the operator's choice through verbatim.
    const modelFlag = plan.model ? ` -m ${shellEscape(plan.model)}` : "";
    const effortFlag = plan.effort
      ? ` -c ${shellEscape(`model_reasoning_effort=${plan.effort}`)}`
      : "";
    const trust = "--dangerously-bypass-hook-trust";
    const sandbox = codexSandboxFlags(plan.runtimeProject, opts.worktreeGitDir);
    const hooks = codexHookFlags(resolveHookRunner());
    return opts.resume
      ? `${plan.envPrefix}codex resume ${shellEscape(opts.sessionId)} ${trust} ${sandbox} ${hooks}${modelFlag}${effortFlag}`
      : `${plan.envPrefix}codex ${trust} ${sandbox} ${hooks}${modelFlag}${effortFlag}`;
  },

  // Headless one-shot (reviewer/resolver/ci-fix) — the spike-verified path.
  // `codex exec` reads the prompt on stdin and prints its final agent message
  // to stdout; stdout -> result (pristine verdict last line), stderr ->
  // sidecar (progress + token trailer + any transient error). NO
  // --dangerously-bypass-hook-trust here: a headless reviewer WANTS Codex to
  // skip the worktree's (untrusted) hooks so it fires no event relay of its
  // own. --dangerously-bypass-approvals-and-sandbox lets the reviewer edit,
  // commit, and push under garden's trust boundary (garden owns the sandbox).
  buildHeadlessCommand(opts: HeadlessCommandOptions): string {
    const plan = opts.launchPlan;
    const modelFlag = plan.model ? ` -m ${shellEscape(plan.model)}` : "";
    const effortFlag = plan.effort
      ? ` -c ${shellEscape(`model_reasoning_effort=${plan.effort}`)}`
      : "";
    const err = shellEscape(codexStderrSidecar(opts.resultFile));
    return `${opts.inlineEnv}${plan.envPrefix}codex exec --dangerously-bypass-approvals-and-sandbox${modelFlag}${effortFlag}`
      + ` < ${shellEscape(opts.promptFile)} > ${shellEscape(opts.resultFile)} 2> ${err}`;
  },

  // Worker-path: the same tmux paste mechanism as claude-code; the Ratatui
  // double-Enter timing is verified against Codex's TUI in the worker slice.
  deliverPrompt(paneId: string, text: string): void {
    pasteAndSubmit(paneId, text);
  },

  isTransientError,
  quotaLimitResetHint,

  // Prefer the hook-captured path (Codex's hook payload carries
  // transcript_path); else locate the rollout file by thread_id under
  // $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<thread_id>.jsonl.
  resolveTranscriptPath(entry: WorkerEntry): string | null {
    const captured = entry.transcriptPath;
    if (captured && isReadable(captured)) return captured;
    if (entry.sessionId) {
      const found = findRolloutByThreadId(path.join(codexHome(), "sessions"), entry.sessionId);
      if (found) return found;
    }
    return null;
  },

  // Parse Codex's rollout JSONL into the neutral Turn[] model (worker-path
  // history view). Line envelope {type, timestamp, payload}; the operator's
  // prompts, assistant text, and applied edits use event_msg/user_message,
  // /agent_message and /patch_apply_end through Codex 0.146, then
  // event_msg/item_completed with UserMessage, AgentMessage and FileChange
  // items in 0.147 (the FileChange item carries the same `changes` map the
  // patch_apply_end event did). Tool activity remains response_item/
  // function_call and /custom_tool_call in both.
  //
  // Structure mirrors readConversation (conversation.ts) exactly, because the
  // history view is a SUMMARY, not a transcript dump. Two things follow from
  // that and both are load-bearing:
  //   - One assistant entry per exchange. Codex emits an agent_message per
  //     progress narration (phase "commentary") as well as the final answer —
  //     a real worker showed 38 of them across 8 prompts — so activity is
  //     accumulated between operator prompts and flushed as ONE turn.
  //   - That turn is summarized by what it DID (summarizeTurn), not by the
  //     model's prose. Codex's tool vocabulary is mapped onto the neutral names
  //     that summarizer reasons about (see codexToolUses), so a Codex turn
  //     reads in the same words as a Claude one ("edited calc.py · ran tests").
  readTurns(transcriptPath: string | null, maxTurns = DEFAULT_MAX_TURNS): Turn[] {
    if (!transcriptPath || !isReadable(transcriptPath)) return [];
    return readTurnsFromTail(transcriptPath, parseCodexTurns).slice(-maxTurns);
  },

  // The status pane's "what is this worker doing" summary. Codex has a
  // terminal-title feature ([tui].terminal_title, default ["activity",
  // "project-name"]) but NONE of its items is the rolling summary Claude Code
  // writes: verified against codex 0.144.6 (2026-07-27), `activity` is a bare
  // spinner glyph, `project-name` falls back to the cwd basename (for a garden
  // worktree that IS the worker name — the symptom this method exists to fix),
  // `task-progress` renders a counter ("Tasks 3/5"), and `thread-title` renders
  // the thread UUID live even once the title is extracted on disk. So the
  // summary is derived here instead.
  //
  // Source of truth is Codex's own plan: the newest update_plan call names the
  // step it is on, which is the closest analog to Claude's title (a short
  // model-written phrase describing current work). Before any plan exists,
  // fall back ONCE to the opening prompt — that is what Codex itself extracts
  // as the thread title, and it keeps a fresh worker's row from reading blank.
  // Codex fires SessionStart at the first TURN, not at boot (verified
  // 2026-08-25 on lean-stout-quartz: launch 18:28:32, SessionStart 18:31:39,
  // 0.6s AFTER the seed paste that caused it). So a Codex worker sits at
  // agentStatus "loading" until something prompts it, and the seed path — which
  // waits for "loading" to clear before prompting — deadlocked until its 180s
  // backstop fired. Every handoff into a Codex worker paid a flat three-minute
  // dead pane before the briefing appeared.
  //
  // The composer is the boot signal instead: Codex paints `› Ask Codex to do
  // anything` once its TUI is accepting input (measured ~1s from launch), and
  // nothing before it does. Matching the glyph ALONE is not enough — see
  // CODEX_PROMPT_MARKER for the startup dialog that reuses it.
  // The rollout file is NOT usable here — it is born at the first turn and its
  // session_meta timestamp is back-stamped to session start, so its existence
  // says the same thing SessionStart does, only later.
  promptReady(paneText: string): boolean {
    return paneText.split("\n").some((line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith(CODEX_PROMPT_MARKER)) return false;
      return trimmed.slice(CODEX_PROMPT_MARKER.length).trim() === CODEX_COMPOSER_PLACEHOLDER;
    });
  },

  readActivity(entry: WorkerEntry): string | null {
    const transcript = codexCore.resolveTranscriptPath(entry);
    if (!transcript || !isReadable(transcript)) return null;
    let tail: string;
    try {
      tail = readTail(transcript, ACTIVITY_TAIL_BYTES);
    } catch {
      return null;
    }
    const step = latestPlanStep(tail);
    if (step) return step;
    // A task equal to the worker name is the pre-fix symptom, not a summary —
    // Codex's default title is `project-name`, which falls back to the worktree
    // basename. Treat it as unset so an existing worker heals without a bounce.
    const unset = !entry.task || entry.task === entry.name || entry.task === CODEX_AWAITING_TASK;
    return unset ? firstPromptLine(transcript) : null;
  },
};

// The parse half of readTurns, run once per tail window by readTurnsFromTail.
function parseCodexTurns(lines: Iterable<string>): Turn[] {
  const turns: Turn[] = [];
  let pending: { tools: ToolUse[]; firstText: string; ts: string } | null = null;
  let seenUser = false;

  const flush = (): void => {
    if (pending && (pending.tools.length > 0 || pending.firstText)) {
      const { text, verb } = summarizeTurn(pending.tools, pending.firstText);
      turns.push({ role: "assistant", text, verb, ts: pending.ts });
    }
    pending = null;
  };

  for (const line of lines) {
    if (!line.trim()) continue;
    let rec: CodexLine;
    try {
      rec = JSON.parse(line) as CodexLine;
    } catch {
      continue;
    }
    const p = rec.payload;
    if (!p || typeof p !== "object") continue;
    const ts = rec.timestamp ?? "";

    const userMessage = codexUserMessage(rec);
    if (userMessage) {
      const turn = promptTurn(userMessage.text, ts, userMessage.image);
      if (!turn) continue;
      flush();
      turns.push(turn);
      pending = { tools: [], firstText: "", ts };
      seenUser = true;
      continue;
    }
    // Drop dangling activity from a head the byte cap clipped, matching
    // readConversation: an assistant turn with no prompt above it is noise.
    if (!seenUser) continue;
    if (!pending) pending = { tools: [], firstText: "", ts };

    if (rec.type === "response_item" && (p.type === "function_call" || p.type === "custom_tool_call")) {
      pending.tools.push(...codexToolUses(p));
      continue;
    }
    if (rec.type === "event_msg" && p.type === "web_search_end") {
      pending.tools.push({ name: "WebSearch", input: {} });
      continue;
    }
    const changed = codexAppliedChanges(rec);
    if (changed) {
      pending.tools.push(...editToolUses(changed));
      continue;
    }
    const agentMessage = codexAgentMessage(rec);
    if (agentMessage) {
      if (!pending.firstText) pending.firstText = agentMessage;
      if (ts) pending.ts = ts;
    }
  }
  flush();
  return turns;
}

// --- transcript helpers (light; no heavy deps) ---

const DEFAULT_MAX_TURNS = 12;

interface CodexLine {
  type?: string;
  timestamp?: string;
  payload?: CodexPayload;
}

interface CodexPayload {
  type?: string;
  role?: unknown;
  content?: unknown;
  message?: unknown;
  text_elements?: unknown;
  images?: unknown[];
  local_images?: unknown[];
  name?: unknown;
  call_id?: unknown;
  arguments?: unknown;
  input?: unknown;
  changes?: unknown;
  item?: unknown;
}

export interface CodexInputRequestState {
  waiting: boolean;
  changedAt: number;
}

const INPUT_REQUEST_TAIL_BYTES = 512 * 1024;

export function readCodexInputRequestState(transcriptPath: string): CodexInputRequestState | null {
  if (!isReadable(transcriptPath)) return null;
  let tail: string;
  try {
    tail = readTail(transcriptPath, INPUT_REQUEST_TAIL_BYTES);
  } catch {
    return null;
  }

  let latestCallId = "";
  let waiting = false;
  let latestChangedAt = 0;
  for (const line of tail.split("\n")) {
    if (!line.trim()) continue;
    let rec: CodexLine;
    try {
      rec = JSON.parse(line) as CodexLine;
    } catch {
      continue;
    }
    if (rec.type !== "response_item" || !rec.payload) continue;
    const callId = typeof rec.payload.call_id === "string" ? rec.payload.call_id : "";
    const changedAt = Date.parse(rec.timestamp ?? "") || 0;
    if (rec.payload.type === "function_call"
        && rec.payload.name === "request_user_input" && callId) {
      latestCallId = callId;
      waiting = true;
      latestChangedAt = changedAt;
    } else if (rec.payload.type === "function_call_output"
        && latestCallId === callId) {
      waiting = false;
      latestChangedAt = changedAt;
    }
  }
  return latestCallId ? { waiting, changedAt: latestChangedAt } : null;
}

export interface CodexTurnState {
  complete: boolean;
  changedAt: number;
}

// Whether the rollout's newest activity is a finished turn. This is the
// authoritative turn-end signal for a Codex worker, and it exists because
// Codex's `Stop` hook is NOT reliably the last event of a turn the way Claude
// Code's is: Codex emits `task_complete` several times per operator turn (21
// times in the rollout that motivated this) and fires `Stop` on only some of
// them, while `PostToolUse` keeps firing for tool calls that land AFTER a
// Stop. Observed 2026-08-09 on codex 0.147: a worker fired Stop (garden wrote
// `idle`), then called `send_message` 37s later (garden wrote `working` off
// PostToolUse), then reached its real `task_complete` 3.7s after that with no
// second Stop — leaving `agentStatus: "working"` with nothing to clear it and
// stalling the merge gate for 30 hours. Reading Codex's own record is the only
// signal that survives a missed hook.
//
// `response_item` is the activity marker (every tool call, reasoning block and
// assistant message is one) and `task_complete` the terminator, so the turn is
// over exactly when no response_item follows the newest task_complete. The
// trailing `token_count` event_msg that Codex writes alongside task_complete is
// not activity and is correctly ignored.
export function readCodexTurnState(transcriptPath: string): CodexTurnState | null {
  if (!isReadable(transcriptPath)) return null;
  let tail: string;
  try {
    tail = readTail(transcriptPath, INPUT_REQUEST_TAIL_BYTES);
  } catch {
    return null;
  }

  let complete: boolean | null = null;
  let changedAt = 0;
  for (const line of tail.split("\n")) {
    if (!line.trim()) continue;
    let rec: CodexLine;
    try {
      rec = JSON.parse(line) as CodexLine;
    } catch {
      continue;
    }
    if (rec.type === "response_item") {
      complete = false;
    } else if (rec.type === "event_msg" && rec.payload?.type === "task_complete") {
      complete = true;
      changedAt = Date.parse(rec.timestamp ?? "") || 0;
    }
  }
  if (complete === null || (complete && changedAt === 0)) return null;
  return { complete, changedAt };
}

interface CodexCompletedItem {
  type?: unknown;
  content?: unknown;
  changes?: unknown;
}

function codexUserMessage(rec: CodexLine): { text: string; image: boolean } | null {
  const p = rec.payload;
  if (!p || rec.type !== "event_msg") return null;
  if (p.type === "user_message") {
    return {
      text: typeof p.message === "string" ? p.message : joinTextElements(p.text_elements),
      image: Boolean((p.images?.length ?? 0) || (p.local_images?.length ?? 0)),
    };
  }
  const item = completedItem(p, "UserMessage");
  if (!item) return null;
  return {
    text: completedItemText(item),
    image: completedItemHasImage(item),
  };
}

function codexAgentMessage(rec: CodexLine): string | null {
  const p = rec.payload;
  if (!p || rec.type !== "event_msg") return null;
  if (p.type === "agent_message") return typeof p.message === "string" ? p.message : null;
  const item = completedItem(p, "AgentMessage");
  return item ? completedItemText(item) : null;
}

// The paths an applied edit touched, or null when this record is not one.
// Empty-but-present is meaningful and distinct from null: an edit whose paths
// could not be read still has to register as an edit (editToolUses renders
// that as the generic "edited files").
function codexAppliedChanges(rec: CodexLine): string[] | null {
  const p = rec.payload;
  if (!p || rec.type !== "event_msg") return null;
  if (p.type === "patch_apply_end") return changedPaths(p.changes);
  const item = completedItem(p, "FileChange");
  return item ? changedPaths(item.changes) : null;
}

function completedItem(p: CodexPayload, type: string): CodexCompletedItem | null {
  if (p.type !== "item_completed" || !p.item || typeof p.item !== "object") return null;
  const item = p.item as CodexCompletedItem;
  return item.type === type ? item : null;
}

function completedItemText(item: CodexCompletedItem): string {
  if (!Array.isArray(item.content)) return "";
  return item.content
    .map((block) => block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
      ? (block as { text: string }).text : "")
    .join("");
}

function completedItemHasImage(item: CodexCompletedItem): boolean {
  if (!Array.isArray(item.content)) return false;
  return item.content.some((block) => {
    if (!block || typeof block !== "object") return false;
    const type = (block as { type?: unknown }).type;
    return type === "local_image" || type === "image" || type === "input_image";
  });
}

// --- tool mapping: Codex's vocabulary -> the neutral names summarizeTurn reads ---

// Codex tool names that mutate the worktree. apply_patch is Codex's edit
// primitive (a custom_tool_call, not a function_call); Edit/Write/MultiEdit are
// the documented aliases. They map to "Write" so summarizeTurn counts them as
// edits — the name it checks, not the one Codex used.
const EDIT_TOOLS = new Set(["apply_patch", "Edit", "Write", "MultiEdit"]);

// Codex's shell primitives. `exec_command` is the function_call form (arguments
// are a JSON string carrying `cmd`); `exec` is the custom_tool_call form, whose
// `input` is a JS snippet wrapping a tools.exec_command({cmd:"…"}) call.
const SHELL_TOOLS = new Set(["exec_command", "exec", "shell", "local_shell"]);

function editToolUses(files: string[]): ToolUse[] {
  // An edit with no parseable path still has to register as an edit;
  // summarizeTurn renders that as the generic "edited files".
  if (files.length === 0) return [{ name: "Write", input: {} }];
  return files.map(f => ({ name: "Write", input: { file_path: f } }));
}

function codexToolUses(p: CodexPayload): ToolUse[] {
  const name = typeof p.name === "string" ? p.name : "";
  if (EDIT_TOOLS.has(name)) {
    return editToolUses(patchedPaths(typeof p.input === "string" ? p.input : ""));
  }
  if (SHELL_TOOLS.has(name)) return shellToolUses(shellCommandOf(p));
  // Codex's subagent primitive; its siblings (wait_agent, list_agents,
  // send_message) are plumbing and stay neutral tool activity.
  if (name === "spawn_agent") return [{ name: "Task", input: {} }];
  if (name === "web_search") return [{ name: "WebSearch", input: {} }];
  // Anything else — update_plan, wait, followup_task — is neutral: it marks the
  // turn as having used tools ("planned") without naming an action, exactly as
  // an unrecognized Claude tool does.
  return [{ name: name || "tool", input: {} }];
}

// The shell command a tool call ran, or "" when it can't be recovered.
function shellCommandOf(p: CodexPayload): string {
  if (typeof p.input === "string") {
    // `exec` wraps exec_command in a JS snippet. Recover its double-quoted cmd
    // so utilities at the start of the command still match the anchored
    // Read/Grep patterns below.
    const match = p.input.match(/\bcmd\s*:\s*"((?:\\.|[^"\\])*)"/);
    if (match) {
      try {
        return JSON.parse(`"${match[1]}"`) as string;
      } catch {
        return p.input;
      }
    }
    return p.input;
  }
  if (typeof p.arguments !== "string") return "";
  try {
    const a = JSON.parse(p.arguments) as { cmd?: unknown; command?: unknown };
    if (typeof a.cmd === "string") return a.cmd;
    if (typeof a.command === "string") return a.command;
    if (Array.isArray(a.command)) return a.command.filter(x => typeof x === "string").join(" ");
  } catch {
    return "";
  }
  return "";
}

// Codex reads and searches through the SHELL, where Claude has dedicated Read
// and Grep tools — so those neutral tools are derived from the command text.
// Without this every exploration turn collapses to "ran commands", which is the
// difference between a history that says what the worker looked at and one that
// doesn't. The Bash tool use is always emitted: it carries the command to
// summarizeTurn's commit/push/test/build detection.
const SEARCH_UTIL = /(?:^|[|;&(]\s*)(?:sudo\s+)?(?:rg|grep|egrep|fgrep|ag|find|fd)\s/;
const READ_SEGMENT = /(?:^|[|;&(]\s*)(?:sudo\s+)?(?:cat|bat|nl|head|tail|less|more|sed)\s([^|;&()]*)/g;
const PATH_TOKEN = /[\w@.\-/]+\.[A-Za-z0-9_]{1,8}\b/g;

function shellToolUses(cmd: string): ToolUse[] {
  const uses: ToolUse[] = [{ name: "Bash", input: { command: cmd } }];
  if (!cmd) return uses;
  if (SEARCH_UTIL.test(cmd)) uses.push({ name: "Grep", input: {} });
  for (const seg of cmd.matchAll(READ_SEGMENT)) {
    for (const p of seg[1].matchAll(PATH_TOKEN)) {
      uses.push({ name: "Read", input: { file_path: p[0] } });
    }
  }
  return uses;
}

// Paths an applied patch touched, from the patch_apply_end event's `changes`
// map (path -> {type, content}).
function changedPaths(changes: unknown): string[] {
  if (!changes || typeof changes !== "object") return [];
  return Object.keys(changes as Record<string, unknown>);
}

// Paths named by an apply_patch call's body, whose format is a run of
// `*** Add|Update|Delete File: <path>` headers.
const PATCH_HEADER = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;

function patchedPaths(input: string): string[] {
  return [...input.matchAll(PATCH_HEADER)].map(m => m[1].trim()).filter(Boolean);
}

function joinTextElements(els: unknown): string {
  if (!Array.isArray(els)) return "";
  return els
    .map((e) => (typeof e === "string" ? e : e && typeof e === "object" && typeof (e as { text?: unknown }).text === "string" ? (e as { text: string }).text : ""))
    .join("");
}

export function initialCodexActivity(seed?: string): string {
  if (!seed) return CODEX_AWAITING_TASK;
  const lines = seed.split("\n").map(line => line.trim()).filter(Boolean);
  let line = lines[0] ?? "";
  if (/^\[handoff(?:\s|\])/i.test(line)) line = lines[1] ?? "";
  line = line.replace(/^\[garden\]\s*/i, "");
  return condense(line) || CODEX_AWAITING_TASK;
}

// Bounds for readActivity's reads. A plan record is ~1KB, so the tail holds
// many of them. The head has to clear the rollout's preamble before the
// opening prompt, which is NOT small: Codex records the composed instructions
// (garden's rules ride the worktree AGENTS.md) up front, measured at 70-90KB
// for real garden workers — so the head bound has a wide margin over that, and
// the read stops once the opening prompt replaces the creation placeholder.
// Both stay well under readTurns' escalating tail: readActivity runs on
// the status render and hook paths, readTurns only when the history view is open.
const ACTIVITY_TAIL_BYTES = 256 * 1024;
const ACTIVITY_HEAD_BYTES = 512 * 1024;
const ACTIVITY_MAX_CHARS = 120;

// The step the newest update_plan call is on: the first in-progress entry, or
// the last completed one when the plan has finished. Scans backwards and stops
// at the first plan found, so cost is a few lines in the common case. The
// tail's leading line may be clipped mid-record; unparseable lines are skipped,
// which covers it.
function latestPlanStep(tail: string): string | null {
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line || !line.includes("update_plan")) continue;
    let rec: CodexLine;
    try {
      rec = JSON.parse(line) as CodexLine;
    } catch {
      continue;
    }
    const p = rec.payload;
    if (!p || (p.type !== "function_call" && p.type !== "custom_tool_call")) continue;
    const steps = planSteps(p);
    const current = steps.find(s => s.status === "in_progress")
      ?? [...steps].reverse().find(s => s.status === "completed");
    if (current) return condense(current.step);
  }
  return null;
}

interface PlanStep {
  step: string;
  status?: string;
}

// The plan carried by an update_plan call, in either shape Codex emits it.
// Direct call (`name: "update_plan"`, arguments a JSON *string*) is the older
// tool protocol; codex 0.146.0 running a gpt-5-codex model instead routes it
// through the generic `exec` tool, whose `input` is JS SOURCE
// (`await tools.update_plan({plan:[{step:"…",status:"…"}]})`). Reading only the
// direct shape left the summary frozen at the opening prompt for every current
// Codex worker — verified against three live rollouts, 2026-08-05.
function planSteps(p: CodexPayload): PlanStep[] {
  if (p.name === "update_plan") {
    let plan: unknown;
    try {
      plan = (JSON.parse(typeof p.arguments === "string" ? p.arguments : "{}") as { plan?: unknown }).plan;
    } catch {
      return [];
    }
    if (!Array.isArray(plan)) return [];
    return plan.filter((s): s is PlanStep =>
      Boolean(s) && typeof s === "object" && typeof (s as { step?: unknown }).step === "string");
  }
  if (typeof p.input === "string" && p.input.includes("update_plan")) return stepsFromSource(p.input);
  return [];
}

// The exec shape's object literal has unquoted keys, so it is not JSON and
// cannot be re-parsed. Scan the source for step/status pairs instead of
// evaluating model-authored code.
const PLAN_STEP_RE = /["']?step["']?\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*["']?status["']?\s*:\s*"([a-z_]+)"/g;

function stepsFromSource(src: string): PlanStep[] {
  const steps: PlanStep[] = [];
  for (const m of src.matchAll(PLAN_STEP_RE)) {
    steps.push({ step: m[1].replace(/\\(["'\\])/g, "$1"), status: m[2] });
  }
  return steps;
}

// The opening operator prompt, condensed — Codex extracts the same message as
// the thread title, so this is its own naming of the thread.
function firstPromptLine(transcriptPath: string): string | null {
  const opening = readCodexOpeningPrompt(transcriptPath);
  return opening ? condense(opening) || null : null;
}

// The operator's opening prompt, whole. firstPromptLine condenses this to one
// bounded line for the status row; the thread-title generator (task-title.ts)
// wants the full text, because the topic of a briefing is routinely stated
// past its first line and the row's 120-char cut throws that away.
// The newest genuine operator prompt in the rollout, verbatim — the Codex half
// of delivery verification (see continue.ts verifyPromptDelivery). Mirrors
// readCodexOpeningPrompt but scans the TAIL backwards for the most recent
// prompt rather than the head for the first, and returns the text uncondensed:
// the caller compares it against what garden pasted, so any trimming would
// manufacture a mismatch.
export function readCodexLatestPrompt(transcriptPath: string): string | null {
  let tail: string;
  try {
    tail = readTail(transcriptPath, ACTIVITY_TAIL_BYTES);
  } catch {
    return null;
  }
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.trim()) continue;
    let rec: CodexLine;
    try {
      rec = JSON.parse(line) as CodexLine;
    } catch {
      // A tail read can land mid-line; only the first fragment is unparseable
      // and it would be skipped anyway.
      continue;
    }
    const text = codexUserMessage(rec)?.text ?? responseItemUserText(rec);
    if (text === null || INJECTED_CONTEXT_RE.test(text)) continue;
    if (text.trim()) return text;
  }
  return null;
}

export function readCodexOpeningPrompt(transcriptPath: string): string | null {
  let head: string;
  try {
    head = readHead(transcriptPath, ACTIVITY_HEAD_BYTES);
  } catch {
    return null;
  }
  for (const line of head.split("\n")) {
    if (!line.trim()) continue;
    let rec: CodexLine;
    try {
      rec = JSON.parse(line) as CodexLine;
    } catch {
      continue;
    }
    const text = codexUserMessage(rec)?.text ?? responseItemUserText(rec);
    if (text === null || INJECTED_CONTEXT_RE.test(text)) continue;
    if (text.trim()) return text.trim();
  }
  return null;
}

// Codex records the AGENTS.md composition and the environment block as
// injected user-role messages ahead of the operator's own prompt, so naming
// either as the worker's activity would report garden's own rules back at it.
// Applied to every prompt shape below, not just one: which record carries the
// injected block varies by Codex version.
const INJECTED_CONTEXT_RE = /^\s*(?:# AGENTS\.md instructions\b|<environment_context\b)/;

// The current rollout shape for an operator prompt: a `response_item` message
// with role "user". Older rollouts carry it as an `event_msg` instead, which
// codexUserMessage reads. Null means this record is not an operator prompt.
function responseItemUserText(rec: CodexLine): string | null {
  const p = rec.payload;
  if (!p || rec.type !== "response_item" || p.type !== "message" || p.role !== "user") return null;
  return joinTextElements(p.content);
}

// One line, bounded — the status pane's detail column truncates too, but the
// registry should not carry a whole paragraph.
function condense(text: string): string {
  const line = text.trim().split("\n").find(l => l.trim())?.trim() ?? "";
  return line.length > ACTIVITY_MAX_CHARS ? `${line.slice(0, ACTIVITY_MAX_CHARS - 1)}…` : line;
}

function readHead(p: string, bytes: number): string {
  const fd = fs.openSync(p, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const read = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, read).toString("utf-8");
  } finally {
    fs.closeSync(fd);
  }
}

function readTail(p: string, bytes: number): string {
  const size = fs.statSync(p).size;
  if (size <= bytes) return fs.readFileSync(p, "utf-8");
  const fd = fs.openSync(p, "r");
  try {
    const buf = Buffer.alloc(bytes);
    fs.readSync(fd, buf, 0, bytes, size - bytes);
    return buf.toString("utf-8");
  } finally {
    fs.closeSync(fd);
  }
}

function isReadable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

// Walk $CODEX_HOME/sessions/YYYY/MM/DD for a rollout file whose name ends in
// `-<threadId>.jsonl`. Bounded shallow walk (year/month/day dirs); returns the
// first match or null.
function findRolloutByThreadId(sessionsDir: string, threadId: string): string | null {
  const suffix = `-${threadId}.jsonl`;
  let hit: string | null = null;
  const walk = (dir: string, depth: number): void => {
    if (hit || depth > 4) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (hit) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile() && e.name.startsWith("rollout-") && e.name.endsWith(suffix)) hit = full;
    }
  };
  walk(sessionsDir, 0);
  return hit;
}

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
import type { Turn, Verb } from "../conversation.js";
import type { WorkerEntry } from "../registry.js";
import { shellEscape, pasteAndSubmit } from "../tmux.js";
import { resolveHookRunner } from "../runner.js";
import type { AgentCommandOptions, HarnessCore, HeadlessCommandOptions } from "./types.js";

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
//     registry writes during checks) plus the worktree's shared git common dir
//     (worktreeGitDir). A garden worker runs in a *linked* worktree whose real
//     git dir is the main checkout's `.git` — outside cwd — so without that
//     root a Codex worker could not commit or push (claude-code's sandbox
//     auto-grants the git dir; Codex workspace-write does not). The HOME roots
//     are constant across workers; the git dir is per-project, passed in.
// Every dynamic value is shell-escaped: the result is spliced into the launch
// command string.
function codexSandboxFlags(worktreeGitDir?: string): string {
  const home = process.env.HOME || os.homedir();
  const writableRoots = [
    path.join(home, ".npm"),
    path.join(home, ".cache"),
    path.join(home, ".garden", "sessions"),
  ];
  if (worktreeGitDir) writableRoots.push(worktreeGitDir);
  const rootsToml = `sandbox_workspace_write.writable_roots=[${writableRoots.map(r => `"${r}"`).join(", ")}]`;
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
  // Tier A intent: Codex 0.142.5's hooks.json covers the full lifecycle
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
  // programmatically-written .codex/hooks.json is untrusted, so without the
  // bypass Codex silently skips every hook and no turn-end/status reaches the
  // poller (verified 2026-07-06: Stop fires per turn interactively with the
  // bypass). Resume is the `codex resume <session-id>` subcommand.
  //
  // Sandbox: an autonomous worker runs under Codex's own `workspace-write`
  // sandbox (see codexSandboxFlags) — NOT the headless reviewer's
  // --dangerously-bypass-approvals-and-sandbox, which is safe only because the
  // reviewer is short-lived and garden owns its trust boundary. A looping
  // worker running unbounded model-generated commands must stay confined.
  buildAgentCommand(opts: AgentCommandOptions): string {
    // opts.ultracode is a claude-code preset with no Codex analog and stays a
    // no-op. opts.effort DOES map: Codex's reasoning rung is the
    // `model_reasoning_effort` config key, so it rides the same `-c` override
    // channel as the hooks and sandbox rather than a flag. The rung vocabulary
    // is per-model and comes from Codex's own catalog (CODEX_EFFORT_LEVELS,
    // codex-models.ts) — it is NOT WORKER_EFFORT_LEVELS, so no value mapping
    // happens here; the composer offers the Codex rungs directly and this
    // passes the operator's choice through verbatim.
    const modelFlag = opts.model ? ` -m ${shellEscape(opts.model)}` : "";
    const effortFlag = opts.effort
      ? ` -c ${shellEscape(`model_reasoning_effort=${opts.effort}`)}`
      : "";
    const trust = "--dangerously-bypass-hook-trust";
    const sandbox = codexSandboxFlags(opts.worktreeGitDir);
    const hooks = codexHookFlags(resolveHookRunner());
    return opts.resume
      ? `${opts.envPrefix}codex resume ${shellEscape(opts.sessionId)} ${trust} ${sandbox} ${hooks}${modelFlag}${effortFlag}`
      : `${opts.envPrefix}codex ${trust} ${sandbox} ${hooks}${modelFlag}${effortFlag}`;
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
    // opts.effort is a claude-code dial and is ignored here, mirroring the
    // worker builder's treatment of effort/ultracode. A codex mapping
    // (model_reasoning_effort) can be added when a codex reviewer needs one.
    const modelFlag = opts.model ? ` -m ${shellEscape(opts.model)}` : "";
    const err = shellEscape(codexStderrSidecar(opts.resultFile));
    return `${opts.inlineEnv}${opts.envPrefix}codex exec --dangerously-bypass-approvals-and-sandbox${modelFlag}`
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
  // prompts are event_msg/user_message, the assistant text is
  // event_msg/agent_message. Verb tagging (verified against a real
  // apply_patch-bearing rollout, codex 0.142.5): the reliable edit signal is
  // an event_msg/patch_apply_end (Codex's edit primitive is a custom_tool_call
  // + patch event, NOT a function_call named apply_patch — those are
  // exec_command shell calls); any function_call/custom_tool_call is tool
  // activity. worked > planned > answered.
  readTurns(transcriptPath: string | null, maxTurns = DEFAULT_MAX_TURNS): Turn[] {
    if (!transcriptPath || !isReadable(transcriptPath)) return [];
    let raw: string;
    try {
      raw = readCapped(transcriptPath);
    } catch {
      return [];
    }
    const turns: Turn[] = [];
    // Track tool activity between the operator's prompt and the assistant's
    // reply so the assistant turn can be tagged worked/planned/answered.
    let sawEdit = false;
    let sawTool = false;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let rec: CodexLine;
      try {
        rec = JSON.parse(line) as CodexLine;
      } catch {
        continue;
      }
      const p = rec.payload;
      if (!p || typeof p !== "object") continue;
      if (rec.type === "event_msg" && p.type === "user_message") {
        sawEdit = false;
        sawTool = false;
        const text = typeof p.message === "string" ? p.message : joinTextElements(p.text_elements);
        turns.push({
          role: "user",
          text: text.trim(),
          ts: rec.timestamp ?? "",
          image: Boolean((p.images?.length ?? 0) || (p.local_images?.length ?? 0)),
        });
      } else if (rec.type === "event_msg" && p.type === "patch_apply_end") {
        sawEdit = true;
      } else if (rec.type === "response_item" && (p.type === "function_call" || p.type === "custom_tool_call")) {
        sawTool = true;
        if (isEditTool(p.name)) sawEdit = true;
      } else if (rec.type === "event_msg" && p.type === "agent_message") {
        const verb: Verb = sawEdit ? "worked" : sawTool ? "planned" : "answered";
        turns.push({
          role: "assistant",
          text: typeof p.message === "string" ? p.message.trim() : "",
          verb,
          ts: rec.timestamp ?? "",
        });
      }
    }
    return turns.slice(-maxTurns);
  },
};

// --- transcript helpers (light; no heavy deps) ---

const DEFAULT_MAX_TURNS = 12;
const MAX_BYTES = 16 * 1024 * 1024;

interface CodexLine {
  type?: string;
  timestamp?: string;
  payload?: {
    type?: string;
    message?: unknown;
    text_elements?: unknown;
    images?: unknown[];
    local_images?: unknown[];
    name?: unknown;
  };
}

// Codex tool names that mutate the worktree -> "worked". apply_patch is
// Codex's edit primitive; Edit/Write are the documented aliases.
const EDIT_TOOLS = new Set(["apply_patch", "Edit", "Write", "MultiEdit"]);
function isEditTool(name: unknown): boolean {
  return typeof name === "string" && EDIT_TOOLS.has(name);
}

function joinTextElements(els: unknown): string {
  if (!Array.isArray(els)) return "";
  return els
    .map((e) => (typeof e === "string" ? e : e && typeof e === "object" && typeof (e as { text?: unknown }).text === "string" ? (e as { text: string }).text : ""))
    .join("");
}

function isReadable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function readCapped(p: string): string {
  const stat = fs.statSync(p);
  if (stat.size <= MAX_BYTES) return fs.readFileSync(p, "utf-8");
  // Tail the last MAX_BYTES; accept a possibly-clipped head (same posture as
  // conversation.ts's claude reader).
  const fd = fs.openSync(p, "r");
  try {
    const buf = Buffer.alloc(MAX_BYTES);
    fs.readSync(fd, buf, 0, MAX_BYTES, stat.size - MAX_BYTES);
    return buf.toString("utf-8");
  } finally {
    fs.closeSync(fd);
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

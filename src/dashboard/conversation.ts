// Per-worker conversation history, read straight from Claude Code's session
// transcript JSONL — the single source of truth, so history is retroactive for
// workers that predate this feature. Feeds the bottom-left "history" dashboard
// view (⌥h) to remind the operator what they last asked a worker. (The view is
// "history"; this module parses the underlying conversation transcript.)
//
// The transcript path is captured from the hook input (`transcript_path`) and
// stored on the worker entry; when absent we derive it from the worktree cwd +
// session id, mirroring Claude Code's on-disk layout
// (~/.claude/projects/<cwd-with-/-and-.-as-dashes>/<sessionId>.jsonl).
//
// This module is pure: it turns a transcript file into an ordered list of
// turns. Live status overlays (working…/asking…) are the renderer's job.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorkerEntry } from "./registry.js";
import { stripControlSequences } from "./tmux.js";

export type Verb = "worked" | "planned" | "answered";

export interface Turn {
  // "garden" marks a garden-injected prompt (post-merge auto-continue, handoff
  // callback, trellis/grow iteration, or a handoff seed briefing) — rendered as
  // a compact labeled marker, not the multi-paragraph text.
  role: "user" | "assistant" | "garden";
  text: string;
  verb?: Verb; // assistant turns only
  ts: string; // ISO timestamp from the transcript, "" if absent
  image?: boolean; // user turns only — prompt carried a screenshot
}

// Tools that mutate the worktree → "worked". Anything else (reads, Bash,
// ExitPlanMode, Task) with no edit → "planned". No tools at all → "answered".
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

// Read the whole transcript so we capture the operator's prompts even when
// they cluster at the start of a long single-worker session (the prompts are
// exactly what this view is for, and they're often followed by megabytes of
// tool activity). The mode-gate in writeHistoryRendered already keeps this
// parse off the hook firehose — it only runs while the operator is looking at
// the history pane — so a full read at human-interaction cadence is cheap.
// The cap is a backstop against a pathologically huge transcript stalling the
// render; beyond it we tail the last chunk and accept a possibly-clipped head.
const MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_TURNS = 12;

// Resolve the transcript file for a worker: prefer the hook-captured path, fall
// back to deriving it from the worktree cwd + session id. Returns null when no
// readable transcript exists yet.
export function resolveTranscriptPath(entry: WorkerEntry): string | null {
  const captured = entry.transcriptPath;
  if (captured && isReadable(captured)) return captured;

  if (entry.worktreePath && entry.sessionId) {
    const home = process.env.HOME || os.homedir();
    const encoded = entry.worktreePath.replace(/[/.]/g, "-");
    const derived = path.join(home, ".claude", "projects", encoded, `${entry.sessionId}.jsonl`);
    if (isReadable(derived)) return derived;
  }
  return null;
}

function isReadable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

// Cumulative token usage summed across a worker's whole Claude transcript, for
// the telemetry cost signal. `turns` is the count of distinct assistant
// messages; `model` is the ground-truth model of the last one (what actually
// ran, vs the model configured on worker.created).
export interface TranscriptUsage {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  model?: string;
}

function usageNum(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// Sum per-assistant-message `usage` across the ENTIRE transcript (not the tail
// readConversation reads for the history view). Best-effort: null on any
// read/parse failure or a transcript with no usage-bearing assistant message.
//
// CRITICAL — dedupe by message.id: Claude Code re-emits each assistant message
// on every streaming update, so the transcript holds several lines per message
// all sharing one id, and the usage on them is the message's cumulative usage
// (not a per-chunk delta). Summing every line overcounts ~2.7x (measured 434,889
// vs 159,573 deduped output tokens on a 3-phase worker). Keeping one usage per
// id — last-wins, since the final emission carries the settled numbers — is what
// makes the cost figure real. Id-less lines (rare) each count once.
export function sumTranscriptUsage(transcriptPath: string | null): TranscriptUsage | null {
  if (!transcriptPath) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(transcriptPath, "utf-8");
  } catch {
    return null;
  }
  const byId = new Map<string, { input: number; output: number; cacheRead: number; cacheCreation: number }>();
  let lastModel: string | undefined;
  let synthetic = 0;
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    // JSON.parse("null") returns null (not a parse error), so guard before
    // dereferencing — a bare `null` line must be skipped, not throw.
    if (!obj || typeof obj !== "object") continue;
    if (obj.type !== "assistant") continue;
    const message = obj.message as
      | { role?: string; id?: string; model?: string; usage?: Record<string, unknown> }
      | undefined;
    if (message?.role !== "assistant" || !message.usage) continue;
    const u = message.usage;
    const key = typeof message.id === "string" && message.id ? message.id : `__no-id-${synthetic++}`;
    byId.set(key, {
      input: usageNum(u.input_tokens),
      output: usageNum(u.output_tokens),
      cacheRead: usageNum(u.cache_read_input_tokens),
      cacheCreation: usageNum(u.cache_creation_input_tokens),
    });
    if (typeof message.model === "string") lastModel = message.model;
  }
  if (byId.size === 0) return null;
  const total: TranscriptUsage = {
    turns: byId.size,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    model: lastModel,
  };
  for (const t of byId.values()) {
    total.inputTokens += t.input;
    total.outputTokens += t.output;
    total.cacheReadTokens += t.cacheRead;
    total.cacheCreationTokens += t.cacheCreation;
  }
  return total;
}

// Bytes of transcript tail scanned for the running model. The newest assistant
// message is normally the last line, so the scan almost always hits on its
// first candidate; the window only needs to be wide enough to clear a trailing
// run of user/tool lines.
const MODEL_TAIL_BYTES = 256 * 1024;

// The model a worker is ACTUALLY running, from the newest assistant message in
// its transcript. `WorkerEntry.model` records only an explicit pin, so an
// unpinned worker — the common case — runs the account default, which the
// registry cannot name. Callers that must reason about real model usage (the
// scoped usage-meter gate) need this rather than the pin.
//
// Same ground truth as sumTranscriptUsage().model, but tail-read: that one
// parses the entire transcript for its token sums, which is far too heavy for
// something the usage poller calls per live worker every cycle.
//
// Fails soft to undefined on any I/O or parse error.
export function readLatestTranscriptModel(transcriptPath: string): string | undefined {
  let raw: string;
  let partialHead = false;
  try {
    const size = fs.statSync(transcriptPath).size;
    const start = Math.max(0, size - MODEL_TAIL_BYTES);
    partialHead = start > 0;
    const fd = fs.openSync(transcriptPath, "r");
    try {
      const buf = Buffer.alloc(Math.min(size, MODEL_TAIL_BYTES));
      const read = fs.readSync(fd, buf, 0, buf.length, start);
      raw = buf.subarray(0, read).toString("utf-8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
  const lines = raw.split("\n");
  // Reading from an offset can land mid-line; that first fragment is not
  // parseable JSON and would only ever be skipped, but drop it explicitly.
  if (partialHead) lines.shift();
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    // Cheap pre-filter: most transcript lines are user/tool records with no
    // model field, and parsing them all would dominate the scan.
    if (!line || !line.includes('"model"')) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object" || obj.type !== "assistant") continue;
    const message = obj.message as { model?: string } | undefined;
    if (typeof message?.model === "string" && message.model) return message.model;
  }
  return undefined;
}

// Read the tail of the transcript and return the last `maxTurns` turns in
// chronological order (oldest first). Fails soft: any I/O or parse error, or a
// schema we don't recognize, yields an empty array rather than throwing.
export function readConversation(
  transcriptPath: string | null,
  maxTurns = DEFAULT_MAX_TURNS,
): Turn[] {
  if (!transcriptPath) return [];
  let raw: string;
  let partialHead = false;
  try {
    const fd = fs.openSync(transcriptPath, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - MAX_BYTES);
      partialHead = start > 0;
      const len = size - start;
      const buf = Buffer.allocUnsafe(len);
      fs.readSync(fd, buf, 0, len, start);
      raw = buf.toString("utf-8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }

  const lines = raw.split("\n");
  // The first line is likely truncated when we started mid-file; drop it.
  if (partialHead) lines.shift();

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
    if (!line) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.isSidechain === true) continue; // subagent internals, not the conversation
    if (obj.isMeta === true) continue; // attachment surfacing ("[Image: source: …]"), system notes — not a real turn

    const type = obj.type;
    const message = obj.message as { role?: string; content?: unknown } | undefined;
    const ts = typeof obj.timestamp === "string" ? obj.timestamp : "";

    if (type === "user" && message?.role === "user") {
      // Genuine operator prompts are string content, or a text+attachment array
      // (a prompt with an image). Tool results are `type:"user"` too but carry a
      // tool_result[] array — userPromptText returns "" for those.
      {
        const raw = userPromptText(message.content);
        if (!raw) continue;
        // System-injected user-role messages — background-task completions
        // (`<task-notification>`), slash-command echoes — are not operator
        // prompts and not turn boundaries. Skip them so the surrounding
        // assistant activity folds into one turn (a Workflow launch and the
        // edits it drove read as a single summary rather than being split by a
        // multi-KB notification blob painted as a fake prompt).
        const promptSource = typeof obj.promptSource === "string" ? obj.promptSource : undefined;
        if (isInjectedSystemMessage(raw, promptSource)) continue;
        // The typed prompt carries an inline "[Image #N]" reference when a
        // screenshot is attached; promptTurn strips it and flags the turn.
        const turn = promptTurn(raw, ts, /\[Image #\d+\]/.test(raw));
        if (!turn) continue;
        flush();
        turns.push(turn);
        pending = { tools: [], firstText: "", ts };
        seenUser = true;
      }
      continue;
    }

    if (type === "assistant" && message?.role === "assistant" && Array.isArray(message.content)) {
      if (!seenUser) continue; // drop a dangling assistant turn from a truncated head
      if (!pending) pending = { tools: [], firstText: "", ts };
      for (const block of message.content as Array<Record<string, unknown>>) {
        if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
          if (!pending.firstText) pending.firstText = block.text; // opening line, for the no-action fallback
          if (ts) pending.ts = ts;
        } else if (block.type === "tool_use" && typeof block.name === "string") {
          const input = (block.input && typeof block.input === "object")
            ? block.input as Record<string, unknown> : {};
          pending.tools.push({ name: block.name, input });
          if (ts && !pending.ts) pending.ts = ts;
        }
      }
    }
  }
  flush();

  return turns.slice(-maxTurns);
}

export interface ToolUse {
  name: string;
  input: Record<string, unknown>;
}

// A user-role message as the history view shows it, or null when nothing
// survives collapsing. Shared by every harness reader: the operator types the
// same prompts and garden pastes the same continuations into a Codex pane as
// into a Claude one, so the marker collapsing belongs here rather than in each
// adapter.
//   - garden's own continuation prompts (interrupt/merge auto-continue, handoff
//     callbacks, trellis/grow iterations) carry a [garden] fence and collapse to
//     a compact labeled marker instead of their multi-paragraph text. The
//     response is kept: a post-merge auto-continue is often a whole phase of work.
//   - a handoff seed (`[handoff from <project>/<worker>]`) is garden-injected in
//     the same way and collapses to a source-labeled marker.
//   - an inline "[Image #N]" screenshot reference is stripped; `image` flags the
//     turn so the view paints a clean "[screenshot]" marker instead.
export function promptTurn(raw: string, ts: string, image = false): Turn | null {
  const text = collapse(raw.replace(/\[Image #\d+\]/g, " "));
  if (!text) return null;
  if (text.startsWith("[garden]")) return { role: "garden", text: gardenLabel(text), ts };
  const handoff = handoffSeedLabel(text);
  if (handoff) return { role: "garden", text: handoff, ts };
  return { role: "user", text, ts, ...(image ? { image: true } : {}) };
}

export function classifyVerb(tools: string[]): Verb {
  if (tools.some(t => EDIT_TOOLS.has(t))) return "worked";
  if (tools.length > 0) return "planned";
  return "answered";
}

// Operator-authored prompts carry `promptSource:"typed"` (or "queued"); Claude
// Code's own injected user-role messages carry "system" (or another value). Use
// that as the authoritative signal, and fall back to a denylist of known
// wrapper tags for legacy transcripts that predate the field (the prompt itself
// is the collapsed content, so a genuine prompt never opens with one of these).
const GENUINE_PROMPT_SOURCES = new Set(["typed", "queued"]);
const INJECTED_WRAPPER =
  /^\s*<(?:task-notification|local-command-[a-z]+|command-(?:name|message|args)|bash-(?:input|stdout|stderr))\b/;

export function isInjectedSystemMessage(raw: string, promptSource: string | undefined): boolean {
  if (promptSource !== undefined) return !GENUINE_PROMPT_SOURCES.has(promptSource);
  return INJECTED_WRAPPER.test(raw);
}

// Map a [garden]-fenced continuation prompt to a compact marker. The prompts
// are multi-paragraph and usually lead with a branch-identity preamble, so
// match the distinctive phrase anywhere in the collapsed text, most-specific
// first. Kept in sync with the prompt builders in continue.ts / grow-continue.ts
// / trellis-continue.ts / trellis-picker.ts / poller-merge.ts.
export function gardenLabel(text: string): string {
  const grow = text.match(/Iteration (\d+) of \d+.{0,4}keep growing/i);
  if (grow) return `grow iteration ${grow[1]}`;
  if (/Grow loop, iteration 1 of/i.test(text)) return "grow start";
  if (/previous iteration was merged\..*trellis/i.test(text)) return "trellis iteration";
  if (/trellis vine bound/i.test(text)) return "trellis start";
  if (/trellis-author/i.test(text)) return "author a trellis";
  if (/Handoff callback:/i.test(text)) return "handoff callback";
  if (/just merged into/i.test(text)) return "sibling merged";
  if (/interrupted by a restart/i.test(text)) return "resumed after interrupt";
  if (/reviewed and merged/i.test(text)) return "continue after merge";
  return "autocontinue";
}

// Map a handoff seed prompt to a compact source-labeled marker, or null when the
// text is not a handoff seed. The seed opens with a bracketed identity line
// (`[handoff from <project>/<worker>]`, optionally `— callback requested`, or a
// bare `[handoff]` from a non-worker) built in commands/handoff.ts; the marker
// is that bracket's contents, e.g. "handoff from garden/plush-faint-dusk". Kept
// in sync with the seed prefix there.
export function handoffSeedLabel(text: string): string | null {
  const m = text.match(/^\[(handoff\b[^\]]*)\]/);
  return m ? collapse(m[1]) : null;
}

// Summarize an assistant turn by what it DID, not what it said last. The closing
// line of a response is almost always a question or sign-off — a poor summary —
// so we synthesize a terse action phrase from the turn's tool calls (files
// edited, committed/pushed, tests, exploration, a plan, a question). Only when a
// turn used no tools at all do we fall back to its opening sentence.
export function summarizeTurn(tools: ToolUse[], firstText: string): { text: string; verb: Verb } {
  const edited = new Set<string>();
  const readFiles = new Set<string>();
  const bash: string[] = [];
  let searched = false, exitPlan = false, asked = false, agents = 0, web = false, workflow = false;

  for (const t of tools) {
    if (EDIT_TOOLS.has(t.name)) {
      const fp = t.input.file_path ?? t.input.notebook_path;
      edited.add(typeof fp === "string" ? basename(fp) : "");
    } else if (t.name === "Read") {
      const fp = t.input.file_path;
      if (typeof fp === "string") readFiles.add(basename(fp));
    } else if (t.name === "Grep" || t.name === "Glob" || t.name === "LS") {
      searched = true;
    } else if (t.name === "Bash") {
      if (typeof t.input.command === "string") bash.push(t.input.command);
    } else if (t.name === "Task" || t.name === "Agent") {
      agents++;
    } else if (t.name === "Workflow") {
      workflow = true;
    } else if (t.name === "ExitPlanMode") {
      exitPlan = true;
    } else if (t.name === "AskUserQuestion") {
      asked = true;
    } else if (t.name === "WebFetch" || t.name === "WebSearch") {
      web = true;
    }
  }

  const allBash = bash.join("\n");
  const committed = /\bgit\s+commit\b/.test(allBash);
  const pushed = /\bgit\s+push\b/.test(allBash);
  const tested = /\bvitest\b|\bjest\b|\bpytest\b|\bgo test\b|\bcargo test\b|\b(?:npm|pnpm|yarn)\s+(?:run\s+)?test/.test(allBash);
  const built = /\b(?:npm|pnpm|yarn)\s+run\s+build\b|\bmake\b|\bcargo build\b|\bgo build\b/.test(allBash);

  const parts: string[] = [];
  // A launched Workflow is notable and often co-occurs with the edits it drove,
  // so lead with it rather than folding it into the single-action chain below.
  if (workflow) parts.push("ran a workflow");
  const editedNames = [...edited].filter(Boolean);
  if (edited.size > 0) {
    parts.push(editedNames.length > 0
      ? "edited " + editedNames.slice(0, 3).join(", ") + (editedNames.length > 3 ? ` +${editedNames.length - 3}` : "")
      : "edited files");
  } else if (exitPlan) {
    parts.push("presented a plan");
  } else if (asked) {
    parts.push("asked a question");
  } else if (agents > 0) {
    parts.push(agents === 1 ? "ran a subagent" : `ran ${agents} subagents`);
  } else if (web) {
    parts.push("researched");
  } else if (readFiles.size > 0) {
    parts.push(`explored ${readFiles.size} file${readFiles.size === 1 ? "" : "s"}`);
  } else if (searched) {
    parts.push("searched the codebase");
  } else if (bash.length > 0 && !(built || tested || committed || pushed)) {
    parts.push("ran commands");
  }
  if (built) parts.push("built");
  if (tested) parts.push("ran tests");
  if (committed) parts.push("committed");
  if (pushed) parts.push("pushed");

  let verb = classifyVerb(tools.map(t => t.name));
  if (verb !== "worked" && (committed || pushed || built || tested)) verb = "worked";

  const text = parts.length > 0 ? parts.join(" · ") : (firstSentence(firstText) || "answered");
  return { text: stripControlSequences(text), verb };
}

// Extract operator prompt text from a user message's content. Returns "" for a
// non-prompt (a tool_result array). Handles a plain string, or a content array
// carrying text blocks alongside attachments (an image-bearing prompt).
function userPromptText(content: unknown): string {
  if (typeof content === "string") return collapse(content);
  if (Array.isArray(content)) {
    const blocks = content as Array<Record<string, unknown>>;
    if (blocks.some(b => b?.type === "tool_result")) return "";
    const texts = blocks
      .filter(b => b?.type === "text" && typeof b.text === "string")
      .map(b => b.text as string);
    return collapse(texts.join(" "));
  }
  return "";
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

// First sentence of a block of prose, whitespace-collapsed and length-capped.
function firstSentence(s: string): string {
  const t = collapse(s);
  if (!t) return "";
  const m = t.match(/^.*?[.!?](?:\s|$)/);
  let out = (m ? m[0] : t).trim();
  if (out.length > 100) out = out.slice(0, 99).trimEnd() + "…";
  return out;
}

function collapse(s: string): string {
  // Strip terminal escapes from operator-prompt / transcript text before it is
  // painted into the history pane, then normalize whitespace.
  return stripControlSequences(s).replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Rendering — pure: turns + width → ANSI lines (oldest at top, newest at
// bottom). The caller (writeHistoryRendered) fits these to the pane
// height and paints them. Kept here so it stays unit-testable without tmux.
// ---------------------------------------------------------------------------

const RESET = "\x1b[0m";
const LABEL_W = 8; // widest label: "answered"
const VERB_COLOR: Record<Verb, string> = {
  worked: "32",  // green
  planned: "36", // cyan
  answered: "2", // dim
};

function paint(code: string, s: string): string {
  return `\x1b[${code}m${s}${RESET}`;
}

export interface FormatOpts {
  width: number;
  // Live worker status overlay for the in-progress turn, if any.
  status?: "working" | "asking";
}

export function formatConversationPane(turns: Turn[], opts: FormatOpts): string[] {
  // Overhead per printed line is " " + gutter(LABEL_W) + " " = LABEL_W + 2 —
  // both the leading margin and the gap between gutter and text count.
  const textWidth = Math.max(10, opts.width - (LABEL_W + 2));
  const lines: string[] = [];

  turns.forEach((turn, i) => {
    // Each exchange opens with a dim, timestamped divider rule — strong visual
    // separation between threads, and a "when did I ask this" cue. Both operator
    // prompts and garden continuation markers are conversation boundaries.
    if (turn.role !== "assistant") {
      if (i > 0) lines.push("");
      lines.push(dividerLine(turn.ts, opts.width));
    }
    const label = turn.role === "user"
      ? paint("1", "you".padEnd(LABEL_W))
      : turn.role === "garden"
        ? paint("2", "garden".padEnd(LABEL_W)) // dim: system-injected, subordinate
        : paint(VERB_COLOR[turn.verb ?? "answered"], (turn.verb ?? "answered").padEnd(LABEL_W));
    const wrapped = wrapText(turn.text, textWidth);
    wrapped.forEach((w, j) => {
      const gutter = j === 0 ? label : " ".repeat(LABEL_W);
      let styled = turn.role === "user" ? paint("1", w)
        : turn.role === "garden" ? paint("2", w)
        : w;
      // A dim "[screenshot]" marker on the last line of a prompt that had one.
      if (turn.role === "user" && turn.image && j === wrapped.length - 1) {
        styled += " " + paint("2", "[screenshot]");
      }
      lines.push(` ${gutter} ${styled}`);
    });
  });

  if (opts.status === "working") lines.push(` ${paint("33", "working…".padEnd(LABEL_W))}`);
  else if (opts.status === "asking") lines.push(` ${paint("33", "asking…".padEnd(LABEL_W))}`);

  return lines;
}

// A dim full-width rule labelled with the local time of the exchange, e.g.
// "─ 3:20pm ─────────────────────". Falls back to a plain rule without a time.
function dividerLine(ts: string, width: number): string {
  const t = formatClockTime(ts);
  const label = t ? `─ ${t} ` : "─ ";
  const fill = Math.max(0, width - label.length);
  return paint("2", label + "─".repeat(fill));
}

// ISO timestamp → local "3:20pm" (transcript timestamps are UTC; the operator
// sees their own timezone). Empty string when the timestamp is missing/invalid.
function formatClockTime(ts: string): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h < 12 ? "am" : "pm";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2, "0")}${ampm}`;
}

// Greedy word-wrap on a plain (un-styled) string.
function wrapText(text: string, width: number): string[] {
  const words = text.split(" ");
  const out: string[] = [];
  let line = "";
  for (let word of words) {
    while (word.length > width) {
      // A single token wider than the column — hard-split it.
      if (line) { out.push(line); line = ""; }
      out.push(word.slice(0, width));
      word = word.slice(width);
    }
    if (!line) line = word;
    else if (line.length + 1 + word.length <= width) line += " " + word;
    else { out.push(line); line = word; }
  }
  if (line) out.push(line);
  return out.length > 0 ? out : [""];
}

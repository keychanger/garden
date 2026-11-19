// Per-worker conversation history, read straight from the harness transcript
// JSONL — the single source of truth, so history is retroactive for workers
// that predate this feature. Feeds the bottom-left "history" dashboard view
// (⌥h) to remind the operator what they last asked a worker. (The view is
// "history"; this module parses the underlying conversation transcript.)
//
// The transcript path is captured from the hook input (`transcript_path`) and
// stored on the worker entry; when absent we derive it from the worktree cwd +
// session id, mirroring Claude Code's on-disk layout
// (~/.claude/projects/<cwd-with-/-and-.-as-dashes>/<sessionId>.jsonl).
//
// This module turns a transcript file into an ordered list of turns; its only
// side effect is the parse checkpoint readAllTurns keeps under the control dir.
// Live status overlays (working…/asking…) are the renderer's job.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONTROL_DIR } from "../paths.js";
import { atomicWriteFile } from "./atomic-write.js";
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
// A landed prompt sits at the very end of the file; garden's own continuation
// prompts are ~2KB and handoff seeds have run to ~16KB, so this clears the
// largest by a wide margin while staying a bounded read.
const PROMPT_TAIL_BYTES = 256 * 1024;

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
    // Claude Code records its own API-error and interrupt notices as assistant
    // messages with model `<synthetic>`. That names no model, and now that the
    // observed model outranks a pin in the scoped-meter gate, returning it would
    // read a Fable worker that just hit an API error as not running Fable.
    if (typeof message?.model === "string" && message.model && message.model !== "<synthetic>") {
      return message.model;
    }
  }
  return undefined;
}

// The newest genuine user prompt in the transcript, verbatim. Delivery
// verification compares it against the text garden pasted (see continue.ts
// verifyPromptDelivery), so unlike readConversation it must NOT collapse,
// label, or truncate anything — a `[garden]` continuation is returned in full,
// not as its marker.
//
// Bounded tail read like readLatestTranscriptModel: a prompt landing now is at
// the very end of the file, and a whole-file parse on every delivery would put
// transcript-sized work on a path that runs per prompt. Injected system
// messages (task notifications, slash-command echoes) are skipped — they are
// user-role records that would otherwise read as "a prompt landed".
export function readLatestPrompt(transcriptPath: string): string | null {
  let raw: string;
  let partialHead = false;
  try {
    const size = fs.statSync(transcriptPath).size;
    const start = Math.max(0, size - PROMPT_TAIL_BYTES);
    partialHead = start > 0;
    const fd = fs.openSync(transcriptPath, "r");
    try {
      const buf = Buffer.alloc(Math.min(size, PROMPT_TAIL_BYTES));
      const read = fs.readSync(fd, buf, 0, buf.length, start);
      raw = buf.subarray(0, read).toString("utf-8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  const lines = raw.split("\n");
  // Reading from an offset can land mid-line; that fragment is not parseable
  // JSON and would only ever be skipped, but drop it explicitly.
  if (partialHead) lines.shift();
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.includes('"user"')) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object" || obj.type !== "user") continue;
    if (obj.isSidechain === true || obj.isMeta === true) continue;
    const text = userText(obj);
    if (text === null) continue;
    const source = typeof obj.promptSource === "string" ? obj.promptSource : undefined;
    if (isInjectedSystemMessage(text, source)) continue;
    if (text.trim()) return text;
  }
  return null;
}

// Bytes of transcript head scanned for the opening prompt. The first genuine
// prompt is within the first few records of a Claude Code transcript (unlike a
// Codex rollout, which records the whole composed instructions ahead of it), so
// this is a wide margin rather than a tight fit.
const PROMPT_HEAD_BYTES = 256 * 1024;

// The FIRST prompt that told this worker what to do, verbatim — the thread
// titler's input (see task-title.ts). Mirrors readLatestPrompt but scans the
// head rather than the tail, and admits one shape that one deliberately drops:
// a prompt another Claude session delivered over the cross-session socket.
// Those are recorded as meta, system-sourced user records carrying an
// `origin.kind === "peer"` envelope, and for delivery verification they are
// correctly ignored — they are not garden's paste. For titling they are the
// opposite: when a parent fans work out over that socket, the peer message is
// the ONLY statement of the task the worker ever receives, and a reader that
// skips it leaves the row permanently blank. `origin.body` is the message the
// peer sent, without the "Another Claude session sent a message:" wrapper the
// transcript text carries.
export function readOpeningPrompt(transcriptPath: string): string | null {
  let raw: string;
  try {
    const fd = fs.openSync(transcriptPath, "r");
    try {
      const buf = Buffer.alloc(PROMPT_HEAD_BYTES);
      const read = fs.readSync(fd, buf, 0, buf.length, 0);
      raw = buf.subarray(0, read).toString("utf-8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  for (const line of raw.split("\n")) {
    if (!line || !line.includes('"user"')) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      // A head read can clip the final line; it is unparseable and would be
      // skipped anyway.
      continue;
    }
    if (!obj || typeof obj !== "object" || obj.type !== "user") continue;
    if (obj.isSidechain === true) continue;
    const peer = peerMessageBody(obj);
    if (peer) return peer;
    if (obj.isMeta === true) continue;
    const text = userText(obj);
    if (text === null) continue;
    const source = typeof obj.promptSource === "string" ? obj.promptSource : undefined;
    if (isInjectedSystemMessage(text, source)) continue;
    if (text.trim()) return text.trim();
  }
  return null;
}

// The body of a prompt relayed from another Claude Code session, or null when
// the record is not one. The envelope is what distinguishes a peer's
// instruction from the harness's own injected meta records, which carry no
// `origin`.
function peerMessageBody(obj: Record<string, unknown>): string | null {
  const origin = obj.origin;
  if (!origin || typeof origin !== "object") return null;
  const { kind, body } = origin as { kind?: unknown; body?: unknown };
  if (kind !== "peer" || typeof body !== "string") return null;
  return body.trim() || null;
}

// The text of a user-role record, joining multi-part content. Null when the
// record carries no text at all (a tool_result or image-only turn).
function userText(obj: Record<string, unknown>): string | null {
  const content = (obj.message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts = content
    .filter((p): p is { type: string; text: string } =>
      !!p && typeof p === "object" && (p as { type?: unknown }).type === "text"
      && typeof (p as { text?: unknown }).text === "string")
    .map(p => p.text);
  return parts.length > 0 ? parts.join("") : null;
}

// The history view reads the WHOLE transcript: the operator must always be able
// to scroll back to the prompt that started a conversation. It used to read an
// escalating tail and keep the last 40 entries, so a long-lived worker's view
// began mid-run (one 485MB worker showed 12 of its 55 prompts, starting three
// weeks after its first).
//
// Whole-file reads are only affordable incrementally. writeHistoryRendered runs
// on every dashboard refresh while ⌥h is open — every hook fire across the
// fleet — and a full parse of that 485MB transcript costs ~1.4s. So the parse
// is a resumable state machine (ParseState) and its state is checkpointed to
// disk after each read, keyed by transcript path, holding the byte offset it
// has consumed through. A refresh parses only what was appended since; only the
// first view of a transcript pays for the whole file, read in bounded chunks.
//
// The checkpoint lives under the control dir, not ~/.garden/sessions: cached
// turn text is painted into the operator's pane without re-sanitizing, so it
// must not be worker-writable.
const HISTORY_CACHE_DIR = path.join(CONTROL_DIR, "history-cache");
// Bump when the parsers or summarizeTurn change what they produce, so cached
// turns written by an older build are re-derived rather than shown forever.
const HISTORY_CACHE_VERSION = 1;
const HISTORY_CACHE_KEEP = 16;
const READ_CHUNK_BYTES = 16 * 1024 * 1024;
// Bytes before the checkpoint offset that must still match for the checkpoint
// to apply. Transcripts are append-only; this catches one that was replaced.
const CHECKPOINT_PROBE_BYTES = 256;

// An exchange still being accumulated: the activity since the last prompt.
export interface PendingTurn {
  tools: ToolUse[];
  firstText: string;
  ts: string;
  compacted?: boolean;
}

export interface ParseState {
  turns: Turn[];
  pending: PendingTurn | null;
  seenUser: boolean;
}

// A harness transcript parser: consumes lines, advancing `state` in place.
export type TurnParser = (lines: Iterable<string>, state: ParseState) => void;

export function newParseState(): ParseState {
  return { turns: [], pending: null, seenUser: false };
}

function pendingSummary(pending: PendingTurn | null): Turn | null {
  if (!pending || (pending.tools.length === 0 && !pending.firstText)) return null;
  const { text, verb } = summarizeTurn(pending.tools, pending.firstText);
  return { role: "assistant", text: pending.compacted ? `${text} · compacted` : text, verb, ts: pending.ts };
}

// Close the exchange in flight and open a new one at a prompt turn.
export function openExchange(state: ParseState, turn: Turn, ts: string): void {
  const done = pendingSummary(state.pending);
  if (done) state.turns.push(done);
  state.turns.push(turn);
  state.pending = { tools: [], firstText: "", ts };
  state.seenUser = true;
}

// Record tool calls on the exchange in flight. Only the input fields
// summarizeTurn reads are kept: the pending exchange is checkpointed to disk,
// and a Write's full file content has no business there.
export function addTools(pending: PendingTurn, tools: ToolUse[]): void {
  for (const t of tools) {
    const input: Record<string, unknown> = {};
    for (const k of ["file_path", "notebook_path", "command"]) {
      if (typeof t.input[k] === "string") input[k] = t.input[k];
    }
    pending.tools.push({ name: t.name, input });
  }
}

// Settled turns plus a summary of the exchange in flight, without closing it.
export function finishTurns(state: ParseState): Turn[] {
  const open = pendingSummary(state.pending);
  return open ? [...state.turns, open] : state.turns.slice();
}

interface HistoryCheckpoint {
  version: number;
  path: string;
  ino: number;
  offset: number;
  probe: string;
  state: ParseState;
}

// Shallow: the file is garden-written under the control dir, so the guard
// rejects an older build's shape or a torn read, not a forgery.
function isHistoryCheckpoint(v: unknown): v is HistoryCheckpoint {
  const c = v as HistoryCheckpoint | null;
  return c?.version === HISTORY_CACHE_VERSION && typeof c.offset === "number" && Array.isArray(c.state?.turns);
}

function checkpointFile(cacheDir: string, transcriptPath: string): string {
  return path.join(cacheDir, crypto.createHash("sha1").update(transcriptPath).digest("hex") + ".json");
}

function probeAt(fd: number, offset: number): string {
  const len = Math.min(offset, CHECKPOINT_PROBE_BYTES);
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, offset - len);
  return buf.toString("base64");
}

function loadCheckpoint(file: string, transcriptPath: string, fd: number, st: fs.Stats): HistoryCheckpoint | null {
  try {
    const c: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (!isHistoryCheckpoint(c) || c.path !== transcriptPath || c.ino !== st.ino || c.offset > st.size) return null;
    return probeAt(fd, c.offset) === c.probe ? c : null;
  } catch {
    return null;
  }
}

function saveCheckpoint(cacheDir: string, file: string, c: HistoryCheckpoint): void {
  try {
    const isNew = !fs.existsSync(file);
    atomicWriteFile(file, JSON.stringify(c), { durable: false });
    if (isNew) pruneCheckpoints(cacheDir);
  } catch { /* a missed checkpoint only costs the next read a re-parse */ }
}

// One checkpoint per transcript ever viewed; keep the most recently written.
function pruneCheckpoints(cacheDir: string): void {
  const files = fs.readdirSync(cacheDir)
    .filter(f => f.endsWith(".json"))
    .map(f => ({ f, t: fs.statSync(path.join(cacheDir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const { f } of files.slice(HISTORY_CACHE_KEEP)) fs.rmSync(path.join(cacheDir, f), { force: true });
}

function* splitLines(data: Buffer, end: number): Generator<string> {
  for (let start = 0, nl; start < end; start = nl + 1) {
    nl = data.indexOf(0x0a, start);
    yield data.toString("utf-8", start, nl);
  }
}

// Parse complete lines from `offset` to EOF into `state`, in bounded chunks;
// returns the offset consumed through. An unterminated last line is still being
// written and is left for the next read. A chunk holding no newline grows until
// it holds one, so a single line longer than the chunk still parses.
function consumeLines(fd: number, size: number, offset: number, state: ParseState, parse: TurnParser): number {
  let chunk = READ_CHUNK_BYTES;
  while (offset < size) {
    const len = Math.min(chunk, size - offset);
    const buf = Buffer.allocUnsafe(len);
    const n = fs.readSync(fd, buf, 0, len, offset);
    const end = buf.subarray(0, n).lastIndexOf(0x0a);
    if (end < 0) {
      if (offset + n >= size) break;
      chunk *= 2;
      continue;
    }
    parse(splitLines(buf, end), state);
    offset += end + 1;
    chunk = READ_CHUNK_BYTES;
  }
  return offset;
}

// Every turn of a transcript, oldest first. Shared by every harness reader.
// Fails soft: an I/O or parse error yields [] rather than throwing.
export function readAllTurns(
  transcriptPath: string | null,
  parse: TurnParser,
  cacheDir: string = HISTORY_CACHE_DIR,
): Turn[] {
  if (!transcriptPath) return [];
  let fd: number;
  try {
    fd = fs.openSync(transcriptPath, "r");
  } catch {
    return [];
  }
  try {
    const st = fs.fstatSync(fd);
    const file = checkpointFile(cacheDir, transcriptPath);
    const cached = loadCheckpoint(file, transcriptPath, fd, st);
    const state = cached?.state ?? newParseState();
    const from = cached?.offset ?? 0;
    const offset = consumeLines(fd, st.size, from, state, parse);
    if (!cached || offset !== from) {
      saveCheckpoint(cacheDir, file, {
        version: HISTORY_CACHE_VERSION, path: transcriptPath, ino: st.ino, offset, probe: probeAt(fd, offset), state,
      });
    }
    return finishTurns(state);
  } catch {
    return [];
  } finally {
    fs.closeSync(fd);
  }
}

// Every turn of a Claude Code transcript, oldest first.
export function readConversation(transcriptPath: string | null, cacheDir?: string): Turn[] {
  return readAllTurns(transcriptPath, parseClaudeTurns, cacheDir);
}

function parseClaudeTurns(lines: Iterable<string>, state: ParseState): void {
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
    // Claude Code's context-compaction summary is recorded as a user message,
    // but it continues the prompt in flight rather than starting a new one.
    // Fold it into that turn as a tag instead of painting a multi-KB summary
    // as an operator prompt.
    if (obj.isCompactSummary === true) {
      if (state.pending) state.pending.compacted = true;
      continue;
    }

    const type = obj.type;
    const message = obj.message as { role?: string; content?: unknown } | undefined;
    const ts = typeof obj.timestamp === "string" ? obj.timestamp : "";

    if (type === "user" && message?.role === "user") {
      // Genuine operator prompts are string content, or a text+attachment array
      // (a prompt with an image). Tool results are `type:"user"` too but carry a
      // tool_result[] array — userPromptText returns "" for those.
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
      if (turn) openExchange(state, turn, ts);
      continue;
    }

    if (type === "assistant" && message?.role === "assistant" && Array.isArray(message.content)) {
      if (!state.seenUser) continue; // activity before any prompt (e.g. a resumed session's preamble)
      const pending = state.pending ??= { tools: [], firstText: "", ts };
      for (const block of message.content as Array<Record<string, unknown>>) {
        if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
          if (!pending.firstText) pending.firstText = block.text; // opening line, for the no-action fallback
          if (ts) pending.ts = ts;
        } else if (block.type === "tool_use" && typeof block.name === "string") {
          const input = (block.input && typeof block.input === "object")
            ? block.input as Record<string, unknown> : {};
          addTools(pending, [{ name: block.name, input }]);
          if (ts && !pending.ts) pending.ts = ts;
        }
      }
    }
  }
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
//   - Claude Code records pasted text inside `<pasted_content id="…">` tags.
//     garden delivers every prompt as a bracketed paste, so the tags are
//     stripped before the [garden]/handoff prefixes are matched.
export function promptTurn(raw: string, ts: string, image = false): Turn | null {
  const text = collapse(raw.replace(/\[Image #\d+\]|<\/?pasted_content\b[^>]*>/g, " "));
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
  let shownDay: string | null = null;

  turns.forEach((turn, i) => {
    // Each exchange opens with a dim, timestamped divider rule — strong visual
    // separation between threads, and a "when did I ask this" cue. Both operator
    // prompts and garden continuation markers are conversation boundaries. The
    // first divider of each local day also carries the date, as the logs pane's
    // day rule does, so yesterday's exchanges don't read as today's.
    if (turn.role !== "assistant") {
      if (i > 0) lines.push("");
      const day = dayKey(turn.ts);
      lines.push(dividerLine(turn.ts, opts.width, day !== "" && day !== shownDay));
      if (day) shownDay = day;
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
// "─ 3:20pm ─────────────────────", or "─ Thu 10-15 · 3:20pm ────" when it opens
// a new day. Falls back to a plain rule without a time.
function dividerLine(ts: string, width: number, withDate: boolean): string {
  const t = formatClockTime(ts);
  const stamp = t && withDate ? `${formatDay(ts)} · ${t}` : t;
  const label = stamp ? `─ ${stamp} ` : "─ ";
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

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// The local calendar day of a timestamp, "" when missing/invalid.
function dayKey(ts: string): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// ISO timestamp → local "Thu 10-15", the logs pane's day-rule format.
function formatDay(ts: string): string {
  const d = new Date(ts);
  return `${WEEKDAYS[d.getDay()]} ${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
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

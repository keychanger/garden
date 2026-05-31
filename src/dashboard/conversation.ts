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

export type Verb = "worked" | "planned" | "answered";

export interface Turn {
  role: "user" | "assistant";
  text: string;
  verb?: Verb; // assistant turns only
  ts: string; // ISO timestamp from the transcript, "" if absent
}

// Tools that mutate the worktree → "worked". Anything else (reads, Bash,
// ExitPlanMode, Task) with no edit → "planned". No tools at all → "answered".
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

// Read the whole transcript so we capture the operator's prompts even when
// they cluster at the start of a long single-worker session (the prompts are
// exactly what this view is for, and they're often followed by megabytes of
// tool activity). The mode-gate in writeConversationRendered already keeps this
// parse off the hook firehose — it only runs while the operator is looking at
// the conversation pane — so a full read at human-interaction cadence is cheap.
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
  let pending: { summary: string; tools: string[]; ts: string } | null = null;
  let seenUser = false;
  let suppress = false; // dropping a [garden]-injected exchange

  const flush = (): void => {
    if (pending && (pending.summary || pending.tools.length > 0)) {
      turns.push({
        role: "assistant",
        text: lastParagraph(pending.summary),
        verb: classifyVerb(pending.tools),
        ts: pending.ts,
      });
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

    const type = obj.type;
    const message = obj.message as { role?: string; content?: unknown } | undefined;
    const ts = typeof obj.timestamp === "string" ? obj.timestamp : "";

    if (type === "user" && message?.role === "user") {
      // Genuine operator prompts have string content; tool results are
      // `type:"user"` too but carry a tool_result[] array — skip those.
      if (typeof message.content === "string") {
        const text = collapse(message.content);
        if (!text) continue;
        flush();
        // garden-injected system prompts (interrupt/merge continuation,
        // handoff callbacks, postMerge notices) are all tagged "[garden] ".
        // They aren't something the operator typed — drop the prompt and its
        // response so the view shows only the real conversation.
        if (text.startsWith("[garden]")) {
          pending = null;
          suppress = true;
          continue;
        }
        suppress = false;
        turns.push({ role: "user", text, ts });
        pending = { summary: "", tools: [], ts };
        seenUser = true;
      }
      continue;
    }

    if (type === "assistant" && message?.role === "assistant" && Array.isArray(message.content)) {
      if (suppress) continue; // response to a [garden]-injected prompt
      if (!seenUser) continue; // drop a dangling assistant turn from a truncated head
      if (!pending) pending = { summary: "", tools: [], ts };
      for (const block of message.content as Array<Record<string, unknown>>) {
        if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
          pending.summary = block.text; // last text block in the turn wins
          if (ts) pending.ts = ts;
        } else if (block.type === "tool_use" && typeof block.name === "string") {
          pending.tools.push(block.name);
          if (ts && !pending.ts) pending.ts = ts;
        }
      }
    }
  }
  flush();

  return turns.slice(-maxTurns);
}

export function classifyVerb(tools: string[]): Verb {
  if (tools.some(t => EDIT_TOOLS.has(t))) return "worked";
  if (tools.length > 0) return "planned";
  return "answered";
}

// The trailing paragraph of an assistant message, whitespace-collapsed to a
// single line for the compact pane.
function lastParagraph(s: string): string {
  const parts = s.trim().split(/\n\s*\n/);
  return collapse(parts[parts.length - 1] ?? "");
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Rendering — pure: turns + width → ANSI lines (oldest at top, newest at
// bottom). The caller (writeConversationRendered) fits these to the pane
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
  const textWidth = Math.max(10, opts.width - (LABEL_W + 1));
  const lines: string[] = [];

  turns.forEach((turn, i) => {
    if (turn.role === "user" && i > 0) lines.push(""); // blank line between exchanges
    const label = turn.role === "user"
      ? paint("1", "you".padEnd(LABEL_W))
      : paint(VERB_COLOR[turn.verb ?? "answered"], (turn.verb ?? "answered").padEnd(LABEL_W));
    const wrapped = wrapText(turn.text, textWidth);
    wrapped.forEach((w, j) => {
      const gutter = j === 0 ? label : " ".repeat(LABEL_W);
      const styled = turn.role === "user" ? paint("1", w) : w;
      lines.push(` ${gutter} ${styled}`);
    });
  });

  if (opts.status === "working") lines.push(` ${paint("33", "working…".padEnd(LABEL_W))}`);
  else if (opts.status === "asking") lines.push(` ${paint("33", "asking…".padEnd(LABEL_W))}`);

  return lines;
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

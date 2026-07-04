import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  readConversation,
  classifyVerb,
  summarizeTurn,
  resolveTranscriptPath,
  formatConversationPane,
  type Turn,
} from "../src/dashboard/conversation.js";
import type { WorkerEntry } from "../src/dashboard/registry.js";
import { useTmpHome } from "./helpers.js";

// Build a JSONL transcript from line objects.
function jsonl(lines: Array<Record<string, unknown>>): string {
  return lines.map(l => JSON.stringify(l)).join("\n") + "\n";
}

function user(content: unknown, ts = "2026-05-30T17:00:00Z", extra: Record<string, unknown> = {}) {
  return { type: "user", message: { role: "user", content }, timestamp: ts, isSidechain: false, ...extra };
}
function assistant(content: unknown, ts = "2026-05-30T17:00:01Z", extra: Record<string, unknown> = {}) {
  return { type: "assistant", message: { role: "assistant", content }, timestamp: ts, isSidechain: false, ...extra };
}

describe("classifyVerb", () => {
  it("worked when a mutating tool ran", () => {
    expect(classifyVerb(["Read", "Edit"])).toBe("worked");
    expect(classifyVerb(["Write"])).toBe("worked");
    expect(classifyVerb(["NotebookEdit"])).toBe("worked");
  });
  it("planned when only non-mutating tools ran", () => {
    expect(classifyVerb(["Read", "Grep"])).toBe("planned");
    expect(classifyVerb(["ExitPlanMode"])).toBe("planned");
  });
  it("answered when no tools ran", () => {
    expect(classifyVerb([])).toBe("answered");
  });
});

describe("summarizeTurn", () => {
  const tool = (name: string, input: Record<string, unknown> = {}) => ({ name, input });

  it("lists edited file basenames", () => {
    const r = summarizeTurn(
      [tool("Edit", { file_path: "src/a.ts" }), tool("Write", { file_path: "deep/b.ts" })], "");
    expect(r.text).toBe("edited a.ts, b.ts");
    expect(r.verb).toBe("worked");
  });

  it("caps the edited list at three names with an overflow count", () => {
    const r = summarizeTurn([
      tool("Edit", { file_path: "a.ts" }), tool("Edit", { file_path: "b.ts" }),
      tool("Write", { file_path: "c.ts" }), tool("Write", { file_path: "d.ts" }),
    ], "");
    expect(r.text).toBe("edited a.ts, b.ts, c.ts +1");
  });

  it("appends build/test/commit/push flags detected from bash", () => {
    const r = summarizeTurn([
      tool("Edit", { file_path: "x.ts" }),
      tool("Bash", { command: "npm run build && npm test" }),
      tool("Bash", { command: "git commit -m wip && git push" }),
    ], "");
    expect(r.text).toBe("edited x.ts · built · ran tests · committed · pushed");
  });

  it("summarizes plans, questions, subagents, research, and exploration", () => {
    expect(summarizeTurn([tool("ExitPlanMode")], "").text).toBe("presented a plan");
    expect(summarizeTurn([tool("AskUserQuestion")], "").text).toBe("asked a question");
    expect(summarizeTurn([tool("Agent"), tool("Agent")], "").text).toBe("ran 2 subagents");
    expect(summarizeTurn([tool("WebSearch")], "").text).toBe("researched");
    expect(summarizeTurn(
      [tool("Read", { file_path: "a.ts" }), tool("Read", { file_path: "b.ts" })], "").text)
      .toBe("explored 2 files");
    expect(summarizeTurn([tool("Grep", { pattern: "x" })], "").text).toBe("searched the codebase");
  });

  it("upgrades the verb to worked when a turn commits without editing", () => {
    const r = summarizeTurn([tool("Bash", { command: "git commit -m x" })], "");
    expect(r.text).toBe("committed");
    expect(r.verb).toBe("worked");
  });

  it("falls back to the first sentence when no tools ran", () => {
    expect(summarizeTurn([], "I dug into the parser. Then more details.").text)
      .toBe("I dug into the parser.");
    expect(summarizeTurn([], "").text).toBe("answered");
  });
});

describe("readConversation", () => {
  const tmp = useTmpHome();

  function writeTranscript(lines: Array<Record<string, unknown>>): string {
    const p = path.join(tmp.sessionsDir, "transcript.jsonl");
    fs.writeFileSync(p, jsonl(lines));
    return p;
  }

  it("assembles turns with action summaries and excludes noise", () => {
    const p = writeTranscript([
      // command/attachment noise types are ignored
      { type: "queue-operation" },
      { type: "last-prompt", lastPrompt: "first question" },
      user("first question", "2026-05-30T17:00:00Z"),
      assistant([{ type: "thinking", thinking: "hmm" }]),
      assistant([{ type: "text", text: "Let me look." }]),
      assistant([{ type: "tool_use", name: "Edit", input: { file_path: "src/foo.ts" } }]),
      // tool_result comes back as type:user with array content — must be skipped
      user([{ type: "tool_result", content: "ok" }]),
      assistant([{ type: "tool_use", name: "Bash", input: { command: "git commit -m fix" } }]),

      user("second question", "2026-05-30T17:01:00Z"),
      assistant([{ type: "tool_use", name: "Read", input: { file_path: "src/bar.ts" } }]),
      assistant([{ type: "text", text: "Here is the answer." }]),

      user("third", "2026-05-30T17:02:00Z"),
      assistant([{ type: "text", text: "Just a reply." }]),
    ]);

    expect(readConversation(p)).toEqual([
      { role: "user", text: "first question", ts: "2026-05-30T17:00:00Z" },
      { role: "assistant", text: "edited foo.ts · committed", verb: "worked", ts: "2026-05-30T17:00:01Z" },
      { role: "user", text: "second question", ts: "2026-05-30T17:01:00Z" },
      { role: "assistant", text: "explored 1 file", verb: "planned", ts: "2026-05-30T17:00:01Z" },
      { role: "user", text: "third", ts: "2026-05-30T17:02:00Z" },
      { role: "assistant", text: "Just a reply.", verb: "answered", ts: "2026-05-30T17:00:01Z" },
    ]);
  });

  it("captures a prompt with an image attachment (array content)", () => {
    const p = writeTranscript([
      user([{ type: "text", text: "look at this screenshot" }, { type: "image", source: {} }]),
      assistant([{ type: "text", text: "I see it." }]),
    ]);
    expect(readConversation(p)).toEqual([
      { role: "user", text: "look at this screenshot", ts: "2026-05-30T17:00:00Z" },
      { role: "assistant", text: "I see it.", verb: "answered", ts: "2026-05-30T17:00:01Z" },
    ]);
  });

  it("excludes isMeta lines and flags an inline [Image #N] prompt", () => {
    const p = writeTranscript([
      user("Better, see this [Image #5]"),
      // the attachment surfaces as a separate isMeta user message — must be dropped
      user("[Image: source: /tmp/NSIRD/Screenshot.png]", "2026-05-30T17:00:30Z", { isMeta: true }),
      assistant([{ type: "text", text: "Got it." }]),
    ]);
    expect(readConversation(p)).toEqual([
      { role: "user", text: "Better, see this", ts: "2026-05-30T17:00:00Z", image: true },
      { role: "assistant", text: "Got it.", verb: "answered", ts: "2026-05-30T17:00:01Z" },
    ]);
  });

  it("excludes sidechain (subagent) lines", () => {
    const p = writeTranscript([
      user("real prompt"),
      assistant([{ type: "text", text: "real answer" }]),
      user("sub task", "2026-05-30T17:00:00Z", { isSidechain: true }),
      assistant([{ type: "text", text: "sub answer" }], "2026-05-30T17:00:01Z", { isSidechain: true }),
    ]);
    const turns = readConversation(p);
    expect(turns).toEqual([
      { role: "user", text: "real prompt", ts: "2026-05-30T17:00:00Z" },
      { role: "assistant", text: "real answer", verb: "answered", ts: "2026-05-30T17:00:01Z" },
    ]);
  });

  it("drops garden-injected [garden] prompts and their responses", () => {
    const p = writeTranscript([
      user("real prompt one"),
      assistant([{ type: "text", text: "real answer one" }]),
      // merge auto-continue: injected as a user prompt, tagged [garden]
      user("[garden] Your previous changes were reviewed and merged. Continue…", "2026-05-30T17:05:00Z"),
      assistant([{ type: "tool_use", name: "Edit" }], "2026-05-30T17:05:01Z"),
      assistant([{ type: "text", text: "auto-continue housekeeping" }], "2026-05-30T17:05:02Z"),
      user("real prompt two", "2026-05-30T17:06:00Z"),
      assistant([{ type: "text", text: "real answer two" }], "2026-05-30T17:06:01Z"),
    ]);
    expect(readConversation(p)).toEqual([
      { role: "user", text: "real prompt one", ts: "2026-05-30T17:00:00Z" },
      { role: "assistant", text: "real answer one", verb: "answered", ts: "2026-05-30T17:00:01Z" },
      { role: "user", text: "real prompt two", ts: "2026-05-30T17:06:00Z" },
      { role: "assistant", text: "real answer two", verb: "answered", ts: "2026-05-30T17:06:01Z" },
    ]);
  });

  it("collapses whitespace in prompts and the no-tool fallback summary", () => {
    const p = writeTranscript([
      user("multi\n  line\nprompt"),
      assistant([{ type: "text", text: "Intro line.\n\nmore   detail here" }]),
    ]);
    expect(readConversation(p)).toEqual([
      { role: "user", text: "multi line prompt", ts: "2026-05-30T17:00:00Z" },
      // no tools → first sentence of the response
      { role: "assistant", text: "Intro line.", verb: "answered", ts: "2026-05-30T17:00:01Z" },
    ]);
  });

  it("strips terminal escape sequences from prompts and action summaries", () => {
    // Both display paths route worker-controlled text through stripControlSequences:
    // the operator prompt via collapse(), and the action summary (a worker-chosen
    // file_path) via summarizeTurn — so neither can smuggle a cursor-move / CR into
    // the ⌥h history render.
    const p = writeTranscript([
      user("say \x1b[31mred\x1b[0m now"),
      assistant([{ type: "tool_use", name: "Edit", input: { file_path: "src/a\x1b[2Jfoo\rbar.ts" } }]),
    ]);
    expect(readConversation(p)).toEqual([
      { role: "user", text: "say red now", ts: "2026-05-30T17:00:00Z" },
      // tool-only turn: ts is inherited from the preceding prompt (no text block to restamp it).
      { role: "assistant", text: "edited afoobar.ts", verb: "worked", ts: "2026-05-30T17:00:00Z" },
    ]);
  });

  it("keeps only the last maxTurns entries", () => {
    const lines: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 10; i++) {
      lines.push(user(`q${i}`));
      lines.push(assistant([{ type: "text", text: `a${i}` }]));
    }
    const p = writeTranscript(lines);
    const turns = readConversation(p, 4);
    expect(turns.length).toBe(4);
    expect(turns[turns.length - 1]).toEqual({
      role: "assistant", text: "a9", verb: "answered", ts: "2026-05-30T17:00:01Z",
    });
  });

  it("returns [] for a missing or null path", () => {
    expect(readConversation(null)).toEqual([]);
    expect(readConversation(path.join(tmp.sessionsDir, "nope.jsonl"))).toEqual([]);
  });

  it("skips unparseable lines without throwing", () => {
    const p = path.join(tmp.sessionsDir, "broken.jsonl");
    fs.writeFileSync(p, `not json\n${JSON.stringify(user("hi"))}\n{bad\n`);
    expect(readConversation(p)).toEqual([
      { role: "user", text: "hi", ts: "2026-05-30T17:00:00Z" },
    ]);
  });
});

describe("formatConversationPane", () => {
  // Strip ANSI so assertions read the plain layout.
  const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

  const turns: Turn[] = [
    { role: "user", text: "fix the login bug", ts: "" },
    { role: "assistant", text: "Patched the token check.", verb: "worked", ts: "" },
  ];

  it("opens each exchange with a divider, then the you/verb gutter lines", () => {
    const out = formatConversationPane(turns, { width: 60 }).map(plain);
    expect(out[0]).toMatch(/^─ ─+$/); // divider (no timestamp for ts:"")
    expect(out[1]).toMatch(/^ you\s+fix the login bug$/);
    expect(out[2]).toMatch(/^ worked\s+Patched the token check\.$/);
  });

  it("labels the divider with the local time when a timestamp is present", () => {
    const out = formatConversationPane(
      [{ role: "user", text: "hi", ts: "2026-05-30T17:00:00Z" }], { width: 60 }).map(plain);
    // Time is local, so don't assert the exact value — just the shape.
    expect(out[0]).toMatch(/^─ \d{1,2}:\d{2}(am|pm) ─+$/);
  });

  it("appends a dim [screenshot] marker to a prompt that carried an image", () => {
    const out = formatConversationPane(
      [{ role: "user", text: "look at this", ts: "", image: true }], { width: 60 }).map(plain);
    expect(out.some(l => l.includes("[screenshot]"))).toBe(true);
  });

  it("wraps long bodies into the gutter-aligned continuation", () => {
    const long: Turn[] = [{ role: "user", text: "a b c d e f g h i j k l", ts: "" }];
    const out = formatConversationPane(long, { width: 24 }).map(plain);
    expect(out.length).toBeGreaterThan(2); // divider + at least two wrapped lines
    // Continuation lines are indented to the gutter (no "you" label).
    expect(out[2]).toMatch(/^ {10}/);
  });

  it("appends a live status indicator when the worker is busy", () => {
    expect(formatConversationPane(turns, { width: 60, status: "working" }).map(plain).at(-1))
      .toMatch(/working…/);
    expect(formatConversationPane(turns, { width: 60, status: "asking" }).map(plain).at(-1))
      .toMatch(/asking…/);
  });

  it("inserts a blank separator before each exchange after the first", () => {
    const two: Turn[] = [
      { role: "user", text: "one", ts: "" },
      { role: "assistant", text: "first", verb: "answered", ts: "" },
      { role: "user", text: "two", ts: "" },
      { role: "assistant", text: "second", verb: "answered", ts: "" },
    ];
    const out = formatConversationPane(two, { width: 60 }).map(plain);
    expect(out).toContain(""); // blank line between the two exchanges
  });
});

describe("resolveTranscriptPath", () => {
  const tmp = useTmpHome();

  const baseEntry = (over: Partial<WorkerEntry>): WorkerEntry => ({
    name: "fond-lush-coal",
    sessionId: "sid-123",
    task: "",
    ...over,
  });

  it("prefers the captured transcriptPath when readable", () => {
    const p = path.join(tmp.sessionsDir, "captured.jsonl");
    fs.writeFileSync(p, "");
    expect(resolveTranscriptPath(baseEntry({ transcriptPath: p }))).toBe(p);
  });

  it("derives ~/.claude/projects/<enc>/<sid>.jsonl from worktreePath + sessionId", () => {
    const worktreePath = path.join(tmp.home, ".garden", "worktrees", "board", "fond-lush-coal");
    const encoded = worktreePath.replace(/[/.]/g, "-");
    const derived = path.join(tmp.home, ".claude", "projects", encoded, "sid-123.jsonl");
    fs.mkdirSync(path.dirname(derived), { recursive: true });
    fs.writeFileSync(derived, "");

    expect(resolveTranscriptPath(baseEntry({ worktreePath }))).toBe(derived);
  });

  it("returns null when neither exists", () => {
    expect(resolveTranscriptPath(baseEntry({ transcriptPath: "/nope.jsonl" }))).toBeNull();
  });
});

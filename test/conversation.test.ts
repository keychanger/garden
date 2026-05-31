import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  readConversation,
  classifyVerb,
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

describe("readConversation", () => {
  const tmp = useTmpHome();

  function writeTranscript(lines: Array<Record<string, unknown>>): string {
    const p = path.join(tmp.sessionsDir, "transcript.jsonl");
    fs.writeFileSync(p, jsonl(lines));
    return p;
  }

  it("assembles turns, classifies verbs, and excludes noise", () => {
    const p = writeTranscript([
      // command/attachment noise types are ignored
      { type: "queue-operation" },
      { type: "last-prompt", lastPrompt: "first question" },
      user("first question", "2026-05-30T17:00:00Z"),
      assistant([{ type: "thinking", thinking: "hmm" }]),
      assistant([{ type: "text", text: "Let me look." }]),
      assistant([{ type: "tool_use", name: "Edit" }]),
      // tool_result comes back as type:user with array content — must be skipped
      user([{ type: "tool_result", content: "ok" }]),
      assistant([{ type: "text", text: "Done.\n\nFixed the bug in foo.ts." }], "2026-05-30T17:00:05Z"),

      user("second question", "2026-05-30T17:01:00Z"),
      assistant([{ type: "tool_use", name: "Read" }]),
      assistant([{ type: "text", text: "Here is the answer." }]),

      user("third", "2026-05-30T17:02:00Z"),
      assistant([{ type: "text", text: "Just a reply." }]),
    ]);

    expect(readConversation(p)).toEqual([
      { role: "user", text: "first question", ts: "2026-05-30T17:00:00Z" },
      { role: "assistant", text: "Fixed the bug in foo.ts.", verb: "worked", ts: "2026-05-30T17:00:05Z" },
      { role: "user", text: "second question", ts: "2026-05-30T17:01:00Z" },
      { role: "assistant", text: "Here is the answer.", verb: "planned", ts: "2026-05-30T17:00:01Z" },
      { role: "user", text: "third", ts: "2026-05-30T17:02:00Z" },
      { role: "assistant", text: "Just a reply.", verb: "answered", ts: "2026-05-30T17:00:01Z" },
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

  it("collapses whitespace in prompts and the last paragraph", () => {
    const p = writeTranscript([
      user("multi\n  line\nprompt"),
      assistant([{ type: "text", text: "intro para\n\nfinal\nline   here" }]),
    ]);
    expect(readConversation(p)).toEqual([
      { role: "user", text: "multi line prompt", ts: "2026-05-30T17:00:00Z" },
      { role: "assistant", text: "final line here", verb: "answered", ts: "2026-05-30T17:00:01Z" },
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

  it("renders a you-label and verb-label gutter, oldest at top", () => {
    const out = formatConversationPane(turns, { width: 60 }).map(plain);
    expect(out[0]).toMatch(/^ you\s+fix the login bug$/);
    expect(out[1]).toMatch(/^ worked\s+Patched the token check\.$/);
  });

  it("wraps long bodies into the gutter-aligned continuation", () => {
    const long: Turn[] = [{ role: "user", text: "a b c d e f g h i j k l", ts: "" }];
    const out = formatConversationPane(long, { width: 24 }).map(plain);
    expect(out.length).toBeGreaterThan(1);
    // Continuation lines are indented to the gutter (no "you" label).
    expect(out[1]).toMatch(/^ {10}/);
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

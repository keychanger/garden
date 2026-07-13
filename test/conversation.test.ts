import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  readConversation,
  classifyVerb,
  summarizeTurn,
  resolveTranscriptPath,
  sumTranscriptUsage,
  formatConversationPane,
  gardenLabel,
  isInjectedSystemMessage,
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

describe("sumTranscriptUsage", () => {
  // Write a transcript to a throwaway file and return its path.
  function writeTranscript(content: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-usage-"));
    const p = path.join(dir, "t.jsonl");
    fs.writeFileSync(p, content);
    return p;
  }
  function asstUsage(id: string, usage: Record<string, number>, model = "claude-opus-4-8") {
    return {
      type: "assistant",
      message: { role: "assistant", id, model, usage, content: [{ type: "text", text: "hi" }] },
      timestamp: "2026-07-13T00:00:00Z",
    };
  }

  it("dedupes by message.id — streaming re-emits of one message count once", () => {
    // m1 appears 3x, m2 appears 2x (Claude Code re-emits each on every stream
    // update with the message's cumulative usage). A naive per-line sum would
    // 3x/2x-overcount; the correct total sums one usage per unique id.
    const u1 = { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 500 };
    const u2 = { input_tokens: 20, output_tokens: 200, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 };
    const content = jsonl([
      user("go"),
      asstUsage("m1", u1), asstUsage("m1", u1), asstUsage("m1", u1),
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "no usage here" }] }, timestamp: "t" },
      asstUsage("m2", u2), asstUsage("m2", u2),
    ]);
    const got = sumTranscriptUsage(writeTranscript(content));
    expect(got).not.toBeNull();
    expect(got!.turns).toBe(2);
    expect(got!.inputTokens).toBe(30);      // 10 + 20, not 10*3 + 20*2
    expect(got!.outputTokens).toBe(300);    // 100 + 200
    expect(got!.cacheReadTokens).toBe(3000);
    expect(got!.cacheCreationTokens).toBe(500);
    expect(got!.model).toBe("claude-opus-4-8");
  });

  it("captures the last assistant message's model as ground truth", () => {
    const u = { input_tokens: 1, output_tokens: 1 };
    const content = jsonl([
      asstUsage("a", u, "claude-sonnet-5"),
      asstUsage("b", u, "claude-fable-5"),
    ]);
    expect(sumTranscriptUsage(writeTranscript(content))!.model).toBe("claude-fable-5");
  });

  it("returns null for a missing transcript or a null path", () => {
    expect(sumTranscriptUsage(null)).toBeNull();
    expect(sumTranscriptUsage("/no/such/transcript.jsonl")).toBeNull();
  });

  it("returns null when no assistant message carries usage", () => {
    const content = jsonl([
      user("hi"),
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "no usage" }] }, timestamp: "t" },
    ]);
    expect(sumTranscriptUsage(writeTranscript(content))).toBeNull();
  });

  it("counts id-less usage-bearing messages once each", () => {
    const u = { input_tokens: 5, output_tokens: 7 };
    const content = jsonl([
      { type: "assistant", message: { role: "assistant", model: "m", usage: u, content: [] }, timestamp: "t" },
      { type: "assistant", message: { role: "assistant", model: "m", usage: u, content: [] }, timestamp: "t" },
    ]);
    const got = sumTranscriptUsage(writeTranscript(content))!;
    expect(got.turns).toBe(2);
    expect(got.outputTokens).toBe(14);
  });
});

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
    expect(summarizeTurn([tool("Workflow")], "").text).toBe("ran a workflow");
    expect(summarizeTurn(
      [tool("Read", { file_path: "a.ts" }), tool("Read", { file_path: "b.ts" })], "").text)
      .toBe("explored 2 files");
    expect(summarizeTurn([tool("Grep", { pattern: "x" })], "").text).toBe("searched the codebase");
  });

  it("leads with the workflow, then the concrete work it drove", () => {
    const r = summarizeTurn([
      tool("Workflow"),
      tool("Edit", { file_path: "notes.md" }),
      tool("Bash", { command: "git commit -m x && git push" }),
    ], "");
    expect(r.text).toBe("ran a workflow · edited notes.md · committed · pushed");
    expect(r.verb).toBe("worked");
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

  it("renders a garden continuation as a compact marker and keeps its response", () => {
    const p = writeTranscript([
      user("real prompt one"),
      assistant([{ type: "text", text: "real answer one" }]),
      // merge auto-continue: injected as a user prompt, tagged [garden]. It reads
      // as a typed prompt (garden pastes it), so the [garden] fence identifies it.
      user("[garden] Your previous changes were reviewed and merged. Continue…",
        "2026-05-30T17:05:00Z", { promptSource: "typed" }),
      assistant([{ type: "tool_use", name: "Edit", input: { file_path: "a.ts" } }], "2026-05-30T17:05:01Z"),
      assistant([{ type: "tool_use", name: "Bash", input: { command: "git push" } }], "2026-05-30T17:05:02Z"),
      user("real prompt two", "2026-05-30T17:06:00Z"),
      assistant([{ type: "text", text: "real answer two" }], "2026-05-30T17:06:01Z"),
    ]);
    expect(readConversation(p)).toEqual([
      { role: "user", text: "real prompt one", ts: "2026-05-30T17:00:00Z" },
      { role: "assistant", text: "real answer one", verb: "answered", ts: "2026-05-30T17:00:01Z" },
      { role: "garden", text: "continue after merge", ts: "2026-05-30T17:05:00Z" },
      { role: "assistant", text: "edited a.ts · pushed", verb: "worked", ts: "2026-05-30T17:05:00Z" },
      { role: "user", text: "real prompt two", ts: "2026-05-30T17:06:00Z" },
      { role: "assistant", text: "real answer two", verb: "answered", ts: "2026-05-30T17:06:01Z" },
    ]);
  });

  it("skips a system-injected task-notification so its turn folds into one summary", () => {
    const p = writeTranscript([
      user("kick off the research"),
      // launch a background workflow, then end the turn
      assistant([{ type: "tool_use", name: "Workflow", input: {} }], "2026-05-30T17:00:01Z"),
      // the completion arrives as a user-role message with promptSource:"system"
      user("<task-notification>\n<status>completed</status>\n" + "x".repeat(9000) + "\n</task-notification>",
        "2026-05-30T17:20:00Z", { promptSource: "system" }),
      // the agent resumes in a fresh assistant message — folds into the same turn
      assistant([{ type: "tool_use", name: "Edit", input: { file_path: "out.md" } }], "2026-05-30T17:20:01Z"),
      assistant([{ type: "tool_use", name: "Bash", input: { command: "git commit -m x" } }], "2026-05-30T17:20:02Z"),
    ]);
    expect(readConversation(p)).toEqual([
      { role: "user", text: "kick off the research", ts: "2026-05-30T17:00:00Z" },
      // tool-only turn: ts inherited from the prompt that seeded it (no text block to restamp).
      { role: "assistant", text: "ran a workflow · edited out.md · committed", verb: "worked", ts: "2026-05-30T17:00:00Z" },
    ]);
  });

  it("skips legacy synthetic wrapper messages that lack promptSource", () => {
    const p = writeTranscript([
      user("real prompt"),
      assistant([{ type: "text", text: "real answer" }]),
      // old transcript: no promptSource field, recognized by its wrapper tag
      user("<local-command-stdout>build ok</local-command-stdout>", "2026-05-30T17:05:00Z"),
      user("real prompt two", "2026-05-30T17:06:00Z"),
      assistant([{ type: "text", text: "second answer" }], "2026-05-30T17:06:01Z"),
    ]);
    expect(readConversation(p)).toEqual([
      { role: "user", text: "real prompt", ts: "2026-05-30T17:00:00Z" },
      { role: "assistant", text: "real answer", verb: "answered", ts: "2026-05-30T17:00:01Z" },
      { role: "user", text: "real prompt two", ts: "2026-05-30T17:06:00Z" },
      { role: "assistant", text: "second answer", verb: "answered", ts: "2026-05-30T17:06:01Z" },
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

  it("renders a garden marker with its own timestamped divider and a garden gutter", () => {
    const out = formatConversationPane([
      { role: "user", text: "do the thing", ts: "" },
      { role: "assistant", text: "did it.", verb: "worked", ts: "" },
      { role: "garden", text: "continue after merge", ts: "" },
      { role: "assistant", text: "kept going.", verb: "worked", ts: "" },
    ], { width: 60 }).map(plain);
    const marker = out.findIndex(l => /^ garden\s+continue after merge$/.test(l));
    expect(marker).toBeGreaterThan(0);
    expect(out[marker - 1]).toMatch(/^─ ─+$/); // divider precedes the marker
  });

  it("appends a live status indicator when the worker is busy", () => {
    expect(formatConversationPane(turns, { width: 60, status: "working" }).map(plain).at(-1))
      .toMatch(/working…/);
    expect(formatConversationPane(turns, { width: 60, status: "asking" }).map(plain).at(-1))
      .toMatch(/asking…/);
  });

  it("never prints a rendered line wider than the pane width", () => {
    // Regression: the gutter overhead is " " + label(8) + " " = 10 chars, but
    // textWidth used to reserve only 9, so a line ending in a full-width word
    // was exactly one char too long — invisible here, but the terminal itself
    // hard-wraps that overflow char onto a bare continuation row (the dangling
    // "g" bug), which plain string assertions on wrapText's own output can't see.
    const long: Turn[] = [{
      role: "user",
      text: "workstation Please dive deeply and assess what it would take to release garden to my friend I am fine with maintaining",
      ts: "",
    }];
    for (let width = 20; width <= 80; width++) {
      const out = formatConversationPane(long, { width }).map(plain);
      for (const line of out) {
        expect(line.length).toBeLessThanOrEqual(width);
      }
    }
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

describe("gardenLabel", () => {
  // The branch-identity preamble leads most continuation prompts, so labels are
  // matched on the distinctive phrase anywhere in the text.
  const preamble = "[garden] You are working in your own git worktree on branch `x`. ";
  it("classifies each continuation kind", () => {
    expect(gardenLabel(preamble + "Your previous changes were reviewed and merged. Before you decide"))
      .toBe("continue after merge");
    expect(gardenLabel("[garden] You were interrupted by a restart. Continue"))
      .toBe("resumed after interrupt");
    expect(gardenLabel("[garden] Handoff callback: proj/worker reached terminal state `merged`."))
      .toBe("handoff callback");
    expect(gardenLabel("[garden] Worker `spry` just merged into main: some title"))
      .toBe("sibling merged");
    expect(gardenLabel("[garden] Your last iteration was merged. Iteration 3 of 5 — keep growing this codebase."))
      .toBe("grow iteration 3");
    expect(gardenLabel("[garden] Grow loop, iteration 1 of 5."))
      .toBe("grow start");
    expect(gardenLabel("[garden] Your previous iteration was merged. The trellis at `t.md`"))
      .toBe("trellis iteration");
    expect(gardenLabel("[garden] You are a trellis vine bound to `t.md`."))
      .toBe("trellis start");
    expect(gardenLabel("[garden] Please invoke the `trellis-author` skill"))
      .toBe("author a trellis");
  });
  it("falls back to a generic autocontinue label", () => {
    expect(gardenLabel("[garden] Something new we don't recognize yet")).toBe("autocontinue");
  });
});

describe("isInjectedSystemMessage", () => {
  it("trusts promptSource when present", () => {
    expect(isInjectedSystemMessage("anything", "typed")).toBe(false);
    expect(isInjectedSystemMessage("anything", "queued")).toBe(false);
    expect(isInjectedSystemMessage("<task-notification>…", "system")).toBe(true);
  });
  it("falls back to wrapper-tag matching when promptSource is absent", () => {
    expect(isInjectedSystemMessage("<task-notification> …", undefined)).toBe(true);
    expect(isInjectedSystemMessage("<local-command-caveat> …", undefined)).toBe(true);
    expect(isInjectedSystemMessage("a normal typed prompt", undefined)).toBe(false);
    // a genuine prompt that merely mentions a tag name is not injected
    expect(isInjectedSystemMessage("what does <task-notification> mean?", undefined)).toBe(false);
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

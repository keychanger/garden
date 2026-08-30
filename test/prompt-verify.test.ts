import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  classifyPromptDelivery,
  readLandedPrompt,
  verifiableHarnesses,
} from "../src/dashboard/prompt-verify.js";
import { harnessNames } from "../src/dashboard/harness/core.js";

// The full post-merge prompt shape, abridged. The real failure landed as a
// mid-sentence suffix of exactly this text.
const SENT =
  "[garden] You are working in your own git worktree on branch `wan-smooth-mead`.\n\n"
  + "[garden] Your previous changes were reviewed and merged. Do NOT invent additional "
  + "work. This prompt is the merge notification, not an instruction to find more to do.";

describe("classifyPromptDelivery", () => {
  it("reports an exact landing intact", () => {
    expect(classifyPromptDelivery(SENT, SENT, null)).toBe("intact");
  });

  it("ignores whitespace re-wrapping when comparing", () => {
    const rewrapped = SENT.replace(/\n\n/g, "\n").replace(/ /g, "  ");
    expect(classifyPromptDelivery(SENT, rewrapped, null)).toBe("intact");
  });

  // The regression: what actually reached wan-smooth-mead on 2026-08-29.
  it("reports the observed mid-sentence suffix as truncated", () => {
    expect(classifyPromptDelivery(SENT, " to find more to do.", null)).toBe("truncated");
  });

  it("reports a dropped tail as truncated too", () => {
    expect(classifyPromptDelivery(SENT, SENT.slice(0, 120), null)).toBe("truncated");
  });

  // The watcher clears this baseline once the prompt hook acknowledges a new
  // turn. Until then, identical text is the old tail, not a new delivery.
  it("keeps an identical baseline pending until the transcript advances", () => {
    expect(classifyPromptDelivery(SENT, SENT, SENT)).toBe("pending");
  });

  it("stays pending while the transcript still shows the pre-paste prompt", () => {
    const before = "an earlier operator message";
    expect(classifyPromptDelivery(SENT, before, before)).toBe("pending");
  });

  it("stays pending when nothing is readable", () => {
    expect(classifyPromptDelivery(SENT, null, null)).toBe("pending");
    expect(classifyPromptDelivery(SENT, "   ", null)).toBe("pending");
  });

  // Narrowness is the safety property: anything that is not our own text, whole
  // or in part, must never trigger a re-paste.
  it("stays pending on unrelated text rather than re-delivering", () => {
    expect(classifyPromptDelivery(SENT, "actually, stop and do X instead", null)).toBe("pending");
  });

  it("stays pending when the landed text merely overlaps ours", () => {
    expect(classifyPromptDelivery(SENT, "find more to do. Also please rebase.", null)).toBe("pending");
  });

  it("stays pending on a middle-only substring rather than guessing truncation", () => {
    expect(classifyPromptDelivery(SENT, "reviewed and merged. Do NOT invent", null)).toBe("pending");
  });

  it("stays pending on a short common prefix or suffix", () => {
    expect(classifyPromptDelivery(SENT, "[garden]", null)).toBe("pending");
    expect(classifyPromptDelivery(SENT, "more to do.", null)).toBe("pending");
  });
});

describe("readLandedPrompt", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "garden-verify-"));

  it("returns null without a transcript path", () => {
    expect(readLandedPrompt("claude-code", null)).toBeNull();
    expect(readLandedPrompt("claude-code", undefined)).toBeNull();
  });

  it("returns null for an unreadable transcript rather than throwing", () => {
    expect(readLandedPrompt("claude-code", path.join(tmp, "absent.jsonl"))).toBeNull();
  });

  it("reads the newest claude-code prompt verbatim, skipping injected records", () => {
    const f = path.join(tmp, "claude.jsonl");
    fs.writeFileSync(f, [
      JSON.stringify({ type: "user", promptSource: "typed", message: { content: "older prompt" } }),
      JSON.stringify({ type: "assistant", message: { model: "claude-opus-5", content: [] } }),
      JSON.stringify({ type: "user", promptSource: "typed", message: { content: SENT } }),
      JSON.stringify({
        type: "user", promptSource: "typed", isSidechain: true,
        message: { content: "subagent prompt" },
      }),
      JSON.stringify({
        type: "user", promptSource: "typed", isMeta: true,
        message: { content: "[Image: source: /tmp/screenshot.png]" },
      }),
      // A task notification is a user-role record but not a prompt; counting it
      // would report "a prompt landed" for something the operator never sent.
      JSON.stringify({
        type: "user",
        promptSource: "system",
        message: { content: "<task-notification>done</task-notification>" },
      }),
    ].join("\n") + "\n");
    expect(readLandedPrompt("claude-code", f)).toBe(SENT);
  });

  it("joins multi-part claude-code content", () => {
    const f = path.join(tmp, "parts.jsonl");
    fs.writeFileSync(f, JSON.stringify({
      type: "user",
      promptSource: "typed",
      message: { content: [{ type: "text", text: "first " }, { type: "text", text: "second" }] },
    }) + "\n");
    expect(readLandedPrompt("claude-code", f)).toBe("first second");
  });

  it("reads the newest codex prompt, skipping the injected rules block", () => {
    const f = path.join(tmp, "codex.jsonl");
    fs.writeFileSync(f, [
      JSON.stringify({
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "older prompt" }] },
      }),
      JSON.stringify({
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: SENT }] },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "# AGENTS.md instructions\n\nrules here" }],
        },
      }),
    ].join("\n") + "\n");
    expect(readLandedPrompt("codex", f)).toBe(SENT);
  });

  // The dispatch is a table rather than a HarnessCore method (see the module
  // header: the hook bundle cannot afford the method). This is the check that
  // replaces the one the type system would have made — without it a new
  // harness silently loses delivery verification.
  it("has a reader for every registered harness", () => {
    expect([...verifiableHarnesses()].sort()).toEqual([...harnessNames()].sort());
  });

  it("returns null for an unregistered harness instead of guessing", () => {
    const f = path.join(tmp, "claude.jsonl");
    expect(readLandedPrompt("some-future-harness", f)).toBeNull();
  });
});

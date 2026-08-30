// Reading back the prompt a worker actually received.
//
// Garden pastes prompts into a TUI, and a paste that arrives mangled still
// submits. `continueSentAt` is cleared by ANY UserPromptSubmit, so a prompt
// that landed as a fragment of itself read as delivered, fired no retry, and
// left no trace — that is how post-merge prompts truncated for days while
// every log line said "continue sent" (see DESIGN.md "Paste delivery"). The
// ground truth is the transcript: whatever the harness recorded is what the
// model actually received.
//
// This module is a LEAF on purpose. `continue.ts` is reachable from the lean
// `dist/hook.js` bundle (hooks/default.ts imports its sentinel helpers), and
// that bundle sits under a hard 128KB ceiling with under 1KB of headroom.
// Hanging the reader off HarnessCore instead costs that headroom
// unconditionally: the core objects are object literals held live by the CORES
// registry, so their method bodies cannot be tree-shaken, and the hook bundle
// pays for a reader it never calls (measured: +1251 bytes, over the ceiling).
// Reached only from continueWorker, the whole module shakes out instead.
//
// The cost of that split is that the harness dispatch is a table here rather
// than an interface method the type checker enforces — so a new harness gets no
// verification unless it adds a row. `prompt-verify.test.ts` asserts the table
// covers every registered harness, which is the guarantee the interface would
// have given.

import { readLatestPrompt } from "./conversation.js";
import { readCodexLatestPrompt } from "./harness/codex-core.js";
import { DEFAULT_HARNESS } from "./harness/core.js";

/** Newest genuine prompt in a transcript, VERBATIM. Each reader must skip its
 *  harness's injected user-role records (task notifications, command echoes,
 *  rules blocks) — those would read as "a prompt landed" — and must not
 *  collapse, label, condense, or truncate, since the caller compares the result
 *  against what garden pasted. Tail-read: this runs once per delivery. */
export type LandedPromptReader = (transcriptPath: string) => string | null;

const READERS: Record<string, LandedPromptReader> = {
  "claude-code": readLatestPrompt,
  codex: readCodexLatestPrompt,
};

/** Exposed for the coverage test; not a runtime lookup. */
export function verifiableHarnesses(): string[] {
  return Object.keys(READERS);
}

// Null means "cannot verify" — no transcript yet, an unreadable one, or a
// harness with no reader. Every caller leaves delivery on its pre-existing
// terms in that case rather than guessing at a mismatch.
export function readLandedPrompt(
  harnessName: string | undefined,
  transcriptPath: string | null | undefined,
): string | null {
  if (!transcriptPath) return null;
  const reader = READERS[harnessName ?? DEFAULT_HARNESS];
  return reader ? reader(transcriptPath) : null;
}

// Collapse whitespace so a comparison cannot fail on a TUI's own re-wrapping or
// a trailing newline. Truncation — the failure being detected — survives this.
function normalizePrompt(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Did the prompt we pasted land intact? Pure, so the rule is testable without
 *  a live TUI.
 *
 *  - `intact`    — the landed text IS ours. Checked BEFORE any change
 *                  detection, so re-sending identical text (the retry legs do)
 *                  still classifies correctly.
 *  - `truncated` — the landed text is a proper fragment OF ours. Deliberately
 *                  narrow: only the observed failure shape is actionable, and
 *                  re-delivering on anything else would risk double-prompting a
 *                  worker over a comparison quirk.
 *  - `pending`   — nothing new has landed yet, or what landed is unrelated (the
 *                  operator typed over us, a system message raced in). The
 *                  caller keeps waiting and ultimately does nothing. */
export function classifyPromptDelivery(
  sent: string,
  landed: string | null,
  landedBefore: string | null,
): "intact" | "truncated" | "pending" {
  if (!landed) return "pending";
  const want = normalizePrompt(sent);
  const got = normalizePrompt(landed);
  if (!got) return "pending";
  if (got === want) return "intact";
  if (landedBefore !== null && got === normalizePrompt(landedBefore)) return "pending";
  if (want.includes(got)) return "truncated";
  return "pending";
}

// Haiku verdict-extraction fallback.
//
// The reviewer is told to end its output with a bare CLEAN/FIXED/FAILED line,
// and parseLastLineVerdict (verdict.ts) scans the trailing lines for a token at
// line-start. When the reviewer instead trails off in prose ("Final suite is
// green (2609 unit + 103 integration, lint clean)."), decorates the token
// (markdown bold, "Verdict: CLEAN"), or dumps test output past the scan window,
// the regex returns null even though the reviewer clearly reached a verdict.
//
// Rather than discard that work and re-run the whole (expensive, Opus) review,
// we hand the reviewer's own output to a cheap Haiku classifier and read the
// verdict back out. This is a text-classification of a conclusion the reviewer
// already reached — NOT a second review — so a small fast model is the right
// tool. The call is synchronous with a hard timeout: the poller already blocks
// on git network I/O (forcePushBranch, fetch) in the same loop, so a bounded
// Haiku call is consistent and avoids an async sub-state. On any failure
// (timeout, spawn error, ambiguous answer) we return null and the caller falls
// back to its existing unparseable-verdict recovery.
import { spawnSync } from "node:child_process";
import { log } from "./log.js";

// Haiku 4.5. A single-token classification over a few KB of text; the strong
// reviewer model is deliberately NOT used here — this reads a conclusion, it
// does not form one.
const EXTRACT_MODEL = "haiku";

// Hard ceiling on the synchronous call. Haiku answers a one-word classification
// in a few seconds including cold start; the cap bounds the poller stall if the
// process wedges (network hang), after which we fall through to re-review.
const EXTRACT_TIMEOUT_MS = 45_000;

// The reviewer's verdict/conclusion lands at the end of its output. Cap the
// input we hand to Haiku to the trailing slice so the call stays cheap and fast
// even when the reviewer dumped a large test log.
const MAX_INPUT_CHARS = 20_000;

const REVIEW_VERDICT_MEANINGS: readonly string[] = [
  "CLEAN  — the reviewer found no issues; the code is ready to merge as-is.",
  "FIXED  — the reviewer found issues and fixed them itself in the worktree.",
  "FAILED — the reviewer found issues it could not fix, or could not finish the review.",
];

const REVIEW_EXTRACT_VOCAB = ["CLEAN", "FIXED", "FAILED"] as const;
export type ReviewVerdictToken = (typeof REVIEW_EXTRACT_VOCAB)[number];

// Pick the single verdict token the classifier's reply names, or null when the
// reply names none (e.g. "UNKNOWN") or more than one (e.g. it echoed the option
// list). Requiring exactly one distinct token is the conservative guard: a
// waffling or non-compliant answer yields null and the caller re-reviews rather
// than merging on a coin-flip. Pure and vocab-generic so it is unit-testable
// without spawning a process.
export function selectVerdictFromResponse<V extends string>(
  response: string,
  vocabulary: readonly V[],
): V | null {
  const upper = response.toUpperCase();
  const present = vocabulary.filter((v) => new RegExp(`\\b${v}\\b`).test(upper));
  return present.length === 1 ? present[0] : null;
}

function buildExtractionPrompt(reviewerOutput: string): string {
  return [
    "You are a text classifier, NOT a code reviewer. Do NOT review any code and",
    "do NOT form your own opinion of the code.",
    "",
    "Below is the complete output of an automated code reviewer. It reached a",
    "conclusion but did not print its verdict on a cleanly parseable final line.",
    "Read the reviewer's OWN conclusion and report which verdict it reached:",
    "",
    ...REVIEW_VERDICT_MEANINGS.map((m) => `  ${m}`),
    "",
    "Reply with EXACTLY ONE of these tokens and nothing else — no punctuation, no",
    "explanation, no markdown, no code fences:",
    "",
    "  CLEAN",
    "  FIXED",
    "  FAILED",
    "",
    "If the reviewer's conclusion is genuinely unclear, reply with the single word",
    "UNKNOWN. Do not guess, and never list more than one token.",
    "",
    "===== BEGIN REVIEWER OUTPUT =====",
    reviewerOutput,
    "===== END REVIEWER OUTPUT =====",
  ].join("\n");
}

export interface ExtractVerdictOptions {
  /** Env for the spawned process. Caller merges process.env with
   *  reviewerEnvObject(project) so the classifier runs on the same first-party
   *  Anthropic account as the reviewer. */
  env?: NodeJS.ProcessEnv;
  /** Override the model (tests). Defaults to Haiku. */
  model?: string;
  /** Override the hard timeout (tests). */
  timeoutMs?: number;
}

// Run the synchronous Haiku classification over a reviewer's output. Returns the
// recovered verdict token, or null on timeout / spawn error / ambiguous answer.
export function extractReviewVerdict(
  reviewerOutput: string,
  opts: ExtractVerdictOptions = {},
): ReviewVerdictToken | null {
  const trimmed = reviewerOutput.trim();
  if (!trimmed) return null;
  const input = trimmed.length > MAX_INPUT_CHARS ? trimmed.slice(-MAX_INPUT_CHARS) : trimmed;
  const prompt = buildExtractionPrompt(input);

  let res: ReturnType<typeof spawnSync>;
  try {
    res = spawnSync("claude", ["-p", "--model", opts.model ?? EXTRACT_MODEL], {
      input: prompt,
      env: opts.env,
      encoding: "utf-8",
      timeout: opts.timeoutMs ?? EXTRACT_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (err) {
    log.warn("poller", "verdict extraction spawn threw", { data: { error: String(err) } });
    return null;
  }
  if (res.error) {
    log.warn("poller", "verdict extraction did not complete", {
      data: { error: String(res.error), signal: res.signal ?? undefined },
    });
    return null;
  }
  const stdout = typeof res.stdout === "string" ? res.stdout : "";
  return selectVerdictFromResponse(stdout, REVIEW_EXTRACT_VOCAB);
}

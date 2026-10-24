// Named reset sets for the WorkerEntry fields that live for one review,
// resolve or ci-fix cycle. Every transition that ends or restarts a cycle has
// to clear the whole set. Written out by hand at each site, the lists drifted:
// the one-shot unparseable marker was cleared by 3 of the 11 sites that
// cleared the review retry counters, so a cycle that ended any other way left
// it set, and the next cycle's first unparseable verdict went straight to
// `failing` instead of getting its retry. Sites spread a set instead, so a new
// per-cycle field is added once, here; test/cycle-resets.test.ts fails on a
// hand-written clear of any member.
//
// Spread a set into the update; the objects are frozen.
import type { WorkerFieldsUpdate } from "./registry.js";

// Review retry bookkeeping. Cleared by every parseable verdict, a worker push
// or edit during the review, a review timeout, each park in `failing` from the
// review path, and `garden kick`. The retry paths that re-queue the same
// review set their own member and keep the rest.
export const FRESH_REVIEW_CYCLE = Object.freeze({
  reviewRetryCount: undefined,
  unparseableRetryCount: undefined,
  quotaRetryCount: undefined,
  reviewFallbackHarness: undefined,
  reviewRetryAt: undefined,
  unparseableReviewAt: undefined,
} as const satisfies WorkerFieldsUpdate);

// The resolver budget and its last attempt, reset for a fresh merge cycle.
export const FRESH_RESOLVE_CYCLE = Object.freeze({
  resolveAttempts: 0,
  preResolveSha: undefined,
  lastResolveBody: undefined,
} as const satisfies WorkerFieldsUpdate);

// The ci-fix budget and its last attempt, reset for a fresh merge cycle.
export const FRESH_CI_FIX_CYCLE = Object.freeze({
  ciFixAttempts: 0,
  preCiFixSha: undefined,
  lastCiFixBody: undefined,
  failingCheckSummary: undefined,
} as const satisfies WorkerFieldsUpdate);

// The in-flight markers of the interposed whole-task review.
export const CLEAR_HOLISTIC = Object.freeze({
  holisticFinalActive: undefined,
  holisticReviewMode: undefined,
} as const satisfies WorkerFieldsUpdate);

// Reviewer non-blocking notes: findings a project's rules tell the reviewer to
// report rather than implement (prompts.ts nonBlockingNotesConvention). The
// review body is scrubbed at merge, so a note left there would reach no one;
// this module lifts the `Non-blocking notes:` section out of a finished review
// and appends it to a durable per-project file that `garden notes` reads. It
// raises no alert: a note is by definition not something to act on now, and
// one alert per review made the alerts pane a feed of them. Strictly
// best-effort: it runs after the verdict is parsed and never influences it.
import fs from "node:fs";
import path from "node:path";
import { reviewNotesPath } from "./headless-paths.js";
import { log } from "./log.js";

export interface ReviewNote {
  at: string;
  project: string;
  worker: string;
  branch: string;
  verdict: string;
  notes: string;
}

const HEADING = /^\s*(?:#{1,6}\s*)?(?:\*\*|__)?\s*non[- ]?blocking notes\s*(?:\*\*|__)?\s*:?\s*(?:\*\*|__)?\s*(.*)$/i;
const NEXT_HEADING = /^\s*#{1,6}\s/;
const EMPTY_NOTES = /^(?:none|n\/a|-|—)\.?$/i;

// The LAST heading wins: the section sits directly above the verdict line, and
// a reviewer may quote the convention's name earlier in its reasoning.
export function extractNonBlockingNotes(body: string): string | null {
  const lines = body.split("\n");
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (HEADING.test(lines[i])) { start = i; break; }
  }
  if (start < 0) return null;
  const section = [lines[start].match(HEADING)![1]];
  for (let i = start + 1; i < lines.length && !NEXT_HEADING.test(lines[i]); i++) {
    section.push(lines[i]);
  }
  const notes = section.join("\n").trim();
  return notes && !EMPTY_NOTES.test(notes) ? notes : null;
}

export function recordReviewNotes(input: Omit<ReviewNote, "at" | "notes"> & { body: string }): void {
  try {
    const notes = extractNonBlockingNotes(input.body);
    if (!notes) return;
    const note: ReviewNote = {
      at: new Date().toISOString(),
      project: input.project,
      worker: input.worker,
      branch: input.branch,
      verdict: input.verdict,
      notes,
    };
    const file = reviewNotesPath(input.project);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(note) + "\n");
    log.debug("poller", "recorded reviewer non-blocking notes", {
      worker: input.worker,
      data: { project: input.project, branch: input.branch, verdict: input.verdict },
    });
  } catch (err) {
    log.warn("poller", "could not record reviewer non-blocking notes", {
      worker: input.worker,
      data: { project: input.project, error: String(err) },
    });
  }
}

// Unparseable lines are skipped rather than failing the read: the file is
// append-only and a torn final line must not hide every note before it.
export function readReviewNotes(project: string): ReviewNote[] {
  let raw: string;
  try {
    raw = fs.readFileSync(reviewNotesPath(project), "utf-8");
  } catch {
    return [];
  }
  const notes: ReviewNote[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Partial<ReviewNote>;
      if (typeof parsed.notes === "string" && typeof parsed.at === "string") notes.push(parsed as ReviewNote);
    } catch { /* torn or foreign line */ }
  }
  return notes;
}

export function clearReviewNotes(project: string): void {
  fs.rmSync(reviewNotesPath(project), { force: true });
}

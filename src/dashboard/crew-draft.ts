// Crew-composer draft: the half-built crew definition the operator assembles in
// the ⌥⇧C picker's new/edit flow before saving it. Mirrors spawn-draft.ts —
// a tmux display-menu is fire-and-forget, so multi-field composition needs
// state that survives each re-open.
//
// GARDEN-level (one file, not one per project) because a crew is a garden-level
// resource: it is defined once and referenced by name from any project. The
// spawn draft is per-project because it stages a spawn INTO one project.
//
// `editing` carries the name when the flow started from "edit", so the save
// step knows whether it is creating or updating; absent means the name is still
// to be prompted for.
import fs from "node:fs";
import path from "node:path";
import { SESSIONS_DIR } from "../config.js";
import { atomicWriteFile } from "./atomic-write.js";
import { log } from "./log.js";

export const CREW_DRAFT_MAX_AGE_MS = 15 * 60_000;

export interface CrewDraft {
  /** Name being edited; absent for a new crew (prompted at save). */
  editing?: string;
  worker?: string;
  workerModel?: string;
  workerEffort?: string;
  review?: string;
  reviewModel?: string;
}

const DRAFT_FIELDS = ["editing", "worker", "workerModel", "workerEffort", "review", "reviewModel"] as const;

function draftPath(): string {
  return path.join(SESSIONS_DIR, "crew-draft.json");
}

// The current draft, or {} when absent or stale. A longer TTL than the spawn
// draft (15 min vs 5): composing a crew is a deliberate configuration act the
// operator may step away from, and unlike a spawn draft a stale one cannot
// silently apply to anything — it is only ever read by an explicit save.
export function readCrewDraft(): CrewDraft {
  try {
    const parsed = JSON.parse(fs.readFileSync(draftPath(), "utf-8")) as CrewDraft & { ts?: number };
    if (typeof parsed.ts !== "number" || Date.now() - parsed.ts > CREW_DRAFT_MAX_AGE_MS) return {};
    const out: CrewDraft = {};
    for (const f of DRAFT_FIELDS) if (parsed[f]) out[f] = parsed[f];
    return out;
  } catch {
    return {};
  }
}

// Merge a patch and re-stamp. An empty-string value clears that field (the
// "clear" rows in the submenus).
export function writeCrewDraft(patch: CrewDraft): void {
  const merged: CrewDraft = { ...readCrewDraft() };
  for (const f of DRAFT_FIELDS) {
    if (patch[f] === undefined) continue;
    if (patch[f]) merged[f] = patch[f];
    else delete merged[f];
  }
  try {
    atomicWriteFile(draftPath(), JSON.stringify({ ...merged, ts: Date.now() }));
  } catch (err) {
    log.warn("crew-draft", "write failed", { data: { error: String(err) } });
  }
}

export function clearCrewDraft(): void {
  try { fs.unlinkSync(draftPath()); } catch { /* already gone */ }
}

// Seed the draft from an existing crew, for the edit flow.
export function seedCrewDraft(name: string, fields: Omit<CrewDraft, "editing">): void {
  clearCrewDraft();
  writeCrewDraft({ editing: name, ...fields });
}

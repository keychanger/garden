// Spawn-composer draft: the base/crew/model/effort overrides the operator
// stages in the ⌥⇧N workflow picker before choosing a workflow. Persisted per
// project so the picker (a fire-and-forget menu) can carry state across its
// re-opens, then consumed (read + deleted) when a workflow is chosen and
// threaded into newWorker. A draft older than MAX_AGE_MS is ignored on read AND
// swept by the watchdog — so a stale draft from last week can never silently
// apply to next week's spawn. ⌥n (the zero-question fast path) never reads a
// draft.
import fs from "node:fs";
import path from "node:path";
import { SESSIONS_DIR } from "../config.js";
import { atomicWriteFile } from "./atomic-write.js";
import { log } from "./log.js";

export const SPAWN_DRAFT_MAX_AGE_MS = 5 * 60_000;

export interface SpawnDraftPatch {
  base?: string;
  crew?: string;
  // Per-worker model alias/id (opaque string; opus/sonnet/haiku/fable or a
  // concrete id) — threaded into newWorker as `model`. Default/grow only.
  model?: string;
  // Per-worker effort rung. The four claude-code `--effort` levels
  // (low/medium/high/xhigh), or the sentinel "ultra" — the top rung the
  // consumer maps to the ultracode preset (max effort + dynamic workflows),
  // reusing that fully-plumbed path rather than a second effort value.
  effort?: string;
}

function draftPath(project: string): string {
  // Project names are simple, but sanitize defensively so the field can never
  // escape SESSIONS_DIR.
  const safe = project.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(SESSIONS_DIR, `spawn-draft-${safe}.json`);
}

// The current draft for a project, or {} when absent or stale (> MAX_AGE_MS).
export function readSpawnDraft(project: string): SpawnDraftPatch {
  try {
    const parsed = JSON.parse(fs.readFileSync(draftPath(project), "utf-8")) as { base?: string; crew?: string; model?: string; effort?: string; ts?: number };
    if (typeof parsed.ts !== "number" || Date.now() - parsed.ts > SPAWN_DRAFT_MAX_AGE_MS) return {};
    return {
      ...(parsed.base ? { base: parsed.base } : {}),
      ...(parsed.crew ? { crew: parsed.crew } : {}),
      ...(parsed.model ? { model: parsed.model } : {}),
      ...(parsed.effort ? { effort: parsed.effort } : {}),
    };
  } catch {
    return {};
  }
}

// Merge a patch into the draft and re-stamp its timestamp. An empty-string value
// clears that field (the "clear" rows). Preserves the other field.
export function writeSpawnDraft(project: string, patch: SpawnDraftPatch): void {
  const current = readSpawnDraft(project);
  const merged: SpawnDraftPatch = { ...current };
  if (patch.base !== undefined) { if (patch.base) merged.base = patch.base; else delete merged.base; }
  if (patch.crew !== undefined) { if (patch.crew) merged.crew = patch.crew; else delete merged.crew; }
  if (patch.model !== undefined) { if (patch.model) merged.model = patch.model; else delete merged.model; }
  if (patch.effort !== undefined) { if (patch.effort) merged.effort = patch.effort; else delete merged.effort; }
  try {
    atomicWriteFile(draftPath(project), JSON.stringify({ ...merged, ts: Date.now() }));
  } catch (err) {
    log.warn("spawn-draft", "write failed", { data: { project, error: String(err) } });
  }
}

// Read the fresh draft AND delete the file — the one-shot consume at spawn.
// Returns {} when absent or stale.
export function consumeSpawnDraft(project: string): SpawnDraftPatch {
  const draft = readSpawnDraft(project);
  try { fs.unlinkSync(draftPath(project)); } catch { /* already gone */ }
  return draft;
}

// Sweep stale draft files. Mirrors watchdog.sweepBootstrapScripts; the read-side
// MAX_AGE guard already prevents a stale draft from applying, so this only bounds
// accumulation. Returns the count removed (for tests).
export function sweepSpawnDrafts(nowMs: number): number {
  let names: string[];
  try {
    names = fs.readdirSync(SESSIONS_DIR);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith("spawn-draft-") || !name.endsWith(".json")) continue;
    const file = path.join(SESSIONS_DIR, name);
    try {
      if (nowMs - fs.statSync(file).mtimeMs <= SPAWN_DRAFT_MAX_AGE_MS) continue;
      fs.unlinkSync(file);
      removed++;
    } catch { /* raced with another sweep, or already gone */ }
  }
  if (removed > 0) {
    log.info("spawn-draft", "swept stale spawn drafts", { data: { removed } });
  }
  return removed;
}

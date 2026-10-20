// Seed prompts: the first prompt seedWorker (continue.ts) pastes into a new or
// cold-respawned worker. Garden writes its own seeds to the control tree. In the
// worker-writable sessions dir, a worker could swap a sibling's briefing for one
// of its own, or for a symlink to a file it cannot read, in the seconds before
// the unsandboxed seeder read it.
//
// `garden handoff` runs inside a worker's sandbox, so its seed starts in the
// sessions dir; the dispatcher copies it into the control tree before spawning.
import crypto from "node:crypto";
import path from "node:path";
import { CONTROL_DIR, CONTROL_SEEDS_DIR, SESSIONS_DIR } from "../paths.js";
import { atomicWriteFile } from "./atomic-write.js";
import { readStableRegularFile } from "./safe-read.js";

export const MAX_SEED_BYTES = 1024 * 1024;

export function writeSeedFile(text: string, label: string): string {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_SEED_BYTES) {
    throw new Error(`seed prompt is ${bytes} bytes, over the ${MAX_SEED_BYTES}-byte limit`);
  }
  const file = path.join(CONTROL_SEEDS_DIR, `${label}-${crypto.randomUUID()}.txt`);
  atomicWriteFile(file, text, { mode: 0o600 });
  return file;
}

// A seed's text, or null when the file is not a regular file under a seed
// root, is a symlink, or is over the size limit. The sessions dir is a root
// only for seeds an older build wrote there, still being delivered or kept
// after a failed delivery; garden no longer writes them there.
export function readSeedFile(file: string): string | null {
  for (const root of [CONTROL_DIR, SESSIONS_DIR]) {
    const read = readStableRegularFile(file, root, MAX_SEED_BYTES);
    if (read) return read.data.toString("utf8");
  }
  return null;
}

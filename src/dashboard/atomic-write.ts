// Atomic file write: write to a temp file in the same directory, then rename.
// Plain writeFileSync truncates and streams, leaving a window where concurrent
// readers see partial or empty contents. Atomic rename is the only way to make
// a file's complete final contents appear to readers in one filesystem op.
// Used for every file that another process might read concurrently with a
// write — registry, state, config, rendered status caches, and per-worker
// .claude/settings.json that Claude itself reads on SessionStart and resume.
import fs from "node:fs";
import path from "node:path";

export interface AtomicWriteOpts {
  mode?: number;
}

export function atomicWriteFile(
  filePath: string,
  content: string | Buffer,
  opts?: AtomicWriteOpts,
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    if (opts?.mode != null) {
      fs.writeFileSync(tmpFile, content, { mode: opts.mode });
    } else {
      fs.writeFileSync(tmpFile, content);
    }
    fs.renameSync(tmpFile, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpFile); } catch { /* tmp may not exist */ }
    throw err;
  }
}

// Atomic file write: write to a temp file in the same directory, then rename.
// Plain writeFileSync truncates and streams, leaving a window where concurrent
// readers see partial or empty contents. Atomic rename is the only way to make
// a file's complete final contents appear to readers in one filesystem op.
// Used for every file that another process might read concurrently with a
// write — registry, state, config, rendered status caches, and per-worker
// .claude/settings.json that Claude itself reads on SessionStart and resume.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface AtomicWriteOpts {
  mode?: number;
  // Flush the tmp file before rename and the parent directory afterward
  // (default true).
  // Set false for throwaway files that a crash can safely lose because the
  // next event rebuilds them — the repaint render caches (status.rendered,
  // usage.rendered, history.rendered, plot-strip.template). fsync is ~97% of
  // this call's cost, and those files are rewritten on every hook/keystroke,
  // so skipping it takes the repaint cascade off the disk-sync path. The
  // atomic rename still guarantees concurrent readers never see a partial
  // file; only crash-durability is traded away.
  durable?: boolean;
}

export function atomicWriteFile(
  filePath: string,
  content: string | Buffer,
  opts?: AtomicWriteOpts,
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // randomUUID is collision-free across process+time, so two writers
  // racing within the same millisecond on the same pid never share a
  // tmp filename. The previous `${pid}.${Date.now()}` form was safe in
  // single-thread Node but collided trivially under fakeTimers and
  // could collide in adversarial scenarios.
  const tmpFile = `${filePath}.${crypto.randomUUID()}.tmp`;
  try {
    if (opts?.mode != null) {
      fs.writeFileSync(tmpFile, content, { mode: opts.mode });
    } else {
      fs.writeFileSync(tmpFile, content);
    }
    // Best-effort durability: flush the tmp file to stable storage before the
    // rename. The atomic rename guarantees concurrent *readers* never see a
    // partial file, but on its own it does not guarantee the bytes survive a
    // power loss or kernel panic — a crash right after the rename can leave the
    // target zero-length even though the rename "succeeded". fsync closes that
    // window for the state files (registry/state/config) that must survive an
    // unclean shutdown. Skipped when durable === false for throwaway repaint
    // caches whose next event rebuilds them. Wrapped and swallowed because
    // fsync is genuinely optional here: it can be unavailable on some
    // filesystems, EACCES on a read-only-mode tmp file (e.g. 0o444
    // settings.json), or stubbed out under a partial fs mock — none of which
    // should fail the write.
    if (opts?.durable !== false) {
      try {
        const fd = fs.openSync(tmpFile, "r+");
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      } catch { /* durability is best-effort */ }
    }
    fs.renameSync(tmpFile, filePath);
    // Persist the directory entry created by rename. Flushing only the file's
    // bytes leaves a power-loss window where the new name itself can vanish.
    // Directory fsync is unsupported on some filesystems/platforms, so it has
    // the same best-effort contract as the file flush above.
    if (opts?.durable !== false) {
      try {
        const dirFd = fs.openSync(path.dirname(filePath), "r");
        try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
      } catch { /* durability is best-effort */ }
    }
  } catch (err) {
    try { fs.unlinkSync(tmpFile); } catch { /* tmp may not exist */ }
    throw err;
  }
}

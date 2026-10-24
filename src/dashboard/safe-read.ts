// Reading files a sandboxed worker can write, from processes that are not
// sandboxed. A plain read follows whatever the worker put at the path: a
// symlink to a credential file its own sandbox cannot read, or a FIFO that
// never reaches EOF.
import fs from "node:fs";
import path from "node:path";

export interface StableFile {
  data: Buffer;
  dev: number;
  ino: number;
}

function sameFile(a: Pick<fs.Stats, "dev" | "ino">, b: Pick<fs.Stats, "dev" | "ino">): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function withinDirectory(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

// Read an untrusted file through a pinned descriptor. Containment is checked
// both before and after the read, the final component may not be a symlink or
// hard link, and inode/timestamps must stay stable for the whole operation.
// The returned bytes no longer depend on the worker-writable pathname. Opened
// non-blocking: without it, opening a FIFO waits for a writer before the
// regular-file check can refuse it, so a worker-made FIFO hung the reader.
export function readStableRegularFile(filePath: string, rootDir: string, maxBytes: number): StableFile | null {
  let fd: number | null = null;
  try {
    const rootBefore = fs.lstatSync(rootDir);
    if (!rootBefore.isDirectory()) return null;
    const realRootBefore = fs.realpathSync(rootDir);
    const realFileBefore = fs.realpathSync(filePath);
    if (!withinDirectory(realRootBefore, realFileBefore)) return null;

    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const before = fs.fstatSync(fd);
    const pathBefore = fs.statSync(filePath);
    if (!before.isFile() || before.nlink !== 1 || !sameFile(before, pathBefore)) return null;
    if (before.size > maxBytes) return null;

    const data = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    const rootAfter = fs.lstatSync(rootDir);
    const realRootAfter = fs.realpathSync(rootDir);
    const realFileAfter = fs.realpathSync(filePath);
    const pathAfter = fs.statSync(filePath);
    if (!rootAfter.isDirectory() || !sameFile(rootBefore, rootAfter)) return null;
    if (realRootAfter !== realRootBefore || !withinDirectory(realRootAfter, realFileAfter)) return null;
    if (!sameFile(before, after) || !sameFile(after, pathAfter)) return null;
    if (before.size !== after.size
        || before.mtimeMs !== after.mtimeMs
        || before.ctimeMs !== after.ctimeMs
        || data.byteLength !== after.size) return null;
    return { data, dev: after.dev, ino: after.ino };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

// Append to a file that readStableRegularFile just returned, refusing anything
// that is no longer that same file: a symlink or FIFO swapped in since the read
// is not opened, and a replaced inode is not written to.
export function appendToStableFile(filePath: string, file: StableFile, text: string): void {
  const fd = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const current = fs.fstatSync(fd);
    if (!current.isFile() || !sameFile(current, file)) throw new Error(`${filePath} changed since it was read`);
    fs.writeSync(fd, text);
  } finally {
    fs.closeSync(fd);
  }
}

// Replace the contents of a file that readStableRegularFile just returned, under
// appendToStableFile's refusals, and only while it still holds the bytes that
// read returned, so a concurrent append is not dropped. Written through the
// pinned descriptor rather than renamed into place: a rename would follow a
// directory link swapped into the path.
export function rewriteStableFile(filePath: string, file: StableFile, text: string): void {
  const fd = fs.openSync(filePath, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const current = fs.fstatSync(fd);
    if (!current.isFile() || !sameFile(current, file) || !fs.readFileSync(fd).equals(file.data)) {
      throw new Error(`${filePath} changed since it was read`);
    }
    const data = Buffer.from(text);
    fs.writeSync(fd, data, 0, data.length, 0);
    fs.ftruncateSync(fd, data.length);
  } finally {
    fs.closeSync(fd);
  }
}

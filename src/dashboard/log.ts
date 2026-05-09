// Structured logger: append-only JSON lines to ~/.garden/sessions/dashboard.log.
import fs from "node:fs";
import path from "node:path";
import { SESSIONS_DIR } from "../config.js";
import { atomicWriteFile } from "./atomic-write.js";

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const LOG_FILE = path.join(SESSIONS_DIR, "dashboard.log");
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
const TRIM_KEEP_BYTES = 8 * 1024 * 1024; // keep ~8MB of tail after a trim

function getMinLevel(): LogLevel {
  const env = process.env.GARDEN_LOG_LEVEL;
  if (env && env in LEVEL_ORDER) return env as LogLevel;
  return "info";
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[getMinLevel()];
}

interface LogOpts {
  worker?: string;
  data?: Record<string, unknown>;
}

function write(level: LogLevel, src: string, msg: string, opts?: LogOpts): void {
  if (!shouldLog(level)) return;
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      src,
    };
    if (opts?.worker) entry.worker = opts.worker;
    entry.msg = msg;
    if (opts?.data) entry.data = opts.data;
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
  } catch { /* logging must never crash the app */ }
}

// Tail-trim: when the log exceeds MAX_LOG_SIZE, atomically rewrite the file
// keeping the most recent ~TRIM_KEEP_BYTES. We snap the cut point to the next
// newline so we never leave a half-truncated JSON line at the head — the
// reader (`garden logs`) parses line-by-line and a partial line would be
// dropped on every render until the next trim.
export function truncateLog(): void {
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size <= MAX_LOG_SIZE) return;
    const buf = fs.readFileSync(LOG_FILE);
    const cutTarget = Math.max(0, buf.length - TRIM_KEEP_BYTES);
    const nl = buf.indexOf(0x0a, cutTarget);
    const start = nl === -1 ? buf.length : nl + 1;
    atomicWriteFile(LOG_FILE, buf.subarray(start));
  } catch { /* file doesn't exist or not accessible */ }
}

// Log levels are a semantic contract, not decoration:
//   error — operator must act
//   warn  — potentially wrong, worth checking later
//   info  — lifecycle state transition (worker moved, merge landed, alert fired)
//   debug — events, heartbeats, pair-half ops, poll cycles with no transition
// Default level is info; flip to debug via GARDEN_LOG_LEVEL=debug when chasing bugs.
export const log = {
  debug: (src: string, msg: string, opts?: LogOpts) => write("debug", src, msg, opts),
  info: (src: string, msg: string, opts?: LogOpts) => write("info", src, msg, opts),
  warn: (src: string, msg: string, opts?: LogOpts) => write("warn", src, msg, opts),
  error: (src: string, msg: string, opts?: LogOpts) => write("error", src, msg, opts),
};

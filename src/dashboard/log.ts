// Structured logger: append-only JSON lines to ~/.garden/sessions/dashboard.log.
import fs from "node:fs";
import path from "node:path";
import { SESSIONS_DIR } from "../config.js";

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const LOG_FILE = path.join(SESSIONS_DIR, "dashboard.log");
const MAX_LOG_SIZE = 512 * 1024; // 512KB

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

export function truncateLog(): void {
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > MAX_LOG_SIZE) {
      fs.writeFileSync(LOG_FILE, "");
    }
  } catch { /* file doesn't exist or not accessible */ }
}

// Log levels are a semantic contract, not decoration:
//   error     — operator must act
//   warn      — potentially wrong, worth checking later
//   info      — lifecycle state transition (worker moved, merge landed, alert fired)
//   debug     — events, heartbeats, pair-half ops, poll cycles with no transition
// Default level is info; flip to debug via GARDEN_LOG_LEVEL=debug when chasing bugs.
//
// `transition` is the canonical helper for state-change logging: fires at info
// when from !== to, debug otherwise. This eliminates the "caller must remember
// to diff before logging" discipline that produced the posttooluse heartbeat
// flood (1,500+ identical lines per session before cleanup).
export const log = {
  debug: (src: string, msg: string, opts?: LogOpts) => write("debug", src, msg, opts),
  info: (src: string, msg: string, opts?: LogOpts) => write("info", src, msg, opts),
  warn: (src: string, msg: string, opts?: LogOpts) => write("warn", src, msg, opts),
  error: (src: string, msg: string, opts?: LogOpts) => write("error", src, msg, opts),
  transition: (src: string, msg: string, from: unknown, to: unknown, opts?: LogOpts) => {
    const level: LogLevel = from === to ? "debug" : "info";
    const data = { from, to, ...(opts?.data ?? {}) };
    write(level, src, msg, { ...opts, data });
  },
};

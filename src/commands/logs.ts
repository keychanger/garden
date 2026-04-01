// Command: garden logs — view dashboard logs with pretty formatting.
import fs from "node:fs";
import path from "node:path";
import { SESSIONS_DIR } from "../config.js";
import { isTTY } from "../output.js";

const LOG_FILE = path.join(SESSIONS_DIR, "dashboard.log");

export interface LogEntry {
  ts: string;
  level: string;
  src: string;
  msg: string;
  worker?: string;
  data?: Record<string, unknown>;
}

// ANSI color helpers — only emit codes when outputting to a TTY.
const color = isTTY
  ? {
      reset: "\x1b[0m",
      dim: "\x1b[2m",
      bold: "\x1b[1m",
      green: "\x1b[32m",
      yellow: "\x1b[33m",
      red: "\x1b[31m",
      cyan: "\x1b[36m",
      magenta: "\x1b[35m",
    }
  : { reset: "", dim: "", bold: "", green: "", yellow: "", red: "", cyan: "", magenta: "" };

const LEVEL_COLORS: Record<string, string> = {
  debug: color.dim,
  info: color.green,
  warn: color.yellow,
  error: color.red,
};

const LEVEL_SYMBOLS: Record<string, string> = {
  debug: ".",
  info: "-",
  warn: "!",
  error: "x",
};

export function relativeTime(isoTs: string): string {
  const delta = Date.now() - new Date(isoTs).getTime();
  if (delta < 0) return "just now";
  const secs = Math.floor(delta / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  // Fall back to absolute for old entries
  return isoTs.replace("T", " ").slice(5, 16);
}

function absoluteTime(isoTs: string): string {
  return isoTs.replace("T", " ").slice(11, 19);
}

function formatData(data: Record<string, unknown>): string {
  return Object.entries(data)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
}

function formatEntry(entry: LogEntry, useRelativeTime: boolean): string {
  const ts = useRelativeTime ? relativeTime(entry.ts).padStart(8) : absoluteTime(entry.ts);
  const levelColor = LEVEL_COLORS[entry.level] ?? "";
  const symbol = LEVEL_SYMBOLS[entry.level] ?? " ";
  const level = entry.level.toUpperCase().padEnd(5);
  const src = entry.src.padEnd(8);
  const workerStr = entry.worker ? `${color.magenta}${entry.worker.padEnd(20)}${color.reset} ` : "";
  const dataStr = entry.data ? `  ${color.dim}${formatData(entry.data)}${color.reset}` : "";

  return `${color.dim}${ts}${color.reset} ${levelColor}${symbol} ${level}${color.reset} ${color.cyan}${src}${color.reset} ${workerStr}${entry.msg}${dataStr}`;
}

function parseLine(line: string): LogEntry | null {
  try {
    return JSON.parse(line) as LogEntry;
  } catch {
    return null;
  }
}

function readLogLines(): string[] {
  try {
    const content = fs.readFileSync(LOG_FILE, "utf-8").trim();
    if (!content) return [];
    return content.split("\n");
  } catch {
    return [];
  }
}

export interface Filters {
  level?: string;
  src?: string;
  worker?: string;
  count: number;
  follow: boolean;
}

export function parseArgs(args: string[]): Filters {
  const filters: Filters = { count: 40, follow: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === "--level" || arg === "-l") && args[i + 1]) {
      filters.level = args[++i].toLowerCase();
    } else if ((arg === "--src" || arg === "-s") && args[i + 1]) {
      filters.src = args[++i].toLowerCase();
    } else if ((arg === "--worker" || arg === "-w") && args[i + 1]) {
      filters.worker = args[++i].toLowerCase();
    } else if ((arg === "--count" || arg === "-n") && args[i + 1]) {
      filters.count = parseInt(args[++i], 10) || 40;
    } else if (arg === "--follow" || arg === "-f") {
      filters.follow = true;
    }
  }
  return filters;
}

const LEVEL_ORDER: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export function matchesFilters(entry: LogEntry, filters: Filters): boolean {
  if (filters.level) {
    const minLevel = LEVEL_ORDER[filters.level] ?? 0;
    const entryLevel = LEVEL_ORDER[entry.level] ?? 0;
    if (entryLevel < minLevel) return false;
  }
  if (filters.src && entry.src.toLowerCase() !== filters.src) return false;
  if (filters.worker) {
    const workerVal = entry.worker ?? entry.data?.worker ?? entry.data?.branchName ?? entry.data?.windowName;
    if (typeof workerVal !== "string" || !workerVal.toLowerCase().includes(filters.worker)) {
      return false;
    }
  }
  return true;
}

function dedupKey(entry: LogEntry): string {
  return `${entry.level}|${entry.src}|${entry.msg}|${JSON.stringify(entry.data ?? {})}`;
}

interface DedupedEntry {
  entry: LogEntry;
  count: number;
}

export function dedup(entries: LogEntry[]): DedupedEntry[] {
  const result: DedupedEntry[] = [];
  for (const entry of entries) {
    const key = dedupKey(entry);
    const last = result[result.length - 1];
    if (last && dedupKey(last.entry) === key) {
      last.count++;
      last.entry = entry; // keep the latest timestamp
    } else {
      result.push({ entry, count: 1 });
    }
  }
  return result;
}

function formatDedupedEntry(d: DedupedEntry, useRelativeTime: boolean): string {
  const line = formatEntry(d.entry, useRelativeTime);
  if (d.count > 1) {
    return `${line}  ${color.dim}(x${d.count})${color.reset}`;
  }
  return line;
}

function printEntries(entries: LogEntry[], filters: Filters, useRelativeTime: boolean): void {
  const filtered = entries.filter((e) => matchesFilters(e, filters));
  const tail = filtered.slice(-filters.count);
  const deduped = dedup(tail);

  if (!isTTY) {
    for (const d of deduped) {
      console.log(JSON.stringify({ ...d.entry, ...(d.count > 1 ? { repeat: d.count } : {}) }));
    }
    return;
  }

  if (deduped.length === 0) {
    console.log(`${color.dim}(no matching log entries)${color.reset}`);
    return;
  }

  for (const d of deduped) {
    console.log(formatDedupedEntry(d, useRelativeTime));
  }
}

async function follow(filters: Filters): Promise<void> {
  let lastSize = 0;
  try {
    lastSize = fs.statSync(LOG_FILE).size;
  } catch { /* file doesn't exist yet */ }

  // Print existing entries first
  const lines = readLogLines();
  const entries = lines.map(parseLine).filter((e): e is LogEntry => e !== null);
  printEntries(entries, filters, false);

  // Poll for new lines
  process.stdout.write(`\n${color.dim}--- following (ctrl-c to stop) ---${color.reset}\n\n`);

  let prevKey = "";
  let repeatCount = 0;

  const poll = setInterval(() => {
    let currentSize: number;
    try {
      currentSize = fs.statSync(LOG_FILE).size;
    } catch {
      return;
    }

    if (currentSize <= lastSize) {
      if (currentSize < lastSize) lastSize = 0; // file was truncated
      else return;
    }

    const fd = fs.openSync(LOG_FILE, "r");
    const buf = Buffer.alloc(currentSize - lastSize);
    fs.readSync(fd, buf, 0, buf.length, lastSize);
    fs.closeSync(fd);
    lastSize = currentSize;

    const newLines = buf.toString("utf-8").trim().split("\n");
    for (const line of newLines) {
      const entry = parseLine(line);
      if (!entry || !matchesFilters(entry, filters)) continue;

      const key = dedupKey(entry);
      if (key === prevKey) {
        repeatCount++;
        // Overwrite the previous line's repeat count
        process.stdout.write(`\r\x1b[K${formatEntry(entry, false)}  ${color.dim}(x${repeatCount})${color.reset}`);
      } else {
        if (prevKey) process.stdout.write("\n");
        process.stdout.write(formatEntry(entry, false));
        prevKey = key;
        repeatCount = 1;
      }
    }
  }, 1000);

  // Keep alive until interrupted
  await new Promise<void>((resolve) => {
    const cleanup = () => {
      clearInterval(poll);
      if (prevKey) process.stdout.write("\n");
      resolve();
    };
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
  });
}

export async function logs(args: string[]): Promise<void> {
  const filters = parseArgs(args);

  if (filters.follow) {
    await follow(filters);
    return;
  }

  const lines = readLogLines();
  const entries = lines.map(parseLine).filter((e): e is LogEntry => e !== null);
  printEntries(entries, filters, true);
}

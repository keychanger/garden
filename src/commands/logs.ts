// Command: garden logs — view dashboard logs.
//
// Two presentation modes share the same JSON file (~/.garden/sessions/dashboard.log):
//   - "pretty" (default): project-first columns, suppression of housekeeping noise,
//     per-message data summarization. Built for humans tailing the logs pane.
//   - "raw": every entry, src column included, no suppression. The shape that
//     existed before. Useful for debugging or grepping the firehose.
//
// Mode resolution: --raw / --pretty flag > config (logs.mode in ~/.garden/config.yml)
// > "pretty" default. Persistent toggle via subcommands: `garden logs raw`,
// `garden logs pretty`, `garden logs mode`.
import fs from "node:fs";
import path from "node:path";
import { SESSIONS_DIR, getLogsMode, setLogsMode, loadConfig, logColorKeyForProject, type LogsMode, type GardenConfig } from "../config.js";
import { logColorAnsi, ASSIGNABLE_LOG_COLOR_KEYS, RESERVED_LOG_COLOR_KEY } from "../log-palette.js";
import { isTTY } from "../output.js";
import { atomicWriteFile } from "../dashboard/atomic-write.js";

const LOG_FILE = path.join(SESSIONS_DIR, "dashboard.log");
export const LOGS_FILTER_FILE = path.join(SESSIONS_DIR, "logs.filter.json");

export interface LogEntry {
  ts: string;
  level: string;
  src: string;
  msg: string;
  worker?: string;
  data?: Record<string, unknown>;
}

const color = isTTY
  ? {
      reset: "\x1b[0m",
      dim: "\x1b[2m",
      bold: "\x1b[1m",
      red: "\x1b[31m",
      green: "\x1b[32m",
      yellow: "\x1b[33m",
      blue: "\x1b[34m",
      magenta: "\x1b[35m",
      cyan: "\x1b[36m",
    }
  : { reset: "", dim: "", bold: "", red: "", green: "", yellow: "", blue: "", magenta: "", cyan: "" };

const LEVEL_COLORS: Record<string, string> = {
  debug: color.dim,
  info: color.green,
  warn: color.yellow,
  error: color.red,
};

const RAW_LEVEL_SYMBOLS: Record<string, string> = {
  debug: ".",
  info: "-",
  warn: "!",
  error: "x",
};

const PRETTY_LEVEL_GLYPHS: Record<string, string> = {
  debug: " ",
  info: "·",
  warn: "!",
  error: "✗",
};

// Hash fallback only triggers for projects missing from config (transient
// registry entries, stale logs); registered projects always get their assigned key.
let cachedConfig: GardenConfig | null = null;
let configLoadFailed = false;

function getCachedConfig(): GardenConfig | null {
  if (cachedConfig || configLoadFailed) return cachedConfig;
  try {
    cachedConfig = loadConfig();
  } catch {
    configLoadFailed = true;
  }
  return cachedConfig;
}

function colorForProject(name: string): string {
  if (!isTTY) return "";
  const cfg = getCachedConfig();
  const key = cfg ? logColorKeyForProject(name, cfg) : null;
  if (key) return logColorAnsi(key) ?? "";
  if (name === "garden") return logColorAnsi(RESERVED_LOG_COLOR_KEY) ?? "";
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  const fallbackKey = ASSIGNABLE_LOG_COLOR_KEYS[Math.abs(h) % ASSIGNABLE_LOG_COLOR_KEYS.length];
  return logColorAnsi(fallbackKey) ?? "";
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function relativeTime(isoTs: string): string {
  const d = new Date(isoTs);
  const delta = Date.now() - d.getTime();
  if (delta < 0) return "just now";
  const secs = Math.floor(delta / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function absoluteTime(isoTs: string): string {
  const d = new Date(isoTs);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// Width of the timestamp column. Absolute time is "MM-DD HH:MM:SS" (14 chars);
// relative time ("5m ago", or the "MM-DD HH:MM" fallback for >24h) is right-padded
// to match so downstream column math (PRETTY_MESSAGE_COL) holds for both modes.
const TIMESTAMP_WIDTH = 14;

// ---- worker → project lookup -----------------------------------------------
//
// Many entries carry only `worker` (e.g. `poller new -> reviewing`); the project
// they belong to lives in the registry. Cached at first read; lazy-refreshed
// on cache miss so workers created mid-tail eventually map.
//
// History-derived fallback: once a worker is killed it leaves the registry, so
// any of its older log lines that didn't include `data.project` would render
// as the dim "system" placeholder. To recover that, we seed a secondary cache
// from every entry whose `data.project` IS set (hooks emit project on every
// transition, so most workers have at least one). The seed populates the
// first time projectForEntry is called for a worker that's not in the
// registry — cheap one-pass scan of the on-disk log.

let workerToProjectCache: Map<string, string> | null = null;
let workerToProjectHistoryCache: Map<string, string> | null = null;
let registryLoadFailed = false;

function loadWorkerMap(): Map<string, string> {
  const map = new Map<string, string>();
  if (registryLoadFailed) return map;
  try {
    // Defer the import so non-dashboard callers (raw `garden logs | head`)
    // don't pay for it; also avoids a hard dep on dashboard internals here.
    const registryFile = path.join(SESSIONS_DIR, "dashboard.registry.json");
    if (!fs.existsSync(registryFile)) return map;
    const raw = JSON.parse(fs.readFileSync(registryFile, "utf-8")) as {
      workers?: Record<string, Array<{ name?: string }>>;
    };
    const workers = raw.workers ?? {};
    for (const [project, entries] of Object.entries(workers)) {
      for (const e of entries) {
        if (e?.name) map.set(e.name, project);
      }
    }
  } catch {
    registryLoadFailed = true;
  }
  return map;
}

// Build worker→project map by scanning the on-disk log for entries that
// carry both `worker` and `data.project`. Used as a fallback after the
// registry lookup misses (worker was killed/cleaned).
function loadWorkerMapFromLog(): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const content = fs.readFileSync(LOG_FILE, "utf-8");
    let start = 0;
    while (start < content.length) {
      const nl = content.indexOf("\n", start);
      const end = nl === -1 ? content.length : nl;
      const line = content.slice(start, end);
      start = end + 1;
      if (!line) continue;
      try {
        const e = JSON.parse(line) as LogEntry;
        const w = e.worker;
        const p = e.data?.project;
        if (typeof w === "string" && typeof p === "string" && !map.has(w)) {
          map.set(w, p);
        }
      } catch { /* skip malformed line */ }
    }
  } catch { /* log file missing or unreadable */ }
  return map;
}

// Reset both caches — used by tests to avoid stale cross-test state when
// the on-disk log changes shape between cases.
export function resetWorkerMapCaches(): void {
  workerToProjectCache = null;
  workerToProjectHistoryCache = null;
  registryLoadFailed = false;
}

function projectForEntry(entry: LogEntry): string | null {
  const fromData = entry.data?.project;
  if (typeof fromData === "string") return fromData;
  if (entry.worker) {
    if (!workerToProjectCache) workerToProjectCache = loadWorkerMap();
    let p = workerToProjectCache.get(entry.worker);
    if (!p) {
      // Cache miss — refresh once in case a new worker was just created.
      workerToProjectCache = loadWorkerMap();
      p = workerToProjectCache.get(entry.worker);
    }
    if (p) return p;
    // Registry miss — worker may have been killed. Try the history cache
    // built from past log entries that carried `data.project`.
    if (!workerToProjectHistoryCache) workerToProjectHistoryCache = loadWorkerMapFromLog();
    const hp = workerToProjectHistoryCache.get(entry.worker);
    if (hp) return hp;
  }
  return null;
}

// Fixed column widths sized for typical garden names: project slugs run
// 5–12 chars, worker slugs are 3-word adj-adj-noun and run 12–22. Anything
// longer is truncated rather than reflowing the column dynamically.
const PROJECT_COL_WIDTH = 16;
const WORKER_COL_WIDTH = 22;

// Visible-width prefix before the message column in pretty mode:
// ts + "  " + project(16) + "  " + worker(22) + " " + glyph(1) + " ".
// Continuation lines indent to this width so each detail aligns under the
// headline's first message char.
const PRETTY_MESSAGE_COL = TIMESTAMP_WIDTH + 2 + PROJECT_COL_WIDTH + 2 + WORKER_COL_WIDTH + 1 + 1 + 1;

// ---- suppression ------------------------------------------------------------

interface SuppressRule {
  src: string;
  msg?: string | RegExp;
  // If set, every key/value pair must match `entry.data`.
  data?: Record<string, unknown>;
  // If set, suppression only applies up to this level; warn/error pass through.
  // Default: suppress at info+debug; warn and error always pass through.
}

const SUPPRESSED: SuppressRule[] = [
  // User's own keystrokes — they know they pressed the key.
  { src: "navigate" },
  // Mechanical pair-halves of navigation.
  { src: "layout", msg: "parked to hidden" },
  { src: "layout", msg: "restored from hidden" },
  { src: "layout", msg: "swapDirect" },
  // Per-tool-call hook spam.
  { src: "hook", msg: "claude hook", data: { event: "posttooluse" } },
  // Bulk on startup; only the *first* sessionstart per worker is interesting,
  // and that's hard to detect without extra state. Ready-state ones are the
  // mechanical bulk; non-ready ones still pass through.
  { src: "hook", msg: "claude hook", data: { event: "sessionstart", claudeStatus: "ready" } },
  // No-transition wakes.
  { src: "poller", msg: "poll cycle" },
  // Verbose, not actionable; full bash command in payload.
  { src: "judge", msg: "bash allow" },
  // 5-minute heartbeat.
  { src: "usage", msg: "fetched" },
  // Startup ceremony.
  { src: "usage-poller", msg: "started" },
  { src: "usage-poller", msg: "spawned window" },
  { src: "git", msg: "installed poll trigger hook" },
];

function ruleMatches(rule: SuppressRule, entry: LogEntry): boolean {
  if (rule.src !== entry.src) return false;
  if (rule.msg !== undefined) {
    if (typeof rule.msg === "string") {
      if (rule.msg !== entry.msg) return false;
    } else if (!rule.msg.test(entry.msg)) {
      return false;
    }
  }
  if (rule.data) {
    if (!entry.data) return false;
    for (const [k, v] of Object.entries(rule.data)) {
      if (entry.data[k] !== v) return false;
    }
  }
  return true;
}

function isSuppressed(entry: LogEntry): boolean {
  // Errors and warns are never suppressed regardless of source.
  if (entry.level === "error" || entry.level === "warn") return false;
  for (const rule of SUPPRESSED) {
    if (ruleMatches(rule, entry)) return true;
  }
  return false;
}

// ---- summarization ----------------------------------------------------------
//
// For known (src, msg) pairs, render a compact human sentence. For unknown
// entries, fall back to msg + the non-boring data fields. Errors keep their
// raw msg unconditionally — the original wording is the alert.

const BORING_DATA_KEYS = new Set([
  "project", "branch", "branchName", "workers",
  "prStateCleared", "windowName", "source", "level",
]);

function compactDataLines(data: Record<string, unknown>): string[] {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (BORING_DATA_KEYS.has(k)) continue;
    const s = typeof v === "string" ? v : JSON.stringify(v);
    parts.push(`${k}=${s}`);
  }
  return parts;
}

// Wrap a detail string into lines no wider than `firstWidth` (line 0) and
// `contWidth` (subsequent). Caller adds the "↳ "/"  " prefix and indent;
// this just splits the text. Caps total lines so a multi-KB value can't
// dominate the screen — overflow gets a trailing ellipsis on the last line.
export function wrapDetail(text: string, firstWidth: number, contWidth: number, maxLines: number): string[] {
  if (firstWidth < 10) return [text]; // terminal too narrow to wrap usefully
  const lines: string[] = [];
  let remaining = text;
  while (remaining.length > 0 && lines.length < maxLines) {
    const w = lines.length === 0 ? firstWidth : contWidth;
    if (remaining.length <= w) {
      lines.push(remaining);
      remaining = "";
      break;
    }
    // Prefer a whitespace break within the last quarter of the window;
    // otherwise hard-break so we don't leave a giant unbroken token.
    const minBreak = Math.floor(w * 0.75);
    const ws = remaining.lastIndexOf(" ", w);
    const breakAt = ws >= minBreak ? ws : w;
    lines.push(remaining.slice(0, breakAt).trimEnd());
    remaining = remaining.slice(breakAt).replace(/^\s+/, "");
  }
  if (remaining.length > 0) {
    const last = lines.pop() ?? "";
    const w = lines.length === 0 ? firstWidth : contWidth;
    const combined = remaining ? `${last} ${remaining}` : last;
    const room = Math.max(w - 1, 1);
    lines.push(combined.slice(0, room).trimEnd() + "…");
  }
  return lines;
}

interface Summarized {
  headline: string;
  details: string[];
}

type Summarizer = (entry: LogEntry) => string;

const SUMMARIZERS: Record<string, Summarizer> = {
  "poller:started": () => "poller started",
  "poller:reviewing -> failing": () => "✗ review failed",
  "poller:resolving -> merge-pending": () => "→ merge-pending (resolved)",
  "poller:resolving -> failing": () => "✗ resolver failed",
  "poller:launched review": () => "launched reviewer",
  "poller:launched resolver": () => "launched resolver",
  "poller:merged to base branch": (e) => {
    const base = e.data?.baseBranch;
    return typeof base === "string" ? `✓ merged into ${base}` : "✓ merged";
  },
  "poller:auto-continued worker after merge": () => "↻ auto-continued (next phase)",
  "hook:claude hook": (e) => {
    const event = String(e.data?.event ?? "?");
    const status = e.data?.claudeStatus;
    return typeof status === "string" ? `${event} → ${status}` : event;
  },
  "workers:created": () => "worker created",
  "workers:killed": () => "worker killed",
  "logs-filter:filter set": (e) => {
    const expr = typeof e.data?.expr === "string" ? e.data.expr : "";
    return expr ? `filter set: ${expr}` : "filter set";
  },
  "alert:": (e) => e.msg,
};

function summarize(entry: LogEntry): Summarized {
  // Alert entries: any msg, just print verbatim.
  if (entry.src === "alert") return { headline: entry.msg, details: [] };
  const key = `${entry.src}:${entry.msg}`;
  const fn = SUMMARIZERS[key];
  if (fn) return { headline: fn(entry), details: [] };
  // Poller emits every state change as "<from> -> <to>". Render any unmatched
  // transition with the unicode arrow so logs stay visually consistent.
  if (entry.src === "poller") {
    const m = entry.msg.match(/^(\S+) -> (\S+)$/);
    if (m) return { headline: `→ ${m[2]}`, details: [] };
  }
  const details = entry.data ? compactDataLines(entry.data) : [];
  return { headline: entry.msg, details };
}

// ---- rendering --------------------------------------------------------------

function formatRawEntry(entry: LogEntry, useRelativeTime: boolean): string {
  const ts = useRelativeTime ? relativeTime(entry.ts).padStart(TIMESTAMP_WIDTH) : absoluteTime(entry.ts);
  const levelColor = LEVEL_COLORS[entry.level] ?? "";
  const symbol = RAW_LEVEL_SYMBOLS[entry.level] ?? " ";
  const level = entry.level.toUpperCase().padEnd(5);
  const src = entry.src.padEnd(8);
  const workerStr = entry.worker ? `${color.magenta}${entry.worker.padEnd(20)}${color.reset} ` : "";
  const dataStr = entry.data
    ? `  ${color.dim}${Object.entries(entry.data).map(([k, v]) =>
        `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ")}${color.reset}`
    : "";
  return `${color.dim}${ts}${color.reset} ${levelColor}${symbol} ${level}${color.reset} ${color.cyan}${src}${color.reset} ${workerStr}${entry.msg}${dataStr}`;
}

function formatPrettyEntry(entry: LogEntry, useRelativeTime: boolean): string {
  const ts = useRelativeTime ? relativeTime(entry.ts).padStart(TIMESTAMP_WIDTH) : absoluteTime(entry.ts);
  const project = projectForEntry(entry);
  const rawLabel = project ?? "system";
  const projectLabel = rawLabel.length > PROJECT_COL_WIDTH ? rawLabel.slice(0, PROJECT_COL_WIDTH) : rawLabel.padEnd(PROJECT_COL_WIDTH);
  const projectColor = project ? colorForProject(project) : color.dim;
  const projectStr = `${projectColor}${projectLabel}${color.reset}`;
  // Project-level poller entries (started/stopped, postMerge, etc.) carry no
  // worker. Label the actor as "poller" so the column isn't blank for
  // entries that clearly originated from the project's poller.
  const workerLabel = entry.worker ?? (entry.src === "poller" ? "poller" : null);
  const workerStr = workerLabel
    ? `${color.dim}${workerLabel.padEnd(WORKER_COL_WIDTH)}${color.reset}`
    : " ".repeat(WORKER_COL_WIDTH);
  const glyph = PRETTY_LEVEL_GLYPHS[entry.level] ?? " ";
  const glyphColor = LEVEL_COLORS[entry.level] ?? "";
  const { headline, details } = summarize(entry);
  const msgColor = entry.level === "error" ? color.red : entry.level === "warn" ? color.yellow : "";
  const msgReset = msgColor ? color.reset : "";
  const headlineLine = `${color.dim}${ts}${color.reset}  ${projectStr}  ${workerStr} ${glyphColor}${glyph}${color.reset} ${msgColor}${headline}${msgReset}`;
  if (details.length === 0) return headlineLine;
  const indent = " ".repeat(PRETTY_MESSAGE_COL);
  // Wrap each detail to the terminal so long error/data dumps stay within
  // the message column instead of natural-wrapping back to column 0.
  // Continuation prefix "  " aligns wrapped text under the char after "↳ ".
  const termWidth = process.stdout.columns && process.stdout.columns > 0 ? process.stdout.columns : 120;
  const usable = Math.max(termWidth - PRETTY_MESSAGE_COL, 20);
  const firstWidth = Math.max(usable - 2, 10); // "↳ "
  const contWidth = Math.max(usable - 2, 10);  // "  "
  const continuationLines: string[] = [];
  for (const d of details) {
    const wrapped = wrapDetail(d, firstWidth, contWidth, 4);
    for (let i = 0; i < wrapped.length; i++) {
      const prefix = i === 0 ? "↳ " : "  ";
      continuationLines.push(`${indent}${color.dim}${prefix}${wrapped[i]}${color.reset}`);
    }
  }
  return [headlineLine, ...continuationLines].join("\n");
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
  project?: string;
  fuzzy?: string[];
  count: number;
  follow: boolean;
  modeOverride?: LogsMode;
  showAll: boolean;
  noSavedFilter?: boolean;
}

export function parseArgs(args: string[]): Filters {
  const filters: Filters = { count: 40, follow: false, showAll: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === "--level" || arg === "-l") && args[i + 1]) {
      filters.level = args[++i].toLowerCase();
    } else if ((arg === "--src" || arg === "-s") && args[i + 1]) {
      filters.src = args[++i].toLowerCase();
    } else if ((arg === "--worker" || arg === "-w") && args[i + 1]) {
      filters.worker = args[++i].toLowerCase();
    } else if ((arg === "--project" || arg === "-p") && args[i + 1]) {
      filters.project = args[++i].toLowerCase();
    } else if ((arg === "--count" || arg === "-n") && args[i + 1]) {
      filters.count = parseInt(args[++i], 10) || 40;
    } else if (arg === "--follow" || arg === "-f") {
      filters.follow = true;
    } else if (arg === "--all" || arg === "-a") {
      filters.showAll = true;
    } else if (arg === "--raw") {
      filters.modeOverride = "raw";
    } else if (arg === "--pretty") {
      filters.modeOverride = "pretty";
    } else if (arg === "--no-saved-filter") {
      filters.noSavedFilter = true;
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
  if (filters.project) {
    const proj = projectForEntry(entry);
    if (!proj || !proj.toLowerCase().includes(filters.project)) return false;
  }
  if (filters.fuzzy && filters.fuzzy.length > 0) {
    const proj = projectForEntry(entry) ?? "";
    const dataValues = entry.data ? collectStringValues(entry.data).join(" ") : "";
    const haystack = `${entry.worker ?? ""} ${entry.src ?? ""} ${entry.msg ?? ""} ${proj} ${dataValues}`.toLowerCase();
    for (const tok of filters.fuzzy) {
      if (!haystack.includes(tok.toLowerCase())) return false;
    }
  }
  return true;
}

// Recursively collect every string value reachable from `value`, ignoring keys.
// Used to build the fuzzy-match haystack — a worker name like "quick-shy-sheen"
// often appears only in nested data fields (data.from, data.branch,
// data.windowName, data.file, …), and missing those silently filtered out
// every event about that worker except the few with a top-level worker field.
function collectStringValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectStringValues);
  if (typeof value === "object" && value !== null) {
    return Object.values(value).flatMap(collectStringValues);
  }
  return [];
}

// ---- sticky filter ---------------------------------------------------------
//
// Persisted across dashboard restarts at LOGS_FILTER_FILE. Honored by both
// `garden logs` and `garden logs --follow` unless --no-saved-filter is set.
// CLI flags override sticky values field-by-field; the parser is forgiving
// (unknown `key:` prefixes fall through to fuzzy tokens).

const STRUCTURED_KEYS = new Set(["worker", "src", "level", "project"]);

export interface ParsedFilterExpr {
  worker?: string;
  src?: string;
  level?: string;
  project?: string;
  fuzzy: string[];
}

export function parseFilterExpr(expr: string): ParsedFilterExpr {
  const result: ParsedFilterExpr = { fuzzy: [] };
  const tokens = expr.trim().split(/\s+/).filter(Boolean);
  for (const tok of tokens) {
    const colon = tok.indexOf(":");
    if (colon > 0 && colon < tok.length - 1) {
      const key = tok.slice(0, colon).toLowerCase();
      const val = tok.slice(colon + 1).toLowerCase();
      if (STRUCTURED_KEYS.has(key)) {
        if (key === "worker" && result.worker === undefined) result.worker = val;
        else if (key === "src" && result.src === undefined) result.src = val;
        else if (key === "level" && result.level === undefined) result.level = val;
        else if (key === "project" && result.project === undefined) result.project = val;
        continue;
      }
    }
    result.fuzzy.push(tok.toLowerCase());
  }
  return result;
}

interface LogsFilterFile { expr: string }

function isLogsFilterFile(x: unknown): x is LogsFilterFile {
  if (!x || typeof x !== "object") return false;
  return typeof (x as Record<string, unknown>).expr === "string";
}

export function readStickyFilterExpr(): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(LOGS_FILTER_FILE, "utf-8"));
    return isLogsFilterFile(raw) ? raw.expr : null;
  } catch {
    return null;
  }
}

export function writeStickyFilterExpr(expr: string): void {
  const trimmed = expr.trim();
  if (!trimmed) {
    try { fs.unlinkSync(LOGS_FILTER_FILE); } catch { /* file may not exist */ }
    return;
  }
  atomicWriteFile(LOGS_FILTER_FILE, JSON.stringify({ expr: trimmed }));
}

// Pane-border label for the logs pane. When a sticky filter is active, the
// expression is appended after a dim separator so the operator can see at a
// glance that the tail is filtered (and what by). Pass `expr` to format a
// known value; omit it to read the current sticky filter from disk. Tmux
// format strings interpret `#` as the start of a directive, so any literal
// `#` in the expression is doubled.
export function formatLogsPaneLabel(expr?: string | null): string {
  const e = expr === undefined ? readStickyFilterExpr() : expr;
  if (!e) return "logs";
  const safe = e.replace(/#/g, "##");
  return `logs #[fg=colour244]· filter:#[default] ${safe}`;
}

export function loadStickyFilter(): Partial<Filters> | null {
  const expr = readStickyFilterExpr();
  if (!expr) return null;
  const parsed = parseFilterExpr(expr);
  const out: Partial<Filters> = {};
  if (parsed.worker !== undefined) out.worker = parsed.worker;
  if (parsed.src !== undefined) out.src = parsed.src;
  if (parsed.level !== undefined) out.level = parsed.level;
  if (parsed.project !== undefined) out.project = parsed.project;
  if (parsed.fuzzy.length > 0) out.fuzzy = parsed.fuzzy;
  return out;
}

// CLI args win field-by-field; sticky fills the gaps. Sticky's fuzzy is
// preserved when CLI doesn't set fuzzy (CLI has no flag for fuzzy today).
export function applyStickyDefaults(filters: Filters, sticky: Partial<Filters> | null): Filters {
  if (!sticky) return filters;
  return {
    ...filters,
    worker: filters.worker ?? sticky.worker,
    src: filters.src ?? sticky.src,
    level: filters.level ?? sticky.level,
    project: filters.project ?? sticky.project,
    fuzzy: filters.fuzzy ?? sticky.fuzzy,
  };
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
      last.entry = entry;
    } else {
      result.push({ entry, count: 1 });
    }
  }
  return result;
}

function formatEntry(entry: LogEntry, mode: LogsMode, useRelativeTime: boolean): string {
  return mode === "raw"
    ? formatRawEntry(entry, useRelativeTime)
    : formatPrettyEntry(entry, useRelativeTime);
}

// (×N) goes on the headline, never on a continuation line.
function appendDedupSuffix(rendered: string, count: number): string {
  if (count <= 1) return rendered;
  const suffix = `  ${color.dim}(×${count})${color.reset}`;
  const nl = rendered.indexOf("\n");
  if (nl === -1) return `${rendered}${suffix}`;
  return `${rendered.slice(0, nl)}${suffix}${rendered.slice(nl)}`;
}

function formatDedupedEntry(d: DedupedEntry, mode: LogsMode, useRelativeTime: boolean): string {
  return appendDedupSuffix(formatEntry(d.entry, mode, useRelativeTime), d.count);
}

interface RenderOptions {
  mode: LogsMode;
  showAll: boolean;
}

function applyPresentation(entries: LogEntry[], opts: RenderOptions): LogEntry[] {
  if (opts.mode === "raw" || opts.showAll) return entries;
  return entries.filter((e) => !isSuppressed(e));
}

function printEntries(entries: LogEntry[], filters: Filters, opts: RenderOptions, useRelativeTime: boolean): void {
  const filtered = entries.filter((e) => matchesFilters(e, filters));
  const presented = applyPresentation(filtered, opts);
  const tail = presented.slice(-filters.count);
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
    console.log(formatDedupedEntry(d, opts.mode, useRelativeTime));
  }
}

async function follow(filters: Filters, opts: RenderOptions): Promise<void> {
  let lastSize = 0;
  try {
    lastSize = fs.statSync(LOG_FILE).size;
  } catch { /* file doesn't exist yet */ }

  const lines = readLogLines();
  const entries = lines.map(parseLine).filter((e): e is LogEntry => e !== null);
  printEntries(entries, filters, opts, false);

  let prevKey = "";
  let repeatCount = 0;
  let prevLineCount = 1;

  // Move cursor back to the start of the previous render and clear each of
  // its lines so a multi-line entry can be rewritten in place when it repeats.
  // Cursor is at the end of the last written line (no trailing newline), so
  // we clear that line first, then walk up.
  const clearPreviousRender = (lineCount: number): string => {
    let s = "\r\x1b[K";
    for (let i = 1; i < lineCount; i++) s += "\x1b[A\x1b[K";
    return s;
  };

  const poll = setInterval(() => {
    let currentSize: number;
    try {
      currentSize = fs.statSync(LOG_FILE).size;
    } catch {
      return;
    }

    if (currentSize <= lastSize) {
      if (currentSize < lastSize) lastSize = 0;
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
      if (opts.mode === "pretty" && !opts.showAll && isSuppressed(entry)) continue;

      const key = dedupKey(entry);
      const rendered = formatEntry(entry, opts.mode, false);
      const renderedLineCount = rendered.split("\n").length;
      if (key === prevKey) {
        repeatCount++;
        process.stdout.write(
          `${clearPreviousRender(prevLineCount)}${appendDedupSuffix(rendered, repeatCount)}`,
        );
        prevLineCount = renderedLineCount;
      } else {
        if (prevKey) process.stdout.write("\n");
        process.stdout.write(rendered);
        prevKey = key;
        repeatCount = 1;
        prevLineCount = renderedLineCount;
      }
    }
  }, 1000);

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

// ---- subcommand handling: persistent mode toggle ---------------------------

async function setModeAndRefresh(mode: LogsMode): Promise<void> {
  setLogsMode(mode);
  console.log(`logs mode set to ${color.bold}${mode}${color.reset}`);
  // If a dashboard is running, respawn the logs pane so the change takes
  // effect immediately. Otherwise this is a no-op (next launch picks it up).
  try {
    const { dashboardExists } = await import("../session.js");
    if (!dashboardExists()) return;
    const { readDashState } = await import("../dashboard/state.js");
    const { respawnLogsPane } = await import("../dashboard/create.js");
    respawnLogsPane(readDashState());
  } catch { /* dashboard not loadable; config write is enough */ }
}

async function handleModeSubcommand(args: string[]): Promise<boolean> {
  const sub = args[0];
  if (sub === "raw" || sub === "pretty") {
    await setModeAndRefresh(sub);
    return true;
  }
  if (sub === "mode") {
    if (args[1] === "raw" || args[1] === "pretty") {
      await setModeAndRefresh(args[1]);
    } else {
      console.log(getLogsMode());
    }
    return true;
  }
  return false;
}

// `garden logs filter <expr...>` — escape hatch for setting the sticky filter
// from a regular shell when the dashboard's command-prompt would garble the
// expression (e.g. embedded single quotes). `garden logs filter` shows the
// current value; `garden logs filter --clear` removes it.
async function handleFilterSubcommand(args: string[]): Promise<boolean> {
  if (args[0] !== "filter") return false;
  const sub2 = args[1];
  if (!sub2) {
    const current = readStickyFilterExpr();
    if (current) console.log(current);
    else console.log(`${color.dim}(no sticky filter)${color.reset}`);
    return true;
  }
  if (sub2 === "--clear" || sub2 === "clear") {
    writeStickyFilterExpr("");
    console.log("sticky logs filter cleared");
  } else {
    const expr = args.slice(1).join(" ");
    writeStickyFilterExpr(expr);
    console.log(`sticky logs filter: ${expr.trim()}`);
  }
  await respawnLogsPaneIfRunning();
  return true;
}

async function respawnLogsPaneIfRunning(): Promise<void> {
  try {
    const { dashboardExists } = await import("../session.js");
    if (!dashboardExists()) return;
    const { readDashState } = await import("../dashboard/state.js");
    const { respawnLogsPane } = await import("../dashboard/create.js");
    respawnLogsPane(readDashState());
  } catch { /* dashboard not loadable; file write is enough */ }
}

export async function logs(args: string[]): Promise<void> {
  if (await handleModeSubcommand(args)) return;
  if (await handleFilterSubcommand(args)) return;

  const cliFilters = parseArgs(args);
  const sticky = cliFilters.noSavedFilter ? null : loadStickyFilter();
  const filters = applyStickyDefaults(cliFilters, sticky);
  const mode: LogsMode = filters.modeOverride ?? getLogsMode();
  const opts: RenderOptions = { mode, showAll: filters.showAll };

  if (filters.follow) {
    await follow(filters, opts);
    return;
  }

  const lines = readLogLines();
  const entries = lines.map(parseLine).filter((e): e is LogEntry => e !== null);
  printEntries(entries, filters, opts, true);
}

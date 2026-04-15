// Reviewer findings: captures structured findings from reviewer output,
// tallies them across workers and projects, and surfaces recurring categories
// as suggested rule additions.
//
// Persistence: ~/.garden/sessions/rules-findings.json, written atomically
// using the same write-tmp-then-rename pattern as alerts.ts. Only the poller
// writes findings; only the `rules` command writes suggestion status.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SESSIONS_DIR } from "../config.js";
import { addAlert } from "./alerts.js";
import { log } from "./log.js";

export type FindingVerdict = "fixed" | "failed";
export type SuggestionState = "pending" | "accepted" | "dismissed";

export interface Finding {
  id: string;
  ts: string;
  project: string;
  worker: string;
  verdict: FindingVerdict;
  category: string;
  summary: string;
}

export interface SuggestionStatus {
  status: SuggestionState;
  firstSeenAt: string;
  lastSeenAt: string;
  acceptedAt?: string;
  dismissedAt?: string;
  appendedTo?: string;
  alertFiredAt?: string;
}

export interface FindingsStore {
  findings: Finding[];
  suggestions: Record<string, SuggestionStatus>;
}

export interface SuggestionSummary {
  category: string;
  count: number;
  distinctWorkers: number;
  projects: string[];
  workers: string[];
  examples: string[];
  firstSeenAt: string;
  lastSeenAt: string;
  status: SuggestionState;
  appendedTo?: string;
}

export const FINDINGS_FILE = path.join(SESSIONS_DIR, "rules-findings.json");

const MAX_FINDINGS = 1000;
const THRESHOLD_COUNT = 3;
const THRESHOLD_WORKERS = 2;
const THRESHOLD_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const CATEGORY_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

// --- Store I/O ---

export function readFindings(): FindingsStore {
  try {
    if (fs.existsSync(FINDINGS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(FINDINGS_FILE, "utf-8"));
      return {
        findings: Array.isArray(parsed.findings) ? parsed.findings : [],
        suggestions: parsed.suggestions && typeof parsed.suggestions === "object"
          ? parsed.suggestions
          : {},
      };
    }
  } catch {
    // corrupt or missing — start fresh
  }
  return { findings: [], suggestions: {} };
}

function writeFindings(store: FindingsStore): void {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const tmpFile = `${FINDINGS_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(store, null, 2));
  fs.renameSync(tmpFile, FINDINGS_FILE);
}

// --- FINDINGS block parser ---

interface RawFinding {
  category: string;
  summary: string;
}

// Extracts the findings JSON block from reviewer body text. The reviewer is
// instructed to emit it as a fenced ```findings block immediately before the
// verdict line. Returns null when the block is absent or unparseable.
export function parseFindingsBlock(body: string): RawFinding[] | null {
  const match = body.match(/```findings\s*\n([\s\S]*?)```/);
  if (!match) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const out: RawFinding[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const category = (item as { category?: unknown }).category;
    const summary = (item as { summary?: unknown }).summary;
    if (typeof category !== "string" || typeof summary !== "string") continue;
    const cat = category.trim().toLowerCase();
    const sum = summary.trim();
    if (!CATEGORY_RE.test(cat) || sum.length === 0) continue;
    out.push({ category: cat, summary: sum });
  }
  return out;
}

// --- Recording ---

export interface RecordInput {
  project: string;
  worker: string;
  verdict: FindingVerdict;
  body: string;
}

// Called by the poller after a review completes with verdict FIXED or FAILED.
// Parses the findings block, appends each finding to the store, and if a
// category crosses the threshold for the first time, fires a one-time alert.
export function recordFindings(input: RecordInput): void {
  const raw = parseFindingsBlock(input.body);
  if (!raw || raw.length === 0) return;

  const store = readFindings();
  const now = new Date().toISOString();
  const crossed = new Set<string>();

  for (const f of raw) {
    const wasPending = isPending(store, f.category, now);

    store.findings.push({
      id: crypto.randomUUID(),
      ts: now,
      project: input.project,
      worker: input.worker,
      verdict: input.verdict,
      category: f.category,
      summary: f.summary,
    });

    const sug = store.suggestions[f.category] ?? {
      status: "pending" as SuggestionState,
      firstSeenAt: now,
      lastSeenAt: now,
    };
    sug.lastSeenAt = now;
    if (!sug.firstSeenAt) sug.firstSeenAt = now;
    store.suggestions[f.category] = sug;

    if (!wasPending && isPending(store, f.category, now) && !sug.alertFiredAt
        && sug.status === "pending") {
      crossed.add(f.category);
      sug.alertFiredAt = now;
    }
  }

  if (store.findings.length > MAX_FINDINGS) {
    store.findings = store.findings.slice(-MAX_FINDINGS);
  }

  writeFindings(store);

  for (const category of crossed) {
    const summary = summarize(store, category, now);
    addAlert({
      level: "warn",
      source: "rules",
      project: summary.projects.length === 1 ? summary.projects[0] : "*",
      message: `Rule suggestion ready: "${category}" (${summary.count} findings across ${summary.distinctWorkers} workers). Run \`garden rules suggest\`.`,
    });
    log.info("findings", "suggestion threshold crossed", {
      data: { category, count: summary.count, workers: summary.distinctWorkers },
    });
  }
}

// --- Threshold + summaries ---

function withinWindow(ts: string, now: string): boolean {
  const t = Date.parse(ts);
  const n = Date.parse(now);
  if (Number.isNaN(t) || Number.isNaN(n)) return false;
  return n - t <= THRESHOLD_WINDOW_MS;
}

function isPending(store: FindingsStore, category: string, now: string): boolean {
  const recent = store.findings.filter(
    f => f.category === category && withinWindow(f.ts, now),
  );
  if (recent.length < THRESHOLD_COUNT) return false;
  const workers = new Set(recent.map(f => `${f.project}/${f.worker}`));
  return workers.size >= THRESHOLD_WORKERS;
}

function summarize(
  store: FindingsStore,
  category: string,
  now: string,
): SuggestionSummary {
  const recent = store.findings.filter(
    f => f.category === category && withinWindow(f.ts, now),
  );
  const projects = [...new Set(recent.map(f => f.project))].sort();
  const workers = [...new Set(recent.map(f => `${f.project}/${f.worker}`))].sort();
  const examples = [...new Set(recent.map(f => f.summary))].slice(0, 3);
  const firstSeenAt = recent.reduce(
    (min, f) => (f.ts < min ? f.ts : min),
    recent[0]?.ts ?? now,
  );
  const lastSeenAt = recent.reduce(
    (max, f) => (f.ts > max ? f.ts : max),
    recent[0]?.ts ?? now,
  );
  const sug = store.suggestions[category];
  return {
    category,
    count: recent.length,
    distinctWorkers: workers.length,
    projects,
    workers,
    examples,
    firstSeenAt,
    lastSeenAt,
    status: sug?.status ?? "pending",
    appendedTo: sug?.appendedTo,
  };
}

// Returns all categories that have crossed the threshold and whose suggestion
// status is still "pending". Sorted by count descending.
export function pendingSuggestions(): SuggestionSummary[] {
  const store = readFindings();
  const now = new Date().toISOString();
  const out: SuggestionSummary[] = [];
  for (const category of Object.keys(store.suggestions)) {
    if (store.suggestions[category].status !== "pending") continue;
    if (!isPending(store, category, now)) continue;
    out.push(summarize(store, category, now));
  }
  out.sort((a, b) => b.count - a.count);
  return out;
}

export function getSuggestion(category: string): SuggestionSummary | null {
  const store = readFindings();
  if (!store.suggestions[category]) return null;
  return summarize(store, category, new Date().toISOString());
}

export function markSuggestion(
  category: string,
  status: SuggestionState,
  fields?: { appendedTo?: string },
): void {
  const store = readFindings();
  const now = new Date().toISOString();
  const existing = store.suggestions[category] ?? {
    status: "pending" as SuggestionState,
    firstSeenAt: now,
    lastSeenAt: now,
  };
  existing.status = status;
  if (status === "accepted") {
    existing.acceptedAt = now;
    if (fields?.appendedTo) existing.appendedTo = fields.appendedTo;
  } else if (status === "dismissed") {
    existing.dismissedAt = now;
  }
  store.suggestions[category] = existing;
  writeFindings(store);
}

export function listFindings(filter?: { project?: string }): Finding[] {
  const store = readFindings();
  if (!filter?.project) return [...store.findings];
  return store.findings.filter(f => f.project === filter.project);
}

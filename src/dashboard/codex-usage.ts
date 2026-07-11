// Codex usage meter. Codex writes a `rate_limits` object into its rollout
// JSONL on every turn (an event_msg whose payload carries primary/secondary
// rolling windows + a credits balance) — the same shape as Anthropic's quota
// meter. Garden needs no new auth, endpoint, or poller: the data is already on
// disk in the worker's rollout, so it is captured at Stop-hook time (when the
// hook already has transcript_path) and cached for the title-pane meter.
//
// Windows are sorted smaller-first (a 5h window above the 30d window) to match
// the Claude meter's 5h-over-week ordering. In practice Codex reports only the
// 30d (window_minutes=43200) window for a subscription account; `secondary`
// (the shorter window) populates when relevant.
//
// Light module (fs + JSON only): reachable from the hook bundle.
import fs from "node:fs";
import path from "node:path";
import { SESSIONS_DIR } from "../config.js";
import { atomicWriteFile } from "./atomic-write.js";

const CODEX_USAGE_FILE = path.join(SESSIONS_DIR, "codex-usage.json");
// rate_limits rides recent response events; the tail is plenty and keeps the
// Stop-hook read cheap even as a rollout grows.
const TAIL_BYTES = 256 * 1024;

export interface CodexUsageWindow {
  /** Window length in minutes (300 = 5h, 10080 = 7d, 43200 = 30d). */
  windowMinutes: number;
  usedPercent: number;
  /** Reset time in epoch SECONDS, as Codex reports it. */
  resetsAt: number;
}
export interface CodexUsageData {
  /** Rolling windows, sorted ascending by windowMinutes (smaller first). */
  windows: CodexUsageWindow[];
  /** Pay-as-you-go credit balance on top of the subscription, when present. */
  creditBalance?: number | null;
  creditsUnlimited?: boolean;
}
export interface CodexUsageSnapshot {
  capturedAt: number; // epoch ms
  data: CodexUsageData;
}

interface RawWindow {
  used_percent?: unknown;
  window_minutes?: unknown;
  resets_at?: unknown;
}

function toWindow(w: unknown): CodexUsageWindow | null {
  if (!w || typeof w !== "object") return null;
  const r = w as RawWindow;
  if (typeof r.used_percent !== "number" || typeof r.window_minutes !== "number" || typeof r.resets_at !== "number") {
    return null;
  }
  return { windowMinutes: r.window_minutes, usedPercent: r.used_percent, resetsAt: r.resets_at };
}

// Parse the LAST rate_limits object from a rollout's tail into CodexUsageData.
// Returns null when the rollout has none (older codex, or no response yet).
export function parseCodexRateLimits(rolloutPath: string): CodexUsageData | null {
  let text: string;
  try {
    const stat = fs.statSync(rolloutPath);
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const len = stat.size - start;
    const fd = fs.openSync(rolloutPath, "r");
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      text = buf.toString("utf-8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }

  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"rate_limits"')) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      continue; // a clipped first line, or not an event_msg — keep scanning
    }
    const rl = (obj as { payload?: { rate_limits?: unknown } })?.payload?.rate_limits;
    if (!rl || typeof rl !== "object") continue;
    const data = fromRateLimits(rl as Record<string, unknown>);
    if (data) return data;
  }
  return null;
}

function fromRateLimits(rl: Record<string, unknown>): CodexUsageData | null {
  const windows: CodexUsageWindow[] = [];
  for (const key of ["primary", "secondary"] as const) {
    const w = toWindow(rl[key]);
    if (w) windows.push(w);
  }
  const credits = rl.credits && typeof rl.credits === "object"
    ? (rl.credits as { balance?: unknown; unlimited?: unknown })
    : null;
  if (windows.length === 0 && !credits) return null;
  windows.sort((a, b) => a.windowMinutes - b.windowMinutes);
  const data: CodexUsageData = { windows };
  if (credits) {
    data.creditBalance = typeof credits.balance === "number" ? credits.balance : null;
    data.creditsUnlimited = Boolean(credits.unlimited);
  }
  return data;
}

export function readCodexUsage(): CodexUsageSnapshot | null {
  try {
    const snap = JSON.parse(fs.readFileSync(CODEX_USAGE_FILE, "utf-8"));
    if (snap && typeof snap.capturedAt === "number" && snap.data && Array.isArray(snap.data.windows)) {
      return snap as CodexUsageSnapshot;
    }
  } catch {
    /* absent or corrupt */
  }
  return null;
}

export function writeCodexUsage(data: CodexUsageData): void {
  const snap: CodexUsageSnapshot = { capturedAt: Date.now(), data };
  try {
    atomicWriteFile(CODEX_USAGE_FILE, JSON.stringify(snap));
  } catch {
    /* best effort — a missed capture just leaves the prior snapshot */
  }
}

// Capture from a Codex worker's rollout at Stop-hook time. Best-effort: a
// missing rollout or absent rate_limits leaves the prior snapshot in place.
export function captureCodexUsage(rolloutPath: string | undefined): void {
  if (!rolloutPath) return;
  const data = parseCodexRateLimits(rolloutPath);
  if (data) writeCodexUsage(data);
}

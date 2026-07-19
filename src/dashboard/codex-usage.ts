// Codex usage meter. Codex writes a `rate_limits` object into its rollout
// JSONL on every turn (an event_msg whose payload carries primary/secondary
// rolling windows + a credits balance) — the same shape as Anthropic's quota
// meter. Garden needs no new auth or endpoint: the data is already on disk in
// each Codex process's rollout, so it is read from there and cached for the
// title-pane meter.
//
// Capture is ROLE-AGNOSTIC. Every Codex process spends the same quota, so the
// meter reads the newest rollout on the fleet (captureCodexUsageLatest) rather
// than one known worker's transcript. This was previously a Stop-hook capture
// keyed on the WORKER's transcript_path, which meant a project whose crew put
// Codex only on the reviewer seat (`claude-codex`) burned Codex quota and
// showed no meter at all — the headless reviewer/resolver/ci-fix roles fire no
// lifecycle hook. Reading whatever rollout is newest covers every role, plus
// any added later, from one call site.
//
// Reading the rollout is PASSIVE — it can only ever be as fresh as the last
// time Codex actually ran. probeCodexUsage is the active half: a minimal
// `codex exec` made purely to make Codex report its quota, the direct analog of
// the Claude meter's 1-token /v1/messages completion. Without it a fleet that
// runs Codex occasionally shows a reading captured days ago, and a plan change
// in between makes that reading not merely stale but arithmetic against a quota
// that no longer exists (observed: a plan upgrade moved limit_id premium->codex
// AND the window from 43200 to 10080 minutes, so the old percentage was against
// a different denominator entirely).
//
// Windows are sorted smaller-first (a 5h window above the 30d window) to match
// the Claude meter's 5h-over-week ordering; which windows populate depends on
// the plan (`window_minutes` 10080 = 7d on Plus, 43200 = 30d elsewhere).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SESSIONS_DIR, loadConfig } from "../config.js";
import { atomicWriteFile } from "./atomic-write.js";
import { readRegistry } from "./registry.js";

const CODEX_USAGE_FILE = path.join(SESSIONS_DIR, "codex-usage.json");
// rate_limits rides recent response events; the tail is plenty and keeps each
// watchdog-tick read cheap even as a rollout grows.
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
  // A `credits` object alone is not a reading. Verified against real rollouts
  // (codex 0.144.5): Codex emits rate_limits on EVERY turn but populates it only
  // periodically — the common shape is
  //   { primary: null, secondary: null, credits: { balance: null, unlimited: false } }
  // whose truthy-but-empty credits object used to satisfy the old
  // `windows.length === 0 && !credits` guard. That produced a windows-[] snapshot
  // that renders as nothing AND overwrote a good prior one. Requiring a real
  // reading also makes parseCodexRateLimits's backward scan skip the all-null
  // tail and find the last genuinely populated entry.
  // Codex reports `balance` as a STRING ("0"), not a number — observed on a
  // real Plus account. Coerce rather than type-test, or a genuine balance is
  // silently dropped and the credits footer never renders.
  const balance = toBalance(credits?.balance);
  const hasCredits = credits !== null && (balance !== null || credits.unlimited === true);
  if (windows.length === 0 && !hasCredits) return null;
  windows.sort((a, b) => a.windowMinutes - b.windowMinutes);
  const data: CodexUsageData = { windows };
  if (hasCredits) {
    data.creditBalance = balance;
    data.creditsUnlimited = credits!.unlimited === true;
  }
  return data;
}

function toBalance(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
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

// Codex's rollout root. Deliberately duplicated from the harness adapter's
// codexHome() rather than imported: this module is a leaf (fs + JSON only) and
// importing codex-core.ts would drag its tmux/runner closure into every caller.
function codexSessionsDir(): string {
  const home = process.env.CODEX_HOME || path.join(process.env.HOME || os.homedir(), ".codex");
  return path.join(home, "sessions");
}

// How many rollouts back to try before giving up. Codex populates rate_limits
// only periodically, so the single newest rollout is routinely all-null for its
// whole life (a short reviewer run can end without ever getting one) while a
// sibling from the same day holds dozens of real readings. Trying a handful
// back finds the reading; the cap bounds the work at a few tail reads.
const MAX_ROLLOUTS_TRIED = 5;

// The newest rollouts under $CODEX_HOME/sessions/YYYY/MM/DD, mtime-descending.
// Descends by taking the lexicographically largest entry at each level and
// backtracking when a branch holds no rollout files — so an empty day dir just
// after midnight, or a pruned month, falls through to the previous real one
// without walking the whole (year-deep) tree. Within the winning day dir files
// are ranked by mtime, not name: a long-running worker's rollout keeps being
// appended, so it can carry a fresher reading than a newer-named short run.
function findNewestRollouts(limit: number): string[] {
  const descend = (dir: string, depth: number): string[] => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    if (depth === 3) {
      const files: Array<{ path: string; mtime: number }> = [];
      for (const e of entries) {
        if (!e.isFile() || !e.name.startsWith("rollout-") || !e.name.endsWith(".jsonl")) continue;
        const full = path.join(dir, e.name);
        try {
          files.push({ path: full, mtime: fs.statSync(full).mtimeMs });
        } catch { /* raced with a prune */ }
      }
      return files.sort((a, b) => b.mtime - a.mtime).slice(0, limit).map((f) => f.path);
    }
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse();
    for (const name of dirs) {
      const hit = descend(path.join(dir, name), depth + 1);
      if (hit.length > 0) return hit;
    }
    return [];
  };
  return descend(codexSessionsDir(), 0);
}

// Role-agnostic capture: read the newest rollout any Codex process wrote, from
// any role. Returns true when the snapshot actually changed, so the caller can
// repaint the title pane only on a real move. No-ops on a fleet that has never
// run Codex (the sessions dir is absent) and skips the write when the reading
// is identical, so an idle fleet never churns the file.
export function captureCodexUsageLatest(): boolean {
  for (const rollout of findNewestRollouts(MAX_ROLLOUTS_TRIED)) {
    const data = parseCodexRateLimits(rollout);
    if (!data) continue; // no populated reading in this one — try the next newest
    const prior = readCodexUsage();
    if (prior && JSON.stringify(prior.data) === JSON.stringify(data)) return false;
    writeCodexUsage(data);
    return true;
  }
  return false;
}

// Is Codex actually in this fleet? probeCodexUsage spends real Codex quota, so
// it must never fire on an all-Claude garden. True when any project selects the
// codex harness for its worker or any review role, or any registered worker was
// spawned on it (including via a per-worker crew, whose name encodes both
// halves — `claude-codex` is a Codex reviewer).
export function codexInFleet(): boolean {
  try {
    for (const p of Object.values(loadConfig().projects)) {
      if (p.harness === "codex") return true;
      for (const role of [p.roles?.reviewer, p.roles?.resolver, p.roles?.ciFix]) {
        if (role?.harness === "codex") return true;
      }
    }
  } catch { /* config unreadable — fall through to the registry */ }
  try {
    for (const entries of Object.values(readRegistry().workers)) {
      for (const e of entries) {
        if (e.harness === "codex") return true;
        if (typeof e.crew === "string" && e.crew.includes("codex")) return true;
      }
    }
  } catch { /* registry unreadable */ }
  return false;
}

// A probe must not outlive a poll cycle; codex exec on a trivial prompt is a
// few seconds (measured ~4s), so this is a hang guard, not a budget.
const PROBE_TIMEOUT_MS = 60_000;

// Make Codex report its current quota. Callers MUST gate on codexInFleet().
//
// `-s read-only` plus a temp cwd so the probe can never touch a worktree;
// --skip-git-repo-check because that cwd is not a repo; stdin closed so
// `codex exec` cannot block waiting for piped instructions (it reads stdin when
// the prompt argument is absent, and would hang forever on an inherited tty).
//
// Returns true when the snapshot moved. A failure is deliberately not fatal:
// offline, codex-not-installed, and out-of-quota all land here, and the
// out-of-quota case still writes a rollout on its way down — so capture
// whatever landed rather than discarding the run.
export function probeCodexUsage(): boolean {
  try {
    execFileSync(
      "codex",
      ["exec", "-s", "read-only", "--skip-git-repo-check", "Reply with the single word: ok"],
      { cwd: os.tmpdir(), stdio: "ignore", timeout: PROBE_TIMEOUT_MS },
    );
  } catch { /* see above — capture anything the attempt wrote */ }
  return captureCodexUsageLatest();
}

// Command: garden doctor — environment preflight. Checks the external tools
// garden depends on (tmux, claude, gh), the node version floor, whether garden
// is initialized, whether each registered project serves one instruction file
// to both harnesses, and surfaces the one prerequisite it can't verify
// programmatically (the Option-as-Meta terminal setting). A first-run operator
// on a fresh box runs this to find out what's missing before hitting a cryptic
// mid-workflow failure.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";
import { output, isTTY } from "../output.js";
import { CONFIG_PATH, loadConfig, beadsStoreError } from "../config.js";

// Node 22.1 is the floor: the worker hook commands set NODE_COMPILE_CACHE
// (added in 22.1) to reuse cached V8 bytecode across cold starts. Older node
// still runs but silently loses that optimization.
const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 1;

type CheckStatus = "ok" | "warn" | "fail";

interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

// Run `bin args...` and return trimmed stdout, or null if the binary is missing
// or exits nonzero. Bounded so a hung tool can't wedge the command.
function tryRun(bin: string, args: string[]): string | null {
  try {
    const r = spawnSync(bin, args, { encoding: "utf-8", timeout: 10_000 });
    if (r.error || r.status !== 0) return null;
    return (r.stdout ?? "").trim();
  } catch {
    return null;
  }
}

function checkTmux(): Check {
  const v = tryRun("tmux", ["-V"]);
  return v
    ? { name: "tmux", status: "ok", detail: v }
    : { name: "tmux", status: "fail", detail: "not found — the dashboard is a tmux session; install tmux" };
}

function checkClaude(): Check {
  const v = tryRun("claude", ["--version"]);
  return v
    ? { name: "claude", status: "ok", detail: v }
    : { name: "claude", status: "fail", detail: "not found — workers and reviewers run `claude`; install Claude Code" };
}

function checkGh(): Check {
  const v = tryRun("gh", ["--version"]);
  if (!v) {
    return { name: "gh", status: "warn", detail: "not found — optional; the CI gate and `garden create` need it" };
  }
  const version = v.split("\n")[0] ?? "gh";
  const authed = spawnSync("gh", ["auth", "status"], { encoding: "utf-8", timeout: 10_000 });
  const ok = !authed.error && authed.status === 0;
  return {
    name: "gh",
    status: ok ? "ok" : "warn",
    detail: ok ? `${version} (authenticated)` : `${version} (not authenticated — run 'gh auth login')`,
  };
}

// Parse a `vMAJOR.MINOR…` string and test it against the floor. Unparseable
// input fails closed (warn) rather than falsely passing. Exported for testing
// since process.version can't be mocked.
export function nodeMeetsFloor(version: string): boolean {
  const m = version.match(/^v(\d+)\.(\d+)/);
  const major = m ? Number(m[1]) : 0;
  const minor = m ? Number(m[2]) : 0;
  return major > MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR);
}

function checkNode(): Check {
  return nodeMeetsFloor(process.version)
    ? { name: "node", status: "ok", detail: process.version }
    : {
        name: "node",
        status: "warn",
        detail: `${process.version} — garden needs Node >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} for the worker hook compile-cache; upgrade node`,
      };
}

function checkConfig(): Check {
  return existsSync(CONFIG_PATH)
    ? { name: "config", status: "ok", detail: CONFIG_PATH }
    : { name: "config", status: "warn", detail: "not initialized — run 'garden init'" };
}

// Claude Code reads CLAUDE.md and never AGENTS.md; Codex reads AGENTS.md and
// never CLAUDE.md. A fleet that runs both harnesses against the same repo needs
// one real file plus a pointer, or the two drift apart and each harness works
// from a different set of instructions. Anthropic documents the pointer as an
// `@AGENTS.md` import in CLAUDE.md, or a symlink.
export type AgentDocsState =
  | "paired"    // one real file, the other points at it
  | "unlinked"  // both exist as independent files — they will drift
  | "claude-only"
  | "codex-only"
  | "none";     // no agent instructions at all; nothing to unify

// True when `file` is a pointer at `target` — a symlink to it, or a CLAUDE.md
// whose body is an `@target` import line (import parsing skips code fences, so
// a fenced mention does not count).
function pointsAt(dir: string, file: string, target: string): boolean {
  const full = path.join(dir, file);
  try {
    if (lstatSync(full).isSymbolicLink()) {
      return path.basename(readlinkSync(full)) === target;
    }
  } catch {
    return false;
  }
  try {
    const body = readFileSync(full, "utf-8").replace(/^```[\s\S]*?^```$/gm, "");
    return new RegExp(`^\\s*@${target.replace(".", "\\.")}\\s*$`, "m").test(body);
  } catch {
    return false;
  }
}

export function classifyAgentDocs(dir: string): AgentDocsState {
  const hasClaude = existsSync(path.join(dir, "CLAUDE.md"));
  const hasAgents = existsSync(path.join(dir, "AGENTS.md"));
  if (!hasClaude && !hasAgents) return "none";
  if (!hasAgents) return "claude-only";
  if (!hasClaude) return "codex-only";
  const linked = pointsAt(dir, "CLAUDE.md", "AGENTS.md") || pointsAt(dir, "AGENTS.md", "CLAUDE.md");
  return linked ? "paired" : "unlinked";
}

const AGENT_DOCS_FIX: Record<Exclude<AgentDocsState, "paired" | "none">, string> = {
  unlinked: "both files exist independently and will drift — merge into AGENTS.md, leave '@AGENTS.md' in CLAUDE.md",
  "claude-only": "Codex reads no instructions here — 'git mv CLAUDE.md AGENTS.md', then a CLAUDE.md of '@AGENTS.md'",
  "codex-only": "Claude Code reads no instructions here — add a CLAUDE.md containing '@AGENTS.md'",
};

function checkAgentDocs(): Check {
  let projects: Record<string, { path: string }>;
  try {
    projects = loadConfig().projects ?? {};
  } catch {
    return { name: "agent docs", status: "warn", detail: "could not read the project list" };
  }
  const unpaired: string[] = [];
  let paired = 0;
  for (const [name, project] of Object.entries(projects)) {
    const state = classifyAgentDocs(project.path);
    if (state === "paired") paired++;
    else if (state !== "none") unpaired.push(`${name} (${AGENT_DOCS_FIX[state].split(" — ")[0]})`);
  }
  if (unpaired.length === 0) {
    return { name: "agent docs", status: "ok", detail: `${paired} project(s) serve one file to both harnesses` };
  }
  return {
    name: "agent docs",
    status: "warn",
    detail: `CLAUDE.md / AGENTS.md not paired in ${unpaired.length}: ${unpaired.join(", ")}`,
  };
}

// Shared-store preflight (board docs/DELEGATION.md Decision 15): every
// project pinning a beadsDir must point at an existing directory, or its
// intake pass reads one store while nothing writes it — the split-brain the
// shared resolver exists to prevent. Only rendered when at least one project
// sets the key; the default own-checkout store needs no preflight (bd
// bootstraps it on first use, legacy behavior). Exported for tests.
export function checkBeadsStores(
  projects: Record<string, { path: string; beadsDir?: string }>,
): Check | null {
  const rows: string[] = [];
  const bad: string[] = [];
  for (const [name, project] of Object.entries(projects)) {
    if (!project.beadsDir) continue;
    const err = beadsStoreError(project);
    if (err) bad.push(`${name}: ${err}`);
    else rows.push(`${name} → ${project.beadsDir}`);
  }
  if (rows.length === 0 && bad.length === 0) return null;
  if (bad.length > 0) {
    return { name: "beads stores", status: "warn", detail: bad.join("; ") };
  }
  return { name: "beads stores", status: "ok", detail: rows.join("; ") };
}

function checkBeadsStoresFromConfig(): Check | null {
  try {
    return checkBeadsStores(loadConfig().projects ?? {});
  } catch {
    return null;
  }
}

function checkOptionKey(): Check {
  // Not programmatically verifiable — the dashboard hotkeys are M-<key>
  // bindings that only fire if the terminal sends Option as Meta/Esc+.
  return {
    name: "Option key",
    status: "warn",
    detail: "cannot verify — terminal must send Left Option as Meta/Esc+ (see 'garden keys' setup line)",
  };
}

export async function doctor(): Promise<void> {
  const checks: Check[] = [
    checkTmux(),
    checkClaude(),
    checkGh(),
    checkNode(),
    checkConfig(),
    checkAgentDocs(),
    checkBeadsStoresFromConfig(),
    checkOptionKey(),
  ].filter((c): c is Check => c !== null);

  if (!isTTY) {
    output({ checks });
    return;
  }

  console.log("");
  console.log("  garden doctor — environment preflight");
  console.log("");
  const nameWidth = Math.max(...checks.map(c => c.name.length));
  for (const c of checks) {
    console.log(`    ${glyph(c.status)} ${c.name.padEnd(nameWidth)}  ${c.detail}`);
  }
  console.log("");
  if (checks.some(c => c.status === "fail")) {
    console.log("  \x1b[1;31mSome required tools are missing.\x1b[0m");
    console.log("");
  }
}

function glyph(status: CheckStatus): string {
  if (status === "ok") return "\x1b[32m✔\x1b[0m";
  if (status === "warn") return "\x1b[33m⚠\x1b[0m";
  return "\x1b[31m✖\x1b[0m";
}

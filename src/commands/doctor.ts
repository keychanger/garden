// Command: garden doctor — environment preflight. Checks the external tools
// garden depends on (tmux, claude, gh) and surfaces the one prerequisite it
// can't verify programmatically (the Option-as-Meta terminal setting). A
// first-run operator on a fresh box runs this to find out what's missing before
// hitting a cryptic mid-workflow failure.
import { spawnSync } from "node:child_process";
import { output, isTTY } from "../output.js";

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

function checkNode(): Check {
  return { name: "node", status: "ok", detail: process.version };
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
    checkOptionKey(),
  ];

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

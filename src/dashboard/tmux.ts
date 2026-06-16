// Low-level tmux helpers used throughout the dashboard.
import { execFileSync } from "node:child_process";
import os from "node:os";
import { DASHBOARD_SESSION } from "../session.js";
import { log } from "./log.js";
import { workerWindowPrefix } from "./window-names.js";

// Re-throws with tmux's stderr appended. Without this the caller sees a bare
// "Command failed: tmux ..." with no reason — and tmux failures from inside a
// Claude Code sandbox ("Operation not permitted" on the server socket) are
// otherwise invisible at the call site.
function rethrowWithStderr(err: unknown, label: string): never {
  const stderr = (err as { stderr?: Buffer | string }).stderr?.toString().trim() ?? "";
  const code = (err as { status?: number | null }).status;
  const detail = stderr || (code != null ? `exit ${code}` : "");
  throw new Error(`${label}${detail ? `: ${detail}` : ""}`);
}

export function tmux(...args: string[]): void {
  try {
    execFileSync("tmux", args, { stdio: ["ignore", "ignore", "pipe"] });
  } catch (err) {
    rethrowWithStderr(err, `tmux ${args[0] ?? ""} failed`);
  }
}

// Paste a message into a Claude pane and submit it. The 300ms gap between
// the paste and `Enter` matters on cold-start panes (`claude --resume` after
// a dashboard restart, fresh sessions for handoff/seed): claude's TUI
// finishes binding its input handler / settles paste-detection during this
// window, so the Enter actually triggers submit instead of being absorbed
// into the paste burst.
//
// Delivery routes through a tmux buffer (load-buffer reads from stdin,
// paste-buffer floods the bytes into the pane) instead of `send-keys -l`.
// The send-keys path put the entire message in argv; ~14KB handoff briefings
// were silently failing with E2BIG / tmux command-buffer overflow, leaving
// the new worker parked at status:ready with a never-delivered seed. Buffers
// are byte streams with no argv exposure, so multi-MB seeds work uniformly.
//
// Submit fires TWO Enter keystrokes — one at 300ms, one at 1500ms — both via
// setTimeout, so the function returns immediately after the paste. The second
// Enter is the cold-respawn safety net: on a freshly respawned `claude
// --resume` TUI (the per-iteration trellis/grow reseed, handoff seeds) the
// status hook can report the pane non-loading a beat before the TUI finishes
// binding paste-detection, so the 300ms Enter lands inside the bracketed-paste
// burst and is absorbed as content instead of submitting — the prompt then
// sits unsent in the input box until an operator hits Enter by hand. The
// 1500ms Enter submits that buffered text once the TUI has settled. Sending a
// second Enter unconditionally is safe: if the first already submitted,
// Claude's prompt box is empty and an empty prompt is never submitted (no-op),
// and Enter during generation is ignored.
//
// In one-shot CLI contexts (the _continue-worker / _seed-worker subcommand
// handlers etc.) Node keeps the process alive until the later timer fires, so
// both Enters land. In long-lived contexts (the poller's merge handler, the
// dashboard) the caller's stack no longer blocks per Submit. Previously this
// was a synchronous `execFileSync("sleep", "0.3")` that monopolized the tick.
let pasteBufferCounter = 0;
export function pasteAndSubmit(paneId: string, message: string): void {
  const bufferName = `garden-paste-${process.pid}-${++pasteBufferCounter}`;
  try {
    execFileSync("tmux", ["load-buffer", "-b", bufferName, "-"], {
      input: message,
      stdio: ["pipe", "ignore", "pipe"],
    });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString().trim() ?? "";
    throw new Error(`tmux load-buffer failed${stderr ? `: ${stderr}` : ""}`);
  }
  try {
    execFileSync("tmux", ["paste-buffer", "-d", "-b", bufferName, "-t", paneId], {
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (err) {
    try {
      execFileSync("tmux", ["delete-buffer", "-b", bufferName], { stdio: "ignore" });
    } catch { /* buffer may already be gone */ }
    const stderr = (err as { stderr?: Buffer }).stderr?.toString().trim() ?? "";
    throw new Error(`tmux paste-buffer failed${stderr ? `: ${stderr}` : ""}`);
  }
  const sendEnter = (): void => {
    try {
      execFileSync("tmux", ["send-keys", "-t", paneId, "Enter"], { stdio: "ignore" });
    } catch {
      // Pane may have been killed between paste and Enter (worker bounced,
      // dashboard torn down, race with worktree cleanup). Caller doesn't
      // wait for confirmation, so swallow.
    }
  };
  setTimeout(sendEnter, 300);
  setTimeout(sendEnter, 1500);
}

export function tmuxOutput(...args: string[]): string {
  // stderr ignored: many tmuxOutput callers (paneExists, windowExists, getPaneTitle)
  // depend on a clean throw-on-miss without noisy stderr.
  return execFileSync("tmux", args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

export function tmuxSplit(...args: string[]): string {
  try {
    return execFileSync("tmux", ["split-window", "-P", "-F", "#{pane_id}", ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    rethrowWithStderr(err, "tmux split-window failed");
  }
}

export function tmuxNewWindow(...args: string[]): string {
  try {
    return execFileSync("tmux", ["new-window", "-P", "-F", "#{pane_id}", ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    rethrowWithStderr(err, "tmux new-window failed");
  }
}

export function getActivePaneId(): string | null {
  try {
    return tmuxOutput("display-message", "-t", DASHBOARD_SESSION, "-p", "#{pane_id}");
  } catch {
    return null;
  }
}

// Read the visible content of a pane (not its scrollback). Used to inspect a
// worker's Claude TUI input box before delivering an auto-continue prompt, so
// garden doesn't paste onto an operator's half-typed draft. `-J` joins
// soft-wrapped lines so a wrapped draft collapses to one logical line; `-p`
// prints to stdout. Returns "" on any failure (pane gone, sandbox), which the
// caller reads as "no draft" — failing open preserves the common auto-continue
// path rather than blocking it on a capture error.
export function capturePaneText(paneId: string): string {
  try {
    return execFileSync("tmux", ["capture-pane", "-p", "-J", "-t", paneId], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

export function tmuxDisplay(msg: string): void {
  try {
    tmux("display-message", "-t", DASHBOARD_SESSION, msg);
  } catch { log.debug("tmux", "tmuxDisplay failed"); }
}

export function setPaneTitle(paneId: string, title: string): void {
  try {
    tmux("select-pane", "-t", paneId, "-T", title);
  } catch { log.debug("tmux", "setPaneTitle failed", { data: { paneId } }); }
}

export function setPaneLabel(paneId: string, label: string): void {
  try {
    tmux("set-option", "-p", "-t", paneId, "@garden_name", label);
  } catch { log.debug("tmux", "setPaneLabel failed", { data: { paneId } }); }
}

export function setPaneVar(paneId: string, name: string, value: string): void {
  try {
    tmux("set-option", "-p", "-t", paneId, `@${name}`, value);
  } catch { log.debug("tmux", "setPaneVar failed", { data: { paneId, name } }); }
}

export function getFirstPaneId(target: string): string | null {
  try {
    return tmuxOutput("list-panes", "-t", target, "-F", "#{pane_id}").split("\n")[0] || null;
  } catch {
    return null;
  }
}

export function paneExists(paneId: string): boolean {
  try {
    const result = tmuxOutput("display-message", "-t", paneId, "-p", "#{pane_id}");
    return result === paneId;
  } catch {
    return false;
  }
}

// All window indices in the dashboard session whose name matches exactly.
// tmux name targets ("session:name") fail outright ("can't find window") when
// more than one window shares the name, so any caller that must survive
// duplicate-named windows — poller windows after a spawn race — resolves by
// index (a unique, unambiguous target) through this instead.
export function windowIndices(windowName: string): number[] {
  try {
    const out = tmuxOutput(
      "list-windows", "-t", DASHBOARD_SESSION, "-F", "#{window_index} #{window_name}",
    );
    const indices: number[] = [];
    for (const line of out.split("\n")) {
      const sep = line.indexOf(" ");
      if (sep < 0) continue;
      if (line.slice(sep + 1) !== windowName) continue;
      const idx = parseInt(line.slice(0, sep), 10);
      if (Number.isFinite(idx)) indices.push(idx);
    }
    return indices;
  } catch {
    return [];
  }
}

// Membership test by name. Returns true when at least one window carries the
// name. Critically — unlike the old `list-panes -t session:name` probe — this
// stays true when duplicates exist; that probe errored on the ambiguous name
// target and reported the window dead, which turned a single stray duplicate
// into an unbounded respawn loop (the watchdog spawning a fresh poller every
// tick because it could never see the ones already there).
export function windowExists(windowName: string): boolean {
  return windowIndices(windowName).length > 0;
}

// Kill every window with this name, addressing each by index so duplicates are
// fully removed (a name target would be ambiguous). Returns the count killed.
export function killWindowsByName(windowName: string): number {
  let killed = 0;
  for (const idx of windowIndices(windowName)) {
    try { tmux("kill-window", "-t", `${DASHBOARD_SESSION}:${idx}`); killed++; } catch { /* ignore */ }
  }
  return killed;
}

// Collapse duplicate same-named windows to one survivor (the lowest index),
// killing the rest by index. Returns how many were killed (0 for none/one).
// The convergence step that heals a poller spawn race back to a single window.
export function dedupeWindows(windowName: string): number {
  const [, ...extra] = windowIndices(windowName).sort((a, b) => a - b);
  let killed = 0;
  for (const idx of extra) {
    try { tmux("kill-window", "-t", `${DASHBOARD_SESSION}:${idx}`); killed++; } catch { /* ignore */ }
  }
  return killed;
}

export function renameWindow(oldName: string, newName: string): void {
  try {
    tmux("rename-window", "-t", `${DASHBOARD_SESSION}:${oldName}`, newName);
  } catch { log.debug("tmux", "renameWindow failed", { data: { oldName, newName } }); }
}

export function getPaneSize(paneId: string): { width: number; height: number } | null {
  try {
    const out = tmuxOutput("display-message", "-t", paneId, "-p", "#{pane_width} #{pane_height}");
    const parts = out.split(" ");
    if (parts.length !== 2) return null;
    return { width: parseInt(parts[0], 10), height: parseInt(parts[1], 10) };
  } catch {
    return null;
  }
}

export interface SessionPane {
  windowName: string;
  paneId: string;
  width: number;
  height: number;
}

// One-shot snapshot of every pane in the dashboard session with its id and
// size. Lets a caller answer "does pane X exist", "first pane of window W",
// and "size of pane X" from a single tmux fork. The swapDirect hot path
// (operator ⌥-key pane switch) asked four of those questions separately —
// paneExists + getFirstPaneId + two getPaneSize — i.e. four synchronous tmux
// forks per keystroke; this collapses them to one.
export function listSessionPanes(): SessionPane[] {
  try {
    const out = tmuxOutput(
      "list-panes", "-s", "-t", DASHBOARD_SESSION,
      "-F", "#{window_name}\t#{pane_id}\t#{pane_width}\t#{pane_height}",
    );
    const result: SessionPane[] = [];
    for (const line of out.split("\n")) {
      if (!line) continue;
      const parts = line.split("\t");
      if (parts.length < 4) continue;
      const width = parseInt(parts[2], 10);
      const height = parseInt(parts[3], 10);
      if (!Number.isFinite(width) || !Number.isFinite(height)) continue;
      result.push({ windowName: parts[0], paneId: parts[1], width, height });
    }
    return result;
  } catch {
    return [];
  }
}

export function resizeWindow(windowName: string, width: number, height: number): void {
  try {
    tmux("resize-window", "-t", `${DASHBOARD_SESSION}:${windowName}`, "-x", String(width), "-y", String(height));
  } catch { /* ignore — window may not exist */ }
}

// Kill every window with this name. There should only ever be one, but a
// respawn race can transiently produce duplicates; killing all of them is the
// correct "this window should be gone" semantics and self-heals the duplicate.
// A name target is ambiguous once duplicates exist, so kill each by index.
export function killWindowSafe(windowName: string): void {
  killWindowsByName(windowName);
}

export function getPanePid(paneId: string): string | null {
  try {
    return tmuxOutput("display-message", "-t", paneId, "-p", "#{pane_pid}");
  } catch {
    return null;
  }
}

// `select-pane -d` blocks tmux from forwarding keystrokes to the pane's pty —
// the chars never reach the terminal driver, so no echo, no buffering. Used on
// the status/usage panes which run a passive sleep loop with nothing to read
// stdin. Survives swap-pane (input-disabled is a pane-level flag) but not
// respawn-pane, so callers must re-apply after each respawn.
export function disablePaneInput(paneId: string): void {
  try {
    tmux("select-pane", "-d", "-t", paneId);
  } catch { log.debug("tmux", "disablePaneInput failed", { data: { paneId } }); }
}

export function getPaneLabel(paneId: string): string | null {
  try {
    const label = tmuxOutput("display-message", "-t", paneId, "-p", "#{@garden_name}");
    return label || null;
  } catch {
    return null;
  }
}

// Read the tmux pane title. Claude Code sets this via terminal escape
// sequences (OSC 0/2) as it works, so it doubles as a "what is this worker
// currently doing" summary. We strip the leading non-alphanumeric noise
// (Claude prefixes with characters like "✱ ") and reject the default
// "Claude Code" placeholder and system hostname (tmux defaults new panes
// to the hostname, which would overwrite the persisted task on resume).
export function cleanPaneTitle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/^[^a-zA-Z0-9]+/, "").trim();
  if (!cleaned || cleaned === "Claude Code") return null;
  if (cleaned === os.hostname()) return null;
  return cleaned;
}

export function getPaneTitle(paneId: string): string | null {
  try {
    return cleanPaneTitle(tmuxOutput("display-message", "-t", paneId, "-p", "#{pane_title}"));
  } catch {
    return null;
  }
}

// One-shot enumeration of every pane in the dashboard session, with each
// pane's window name, id, and raw title. Replaces N per-worker tmux forks
// (windowExists + getFirstPaneId + display-message) in callers like
// refreshWorkerTasks. Field separator is tab — unlikely in pane titles, and
// the parser defensively rejoins any tail tokens past the third one.
export interface PaneInfo {
  windowName: string;
  paneId: string;
  rawTitle: string;
}

export function listSessionPaneTitles(): PaneInfo[] {
  try {
    const out = tmuxOutput(
      "list-panes", "-s", "-t", DASHBOARD_SESSION,
      "-F", "#{window_name}\t#{pane_id}\t#{pane_title}",
    );
    const result: PaneInfo[] = [];
    for (const line of out.split("\n")) {
      if (!line) continue;
      const parts = line.split("\t");
      if (parts.length < 3) continue;
      result.push({
        windowName: parts[0],
        paneId: parts[1],
        rawTitle: parts.slice(2).join("\t"),
      });
    }
    return result;
  } catch {
    return [];
  }
}

export function listAllWindowNames(): string[] {
  try {
    return tmuxOutput(
      "list-windows", "-t", DASHBOARD_SESSION, "-F", "#{window_name}"
    ).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

export function listHiddenWorkerWindows(project: string, windowNames?: string[]): string[] {
  const names = windowNames ?? listAllWindowNames();
  const prefix = workerWindowPrefix(project);
  return names.filter(w => w.startsWith(prefix));
}

// Returns a fully single-quoted bash literal of the input. Safe for all
// shell metacharacters. Strings that match the safe-token character class
// are passed through unquoted as a tiny readability optimization. Use the
// result WITHOUT additional surrounding `'...'` in templates — the helper
// already supplies the outer quotes when needed. Prefer this over inline
// `.replace(/'/g, "'\\''")` so all bash escaping flows through one helper.
export function shellEscape(s: string): string {
  if (/^[a-zA-Z0-9_./:=-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// Tmux's own command parser supports double-quoted strings: $variable
// expansion and command substitution are interpreted inside them, and
// backslash escapes the next character. When passing a shell command
// through tmux's run-shell or set-hook command-templates, the outer wrapper
// is a tmux-parsed string — wrap with this helper so $, `, \, " in the
// shell command don't get re-interpreted by tmux before reaching the shell.
// `#` is NOT escaped — tmux format references like #{window_name} remain
// active inside the wrapped string.
export function tmuxDoubleQuote(s: string): string {
  return `"${s.replace(/[\\$"`]/g, "\\$&")}"`;
}

// Low-level tmux helpers used throughout the dashboard.
import { execFileSync } from "node:child_process";
import os from "node:os";
import { DASHBOARD_SESSION } from "../session.js";
import { log } from "./log.js";
import { workerWindowPrefix } from "./window-names.js";

// Test isolation: the dashboard drives a single hardcoded tmux session
// (DASHBOARD_SESSION = "garden-dashboard"). The vitest suite is routinely run
// on a machine that HAS a live dashboard — every garden worker runs `npm test`
// as part of its checks. A test that exercises addAlert / refreshAlertBadge /
// poller / hook flows WITHOUT mocking this module would otherwise shell out to
// the operator's live session and mutate it. The observed symptom: a fake
// "⚠ 1 alert — ⌥a to clear" badge (rendered "garden dev", the unbuilt version
// string) flashing onto the real status bar with no matching real alert — a
// test's refreshAlertBadge writing @garden_right on the live session, then
// wiped by the dashboard's next legitimate refresh.
//
// So mutating tmux commands are inert by default under the runner. Every
// helper that runs a tmux command with side effects guards on this flag:
// tmux() and pasteAndSubmit() (which shell out via their own execFileSync),
// plus tmuxSplit() (split-window) and tmuxNewWindow() (new-window). Read-only
// helpers (tmuxOutput / capturePaneText / capturePaneCursor) are left
// unguarded — they observe the live server but never mutate it. A new mutating
// helper must add the same guard. Tests that assert tmux behavior either mock
// this module wholesale (the real functions never run) or — like
// tmux-extended.test.ts — mock `execFileSync` to exercise the wrapper argv
// directly without touching a real server; the latter opt back in via
// __setTmuxExecAllowedForTests(true), which is safe precisely because their
// execFileSync is a stub. VITEST is set to "true" by the runner in every test
// worker process and never in the built CLI/hook binaries, so production
// behavior is unchanged.
let tmuxExecAllowed = process.env.VITEST !== "true";

// Test-only seam: re-enable real exec for tests that mock execFileSync and
// assert on the wrapper's argv. Never called from production code.
export function __setTmuxExecAllowedForTests(allowed: boolean): void {
  tmuxExecAllowed = allowed;
}

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
  if (!tmuxExecAllowed) return;
  try {
    execFileSync("tmux", args, { stdio: ["ignore", "ignore", "pipe"] });
  } catch (err) {
    rethrowWithStderr(err, `tmux ${args[0] ?? ""} failed`);
  }
}

// Run one tmux command while a hidden session variable is temporarily
// inheritable. The unhide, target command, and re-hide are one tmux command
// queue, so no command from another client can create a pane between them.
// The variable's VALUE never crosses the client argv boundary: tmux expands
// it server-side from its hidden environment. If the target command fails and
// aborts the queue before the final re-hide, the recovery call restores the
// hidden bit before the error escapes.
export function tmuxWithHiddenEnvironment(variable: string, ...args: string[]): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) {
    throw new Error(`Invalid tmux environment variable: ${variable}`);
  }
  const format = `#{${variable}}`;
  const hide = [
    "set-environment", "-hF", "-t", DASHBOARD_SESSION,
    variable, format,
  ];
  try {
    tmux(
      "set-environment", "-F", "-t", DASHBOARD_SESSION,
      variable, format,
      ";", ...args,
      ";", ...hide,
    );
  } catch (err) {
    try {
      tmux(...hide);
    } catch (cleanupErr) {
      log.error("tmux", "failed to re-hide scoped environment after tmux command failure", {
        data: { variable, error: String(cleanupErr) },
      });
    }
    throw err;
  }
}

// Run several tmux commands in ONE client connect. Each group is a full command
// argv (e.g. ["set-option", "-t", target, ...]); they are joined with tmux's
// `;` argv command separator so a single execFileSync pays one client-connect
// instead of one per command — the server runs them in order. Measured: six
// chained commands cost the same ~3ms as one, so batching a hot-path write
// sequence is effectively free. Use ONLY for independent WRITE commands: no
// group may depend on another's stdout (the connect discards it), and a failure
// in any group aborts the rest, so don't batch across an operation that must
// run even if an earlier one fails. Empty groups are skipped.
export function tmuxBatch(...groups: string[][]): void {
  if (!tmuxExecAllowed) return;
  const argv: string[] = [];
  for (const g of groups) {
    if (g.length === 0) continue;
    if (argv.length > 0) argv.push(";");
    argv.push(...g);
  }
  if (argv.length === 0) return;
  try {
    execFileSync("tmux", argv, { stdio: ["ignore", "ignore", "pipe"] });
  } catch (err) {
    rethrowWithStderr(err, `tmux ${argv[0] ?? "batch"} failed`);
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
  if (!tmuxExecAllowed) return;
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

// Submit whatever already sits in the pane's input box. The recovery half of
// pasteAndSubmit: when a prior paste's Enter taps were eaten (TUI mid-redraw),
// the message is still in the box and only the submit is owed. Immediate tap
// plus one delayed re-tap, mirroring pasteAndSubmit's double-tap.
export function pressEnter(paneId: string): void {
  if (!tmuxExecAllowed) return;
  const sendEnter = (): void => {
    try {
      execFileSync("tmux", ["send-keys", "-t", paneId, "Enter"], { stdio: "ignore" });
    } catch {
      // Pane gone (worker bounced, dashboard torn down); caller doesn't wait.
    }
  };
  sendEnter();
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
  if (!tmuxExecAllowed) return "";
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
  if (!tmuxExecAllowed) return "";
  try {
    return execFileSync("tmux", ["new-window", "-P", "-F", "#{pane_id}", ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    rethrowWithStderr(err, "tmux new-window failed");
  }
}

// Blank a window's name in the status bar's center strip, appended to a
// new-window command via tmux's `;` argv command separator so creation and
// suppression happen in one client connect. tmux keeps the per-window option
// until the window dies, so setting it once at birth is durable — this
// replaces the old per-refresh suppressWindowNames sweep, whose process-local
// skip cache was always cold in the fresh hook/hotkey process and so re-forked
// two set-options for every window on every full refresh (every hook fire runs
// one). The trailing shell-command of new-window terminates at the standalone
// `;` argv, so a window that runs a command still gets suppressed.
function windowNameSuppressionArgs(windowName: string): string[] {
  const target = `${DASHBOARD_SESSION}:${windowName}`;
  return [
    ";", "set-option", "-t", target, "window-status-format", "",
    ";", "set-option", "-t", target, "window-status-current-format", "",
  ];
}

// Create a detached window in DASHBOARD_SESSION with its name pre-suppressed.
// Use for every window added to the dashboard session so the status bar's
// center strip stays empty without a per-refresh sweep.
export function newDashboardWindow(windowName: string, ...rest: string[]): void {
  tmux("new-window", "-d", "-t", DASHBOARD_SESSION, "-n", windowName, ...rest,
    ...windowNameSuppressionArgs(windowName));
}

// Same as newDashboardWindow but returns the new window's first pane id (the
// `-P -F #{pane_id}` form); the batched set-options print nothing, so stdout is
// just the pane id.
export function newDashboardWindowPaned(windowName: string, ...rest: string[]): string {
  return tmuxNewWindow("-d", "-t", DASHBOARD_SESSION, "-n", windowName, ...rest,
    ...windowNameSuppressionArgs(windowName));
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
// garden doesn't paste onto an operator's half-typed draft. `-p` prints to
// stdout. We deliberately do NOT pass `-J`: draft detection pairs this capture
// with capturePaneCursor, and cursor_y is in physical-row space, so the output
// must stay one line per pane row (joining wrapped lines would desync the row
// indices). Returns "" on any failure (pane gone, sandbox), which the caller
// reads as "no draft" — failing open preserves the common auto-continue path
// rather than blocking it on a capture error.
export function capturePaneText(paneId: string): string {
  try {
    return execFileSync("tmux", ["capture-pane", "-p", "-t", paneId], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

export interface PaneCursor { x: number; y: number; }

// Read the terminal caret position within a pane (0-based column, row),
// independent of whether the pane is active. Draft detection uses it to tell an
// operator's typed text apart from the dimmed ghost/placeholder text Claude Code
// renders into an empty input box: the caret sits at the end of typed text, so
// anything to its right is a suggestion, not a draft. Returns null on any
// failure, which the caller reads as "cursor unknown".
export function capturePaneCursor(paneId: string): PaneCursor | null {
  try {
    const out = execFileSync(
      "tmux",
      ["display-message", "-p", "-t", paneId, "#{cursor_x},#{cursor_y}"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    const [x, y] = out.split(",").map(Number);
    if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
    return { x, y };
  } catch {
    return null;
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

// Rename by window id (@N) — the only rename that stays correct when window
// names are duplicated. A name target on tmux >= 3.x FAILS outright ("can't
// find window") once two windows share the name, and the silent no-op left the
// just-swapped pane filed under the wrong name — the corruption engine behind
// workers vanishing from the status pane. Returns false on failure so callers
// can surface it instead of swallowing a misfile.
export function renameWindowById(windowId: string, newName: string): boolean {
  try {
    tmux("rename-window", "-t", windowId, newName);
    return true;
  } catch {
    log.warn("tmux", "renameWindowById failed", { data: { windowId, newName } });
    return false;
  }
}

export function resizeWindowById(windowId: string, width: number, height: number): void {
  try {
    tmux("resize-window", "-t", windowId, "-x", String(width), "-y", String(height));
  } catch { /* ignore — window may not exist */ }
}

export function killWindowById(windowId: string): void {
  try {
    tmux("kill-window", "-t", windowId);
  } catch { /* ignore — window may not exist */ }
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
  windowId: string;
  windowName: string;
  paneId: string;
  width: number;
  height: number;
  panePath: string;
}

// One-shot snapshot of every pane in the dashboard session with its id and
// size. Lets a caller answer "does pane X exist", "first pane of window W",
// and "size of pane X" from a single tmux fork. The swapDirect hot path
// (operator ⌥-key pane switch) asked four of those questions separately —
// paneExists + getFirstPaneId + two getPaneSize — i.e. four synchronous tmux
// forks per keystroke; this collapses them to one. windowId is the unambiguous
// handle for mutations: window NAMES can be duplicated (a respawn race, a
// misfiled rename), and every name-targeted tmux mutation either errors or
// picks an arbitrary duplicate. panePath is last in the format because a path
// may itself contain the separator.
export function listSessionPanes(): SessionPane[] {
  try {
    const out = tmuxOutput(
      "list-panes", "-s", "-t", DASHBOARD_SESSION,
      "-F", "#{window_id}\t#{window_name}\t#{pane_id}\t#{pane_width}\t#{pane_height}\t#{pane_current_path}",
    );
    const result: SessionPane[] = [];
    for (const line of out.split("\n")) {
      if (!line) continue;
      const parts = line.split("\t");
      if (parts.length < 6) continue;
      const width = parseInt(parts[3], 10);
      const height = parseInt(parts[4], 10);
      if (!Number.isFinite(width) || !Number.isFinite(height)) continue;
      result.push({
        windowId: parts[0],
        windowName: parts[1],
        paneId: parts[2],
        width,
        height,
        panePath: parts.slice(5).join("\t"),
      });
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

const SHELL_COMMANDS = new Set([
  "sh", "bash", "zsh", "dash", "ksh", "fish", "tcsh", "csh",
]);

// Is the pane a bare shell — i.e. the worker's Claude has exited? Reads the
// pane's tty and returns true iff EVERY process on it is a login/interactive
// shell. This is a NEGATIVE check by design: a LIVE worker's tty always carries
// its agent process (`claude`, or `node` for an npm install) alongside the `sh`
// launch wrapper and any Bash-tool `bash`, so it is never "all shells" and can
// never be wrongly flagged — the failure mode that would break auto-continue.
// A clean Claude exit `exec $SHELL`s the wrapper WITHOUT firing tmux pane-died
// (so agentStatus can still read `idle`), leaving only the shell on the tty —
// the exact state a live `#{pane_current_command}` probe can't distinguish
// (Claude Code holds a `bash` in the pty foreground even while alive). Fails
// OPEN (returns false → treat as live) on any probe error, empty output, or
// ambiguity, so a live worker is never blocked; the cost of a miss is only that
// the pre-existing paste-into-shell hazard is not caught in that edge.
export function paneRunningOnlyShell(paneId: string): boolean {
  let tty: string;
  try {
    tty = tmuxOutput("display-message", "-t", paneId, "-p", "#{pane_tty}").trim();
  } catch {
    return false;
  }
  const ttyName = tty.replace(/^\/dev\//, "");
  if (!ttyName) return false;
  let out: string;
  try {
    out = execFileSync("ps", ["-t", ttyName, "-o", "comm="], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return false;
  }
  const comms = out.split("\n")
    // macOS `comm=` yields a path and marks login shells with a leading `-`;
    // reduce to the bare, lowercased basename ("/bin/-zsh" / "-zsh" -> "zsh").
    .map(l => l.trim().replace(/^.*\//, "").replace(/^-/, "").toLowerCase())
    .filter(Boolean);
  if (comms.length === 0) return false;
  return comms.every(c => SHELL_COMMANDS.has(c));
}

const DIARY_EDITOR_COMMANDS = new Set(["nano", "pico", "rnano"]);

// Is a nano/pico editor live on the pane's tty? The diary-follow drive
// (reloadDiaryEditor) makes the diary follow the focused project by injecting
// the editor's own save+exit keys (^O ^X). It must send those ONLY when the
// editor is actually running: `#{pane_current_command}` reports `bash` whether
// the diary-view loop is editing (nano is a child of the loop's sh) or sitting
// at a shell between reopens, so it cannot tell them apart — this tty probe
// can. When the pane instead carries a shell (loop between reopens / its editor
// exited / a non-editor pane swapped into the slot), ^O/^X hit that shell's
// line editor and ring the terminal bell (^O unbound, ^X an incomplete prefix):
// the macOS "chirp". A POSITIVE check (not paneRunningOnlyShell's negative one)
// so a swapped-in worker `claude` or a `vim` is skipped too, not just shells.
// Fails CLOSED (skip the drive) on any probe error: a missed follow is harmless
// (the loop reopens on the focused project on its own) while a spurious key
// injection is the bug being fixed.
export function paneRunningEditor(paneId: string): boolean {
  let tty: string;
  try {
    tty = tmuxOutput("display-message", "-t", paneId, "-p", "#{pane_tty}").trim();
  } catch {
    return false;
  }
  const ttyName = tty.replace(/^\/dev\//, "");
  if (!ttyName) return false;
  let out: string;
  try {
    out = execFileSync("ps", ["-t", ttyName, "-o", "comm="], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return false;
  }
  return out.split("\n")
    .map(l => l.trim().replace(/^.*\//, "").replace(/^-/, "").toLowerCase())
    .some(c => DIARY_EDITOR_COMMANDS.has(c));
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

// Marks a pane as mouse-locked: the root-table mouse bindings installed by
// setupKeybindings() check this pane option on whatever pane the mouse event
// targets and no-op (beyond switching focus there) instead of scrolling into
// copy-mode or starting a text selection. Used on the usage and status panes
// only — pure repaint content with no scrollback or copy-paste value, unlike
// logs/history/alerts which the operator does scroll and copy from. Like
// disablePaneInput, this is a pane option and may not survive respawn-pane —
// callers pair the two and re-apply both after each respawn.
export function lockPaneMouse(paneId: string): void {
  setPaneVar(paneId, "garden_mouse_lock", "1");
}

export function getPaneLabel(paneId: string): string | null {
  try {
    const label = tmuxOutput("display-message", "-t", paneId, "-p", "#{@garden_name}");
    return label || null;
  } catch {
    return null;
  }
}

// Strip terminal control sequences (ANSI CSI/OSC escapes, other Fe escapes, and
// C0/C1 control chars — keeping only tab and newline) from text that originates
// OUTSIDE garden — pane titles, worker task strings, transcript lines — before
// it is painted into a dashboard pane. Otherwise a worker's output (or the code
// it reviews) could smuggle cursor-movement / screen-clear / OSC sequences that
// corrupt the operator's dashboard render or reposition their cursor. Aggressive
// by design: this text is for display, not round-tripping. Garden's own ANSI
// coloring is applied to the template AROUND these values, never through this.
export function stripControlSequences(s: string): string {
  return s
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, "")       // OSC (… BEL / ST)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")             // CSI (cursor/color/clear)
    .replace(/\x1b[@-_]/g, "")                             // other Fe escapes
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");        // C0 (keep \t\n; drop \r) + C1 + DEL + lone ESC
}

// Read the tmux pane title. Claude Code sets this via terminal escape
// sequences (OSC 0/2) as it works, so it doubles as a "what is this worker
// currently doing" summary. We strip the leading non-alphanumeric noise
// (Claude prefixes with characters like "✱ ") and reject the default
// "Claude Code" placeholder and system hostname (tmux defaults new panes
// to the hostname, which would overwrite the persisted task on resume).
// Also reject the generic title Claude Code emits when a session is
// resumed (rate-limit cutoff, restart, etc.) before it has done any new
// work — it carries no information about the worker's actual task, and
// letting it through clobbers the last real summary with a placeholder
// that never gets refreshed if the resumed turn is short.
export function cleanPaneTitle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = stripControlSequences(raw).replace(/^[^a-zA-Z0-9]+/, "").trim();
  if (!cleaned || cleaned === "Claude Code") return null;
  if (cleaned === os.hostname()) return null;
  if (cleaned.toLowerCase() === "continue previous coding session") return null;
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

// Wrap a shell command so it is a valid COMMAND for a tmux `display-menu`
// item or key binding. Those command slots are parsed by tmux as tmux
// commands, NOT shell commands — a bare `<node> <cli.js> ...` fails with
// "unknown command: <node>". `run-shell` hands the whole string to /bin/sh;
// tmuxDoubleQuote keeps tmux from re-interpreting $/`/\/" before it gets there.
export function menuRunShell(shellCommand: string): string {
  return `run-shell ${tmuxDoubleQuote(shellCommand)}`;
}

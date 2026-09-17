// `garden awake`: keep the Mac running with the lid closed while it stays
// plugged in (see src/dashboard/awake.ts for the mechanism and its safety net).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AWAKE_STATE_PATH, PMSET, SUDOERS_PATH, canToggleWithoutPassword, clearAwakeState,
  readAwakeState, readPowerState, setSleepDisabled, sudoersEntry, writeAwakeState, withAwakeLock,
} from "../dashboard/awake.js";
import { windowExists } from "../dashboard/tmux.js";
import { watchdogWindowName } from "../dashboard/window-names.js";
import { log } from "../dashboard/log.js";
import { output } from "../output.js";

const USAGE = "Usage: garden awake [status | on [--for <duration>] | off | setup]";
const SETUP_HINT = "Run `garden awake setup` once to allow it (asks for your password).";

export function parseAwakeDuration(raw: string): number | null {
  const m = raw.match(/^(?:(\d+)h)?(?:(\d+)m)?$/);
  if (!m || (m[1] === undefined && m[2] === undefined)) return null;
  const ms = Number(m[1] ?? 0) * 3_600_000 + Number(m[2] ?? 0) * 60_000;
  return Number.isSafeInteger(ms) && ms > 0 && Number.isFinite(new Date(Date.now() + ms).getTime()) ? ms : null;
}

function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export async function awake(args: string[]): Promise<void> {
  const sub = args[0] ?? "status";
  if (process.platform !== "darwin") {
    throw new Error("garden awake is macOS-only: it drives pmset's lid-close sleep override.");
  }
  if (sub === "status") return showStatus();
  if (sub === "on") return withAwakeLock(() => turnOn(args.slice(1)));
  if (sub === "off") return withAwakeLock(() => turnOff());
  if (sub === "setup") return setup();
  throw new Error(`Unknown subcommand: ${sub}. ${USAGE}`);
}

function turnOn(rest: string[]): void {
  let forMs: number | undefined;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] !== "--for") throw new Error(`Unknown argument: ${rest[i]}. ${USAGE}`);
    const parsed = rest[i + 1] === undefined ? null : parseAwakeDuration(rest[i + 1]);
    if (parsed === null) throw new Error(`Invalid --for '${rest[i + 1] ?? ""}'. Use e.g. 8h, 90m, or 7h30m.`);
    forMs = parsed;
    i++;
  }

  const power = readPowerState();
  if (!power) throw new Error(`Could not read the power state from ${PMSET}.`);
  if (!power.onAc) {
    throw new Error("Not plugged in. garden awake only holds while on AC power; plug in and run it again.");
  }
  if (power.sleepDisabled && !readAwakeState()) {
    throw new Error(`Sleep is disabled outside garden. Run sudo ${PMSET} -a disablesleep 0 before enabling garden awake.`);
  }
  if (!windowExists(watchdogWindowName())) {
    throw new Error(
      "The garden watchdog is not running (start the dashboard). It is what turns awake off "
      + "when you unplug or the timer ends, so garden will not turn awake on without it.",
    );
  }
  if (!canToggleWithoutPassword()) {
    throw new Error(`garden awake needs permission to run ${PMSET} -a disablesleep without a password. ${SETUP_HINT}`);
  }

  const now = Date.now();
  const state = forMs === undefined
    ? { since: new Date(now).toISOString() }
    : { since: new Date(now).toISOString(), until: new Date(now + forMs).toISOString() };
  // Listing sudo permissions does not prove a command is passwordless.
  setSleepDisabled(false);
  try {
    setSleepDisabled(true);
    writeAwakeState(state);
  } catch (err) {
    setSleepDisabled(false);
    clearAwakeState();
    throw err;
  }
  log.info("awake", "on", { data: { ...state } });
  const end = state.until ? `until you unplug or ${clockTime(state.until)}, whichever comes first` : "until you unplug";
  console.log(`Awake: the lid can close without sleeping ${end}. Turn off early with \`garden awake off\`.`);
}

function turnOff(): void {
  const power = readPowerState();
  if (!readAwakeState()) {
    console.log(power?.sleepDisabled
      ? `Sleep is disabled outside garden; left unchanged. Run sudo ${PMSET} -a disablesleep 0 to undo it.`
      : "Awake is already off.");
    return;
  }
  setSleepDisabled(false);
  clearAwakeState();
  log.info("awake", "off", { data: { reason: "operator" } });
  console.log("Awake off: closing the lid sleeps the Mac again.");
}

function setup(): void {
  const entry = sudoersEntry(os.userInfo().username);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-awake-"));
  const tmpFile = path.join(tmpDir, "garden-awake");
  try {
    fs.writeFileSync(tmpFile, entry);
    console.log(`Installing ${SUDOERS_PATH}:\n  ${entry.trim()}`);
    const sudo = (argv: string[]): void => {
      const r = spawnSync("sudo", argv, { stdio: "inherit" });
      if (r.status !== 0) throw new Error(`sudo ${argv.join(" ")} failed (exit ${r.status ?? "signal"}).`);
    };
    sudo(["/usr/sbin/visudo", "-cf", tmpFile]);
    sudo(["/usr/bin/install", "-m", "0440", "-o", "root", "-g", "wheel", tmpFile, SUDOERS_PATH]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  if (!canToggleWithoutPassword()) {
    throw new Error(
      `Installed ${SUDOERS_PATH}, but sudo still asks for a password for ${PMSET} -a disablesleep. `
      + "Check that /etc/sudoers includes /private/etc/sudoers.d.",
    );
  }
  console.log("Done. `garden awake on` now works without a password.");
}

function showStatus(): void {
  const state = readAwakeState();
  const power = readPowerState();
  const watchdogRunning = windowExists(watchdogWindowName());
  const ready = canToggleWithoutPassword();
  output(
    {
      on: state !== null,
      since: state?.since ?? null,
      until: state?.until ?? null,
      onAc: power?.onAc ?? null,
      sleepDisabled: power?.sleepDisabled ?? null,
      watchdogRunning,
      setupDone: ready,
      statePath: AWAKE_STATE_PATH,
    },
    () => {
      const lines: string[] = [];
      if (state) {
        lines.push(`awake:     on since ${clockTime(state.since)}, ${state.until ? `until unplugged or ${clockTime(state.until)}` : "until unplugged"}`);
        if (!watchdogRunning) lines.push("           watchdog not running: nothing will turn this off automatically");
      } else {
        lines.push("awake:     off");
      }
      if (power) {
        lines.push(`power:     ${power.onAc ? "plugged in" : "battery"}`);
        if (!state && power.sleepDisabled) lines.push(`           sleep is disabled outside garden (sudo ${PMSET} -a disablesleep 0 to undo)`);
      }
      lines.push(`setup:     ${ready ? "done" : `not done. ${SETUP_HINT}`}`);
      return lines.join("\n");
    },
  );
}

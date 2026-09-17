// `garden awake`: keep the Mac running with its lid closed while it stays
// plugged in, so the fleet keeps working in a dark room.
//
// macOS offers exactly one switch that overrides lid-close (clamshell) sleep:
// the undocumented, root-only `pmset -a disablesleep 1`. `pmset sleep 0` only
// governs the idle timer and `caffeinate` cannot hold a closed lid at all.
// The switch is dangerous to forget — a laptop that never sleeps cooks in a
// bag — so garden only ever turns it on with a way back off: the watchdog
// releases it on the first tick after the machine leaves AC power or the
// optional timer ends, and puts a closed-lid machine to sleep as it does, which
// is what closing the lid would have done without garden.
//
// Root without a prompt comes from a one-time sudoers entry (`garden awake
// setup`) that allows exactly the two pmset invocations below and nothing
// else. The watchdog runs with no terminal, so a password-gated sudo would
// leave it unable to release.
//
// State lives under CONTROL_DIR, which no worker sandbox can write: the file's
// presence is what tells the watchdog garden owns the switch, so a
// `disablesleep` the operator set by hand is never touched.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CONTROL_DIR } from "../paths.js";
import { atomicWriteFile } from "./atomic-write.js";
import { addAlert } from "./alerts.js";
import { log } from "./log.js";

export const PMSET = "/usr/bin/pmset";
export const SUDOERS_PATH = "/etc/sudoers.d/garden-awake";
export const AWAKE_STATE_PATH = path.join(CONTROL_DIR, "awake.json");

export interface AwakeState {
  since: string;
  until?: string;
}

export interface PowerState {
  sleepDisabled: boolean;
  onAc: boolean;
  lidClosed: boolean;
}

export function parseSleepDisabled(pmsetG: string): boolean | null {
  if (!pmsetG.includes("System-wide power settings")) return null;
  return /^\s*SleepDisabled\s+1\s*$/m.test(pmsetG);
}

export function parseOnAc(pmsetBatt: string): boolean | null {
  const m = pmsetBatt.match(/Now drawing from '([^']+)'/);
  return m ? m[1] === "AC Power" : null;
}

export function parseLidClosed(ioreg: string): boolean {
  return /"AppleClamshellState" = Yes/.test(ioreg);
}

function run(file: string, args: string[]): string {
  return execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function readPowerState(): PowerState | null {
  try {
    const sleepDisabled = parseSleepDisabled(run(PMSET, ["-g"]));
    const onAc = parseOnAc(run(PMSET, ["-g", "batt"]));
    if (sleepDisabled === null || onAc === null) return null;
    const lidClosed = parseLidClosed(run("/usr/sbin/ioreg", ["-r", "-k", "AppleClamshellState", "-d", "1"]));
    return { sleepDisabled, onAc, lidClosed };
  } catch (err) {
    log.warn("awake", "power state read failed", { data: { error: String(err) } });
    return null;
  }
}

// -k ignores cached sudo credentials: a password the operator typed in this
// terminal a minute ago would otherwise pass here and still fail in the
// watchdog, which has no terminal and no cache.
function pmsetDisablesleepArgs(value: "0" | "1", listOnly: boolean): string[] {
  return ["-k", "-n", ...(listOnly ? ["-l"] : []), PMSET, "-a", "disablesleep", value];
}

export function canToggleWithoutPassword(): boolean {
  try {
    run("sudo", pmsetDisablesleepArgs("1", true));
    run("sudo", pmsetDisablesleepArgs("0", true));
    return true;
  } catch {
    return false;
  }
}

export function setSleepDisabled(disabled: boolean): void {
  try {
    run("sudo", pmsetDisablesleepArgs(disabled ? "1" : "0", false));
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.trim();
    throw new Error(
      `sudo ${PMSET} -a disablesleep ${disabled ? 1 : 0} failed: ${stderr || String(err)}`,
    );
  }
}

export function sudoersEntry(user: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(user)) {
    throw new Error(`Refusing to write a sudoers entry for username '${user}': unexpected characters.`);
  }
  return `${user} ALL=(root) NOPASSWD: ${PMSET} -a disablesleep 0, ${PMSET} -a disablesleep 1\n`;
}

export function readAwakeState(): AwakeState | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(AWAKE_STATE_PATH, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const { since, until } = parsed as Record<string, unknown>;
    if (typeof since !== "string") return null;
    if (until !== undefined && typeof until !== "string") return null;
    return until === undefined ? { since } : { since, until };
  } catch {
    return null;
  }
}

export function writeAwakeState(state: AwakeState): void {
  atomicWriteFile(AWAKE_STATE_PATH, JSON.stringify(state));
}

export function clearAwakeState(): void {
  fs.rmSync(AWAKE_STATE_PATH, { force: true });
}

export function awakeReleaseReason(state: AwakeState, power: PowerState, nowMs: number): string | null {
  if (!power.sleepDisabled) return "sleep was re-enabled outside garden";
  if (!power.onAc) return "unplugged";
  if (state.until !== undefined && Date.parse(state.until) <= nowMs) return "timer ended";
  return null;
}

// Watchdog entry point. Forks nothing unless awake is on.
export function enforceAwake(nowMs: number): void {
  const state = readAwakeState();
  if (!state) return;
  const power = readPowerState();
  if (!power) return;
  const reason = awakeReleaseReason(state, power, nowMs);
  if (!reason) return;
  releaseAwake(reason, power);
}

export function releaseIfAwake(reason: string): void {
  if (!readAwakeState()) return;
  const power = readPowerState();
  if (power) releaseAwake(reason, power);
}

export function releaseAwake(reason: string, power: PowerState): void {
  try {
    if (power.sleepDisabled) setSleepDisabled(false);
  } catch (err) {
    log.error("awake", "release failed", { data: { reason, error: String(err) } });
    addAlert({
      level: "error",
      source: "awake",
      project: "garden",
      message:
        `garden awake could not re-enable sleep (${reason}): ${String(err)}. ` +
        `The Mac will not sleep with its lid closed until you run: sudo ${PMSET} -a disablesleep 0`,
      dedupKey: "awake:release-failed",
    });
    return;
  }
  clearAwakeState();
  log.info("awake", "released", { data: { reason, lidClosed: power.lidClosed } });
  if (power.sleepDisabled && power.lidClosed) {
    try {
      run(PMSET, ["sleepnow"]);
    } catch (err) {
      log.warn("awake", "sleepnow failed", { data: { error: String(err) } });
    }
  }
}

// `garden awake` against a simulated Mac: pmset, ioreg, and sudo are replaced
// by a fake machine so the tests can plug, unplug, close the lid, and withhold
// the sudoers entry, then observe what the command and the watchdog did to it.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import { useTmpHome } from "./helpers.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn(), spawnSync: vi.fn() };
});
vi.mock("../src/dashboard/tmux.js", () => ({ windowExists: vi.fn() }));
vi.mock("../src/dashboard/alerts.js", () => ({ addAlert: vi.fn() }));
vi.mock("../src/dashboard/log.js", async () => (await import("./mocks.js")).logMockModule());

import { execFileSync } from "node:child_process";

const machine = { sleepDisabled: false, onAc: true, lidClosed: false, sudoers: true, watchdog: true };
let sleepnowCalls = 0;

function fakeExec(file: string, args: string[]): string {
  if (file === "/usr/bin/pmset" && args.join(" ") === "-g") {
    return `System-wide power settings:\n${machine.sleepDisabled ? " SleepDisabled\t\t1\n" : ""}Currently in use:\n sleep                0\n`;
  }
  if (file === "/usr/bin/pmset" && args.join(" ") === "-g batt") {
    return `Now drawing from '${machine.onAc ? "AC Power" : "Battery Power"}'\n -InternalBattery-0\t100%; charged;\n`;
  }
  if (file === "/usr/bin/pmset" && args[0] === "sleepnow") {
    sleepnowCalls++;
    return "Sleeping now...\n";
  }
  if (file === "/usr/sbin/ioreg") return `      "AppleClamshellState" = ${machine.lidClosed ? "Yes" : "No"}\n`;
  if (file === "sudo") {
    if (!machine.sudoers) throw Object.assign(new Error("exit 1"), { stderr: "sudo: a password is required\n" });
    if (!args.includes("-l")) machine.sleepDisabled = args[args.length - 1] === "1";
    return "";
  }
  throw new Error(`unexpected exec: ${file} ${args.join(" ")}`);
}

useTmpHome();

const realPlatform = process.platform;

beforeEach(async () => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  Object.assign(machine, { sleepDisabled: false, onAc: true, lidClosed: false, sudoers: true, watchdog: true });
  sleepnowCalls = 0;
  vi.mocked(execFileSync).mockReset();
  vi.mocked(execFileSync).mockImplementation(((file: string, args: string[]) => fakeExec(file, args)) as never);
  const tmux = await import("../src/dashboard/tmux.js");
  vi.mocked(tmux.windowExists).mockImplementation(() => machine.watchdog);
  const alerts = await import("../src/dashboard/alerts.js");
  vi.mocked(alerts.addAlert).mockReset();
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: realPlatform });
});

async function load() {
  const cmd = await import("../src/commands/awake.js");
  const core = await import("../src/dashboard/awake.js");
  const alerts = await import("../src/dashboard/alerts.js");
  return { ...cmd, ...core, addAlert: vi.mocked(alerts.addAlert) };
}

describe("awake parsers", () => {
  it("reads SleepDisabled only from a recognizable pmset -g", async () => {
    const { parseSleepDisabled } = await load();
    expect(parseSleepDisabled("System-wide power settings:\n SleepDisabled\t\t1\nCurrently in use:\n")).toBe(true);
    expect(parseSleepDisabled("System-wide power settings:\nCurrently in use:\n sleep 0\n")).toBe(false);
    expect(parseSleepDisabled("")).toBeNull();
  });

  it("reads the power source and lid", async () => {
    const { parseOnAc, parseLidClosed } = await load();
    expect(parseOnAc("Now drawing from 'AC Power'\n")).toBe(true);
    expect(parseOnAc("Now drawing from 'Battery Power'\n")).toBe(false);
    expect(parseOnAc("")).toBeNull();
    expect(parseLidClosed('"AppleClamshellState" = Yes')).toBe(true);
    expect(parseLidClosed('"AppleClamshellState" = No')).toBe(false);
  });

  it("parses --for durations", async () => {
    const { parseAwakeDuration } = await load();
    expect(parseAwakeDuration("8h")).toBe(8 * 3_600_000);
    expect(parseAwakeDuration("90m")).toBe(90 * 60_000);
    expect(parseAwakeDuration("7h30m")).toBe(7.5 * 3_600_000);
    for (const bad of ["", "0h", "8", "8d", "h", "8h 30m"]) expect(parseAwakeDuration(bad)).toBeNull();
  });

  it("scopes the sudoers entry to the two pmset invocations", async () => {
    const { sudoersEntry } = await load();
    expect(sudoersEntry("jic")).toBe(
      "jic ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 0, /usr/bin/pmset -a disablesleep 1\n",
    );
    expect(() => sudoersEntry("a b")).toThrow(/unexpected characters/);
  });
});

describe("garden awake on/off", () => {
  it("disables lid sleep and records the timer", async () => {
    const { awake, readAwakeState } = await load();
    const before = Date.now();
    await awake(["on", "--for", "8h"]);
    expect(machine.sleepDisabled).toBe(true);
    const state = readAwakeState();
    expect(Date.parse(state!.until!) - before).toBeGreaterThanOrEqual(8 * 3_600_000);
    expect(Date.parse(state!.until!) - before).toBeLessThan(8 * 3_600_000 + 5_000);
  });

  it.each([
    ["on battery", () => { machine.onAc = false; }, /Not plugged in/],
    ["without a running watchdog", () => { machine.watchdog = false; }, /watchdog is not running/],
    ["before setup", () => { machine.sudoers = false; }, /garden awake setup/],
  ])("refuses %s and changes nothing", async (_label, arrange, message) => {
    const { awake, AWAKE_STATE_PATH } = await load();
    arrange();
    await expect(awake(["on"])).rejects.toThrow(message);
    expect(machine.sleepDisabled).toBe(false);
    expect(fs.existsSync(AWAKE_STATE_PATH)).toBe(false);
  });

  it("reverts when pmset does not report the switch it just set", async () => {
    const { awake, AWAKE_STATE_PATH } = await load();
    const exec = vi.mocked(execFileSync).getMockImplementation()!;
    vi.mocked(execFileSync).mockImplementation(((file: string, args: string[]) =>
      file === "/usr/bin/pmset" && args.join(" ") === "-g"
        ? "System-wide power settings:\nCurrently in use:\n"
        : exec(file, args as never, undefined as never)) as never);
    await expect(awake(["on"])).rejects.toThrow(/does not report SleepDisabled 1/);
    expect(machine.sleepDisabled).toBe(false);
    expect(fs.existsSync(AWAKE_STATE_PATH)).toBe(false);
  });

  it("refuses off macOS", async () => {
    const { awake } = await load();
    Object.defineProperty(process, "platform", { value: "linux" });
    await expect(awake(["on"])).rejects.toThrow(/macOS-only/);
  });

  it("rejects a malformed --for", async () => {
    const { awake } = await load();
    await expect(awake(["on", "--for", "tonight"])).rejects.toThrow(/Invalid --for/);
    expect(machine.sleepDisabled).toBe(false);
  });

  it("off re-enables sleep without putting an open laptop to sleep", async () => {
    const { awake, AWAKE_STATE_PATH } = await load();
    await awake(["on"]);
    await awake(["off"]);
    expect(machine.sleepDisabled).toBe(false);
    expect(fs.existsSync(AWAKE_STATE_PATH)).toBe(false);
    expect(sleepnowCalls).toBe(0);
  });
});

describe("watchdog enforcement", () => {
  it("does nothing, and forks nothing, when awake is off", async () => {
    const { enforceAwake } = await load();
    enforceAwake(Date.now());
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("holds while plugged in with the lid closed", async () => {
    const { awake, enforceAwake, readAwakeState } = await load();
    await awake(["on"]);
    machine.lidClosed = true;
    enforceAwake(Date.now() + 12 * 3_600_000);
    expect(machine.sleepDisabled).toBe(true);
    expect(readAwakeState()).not.toBeNull();
    expect(sleepnowCalls).toBe(0);
  });

  it("releases on unplug and sleeps a closed laptop", async () => {
    const { awake, enforceAwake, readAwakeState } = await load();
    await awake(["on"]);
    machine.lidClosed = true;
    machine.onAc = false;
    enforceAwake(Date.now());
    expect(machine.sleepDisabled).toBe(false);
    expect(readAwakeState()).toBeNull();
    expect(sleepnowCalls).toBe(1);
  });

  it("releases when the timer ends but leaves an open laptop awake", async () => {
    const { awake, enforceAwake, readAwakeState } = await load();
    await awake(["on", "--for", "1h"]);
    enforceAwake(Date.now() + 30 * 60_000);
    expect(machine.sleepDisabled).toBe(true);
    enforceAwake(Date.now() + 61 * 60_000);
    expect(machine.sleepDisabled).toBe(false);
    expect(readAwakeState()).toBeNull();
    expect(sleepnowCalls).toBe(0);
  });

  it("forgets its state when sleep was re-enabled by hand", async () => {
    const { awake, enforceAwake, readAwakeState } = await load();
    await awake(["on"]);
    machine.sleepDisabled = false;
    machine.lidClosed = true;
    enforceAwake(Date.now());
    expect(readAwakeState()).toBeNull();
    expect(sleepnowCalls).toBe(0);
  });

  it("alerts and keeps retrying when it cannot re-enable sleep", async () => {
    const { awake, enforceAwake, readAwakeState, addAlert } = await load();
    await awake(["on"]);
    machine.sudoers = false;
    machine.onAc = false;
    enforceAwake(Date.now());
    expect(machine.sleepDisabled).toBe(true);
    expect(readAwakeState()).not.toBeNull();
    expect(addAlert).toHaveBeenCalledWith(expect.objectContaining({
      level: "error",
      message: expect.stringContaining("sudo /usr/bin/pmset -a disablesleep 0"),
    }));
  });

  it("releases when the dashboard closes", async () => {
    const { awake, releaseIfAwake, readAwakeState } = await load();
    await awake(["on"]);
    releaseIfAwake("dashboard closed");
    expect(machine.sleepDisabled).toBe(false);
    expect(readAwakeState()).toBeNull();
  });
});

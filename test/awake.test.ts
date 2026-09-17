// `garden awake` against a simulated Mac: pmset, ioreg, and sudo are replaced
// by a fake machine so the tests can plug, unplug, close the lid, and withhold
// the sudoers entry, then observe what the command and the watchdog did to it.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { useTmpHome, captureConsoleLog } from "./helpers.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn(), spawnSync: vi.fn() };
});
vi.mock("../src/dashboard/tmux.js", () => ({ windowExists: vi.fn() }));
vi.mock("../src/dashboard/alerts.js", () => ({ addAlert: vi.fn() }));
vi.mock("../src/dashboard/log.js", async () => (await import("./mocks.js")).logMockModule());

import { execFileSync, spawnSync } from "node:child_process";

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
    if (args.includes("-ll")) return "Sudoers entry:\n    RunAsUsers: root\n    Options: !authenticate\n    Commands:\n        /usr/bin/pmset -a disablesleep " + args.at(-1) + "\n";
    machine.sleepDisabled = args[args.length - 1] === "1";
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
  vi.mocked(spawnSync).mockReset();
  vi.mocked(execFileSync).mockReset();
  vi.mocked(execFileSync).mockImplementation(((file: string, args: string[]) => fakeExec(file, args)) as never);
  const tmux = await import("../src/dashboard/tmux.js");
  vi.mocked(tmux.windowExists).mockImplementation(() => machine.watchdog);
  const alerts = await import("../src/dashboard/alerts.js");
  vi.mocked(alerts.addAlert).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
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

  it("rejects an out-of-range timer before changing power settings", async () => {
    const { awake } = await load();
    await expect(awake(["on", "--for", "999999999999999999999999h"])).rejects.toThrow(/Invalid --for/);
    expect(machine.sleepDisabled).toBe(false);
  });

  it("restores sleep if saving ownership fails", async () => {
    const { awake, readAwakeState } = await load();
    const atomic = await import("../src/dashboard/atomic-write.js");
    vi.spyOn(atomic, "atomicWriteFile").mockImplementation(() => { throw new Error("disk full"); });
    await expect(awake(["on"])).rejects.toThrow(/disk full/);
    expect(machine.sleepDisabled).toBe(false);
    expect(readAwakeState()).toBeNull();
  });

  it("proves release permission before enabling, even when sudo listing succeeds", async () => {
    const { awake } = await load();
    vi.mocked(execFileSync).mockImplementation(((file: string, args: string[]) => {
      if (file === "sudo" && !args.includes("-ll") && args.at(-1) === "0") {
        throw new Error("password required for release");
      }
      return fakeExec(file, args);
    }) as never);
    await expect(awake(["on"])).rejects.toThrow(/password required for release/);
    expect(machine.sleepDisabled).toBe(false);
  });

  it("keeps ownership and reports an off command that failed to restore sleep", async () => {
    const { awake, readAwakeState } = await load();
    await awake(["on"]);
    vi.mocked(execFileSync).mockImplementation(((file: string, args: string[]) => {
      if (file === "sudo" && !args.includes("-ll") && args.at(-1) === "0") return "";
      return fakeExec(file, args);
    }) as never);
    await expect(awake(["off"])).rejects.toThrow(/SleepDisabled/);
    expect(readAwakeState()).not.toBeNull();
  });

  it.each(["on", "off"])("%s preserves a sleep override set outside garden", async (sub) => {
    const { awake, readAwakeState } = await load();
    machine.sleepDisabled = true;
    if (sub === "on") await expect(awake([sub])).rejects.toThrow(/outside garden/);
    else await awake([sub]);
    expect(machine.sleepDisabled).toBe(true);
    expect(readAwakeState()).toBeNull();
  });

  it.each(["authenticate", "!authenticate, authenticate", ""])("rejects sudo listing with options '%s'", async (options) => {
    const { canToggleWithoutPassword } = await load();
    vi.mocked(execFileSync).mockReturnValue(`Sudoers entry:\n    Options: ${options}\n    Commands:\n        ALL\n`);
    expect(canToggleWithoutPassword()).toBe(false);
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

describe("awake setup and status", () => {
  it("reports a timed hold and permission readiness as JSON", async () => {
    const { awake, readAwakeState } = await load();
    await awake(["on", "--for", "1h"]);
    const lines = await captureConsoleLog(() => awake(["status"]));
    expect(JSON.parse(lines[0])).toMatchObject({
      on: true, until: readAwakeState()!.until, onAc: true,
      sleepDisabled: true, watchdogRunning: true, setupDone: true,
    });
  });

  it.each(["success", "validation", "install"])("cleans up setup files after %s", async (outcome) => {
    const { awake, SUDOERS_PATH } = await load();
    let tmpFile = "";
    vi.mocked(spawnSync).mockImplementation(((_file: string, args: string[]) => {
      tmpFile = args[0] === "/usr/sbin/visudo" ? args[2] : args[7];
      expect(fs.readFileSync(tmpFile, "utf8")).toContain("NOPASSWD:");
      const failed = outcome === "validation" && args[0] === "/usr/sbin/visudo"
        || outcome === "install" && args[0] === "/usr/bin/install";
      return { status: failed ? 1 : 0 };
    }) as never);
    if (outcome === "success") await awake(["setup"]);
    else await expect(awake(["setup"])).rejects.toThrow(/failed/);
    expect(fs.existsSync(path.dirname(tmpFile))).toBe(false);
    expect(spawnSync).toHaveBeenCalledTimes(outcome === "validation" ? 1 : 2);
    if (outcome !== "validation") {
      expect(spawnSync).toHaveBeenLastCalledWith("sudo", [
        "/usr/bin/install", "-m", "0440", "-o", "root", "-g", "wheel", tmpFile, SUDOERS_PATH,
      ], { stdio: "inherit" });
    }
  });

  it("refuses activation while another awake transaction holds the lock", async () => {
    const { awake, AWAKE_STATE_PATH } = await load();
    fs.mkdirSync(path.dirname(AWAKE_STATE_PATH), { recursive: true });
    fs.writeFileSync(`${AWAKE_STATE_PATH}.lock`, String(process.pid));
    await expect(awake(["on"])).rejects.toThrow(/acquire awake lock/);
    expect(execFileSync).not.toHaveBeenCalled();
    expect(machine.sleepDisabled).toBe(false);
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
  it("still releases an expired timer when power inspection fails", async () => {
    const { awake, enforceAwake, readAwakeState } = await load();
    await awake(["on", "--for", "1h"]);
    vi.mocked(execFileSync).mockImplementation(((file: string, args: string[]) => {
      if (file === "/usr/sbin/ioreg") throw new Error("ioreg failed");
      return fakeExec(file, args);
    }) as never);
    enforceAwake(Date.now() + 61 * 60_000);
    expect(machine.sleepDisabled).toBe(false);
    expect(readAwakeState()).toBeNull();
  });

  it("releases on dashboard exit even if power inspection fails", async () => {
    const { awake, releaseIfAwake, readAwakeState } = await load();
    await awake(["on"]);
    vi.mocked(execFileSync).mockImplementation(((file: string, args: string[]) => {
      if (file === "/usr/sbin/ioreg") throw new Error("ioreg failed");
      return fakeExec(file, args);
    }) as never);
    releaseIfAwake("dashboard closed");
    expect(machine.sleepDisabled).toBe(false);
    expect(readAwakeState()).toBeNull();
  });

  it("refuses shutdown when sleep cannot be restored", async () => {
    const { awake, releaseIfAwake, readAwakeState } = await load();
    await awake(["on"]);
    machine.sudoers = false;
    expect(() => releaseIfAwake("dashboard closed")).toThrow(/could not re-enable sleep/);
    expect(readAwakeState()).not.toBeNull();
  });

  it.each([true, false])("dashboard exit preserves recovery until release succeeds (%s)", async (canRelease) => {
    const { awake } = await load();
    const session = await import("../src/session.js");
    const poller = await import("../src/dashboard/poller.js");
    const usage = await import("../src/dashboard/usage-poller.js");
    const watchdog = await import("../src/dashboard/watchdog.js");
    const create = await import("../src/dashboard/create.js");
    vi.spyOn(session, "checkTmux").mockImplementation(() => {});
    vi.spyOn(session, "dashboardExists").mockReturnValue(true);
    const kill = vi.spyOn(session, "killDashboardSession").mockImplementation(() => {});
    vi.spyOn(poller, "stopAllPollers").mockImplementation(() => {});
    vi.spyOn(usage, "stopUsagePoller").mockImplementation(() => {});
    const stop = vi.spyOn(watchdog, "stopWatchdog").mockImplementation(() => {
      expect(machine.sleepDisabled).toBe(false);
    });
    vi.spyOn(create, "cleanupContextFiles").mockImplementation(() => {});
    const { dashboard } = await import("../src/dashboard/index.js");
    await awake(["on"]);
    machine.sudoers = canRelease;
    if (canRelease) await dashboard(["exit"]);
    else await expect(dashboard(["exit"])).rejects.toThrow(/could not re-enable sleep/);
    expect(stop).toHaveBeenCalledTimes(canRelease ? 1 : 0);
    expect(kill).toHaveBeenCalledTimes(canRelease ? 1 : 0);
  });

});

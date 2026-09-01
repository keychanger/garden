import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

let tmpHome: string;
let originalHome: string | undefined;
let activePlot: string | null = null;

vi.mock("../src/dashboard/state.js", () => ({
  readDashState: () => ({ activePlot }),
}));

vi.mock("../src/session.js", () => ({
  dashboardExists: vi.fn(() => false),
}));

vi.mock("../src/dashboard/header.js", () => ({
  refreshDashboard: vi.fn(),
}));

const execFileSyncMock = vi.fn();
const spawnSyncMock = vi.fn();

vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

beforeEach(() => {
  vi.clearAllMocks();
  activePlot = null;
  execFileSyncMock.mockImplementation(() => "");
  spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
    if (cmd === "gh" && args[0] === "api" && args[1] === "user") {
      return { status: 0, stdout: "tester\n" };
    }
    return { status: 0 };
  });
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "garden-create-test-"));
  originalHome = process.env.HOME;
  process.env.HOME = tmpHome;
});

afterEach(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.resetModules();
});

async function setup() {
  const config = await import("../src/config.js");
  fs.mkdirSync(config.GARDEN_DIR, { recursive: true });
  fs.mkdirSync(config.SESSIONS_DIR, { recursive: true });
  return config;
}

async function importCreate() {
  return await import("../src/commands/create.js");
}

describe("garden create", () => {
  it("throws when no path is given", async () => {
    await setup();
    const { create } = await importCreate();
    await expect(create([])).rejects.toThrow("Usage: garden create");
  });

  it("rejects an unknown flag and a second positional argument", async () => {
    await setup();
    const { create } = await importCreate();
    await expect(create([path.join(tmpHome, "p"), "--nope"])).rejects.toThrow("Unknown flag '--nope'");
    await expect(create([path.join(tmpHome, "p"), "extra"])).rejects.toThrow("Unexpected argument 'extra'");
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("rejects a missing or malformed --org value before any side effects", async () => {
    await setup();
    const { create } = await importCreate();
    const target = path.join(tmpHome, "orgless");
    await expect(create([target, "--org"])).rejects.toThrow("--org requires an organization name");
    await expect(create([target, "--org", "--private"])).rejects.toThrow(
      "--org requires an organization name",
    );
    await expect(create([target, "--org", "Bad Org/x"])).rejects.toThrow(
      "is not a valid GitHub owner name",
    );
    expect(fs.existsSync(target)).toBe(false);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("rejects names with reserved tmux substrings before any side effects", async () => {
    await setup();
    const { create } = await importCreate();
    const target = path.join(tmpHome, "my-worker-1");
    await expect(create([target])).rejects.toThrow("reserved for tmux");
    expect(fs.existsSync(target)).toBe(false);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("throws when a project with the same name is already registered", async () => {
    const config = await setup();
    config.saveConfig({ projects: { taken: { path: "/elsewhere/taken" } } });
    const { create } = await importCreate();
    await expect(create([path.join(tmpHome, "taken")])).rejects.toThrow(
      "already exists at /elsewhere/taken",
    );
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("throws when the target path already exists", async () => {
    const config = await setup();
    config.saveConfig({ projects: {} });
    const target = path.join(tmpHome, "existing");
    fs.mkdirSync(target);
    const { create } = await importCreate();
    await expect(create([target])).rejects.toThrow("Path already exists");
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("throws when the active plot is missing from config", async () => {
    const config = await setup();
    config.saveConfig({ projects: {}, plots: {} });
    activePlot = "phantom";
    const { create } = await importCreate();
    await expect(create([path.join(tmpHome, "newproj")])).rejects.toThrow(
      "Active plot 'phantom' is missing",
    );
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("refuses to create when the active plot is full, before touching git or GitHub", async () => {
    const config = await setup();
    const filler = Array.from({ length: 9 }, (_, i) => `p${i}`);
    const projects: Record<string, { path: string }> = {};
    for (const p of filler) projects[p] = { path: `/x/${p}` };
    config.saveConfig({
      projects,
      plots: { full: { projects: filler } },
    });
    activePlot = "full";

    const target = path.join(tmpHome, "newproj");
    const { create } = await importCreate();
    await expect(create([target])).rejects.toThrow(/full \(9 projects\)/);
    expect(fs.existsSync(target)).toBe(false);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("creates remote first, then scaffolds locally and registers on the active plot", async () => {
    const config = await setup();
    config.saveConfig({
      projects: {},
      plots: { all: { projects: [] } },
    });
    activePlot = "all";
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "api" && args[1] === "user") return { status: 0, stdout: "tester\n" };
      if (cmd === "gh" && args[0] === "config") return { status: 0, stdout: "ssh\n" };
      return { status: 0 };
    });

    const target = path.join(tmpHome, "shiny");
    const { create } = await importCreate();
    await create([target]);

    expect(fs.existsSync(path.join(target, "README.md"))).toBe(true);
    expect(fs.readFileSync(path.join(target, "README.md"), "utf-8")).toContain("# shiny");

    const calls = execFileSyncMock.mock.calls.map(c => [c[0], c[1]]);
    expect(calls).toEqual([
      ["gh", ["repo", "create", "tester/shiny", "--private"]],
      ["git", ["init", "-b", "main"]],
      ["git", ["add", "README.md"]],
      ["git", ["commit", "-m", "Initial commit"]],
      ["git", ["remote", "add", "origin", "git@github.com:tester/shiny.git"]],
      ["git", ["push", "-u", "origin", "main"]],
    ]);

    const loaded = config.loadConfig();
    expect(loaded.projects["shiny"].path).toBe(target);
    expect(loaded.plots?.all.projects).toContain("shiny");
  });

  it("leaves no local directory behind when 'gh repo create' fails", async () => {
    const config = await setup();
    config.saveConfig({ projects: {}, plots: { all: { projects: [] } } });
    activePlot = "all";

    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "repo" && args[1] === "create") {
        throw new Error("Name already exists on this account");
      }
      return "";
    });

    const target = path.join(tmpHome, "denied");
    const { create } = await importCreate();
    await expect(create([target])).rejects.toThrow(/'gh repo create .* failed/);
    expect(fs.existsSync(target)).toBe(false);
    const loaded = config.loadConfig();
    expect(loaded.projects["denied"]).toBeUndefined();
  });

  it("reads git_protocol scoped to github.com, not the global default", async () => {
    const config = await setup();
    config.saveConfig({ projects: {}, plots: { all: { projects: [] } } });
    activePlot = "all";
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "api" && args[1] === "user") return { status: 0, stdout: "tester\n" };
      if (cmd === "gh" && args[0] === "config") {
        const hostScoped = args[2] === "-h" && args[3] === "github.com";
        return { status: 0, stdout: hostScoped ? "ssh\n" : "https\n" };
      }
      return { status: 0 };
    });

    const target = path.join(tmpHome, "hosty");
    const { create } = await importCreate();
    await create([target]);

    const remoteAddCall = execFileSyncMock.mock.calls.find(
      c => c[0] === "git" && Array.isArray(c[1]) && (c[1] as string[])[0] === "remote",
    );
    expect(remoteAddCall?.[1]).toEqual([
      "remote", "add", "origin", "git@github.com:tester/hosty.git",
    ]);
  });

  it("uses HTTPS remote when gh git_protocol is not ssh", async () => {
    const config = await setup();
    config.saveConfig({ projects: {}, plots: { all: { projects: [] } } });
    activePlot = "all";
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "api" && args[1] === "user") return { status: 0, stdout: "tester\n" };
      if (cmd === "gh" && args[0] === "config") return { status: 0, stdout: "https\n" };
      return { status: 0 };
    });

    const target = path.join(tmpHome, "webby");
    const { create } = await importCreate();
    await create([target]);

    const remoteAddCall = execFileSyncMock.mock.calls.find(
      c => c[0] === "git" && Array.isArray(c[1]) && (c[1] as string[])[0] === "remote",
    );
    expect(remoteAddCall?.[1]).toEqual([
      "remote", "add", "origin", "https://github.com/tester/webby.git",
    ]);
  });

  it("creates the repo under --org and points origin at the org slug", async () => {
    const config = await setup();
    config.saveConfig({ projects: {}, plots: { all: { projects: [] } } });
    activePlot = "all";
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "api" && args[1] === "user") return { status: 0, stdout: "tester\n" };
      if (cmd === "gh" && args[0] === "config") return { status: 0, stdout: "ssh\n" };
      return { status: 0 };
    });

    const target = path.join(tmpHome, "orgproj");
    const { create } = await importCreate();
    await create([target, "--org", "Leading-Tone"]);

    const calls = execFileSyncMock.mock.calls.map(c => [c[0], c[1]]);
    expect(calls).toContainEqual(["gh", ["repo", "create", "Leading-Tone/orgproj", "--private"]]);
    expect(calls).toContainEqual([
      "git",
      ["remote", "add", "origin", "git@github.com:Leading-Tone/orgproj.git"],
    ]);
    // The org is the owner, so the authenticated user is never consulted.
    expect(
      spawnSyncMock.mock.calls.some(c => c[0] === "gh" && (c[1] as string[])[0] === "api"),
    ).toBe(false);

    expect(config.loadConfig().projects["orgproj"].path).toBe(target);
  });

  it("aborts before any side effects when gh is not authenticated and stdin is not a TTY", async () => {
    const config = await setup();
    config.saveConfig({ projects: {}, plots: { all: { projects: [] } } });
    activePlot = "all";
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "auth" && args[1] === "status") return { status: 1 };
      return { status: 0 };
    });
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });

    const target = path.join(tmpHome, "noauth");
    try {
      const { create } = await importCreate();
      await expect(create([target])).rejects.toThrow(/gh auth required/);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
    }

    expect(fs.existsSync(target)).toBe(false);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("registers without a plot when none is active and prints a hint", async () => {
    const config = await setup();
    config.saveConfig({ projects: {} });
    activePlot = null;

    const target = path.join(tmpHome, "loner");
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
    try {
      const { create } = await importCreate();
      await create([target]);
    } finally {
      console.log = orig;
    }

    const loaded = config.loadConfig();
    expect(loaded.projects["loner"].path).toBe(target);
    expect(logs.some(l => l.includes("No active plot"))).toBe(true);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { captureConsoleLog } from "./helpers.js";

const h = vi.hoisted(() => ({
  isTTY: true,
  configExists: true,
  // Map of `${bin} ${args[0]}` -> { status, stdout } for spawnSync.
  responses: {} as Record<string, { status: number; stdout: string; error?: boolean }>,
}));

vi.mock("../src/output.js", () => ({
  output: vi.fn(),
  get isTTY() { return h.isTTY; },
}));
vi.mock("node:child_process", () => ({
  spawnSync: (bin: string, args: string[]) => {
    const r = h.responses[`${bin} ${args[0]}`];
    if (!r) return { status: 127, stdout: "", error: new Error("ENOENT") };
    return r.error ? { error: new Error("fail"), status: null, stdout: "" } : { status: r.status, stdout: r.stdout };
  },
}));
vi.mock("node:fs", async (orig) => {
  const actual = await orig<typeof import("node:fs")>();
  return { ...actual, existsSync: () => h.configExists };
});

import { doctor, nodeMeetsFloor } from "../src/commands/doctor.js";
import { output } from "../src/output.js";

const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
const ok = (stdout: string) => ({ status: 0, stdout });

beforeEach(() => {
  h.isTTY = true;
  h.configExists = true;
  h.responses = {};
  vi.clearAllMocks();
});

describe("garden doctor", () => {
  it("reports ok for tmux/claude when present and gh authenticated", async () => {
    h.responses = {
      "tmux -V": ok("tmux 3.4"),
      "claude --version": ok("2.1.0 (Claude Code)"),
      "gh --version": ok("gh version 2.86.0"),
      "gh auth": ok("Logged in"),
    };
    const text = (await captureConsoleLog(() => doctor())).map(strip).join("\n");
    expect(text).toMatch(/✔ tmux\s+tmux 3\.4/);
    expect(text).toMatch(/✔ claude/);
    expect(text).toContain("authenticated");
    expect(text).toContain(process.version); // node check
  });

  it("fails when tmux is missing", async () => {
    h.responses = { "claude --version": ok("2.1.0"), "gh --version": ok("gh version 2"), "gh auth": ok("") };
    const text = (await captureConsoleLog(() => doctor())).map(strip).join("\n");
    expect(text).toMatch(/✖ tmux\s+not found/);
    expect(text).toContain("Some required tools are missing");
  });

  it("warns when gh is present but not authenticated", async () => {
    h.responses = {
      "tmux -V": ok("tmux 3.4"),
      "claude --version": ok("2.1.0"),
      "gh --version": ok("gh version 2.86.0"),
      "gh auth": { status: 1, stdout: "" },
    };
    const text = (await captureConsoleLog(() => doctor())).map(strip).join("\n");
    expect(text).toMatch(/⚠ gh\s+.*not authenticated/);
  });

  it("warns (not fails) when gh is absent — it is optional", async () => {
    h.responses = { "tmux -V": ok("tmux 3.4"), "claude --version": ok("2.1.0") };
    const lines = (await captureConsoleLog(() => doctor())).map(strip);
    // Match the gh check row specifically (glyph then "gh"), not the header —
    // "preflight" also contains the substring "gh".
    const ghLine = lines.find(l => /^\s*[⚠✔✖]\s+gh\b/.test(l));
    expect(ghLine).toMatch(/⚠/);
    expect(lines.join("\n")).not.toContain("Some required tools are missing");
  });

  it("warns when garden is not initialized", async () => {
    h.configExists = false;
    h.responses = { "tmux -V": ok("tmux 3.4"), "claude --version": ok("2.1.0") };
    const lines = (await captureConsoleLog(() => doctor())).map(strip);
    const configLine = lines.find(l => /^\s*[⚠✔✖]\s+config\b/.test(l));
    expect(configLine).toMatch(/⚠/);
    expect(configLine).toContain("garden init");
    // Missing config is a warn, not a fail — it's expected on first run.
    expect(lines.join("\n")).not.toContain("Some required tools are missing");
  });

  it("shows config ok when initialized", async () => {
    h.configExists = true;
    h.responses = { "tmux -V": ok("tmux 3.4"), "claude --version": ok("2.1.0") };
    const lines = (await captureConsoleLog(() => doctor())).map(strip);
    const configLine = lines.find(l => /^\s*[⚠✔✖]\s+config\b/.test(l));
    expect(configLine).toMatch(/✔/);
  });

  it("node floor accepts 22.1 and above, rejects below", () => {
    // Boundary: 22.1 is the floor (NODE_COMPILE_CACHE landed there).
    expect(nodeMeetsFloor("v22.1.0")).toBe(true);
    expect(nodeMeetsFloor("v22.14.0")).toBe(true);
    expect(nodeMeetsFloor("v24.0.0")).toBe(true);
    expect(nodeMeetsFloor("v22.0.0")).toBe(false);
    expect(nodeMeetsFloor("v20.11.0")).toBe(false);
    // Unparseable input fails closed (warn), never falsely passes.
    expect(nodeMeetsFloor("garbage")).toBe(false);
  });

  it("emits JSON when not a TTY", async () => {
    h.isTTY = false;
    h.responses = { "tmux -V": ok("tmux 3.4"), "claude --version": ok("2.1.0"), "gh --version": ok("gh v2"), "gh auth": ok("") };
    await doctor();
    expect(output).toHaveBeenCalledWith(expect.objectContaining({
      checks: expect.arrayContaining([
        expect.objectContaining({ name: "tmux", status: "ok" }),
        expect.objectContaining({ name: "Option key", status: "warn" }),
      ]),
    }));
  });
});

// Shared-store preflight (DELEGATION.md Decision 15): projects pinning a
// beadsDir get one row — ok listing the resolved stores, warn naming each
// dangling one — and fleets with no beadsDir keys get no row at all.
describe("checkBeadsStores", () => {
  it("returns null when no project configures a beadsDir", async () => {
    const { checkBeadsStores } = await import("../src/commands/doctor.js");
    expect(checkBeadsStores({ a: { path: "/repo/a" } })).toBeNull();
  });

  it("reports ok for existing stores and warn for dangling ones", async () => {
    const { checkBeadsStores } = await import("../src/commands/doctor.js");
    const fsReal = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fsReal.mkdtempSync(path.join(os.tmpdir(), "doctor-beads-"));
    try {
      const store = path.join(dir, ".beads");
      fsReal.mkdirSync(store);
      const ok = checkBeadsStores({ a: { path: "/repo/a", beadsDir: store } });
      expect(ok).toMatchObject({ name: "beads stores", status: "ok" });
      expect(ok!.detail).toContain(store);

      const warn = checkBeadsStores({
        a: { path: "/repo/a", beadsDir: store },
        b: { path: "/repo/b", beadsDir: path.join(dir, "missing", ".beads") },
      });
      expect(warn).toMatchObject({ name: "beads stores", status: "warn" });
      expect(warn!.detail).toContain("does not exist");
      expect(warn!.detail).toContain("b:");
    } finally {
      fsReal.rmSync(dir, { recursive: true, force: true });
    }
  });
});

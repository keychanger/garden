import { describe, it, expect, vi, beforeEach } from "vitest";
import { captureConsoleLog } from "./helpers.js";

const h = vi.hoisted(() => ({
  isTTY: true,
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

import { doctor } from "../src/commands/doctor.js";
import { output } from "../src/output.js";

const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
const ok = (stdout: string) => ({ status: 0, stdout });

beforeEach(() => {
  h.isTTY = true;
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

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn(() => false),
    realpathSync: vi.fn(() => { throw new Error("ENOENT"); }),
    statSync: vi.fn(() => { throw new Error("ENOENT"); }),
  },
}));

import fs from "node:fs";
import { resolveGardenRunner, resolveHookRunner, findStableGardenBin, resolveNodeBin, hookCompileCachePrefix } from "../src/dashboard/runner.js";

const savedArgv1 = process.argv[1];
const savedPath = process.env.PATH;
afterAll(() => {
  process.argv[1] = savedArgv1;
  process.env.PATH = savedPath;
});

beforeEach(() => {
  vi.clearAllMocks();
  process.argv[1] = "/usr/local/bin/garden";
  process.env.PATH = "/usr/local/bin:/opt/homebrew/bin";
  vi.mocked(fs.realpathSync).mockImplementation(() => { throw new Error("ENOENT"); });
  vi.mocked(fs.statSync).mockImplementation(() => { throw new Error("ENOENT"); });
});

describe("resolveGardenRunner", () => {
  it("uses node with absolute path for compiled .js binary", () => {
    process.argv[1] = "/usr/local/bin/garden";
    const result = resolveGardenRunner();
    expect(result).toContain(process.execPath);
    expect(result).toContain("/usr/local/bin/garden");
  });

  it("uses tsx when argv ends in .ts and tsx binary exists", () => {
    process.argv[1] = "/code/garden/src/cli.ts";
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const result = resolveGardenRunner();
    expect(result).toContain("tsx");
    expect(result).toContain("/code/garden/src/cli.ts");
  });

  it("falls back to npx tsx when tsx binary not found", () => {
    process.argv[1] = "/code/garden/src/cli.ts";
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const result = resolveGardenRunner();
    expect(result).toContain("npx tsx");
    expect(result).toContain("/code/garden/src/cli.ts");
  });

  // Worktree-stability guard: argv[1] inside /.garden/worktrees/ is ephemeral.
  // The dashboard often runs from a worker's worktree during dev; without this
  // guard, persistence sites (tmux key bindings, .claude/settings.json hook
  // commands, hidden window long-running shells) bake the worktree path and
  // break the moment that worker's branch merges. See runner.ts comment block
  // for the propagation chain.
  it("redirects to stable PATH-resolved binary when argv[1] is inside a worktree", () => {
    process.argv[1] = "/Users/joshua/.garden/worktrees/garden/blue-fern/dist/cli.js";
    vi.mocked(fs.realpathSync).mockImplementation((p) => {
      if (String(p) === "/usr/local/bin/garden") return "/Users/joshua/code/keychange/garden/dist/cli.js";
      throw new Error("ENOENT");
    });
    const result = resolveGardenRunner();
    expect(result).toContain("/Users/joshua/code/keychange/garden/dist/cli.js");
    expect(result).not.toContain("blue-fern");
  });

  it("falls back to argv[1] when worktree path is set but no stable global exists", () => {
    process.argv[1] = "/Users/joshua/.garden/worktrees/garden/blue-fern/dist/cli.js";
    // realpathSync throws everywhere → no stable global on PATH.
    const result = resolveGardenRunner();
    expect(result).toContain("blue-fern");
  });

  it("does not redirect when argv[1] is already outside any worktree", () => {
    process.argv[1] = "/opt/homebrew/bin/garden";
    // realpathSync should not be invoked at all in this branch.
    const result = resolveGardenRunner();
    expect(result).toContain("/opt/homebrew/bin/garden");
    expect(fs.realpathSync).not.toHaveBeenCalled();
  });
});

describe("resolveHookRunner", () => {
  it("targets dist/hook.js next to the real cli.js, resolving a bin symlink", () => {
    process.argv[1] = "/opt/homebrew/bin/garden";
    vi.mocked(fs.realpathSync).mockImplementation((p) => {
      if (String(p) === "/opt/homebrew/bin/garden") return "/Users/joshua/code/keychange/garden/dist/cli.js";
      throw new Error("ENOENT");
    });
    const result = resolveHookRunner();
    expect(result).toContain(process.execPath);
    expect(result).toContain("/Users/joshua/code/keychange/garden/dist/hook.js");
  });

  it("falls back to argv[1]'s own dir when the symlink can't be resolved", () => {
    process.argv[1] = "/usr/local/bin/garden";
    // realpathSync throws by default → use argv[1] as-is.
    const result = resolveHookRunner();
    expect(result).toContain("/usr/local/bin/hook.js");
  });

  it("uses tsx with the sibling hook-entry.ts in dev", () => {
    process.argv[1] = "/code/garden/src/cli.ts";
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const result = resolveHookRunner();
    expect(result).toContain("tsx");
    expect(result).toContain("/code/garden/src/hook-entry.ts");
  });

  it("redirects to the stable global's dist/hook.js when argv[1] is in a worktree", () => {
    process.argv[1] = "/Users/joshua/.garden/worktrees/garden/blue-fern/dist/cli.js";
    vi.mocked(fs.realpathSync).mockImplementation((p) => {
      if (String(p) === "/usr/local/bin/garden") return "/Users/joshua/code/keychange/garden/dist/cli.js";
      throw new Error("ENOENT");
    });
    const result = resolveHookRunner();
    expect(result).toContain("/Users/joshua/code/keychange/garden/dist/hook.js");
    expect(result).not.toContain("blue-fern");
  });

  it("falls back to the worktree's own dist/hook.js when no stable global exists", () => {
    process.argv[1] = "/Users/joshua/.garden/worktrees/garden/blue-fern/dist/cli.js";
    const result = resolveHookRunner();
    expect(result).toContain("/Users/joshua/.garden/worktrees/garden/blue-fern/dist/hook.js");
  });
});

describe("hookCompileCachePrefix", () => {
  const savedHome = process.env.HOME;
  afterAll(() => { process.env.HOME = savedHome; });

  it("emits a NODE_COMPILE_CACHE assignment under ~/.cache", () => {
    process.env.HOME = "/Users/joshua";
    const prefix = hookCompileCachePrefix();
    // A shell-safe path needs no quoting; the assignment is still valid.
    expect(prefix).toBe("NODE_COMPILE_CACHE=/Users/joshua/.cache/garden/node-compile ");
    // Trailing space so it prepends cleanly onto the runner command.
    expect(prefix.endsWith(" ")).toBe(true);
  });

  it("shell-escapes a HOME containing spaces so the assignment stays one token", () => {
    process.env.HOME = "/Users/jo shua";
    expect(hookCompileCachePrefix()).toBe("NODE_COMPILE_CACHE='/Users/jo shua/.cache/garden/node-compile' ");
  });

  it("returns empty when HOME is unset (never bakes a bogus path)", () => {
    delete process.env.HOME;
    expect(hookCompileCachePrefix()).toBe("");
  });
});

describe("findStableGardenBin", () => {
  it("returns the realpath-resolved garden binary from the first PATH dir that has one", () => {
    process.env.PATH = "/empty:/opt/homebrew/bin:/usr/local/bin";
    vi.mocked(fs.realpathSync).mockImplementation((p) => {
      if (String(p) === "/empty/garden") throw new Error("ENOENT");
      if (String(p) === "/opt/homebrew/bin/garden") return "/Users/joshua/code/keychange/garden/dist/cli.js";
      throw new Error("ENOENT");
    });
    expect(findStableGardenBin()).toBe("/Users/joshua/code/keychange/garden/dist/cli.js");
  });

  it("rejects symlinks that resolve into a worktree (chasing one defeats the stability check)", () => {
    process.env.PATH = "/opt/homebrew/bin";
    vi.mocked(fs.realpathSync).mockImplementation(() => {
      return "/Users/joshua/.garden/worktrees/garden/blue-fern/dist/cli.js";
    });
    expect(findStableGardenBin()).toBeNull();
  });

  it("returns null when no garden binary exists on PATH", () => {
    process.env.PATH = "/usr/bin:/bin";
    // realpathSync default throws everywhere.
    expect(findStableGardenBin()).toBeNull();
  });

  it("ignores non-.js targets so it does not match wrapper scripts", () => {
    process.env.PATH = "/usr/local/bin";
    vi.mocked(fs.realpathSync).mockReturnValue("/usr/local/bin/garden");
    expect(findStableGardenBin()).toBeNull();
  });
});

// Regression: a node upgrade (even an incidental one pulled in by an unrelated
// `brew install`) deletes the versioned Cellar dir, so baking process.execPath
// — the version-pinned realpath — turns every persisted command into a 127.
// resolveNodeBin bakes the stable PATH symlink (/opt/homebrew/bin/node) whose
// target Homebrew rewrites on upgrade, keeping the baked path valid.
describe("resolveNodeBin", () => {
  it("returns the un-resolved node from the first PATH dir that has one", () => {
    process.env.PATH = "/usr/local/bin:/opt/homebrew/bin";
    vi.mocked(fs.statSync).mockImplementation((p) => {
      if (String(p) === "/opt/homebrew/bin/node") return { isFile: () => true } as ReturnType<typeof fs.statSync>;
      throw new Error("ENOENT");
    });
    // The symlink path itself, NOT its versioned Cellar realpath.
    expect(resolveNodeBin()).toBe("/opt/homebrew/bin/node");
  });

  it("does not realpath the candidate — a node upgrade keeps the baked path valid", () => {
    process.env.PATH = "/opt/homebrew/bin";
    vi.mocked(fs.statSync).mockReturnValue({ isFile: () => true } as ReturnType<typeof fs.statSync>);
    const result = resolveNodeBin();
    expect(result).toBe("/opt/homebrew/bin/node");
    expect(result).not.toContain("Cellar");
  });

  it("falls back to process.execPath when no node is on PATH", () => {
    process.env.PATH = "/usr/bin:/bin";
    // statSync default throws everywhere → no usable node on PATH.
    expect(resolveNodeBin()).toBe(process.execPath);
  });

  it("bakes the stable PATH node into the garden runner command", () => {
    process.argv[1] = "/opt/homebrew/bin/garden";
    process.env.PATH = "/opt/homebrew/bin";
    vi.mocked(fs.statSync).mockReturnValue({ isFile: () => true } as ReturnType<typeof fs.statSync>);
    const result = resolveGardenRunner();
    expect(result).toContain("/opt/homebrew/bin/node");
    expect(result).not.toContain("Cellar");
  });
});

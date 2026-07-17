import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

let tmpHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "garden-config-test-"));
  originalHome = process.env.HOME;
  process.env.HOME = tmpHome;
});

afterEach(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.resetModules();
});

async function importConfig() {
  return await import("../src/config.js");
}

describe("loadConfig", () => {
  it("throws when not initialized", async () => {
    const { loadConfig } = await importConfig();
    expect(() => loadConfig()).toThrow("Garden is not initialized");
  });

  it("returns empty projects after init", async () => {
    const { loadConfig, saveConfig, GARDEN_DIR } = await importConfig();
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    saveConfig({ projects: {} });
    const config = loadConfig();
    expect(config.projects).toEqual({});
  });
});

describe("getProject", () => {
  it("returns a registered project", async () => {
    const { getProject, saveConfig, GARDEN_DIR } = await importConfig();
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    saveConfig({ projects: { test: { path: "/tmp/test" } } });
    const project = getProject("test");
    expect(project.name).toBe("test");
    expect(project.path).toBe("/tmp/test");
  });

  it("throws for unknown project", async () => {
    const { getProject, saveConfig, GARDEN_DIR } = await importConfig();
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    saveConfig({ projects: {} });
    expect(() => getProject("nope")).toThrow("Unknown project: nope");
  });
});

describe("tryGetProject", () => {
  it("returns null for unknown project", async () => {
    const { tryGetProject, saveConfig, GARDEN_DIR } = await importConfig();
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    saveConfig({ projects: {} });
    expect(tryGetProject("nope")).toBeNull();
  });
});

describe("resolveProject", () => {
  it("resolves from explicit name", async () => {
    const { resolveProject, saveConfig, GARDEN_DIR } = await importConfig();
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    saveConfig({ projects: { myproj: { path: "/tmp/myproj" } } });
    const project = resolveProject("myproj");
    expect(project.name).toBe("myproj");
  });

  it("resolves from GARDEN_PROJECT env var", async () => {
    const { resolveProject, saveConfig, GARDEN_DIR } = await importConfig();
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    saveConfig({ projects: { envproj: { path: "/tmp/envproj" } } });
    process.env.GARDEN_PROJECT = "envproj";
    try {
      const project = resolveProject();
      expect(project.name).toBe("envproj");
    } finally {
      delete process.env.GARDEN_PROJECT;
    }
  });

  it("throws when no project can be resolved", async () => {
    const { resolveProject, saveConfig, GARDEN_DIR } = await importConfig();
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    saveConfig({ projects: {} });
    expect(() => resolveProject()).toThrow("No project specified");
  });
});

describe("getFocusedProjectNames", () => {
  it("returns all plot projects when no focused filter is needed", async () => {
    const { getFocusedProjectNames, saveConfig, GARDEN_DIR } = await importConfig();
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    saveConfig({
      projects: { a: { path: "/a" }, b: { path: "/b" } },
      plots: { all: { projects: ["a", "b"] } },
    });
    expect(getFocusedProjectNames()).toEqual(["a", "b"]);
  });

  it("returns the active plot's projects when specified", async () => {
    const { getFocusedProjectNames, saveConfig, GARDEN_DIR } = await importConfig();
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    saveConfig({
      projects: { a: { path: "/a" }, b: { path: "/b" }, c: { path: "/c" } },
      plots: {
        all: { projects: ["a", "b", "c"] },
        mini: { projects: ["b"] },
      },
    });
    expect(getFocusedProjectNames(undefined, "mini")).toEqual(["b"]);
  });

  it("falls back to the first focused plot when active plot is missing", async () => {
    const { getFocusedProjectNames, saveConfig, GARDEN_DIR } = await importConfig();
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    saveConfig({
      projects: { a: { path: "/a" }, b: { path: "/b" } },
      plots: {
        hidden: { projects: ["a"], focused: false },
        main: { projects: ["b"] },
      },
    });
    expect(getFocusedProjectNames(undefined, "nonexistent")).toEqual(["b"]);
  });

  it("filters projects that no longer exist in config", async () => {
    const { getFocusedProjectNames, GARDEN_DIR } = await importConfig();
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    const config = {
      projects: { a: { path: "/a" } },
      plots: { all: { projects: ["a", "ghost"] } },
    };
    expect(getFocusedProjectNames(config, "all")).toEqual(["a"]);
  });
});

describe("allPlotProjectNames", () => {
  it("returns the deduplicated union of every plot's projects in first-seen order", async () => {
    const { allPlotProjectNames, GARDEN_DIR } = await importConfig();
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    const config = {
      projects: { a: { path: "/a" }, b: { path: "/b" }, c: { path: "/c" } },
      plots: {
        first: { projects: ["a", "b"] },
        second: { projects: ["b", "c"] },
      },
    };
    expect(allPlotProjectNames(config)).toEqual(["a", "b", "c"]);
  });

  it("filters projects that no longer exist in config", async () => {
    const { allPlotProjectNames, GARDEN_DIR } = await importConfig();
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    const config = {
      projects: { a: { path: "/a" } },
      plots: {
        one: { projects: ["a", "ghost"] },
        two: { projects: ["phantom"] },
      },
    };
    expect(allPlotProjectNames(config)).toEqual(["a"]);
  });

  it("returns an empty array when there are no plots", async () => {
    const { allPlotProjectNames, GARDEN_DIR } = await importConfig();
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    const config = { projects: { a: { path: "/a" } } };
    expect(allPlotProjectNames(config)).toEqual([]);
  });
});

describe("plots migration", () => {
  it("synthesizes an 'all' plot from currently focused projects", async () => {
    const { loadConfig, GARDEN_DIR, CONFIG_PATH } = await importConfig();
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    fs.writeFileSync(
      CONFIG_PATH,
      "projects:\n  a:\n    path: /a\n  b:\n    path: /b\n    focused: false\n  c:\n    path: /c\n",
    );
    const config = loadConfig();
    expect(config.plots).toEqual({ all: { projects: ["a", "c"] } });
  });

  it("drops the deprecated per-project focused flag during migration", async () => {
    const { loadConfig, GARDEN_DIR, CONFIG_PATH } = await importConfig();
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    fs.writeFileSync(
      CONFIG_PATH,
      "projects:\n  a:\n    path: /a\n  b:\n    path: /b\n    focused: false\n",
    );
    loadConfig();
    const after = loadConfig();
    expect(after.projects.b).not.toHaveProperty("focused");
  });

  it("is idempotent when plots already exist", async () => {
    const { loadConfig, saveConfig, GARDEN_DIR, CONFIG_PATH } = await importConfig();
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    saveConfig({
      projects: { a: { path: "/a", logColor: "cyan" } },
      plots: { custom: { projects: ["a"] } },
    });
    const before = fs.readFileSync(CONFIG_PATH, "utf-8");
    loadConfig();
    const after = fs.readFileSync(CONFIG_PATH, "utf-8");
    expect(after).toBe(before);
  });
});

describe("isValidConfigKey", () => {
  it("accepts sandboxDomains as a valid key", async () => {
    const { isValidConfigKey } = await importConfig();
    expect(isValidConfigKey("sandboxDomains")).toBe(true);
  });

  it("accepts logColor as a valid key", async () => {
    const { isValidConfigKey } = await importConfig();
    expect(isValidConfigKey("logColor")).toBe(true);
  });
});

describe("logColor migration", () => {
  it("assigns a unique color to every project on first load", async () => {
    const { loadConfig, saveConfig, GARDEN_DIR } = await importConfig();
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    saveConfig({
      projects: {
        garden: { path: "/g" },
        sharona: { path: "/s" },
        imp: { path: "/i" },
      },
      plots: { all: { projects: ["garden", "sharona", "imp"] } },
    });
    const cfg = loadConfig();
    expect(cfg.projects.garden.logColor).toBeUndefined();
    expect(cfg.projects.sharona.logColor).toBeDefined();
    expect(cfg.projects.imp.logColor).toBeDefined();
    expect(cfg.projects.sharona.logColor).not.toBe(cfg.projects.imp.logColor);
    expect(cfg.projects.sharona.logColor).not.toBe("green");
    expect(cfg.projects.imp.logColor).not.toBe("green");
  });

  it("strips a stray logColor from garden", async () => {
    const { loadConfig, saveConfig, GARDEN_DIR } = await importConfig();
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    saveConfig({
      projects: { garden: { path: "/g", logColor: "cyan" } },
      plots: { all: { projects: ["garden"] } },
    });
    const cfg = loadConfig();
    expect(cfg.projects.garden.logColor).toBeUndefined();
  });

  it("preserves valid existing assignments", async () => {
    const { loadConfig, saveConfig, GARDEN_DIR } = await importConfig();
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    saveConfig({
      projects: {
        a: { path: "/a", logColor: "pink" },
        b: { path: "/b" },
      },
      plots: { all: { projects: ["a", "b"] } },
    });
    const cfg = loadConfig();
    expect(cfg.projects.a.logColor).toBe("pink");
    expect(cfg.projects.b.logColor).toBeDefined();
    expect(cfg.projects.b.logColor).not.toBe("pink");
    expect(cfg.projects.b.logColor).not.toBe("green");
  });

  it("reassigns when an existing color is unknown", async () => {
    const { loadConfig, saveConfig, GARDEN_DIR } = await importConfig();
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    saveConfig({
      projects: { a: { path: "/a", logColor: "fuchsia-the-cat" } },
      plots: { all: { projects: ["a"] } },
    });
    const cfg = loadConfig();
    expect(cfg.projects.a.logColor).not.toBe("fuchsia-the-cat");
    expect(cfg.projects.a.logColor).not.toBe("green");
  });
});

describe("log palette renderers", () => {
  it("derives ANSI and tmux colors from the same palette index", async () => {
    const { logColorAnsi, logColorTmux } = await import("../src/log-palette.js");
    expect(logColorAnsi("cyan")).toBe("\x1b[38;5;39m");
    expect(logColorTmux("cyan")).toBe("colour39");
    expect(logColorAnsi("not-a-color")).toBeNull();
    expect(logColorTmux("not-a-color")).toBeNull();
  });
});

describe("assignLogColor", () => {
  it("picks an unused color when adding a new project", async () => {
    const { assignLogColor } = await importConfig();
    const config = {
      projects: {
        a: { path: "/a", logColor: "cyan" },
        b: { path: "/b", logColor: "skyblue" },
        c: { path: "/c" },
      },
    };
    assignLogColor(config, "c");
    expect(config.projects.c.logColor).toBeDefined();
    expect(config.projects.c.logColor).not.toBe("cyan");
    expect(config.projects.c.logColor).not.toBe("skyblue");
    expect(config.projects.c.logColor).not.toBe("green");
  });

  it("never assigns a color to garden", async () => {
    const { assignLogColor } = await importConfig();
    const config = {
      projects: { garden: { path: "/g" } },
    };
    assignLogColor(config, "garden");
    expect(config.projects.garden.logColor).toBeUndefined();
  });

  it("leaves a valid existing color in place", async () => {
    const { assignLogColor } = await importConfig();
    const config = {
      projects: { a: { path: "/a", logColor: "pink" } },
    };
    assignLogColor(config, "a");
    expect(config.projects.a.logColor).toBe("pink");
  });

  it("falls back to least-used when palette is exhausted", async () => {
    const { assignLogColor } = await importConfig();
    const { ASSIGNABLE_LOG_COLOR_KEYS } = await import("../src/log-palette.js");
    const projects: Record<string, { path: string; logColor?: string }> = {};
    for (let i = 0; i < ASSIGNABLE_LOG_COLOR_KEYS.length; i++) {
      projects[`p${i}`] = { path: `/p${i}`, logColor: ASSIGNABLE_LOG_COLOR_KEYS[i] };
    }
    projects.extra = { path: "/extra" };
    const config = { projects };
    assignLogColor(config, "extra");
    expect(projects.extra.logColor).toBeDefined();
    expect(projects.extra.logColor).not.toBe("green");
  });
});

describe("sandboxDomains round-trip", () => {
  it("persists and reloads sandboxDomains as an array", async () => {
    const { loadConfig, saveConfig, GARDEN_DIR } = await importConfig();
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    saveConfig({
      projects: {
        test: { path: "/tmp/test", sandboxDomains: ["foo.com", "bar.com"] },
      },
    });
    const reloaded = loadConfig();
    expect(reloaded.projects.test.sandboxDomains).toEqual(["foo.com", "bar.com"]);
  });
});

describe("expandHome", () => {
  it("expands ~ to HOME", async () => {
    const { expandHome } = await importConfig();
    expect(expandHome("~/foo/bar")).toBe(path.join(tmpHome, "foo/bar"));
  });

  it("returns bare ~ as HOME", async () => {
    const { expandHome } = await importConfig();
    expect(expandHome("~")).toBe(tmpHome);
  });

  it("leaves absolute paths unchanged", async () => {
    const { expandHome } = await importConfig();
    expect(expandHome("/usr/local")).toBe("/usr/local");
  });
});

describe("resolveClaudeProfile", () => {
  it("returns null when project has no claudeProfile", async () => {
    const { resolveClaudeProfile } = await importConfig();
    expect(resolveClaudeProfile({})).toBeNull();
  });

  it("resolves a registered profile", async () => {
    const { resolveClaudeProfile } = await importConfig();
    const config = {
      projects: {},
      claudeProfiles: { imp: { configDir: "~/.claude-imp" } },
    };
    const result = resolveClaudeProfile({ claudeProfile: "imp" }, config);
    expect(result).toEqual({
      name: "imp",
      configDir: path.join(tmpHome, ".claude-imp"),
      label: "imp",
    });
  });

  it("throws for an unknown profile name", async () => {
    const { resolveClaudeProfile } = await importConfig();
    const config = { projects: {}, claudeProfiles: {} };
    expect(() => resolveClaudeProfile({ claudeProfile: "nope" }, config)).toThrow("unknown claudeProfile");
  });

  it("uses the label when provided", async () => {
    const { resolveClaudeProfile } = await importConfig();
    const config = {
      projects: {},
      claudeProfiles: { imp: { configDir: "/tmp/imp", label: "Client Plan" } },
    };
    const result = resolveClaudeProfile({ claudeProfile: "imp" }, config);
    expect(result?.label).toBe("Client Plan");
  });
});

describe("tryResolveClaudeProfile", () => {
  it("returns null instead of throwing for unknown profile", async () => {
    const { tryResolveClaudeProfile } = await importConfig();
    const config = { projects: {}, claudeProfiles: {} };
    expect(tryResolveClaudeProfile({ claudeProfile: "nope" }, config)).toBeNull();
  });
});

describe("claudeProfile round-trip", () => {
  it("persists and reloads claudeProfile", async () => {
    const { loadConfig, saveConfig, GARDEN_DIR } = await importConfig();
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    saveConfig({
      projects: { test: { path: "/tmp/test", claudeProfile: "imp" } },
      claudeProfiles: { imp: { configDir: "~/.claude-imp" } },
    });
    const reloaded = loadConfig();
    expect(reloaded.projects.test.claudeProfile).toBe("imp");
    expect(reloaded.claudeProfiles?.imp.configDir).toBe("~/.claude-imp");
  });
});

describe("isValidConfigKey — claudeProfile", () => {
  it("accepts claudeProfile as a valid key", async () => {
    const { isValidConfigKey } = await importConfig();
    expect(isValidConfigKey("claudeProfile")).toBe(true);
  });
});

describe("detectProjectFromPath", () => {
  it("returns the deepest matching project", async () => {
    const { detectProjectFromPath, saveConfig, GARDEN_DIR } = await importConfig();
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    saveConfig({
      projects: {
        code: { path: "/home/user/code" },
        sub: { path: "/home/user/code/sub" },
      },
    });
    expect(detectProjectFromPath("/home/user/code/sub/dir")).toBe("sub");
  });

  it("returns the only matching project", async () => {
    const { detectProjectFromPath, saveConfig, GARDEN_DIR } = await importConfig();
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    saveConfig({
      projects: {
        code: { path: "/home/user/code" },
      },
    });
    expect(detectProjectFromPath("/home/user/code/nested")).toBe("code");
  });

  it("returns undefined when no project matches", async () => {
    const { detectProjectFromPath, saveConfig, GARDEN_DIR } = await importConfig();
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    saveConfig({ projects: { code: { path: "/home/user/code" } } });
    expect(detectProjectFromPath("/other/path")).toBeUndefined();
  });
});

describe("logs mode", () => {
  it("defaults to pretty when nothing is persisted", async () => {
    const { getLogsMode, saveConfig, GARDEN_DIR } = await importConfig();
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    saveConfig({ projects: {} });
    expect(getLogsMode()).toBe("pretty");
  });

  it("returns the persisted mode when set to raw", async () => {
    const { getLogsMode, saveConfig, GARDEN_DIR } = await importConfig();
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    saveConfig({ projects: {}, logs: { mode: "raw" } });
    expect(getLogsMode()).toBe("raw");
  });

  it("setLogsMode round-trips through the config file", async () => {
    const { getLogsMode, setLogsMode, saveConfig, GARDEN_DIR } = await importConfig();
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    saveConfig({ projects: {} });
    setLogsMode("raw");
    expect(getLogsMode()).toBe("raw");
    setLogsMode("pretty");
    expect(getLogsMode()).toBe("pretty");
  });

  it("treats an unknown stored value as pretty", async () => {
    const { getLogsMode, GARDEN_DIR, CONFIG_PATH } = await importConfig();
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, "projects: {}\nlogs:\n  mode: gibberish\n");
    expect(getLogsMode()).toBe("pretty");
  });
});

// Garden-level machine-wide resource budgets (config.ts LimitsConfig). These
// are not per-project — they govern how much of the single shared workstation
// the whole fleet may use. Cover the getters' defaults + coercion and the
// lock-protected setter's round-trip / clear-on-empty behavior.
describe("limits (garden-level resource budgets)", () => {
  it("getMaxConcurrentReviews defaults to 0 (unlimited) when unset", async () => {
    const { getMaxConcurrentReviews, saveConfig, GARDEN_DIR } = await importConfig();
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    saveConfig({ projects: {} });
    expect(getMaxConcurrentReviews()).toBe(0);
  });

  it("getChecksSlotsOverride returns undefined when unset (caller uses the hardware default)", async () => {
    const { getChecksSlotsOverride, saveConfig, GARDEN_DIR } = await importConfig();
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    saveConfig({ projects: {} });
    expect(getChecksSlotsOverride()).toBeUndefined();
  });

  it("setLimit round-trips both keys and getters read them back", async () => {
    const { setLimit, getMaxConcurrentReviews, getChecksSlotsOverride, saveConfig, GARDEN_DIR } = await importConfig();
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    saveConfig({ projects: {} });
    setLimit("maxConcurrentReviews", 3);
    setLimit("checksSlots", 2);
    expect(getMaxConcurrentReviews()).toBe(3);
    expect(getChecksSlotsOverride()).toBe(2);
  });

  it("setLimit(key, undefined) clears the key and prunes an empty limits block", async () => {
    const { setLimit, loadConfig, getMaxConcurrentReviews, saveConfig, GARDEN_DIR } = await importConfig();
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    saveConfig({ projects: {} });
    setLimit("maxConcurrentReviews", 5);
    setLimit("maxConcurrentReviews", undefined);
    expect(getMaxConcurrentReviews()).toBe(0);
    expect(loadConfig().limits).toBeUndefined();
  });

  it("getters coerce out-of-range/garbage stored values to the safe default", async () => {
    const { getMaxConcurrentReviews, getChecksSlotsOverride, GARDEN_DIR, CONFIG_PATH } = await importConfig();
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    // maxConcurrentReviews: 0 and negative → unlimited; checksSlots < 1 → default.
    fs.writeFileSync(CONFIG_PATH, "projects: {}\nlimits:\n  maxConcurrentReviews: -2\n  checksSlots: 0\n");
    expect(getMaxConcurrentReviews()).toBe(0);
    expect(getChecksSlotsOverride()).toBeUndefined();
  });
});

// Trellis workflow adds three optional ProjectConfig keys. Round-trip them
// through saveConfig → loadConfig and confirm isValidConfigKey accepts them.
// See WORKFLOWS.md "Project config".
describe("trellis project config keys", () => {
  it("isValidConfigKey accepts the three trellis keys", async () => {
    const { isValidConfigKey } = await importConfig();
    expect(isValidConfigKey("trellisDir")).toBe(true);
    expect(isValidConfigKey("maxTrellisIterations")).toBe(true);
    expect(isValidConfigKey("trellisOpusFallback")).toBe(true);
  });

  it("rejects unknown keys", async () => {
    const { isValidConfigKey } = await importConfig();
    expect(isValidConfigKey("notARealKey")).toBe(false);
  });

  it("round-trips trellisDir, maxTrellisIterations, and trellisOpusFallback", async () => {
    const { loadConfig, saveConfig, GARDEN_DIR } = await importConfig();
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    saveConfig({
      projects: {
        garden: {
          path: "/tmp/garden",
          trellisDir: "docs/trellises",
          maxTrellisIterations: 15,
          trellisOpusFallback: false,
        },
      },
    });
    const cfg = loadConfig();
    expect(cfg.projects.garden.trellisDir).toBe("docs/trellises");
    expect(cfg.projects.garden.maxTrellisIterations).toBe(15);
    expect(cfg.projects.garden.trellisOpusFallback).toBe(false);
  });

  it("treats trellis keys as optional (project config without them still loads)", async () => {
    const { loadConfig, saveConfig, GARDEN_DIR } = await importConfig();
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    saveConfig({ projects: { garden: { path: "/tmp/garden" } } });
    const cfg = loadConfig();
    expect(cfg.projects.garden.path).toBe("/tmp/garden");
    expect(cfg.projects.garden.trellisDir).toBeUndefined();
    expect(cfg.projects.garden.maxTrellisIterations).toBeUndefined();
    expect(cfg.projects.garden.trellisOpusFallback).toBeUndefined();
  });
});

// Grow workflow project config — same shape and pattern as trellis. Single
// integer key (`maxGrowIterations`); the seed is per-worker, not per-project.
describe("grow project config keys", () => {
  it("isValidConfigKey accepts maxGrowIterations", async () => {
    const { isValidConfigKey } = await importConfig();
    expect(isValidConfigKey("maxGrowIterations")).toBe(true);
  });

  it("round-trips maxGrowIterations through saveConfig + loadConfig", async () => {
    const { loadConfig, saveConfig, GARDEN_DIR } = await importConfig();
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    saveConfig({
      projects: {
        garden: {
          path: "/tmp/garden",
          maxGrowIterations: 8,
        },
      },
    });
    const cfg = loadConfig();
    expect(cfg.projects.garden.maxGrowIterations).toBe(8);
  });

  it("treats maxGrowIterations as optional (default workflow projects load fine)", async () => {
    const { loadConfig, saveConfig, GARDEN_DIR } = await importConfig();
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    saveConfig({ projects: { garden: { path: "/tmp/garden" } } });
    const cfg = loadConfig();
    expect(cfg.projects.garden.maxGrowIterations).toBeUndefined();
  });
});

// CI gate project config — boolean opt-out for the poller's GitHub Actions
// merge gate (see src/dashboard/poller-ci.ts). Default-on; absence means the
// gate runs.
describe("requireCiSuccess project config key", () => {
  it("isValidConfigKey accepts requireCiSuccess", async () => {
    const { isValidConfigKey } = await importConfig();
    expect(isValidConfigKey("requireCiSuccess")).toBe(true);
  });

  it("round-trips requireCiSuccess = false through saveConfig + loadConfig", async () => {
    const { loadConfig, saveConfig, GARDEN_DIR } = await importConfig();
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    saveConfig({
      projects: { garden: { path: "/tmp/garden", requireCiSuccess: false } },
    });
    const cfg = loadConfig();
    expect(cfg.projects.garden.requireCiSuccess).toBe(false);
  });

  it("treats requireCiSuccess as optional (absence means gate runs)", async () => {
    const { loadConfig, saveConfig, GARDEN_DIR } = await importConfig();
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    saveConfig({ projects: { garden: { path: "/tmp/garden" } } });
    const cfg = loadConfig();
    expect(cfg.projects.garden.requireCiSuccess).toBeUndefined();
  });
});

// Holistic post-merge review mode — a three-value enum config key
// ("off" | "shadow" | "fix"; see src/config.ts and the dispatcher in
// src/dashboard/poller-holistic-review.ts). Beyond the sibling-key pattern
// (isValidConfigKey + round-trip + optional), this drives the public config()
// command so the new setConfigKey validation branch is exercised: it accepts
// each mode, clears on empty, and rejects anything else.
describe("holisticReview project config key", () => {
  it("isValidConfigKey accepts holisticReview", async () => {
    const { isValidConfigKey } = await importConfig();
    expect(isValidConfigKey("holisticReview")).toBe(true);
  });

  it("round-trips holisticReview = 'shadow' through saveConfig + loadConfig", async () => {
    const { loadConfig, saveConfig, GARDEN_DIR } = await importConfig();
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    saveConfig({
      projects: { garden: { path: "/tmp/garden", holisticReview: "shadow" } },
    });
    const cfg = loadConfig();
    expect(cfg.projects.garden.holisticReview).toBe("shadow");
  });

  it("treats holisticReview as optional (absent from config; the effective default is applied at the gate)", async () => {
    const { loadConfig, saveConfig, GARDEN_DIR } = await importConfig();
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    saveConfig({ projects: { garden: { path: "/tmp/garden" } } });
    const cfg = loadConfig();
    // config stores nothing when unset; DEFAULT_HOLISTIC_REVIEW ("fix") is
    // resolved by the poller gate / menu, not at config-load time.
    expect(cfg.projects.garden.holisticReview).toBeUndefined();
  });

  it("config() persists each valid mode and clears on empty", async () => {
    const { loadConfig, saveConfig, GARDEN_DIR } = await importConfig();
    const { config } = await import("../src/commands/config.js");
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    saveConfig({ projects: { garden: { path: "/tmp/garden" } } });
    for (const mode of ["shadow", "fix", "off"] as const) {
      await config(["garden", "holisticReview", mode]);
      expect(loadConfig().projects.garden.holisticReview).toBe(mode);
    }
    await config(["garden", "holisticReview", ""]);
    expect(loadConfig().projects.garden.holisticReview).toBeUndefined();
  });

  it("config() rejects an invalid mode", async () => {
    const { saveConfig, GARDEN_DIR } = await importConfig();
    const { config } = await import("../src/commands/config.js");
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    saveConfig({ projects: { garden: { path: "/tmp/garden" } } });
    await expect(config(["garden", "holisticReview", "bogus"]))
      .rejects.toThrow(/holisticReview must be 'off', 'shadow', or 'fix'/);
  });
});

// Project-level worker model/effort defaults (config.ts ProjectConfig.model /
// .effort). They are the project-level analog of `workers new --model/--effort`
// and layer beneath the per-spawn opts in newWorker; here we cover the config
// surface (validity, round-trip, the config() validation branches).
describe("model / effort project config keys", () => {
  it("isValidConfigKey accepts model and effort", async () => {
    const { isValidConfigKey } = await importConfig();
    expect(isValidConfigKey("model")).toBe(true);
    expect(isValidConfigKey("effort")).toBe(true);
  });

  it("round-trips model + effort through saveConfig + loadConfig", async () => {
    const { loadConfig, saveConfig, GARDEN_DIR } = await importConfig();
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    saveConfig({
      projects: { garden: { path: "/tmp/garden", model: "sonnet", effort: "high" } },
    });
    const cfg = loadConfig();
    expect(cfg.projects.garden.model).toBe("sonnet");
    expect(cfg.projects.garden.effort).toBe("high");
  });

  it("config() sets model (opaque) and clears on empty", async () => {
    const { loadConfig, saveConfig, GARDEN_DIR } = await importConfig();
    const { config } = await import("../src/commands/config.js");
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    saveConfig({ projects: { garden: { path: "/tmp/garden" } } });
    await config(["garden", "model", "claude-sonnet-5"]);
    expect(loadConfig().projects.garden.model).toBe("claude-sonnet-5");
    await config(["garden", "model", "unset"]);
    expect(loadConfig().projects.garden.model).toBeUndefined();
  });

  it("config() accepts each effort rung plus ultra, clears on empty", async () => {
    const { loadConfig, saveConfig, GARDEN_DIR } = await importConfig();
    const { config } = await import("../src/commands/config.js");
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    saveConfig({ projects: { garden: { path: "/tmp/garden" } } });
    for (const rung of ["low", "medium", "high", "xhigh", "ultra"] as const) {
      await config(["garden", "effort", rung]);
      expect(loadConfig().projects.garden.effort).toBe(rung);
    }
    await config(["garden", "effort", ""]);
    expect(loadConfig().projects.garden.effort).toBeUndefined();
  });

  it("config() rejects an invalid effort value", async () => {
    const { saveConfig, GARDEN_DIR } = await importConfig();
    const { config } = await import("../src/commands/config.js");
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    saveConfig({ projects: { garden: { path: "/tmp/garden" } } });
    await expect(config(["garden", "effort", "max"]))
      .rejects.toThrow(/effort must be one of/);
  });
});

describe("config role subcommand", () => {
  async function setup() {
    const { saveConfig, GARDEN_DIR, loadConfig } = await importConfig();
    const { config } = await import("../src/commands/config.js");
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    saveConfig({ projects: { garden: { path: "/tmp/garden" } } });
    return { config, loadConfig };
  }

  it("routes the reviewer to codex", async () => {
    const { config, loadConfig } = await setup();
    await config(["garden", "role", "reviewer", "harness", "codex"]);
    expect(loadConfig().projects.garden.roles?.reviewer?.harness).toBe("codex");
  });

  it("maps the ci-fix CLI name to the ciFix config key", async () => {
    const { config, loadConfig } = await setup();
    await config(["garden", "role", "ci-fix", "model", "sonnet"]);
    expect(loadConfig().projects.garden.roles?.ciFix?.model).toBe("sonnet");
  });

  it("rejects an unregistered harness", async () => {
    const { config } = await setup();
    await expect(config(["garden", "role", "reviewer", "harness", "gpt4all"]))
      .rejects.toThrow(/Unknown harness 'gpt4all'/);
  });

  it("accepts the 'claude' alias for a review role and persists claude-code", async () => {
    const { config, loadConfig } = await setup();
    await config(["garden", "role", "reviewer", "harness", "claude"]);
    expect(loadConfig().projects.garden.roles?.reviewer?.harness).toBe("claude-code");
  });

  it("rejects an unknown role and dimension", async () => {
    const { config } = await setup();
    await expect(config(["garden", "role", "worker", "harness", "codex"]))
      .rejects.toThrow(/Unknown role 'worker'/);
    await expect(config(["garden", "role", "reviewer", "provider", "deepseek"]))
      .rejects.toThrow(/Unknown role dimension 'provider'/);
  });

  it("clears a role dimension and prunes the empty object", async () => {
    const { config, loadConfig } = await setup();
    await config(["garden", "role", "resolver", "harness", "codex"]);
    await config(["garden", "role", "resolver", "harness", "unset"]);
    expect(loadConfig().projects.garden.roles).toBeUndefined();
  });
});

// Project-default worker harness key — the axis-2 analog of `provider`. Drives
// the setConfigKey validation branch in config(): accepts a registered
// harness, clears on the empty/unset/null sentinels, and rejects an
// unregistered one. Mirrors the holisticReview config() precedent above.
describe("config harness key", () => {
  async function setup() {
    const { saveConfig, GARDEN_DIR, loadConfig } = await importConfig();
    const { config } = await import("../src/commands/config.js");
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    saveConfig({ projects: { garden: { path: "/tmp/garden" } } });
    return { config, loadConfig };
  }

  it("isValidConfigKey accepts harness", async () => {
    const { isValidConfigKey } = await importConfig();
    expect(isValidConfigKey("harness")).toBe(true);
  });

  it("persists a registered harness", async () => {
    const { config, loadConfig } = await setup();
    await config(["garden", "harness", "codex"]);
    expect(loadConfig().projects.garden.harness).toBe("codex");
  });

  it("clears the harness on the empty sentinel", async () => {
    const { config, loadConfig } = await setup();
    await config(["garden", "harness", "codex"]);
    await config(["garden", "harness", ""]);
    expect(loadConfig().projects.garden.harness).toBeUndefined();
  });

  it("accepts the 'claude' alias and persists the claude-code registry name", async () => {
    const { config, loadConfig } = await setup();
    await config(["garden", "harness", "claude"]);
    expect(loadConfig().projects.garden.harness).toBe("claude-code");
  });

  it("rejects an unregistered harness", async () => {
    const { config } = await setup();
    await expect(config(["garden", "harness", "gpt4all"]))
      .rejects.toThrow(/Unknown harness 'gpt4all'/);
  });
});

// Project-level baseBranch key — the authoritative merge target for new
// workers (Phase 2 of the OPERATOR-UI work). Drives the setConfigKey branch in
// config(): persists a trimmed branch name, clears on the sentinels, and
// rejects a whitespace-only value. Validation of existence-on-origin is a soft
// warning at set time (the spawn path does the hard check), so a name that
// isn't on origin still persists.
describe("config baseBranch key", () => {
  async function setup() {
    const { saveConfig, GARDEN_DIR, loadConfig } = await importConfig();
    const { config } = await import("../src/commands/config.js");
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    saveConfig({ projects: { garden: { path: "/tmp/garden" } } });
    return { config, loadConfig };
  }

  it("isValidConfigKey accepts baseBranch", async () => {
    const { isValidConfigKey } = await importConfig();
    expect(isValidConfigKey("baseBranch")).toBe(true);
  });

  it("persists a branch name, trimming surrounding whitespace", async () => {
    const { config, loadConfig } = await setup();
    await config(["garden", "baseBranch", "  v2-api  "]);
    expect(loadConfig().projects.garden.baseBranch).toBe("v2-api");
  });

  it("clears the base on the empty/unset sentinels", async () => {
    const { config, loadConfig } = await setup();
    await config(["garden", "baseBranch", "v2-api"]);
    await config(["garden", "baseBranch", "unset"]);
    expect(loadConfig().projects.garden.baseBranch).toBeUndefined();
  });

  it("rejects a whitespace-only branch name", async () => {
    const { config } = await setup();
    await expect(config(["garden", "baseBranch", "   "]))
      .rejects.toThrow(/non-empty branch name/);
  });
});

// `garden config <p> crew [<name>]` — sugar that sets the worker harness plus
// the three review-role harnesses in one word. Exercises handleCrewCommand's
// three branches (no-name display, unknown-crew throw, apply) at the config()
// seam; crew.test.ts covers the pure crew.ts resolution separately.
describe("config crew subcommand", () => {
  async function setup() {
    const { saveConfig, GARDEN_DIR, loadConfig } = await importConfig();
    const { config } = await import("../src/commands/config.js");
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    saveConfig({ projects: { garden: { path: "/tmp/garden" } } });
    return { config, loadConfig };
  }

  it("applies all-codex: worker + all three review roles become codex", async () => {
    const { config, loadConfig } = await setup();
    await config(["garden", "crew", "all-codex"]);
    const p = loadConfig().projects.garden;
    expect(p.harness).toBe("codex");
    expect(p.roles?.reviewer?.harness).toBe("codex");
    expect(p.roles?.resolver?.harness).toBe("codex");
    expect(p.roles?.ciFix?.harness).toBe("codex");
  });

  it("switching to all-claude clears everything the crew manages", async () => {
    const { config, loadConfig } = await setup();
    await config(["garden", "crew", "codex-claude"]);
    expect(loadConfig().projects.garden.harness).toBe("codex");
    await config(["garden", "crew", "all-claude"]);
    const p = loadConfig().projects.garden;
    expect(p.harness).toBeUndefined();
    expect(p.roles).toBeUndefined();
  });

  it("rejects an unknown crew name", async () => {
    const { config } = await setup();
    await expect(config(["garden", "crew", "nonsense"]))
      .rejects.toThrow(/Unknown crew 'nonsense'/);
  });

  it("no-name form reports the current crew without throwing", async () => {
    const { config } = await setup();
    await expect(config(["garden", "crew"])).resolves.toBeUndefined();
  });
});

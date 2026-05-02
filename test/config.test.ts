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

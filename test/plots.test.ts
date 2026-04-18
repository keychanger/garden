import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

let tmpHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "garden-plots-test-"));
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

function projectsWith(names: string[]): Record<string, { path: string }> {
  return Object.fromEntries(names.map(n => [n, { path: `/tmp/${n}` }]));
}

describe("createPlot", () => {
  it("creates a plot with initial projects", async () => {
    const { createPlot, GARDEN_DIR } = await importConfig();
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    const config = { projects: projectsWith(["a", "b"]), plots: {} };
    createPlot(config, "imp", ["a", "b"]);
    expect(config.plots.imp).toEqual({ projects: ["a", "b"] });
  });

  it("rejects a plot that exceeds the 9-project cap", async () => {
    const { createPlot, PLOT_MAX_PROJECTS } = await importConfig();
    const projects = Array.from({ length: PLOT_MAX_PROJECTS + 1 }, (_, i) => `p${i}`);
    const config = { projects: projectsWith(projects), plots: {} };
    expect(() => createPlot(config, "too-big", projects)).toThrow(/exceeds/);
  });

  it("rejects a plot referencing an unknown project", async () => {
    const { createPlot } = await importConfig();
    const config = { projects: projectsWith(["a"]), plots: {} };
    expect(() => createPlot(config, "x", ["a", "ghost"])).toThrow(/Unknown project: ghost/);
  });

  it("rejects duplicate plot names", async () => {
    const { createPlot } = await importConfig();
    const config = { projects: projectsWith(["a"]), plots: { imp: { projects: ["a"] } } };
    expect(() => createPlot(config, "imp", ["a"])).toThrow(/already exists/);
  });

  it("rejects names with whitespace", async () => {
    const { createPlot } = await importConfig();
    const config = { projects: projectsWith(["a"]), plots: {} };
    expect(() => createPlot(config, "bad name", ["a"])).toThrow(/Invalid plot name/);
  });
});

describe("addProjectToPlot", () => {
  it("appends by default", async () => {
    const { addProjectToPlot } = await importConfig();
    const config = {
      projects: projectsWith(["a", "b", "c"]),
      plots: { imp: { projects: ["a"] } },
    };
    addProjectToPlot(config, "imp", "b");
    expect(config.plots.imp.projects).toEqual(["a", "b"]);
  });

  it("inserts at a 1-based position", async () => {
    const { addProjectToPlot } = await importConfig();
    const config = {
      projects: projectsWith(["a", "b", "c"]),
      plots: { imp: { projects: ["a", "b"] } },
    };
    addProjectToPlot(config, "imp", "c", 1);
    expect(config.plots.imp.projects).toEqual(["c", "a", "b"]);
  });

  it("rejects duplicates", async () => {
    const { addProjectToPlot } = await importConfig();
    const config = {
      projects: projectsWith(["a"]),
      plots: { imp: { projects: ["a"] } },
    };
    expect(() => addProjectToPlot(config, "imp", "a")).toThrow(/already in plot/);
  });

  it("rejects when plot would exceed the cap", async () => {
    const { addProjectToPlot, PLOT_MAX_PROJECTS } = await importConfig();
    const names = Array.from({ length: PLOT_MAX_PROJECTS }, (_, i) => `p${i}`);
    const config = {
      projects: projectsWith([...names, "extra"]),
      plots: { imp: { projects: names } },
    };
    expect(() => addProjectToPlot(config, "imp", "extra")).toThrow(/full/);
  });
});

describe("reorderProjectInPlot", () => {
  it("moves a project within a plot", async () => {
    const { reorderProjectInPlot } = await importConfig();
    const config = {
      projects: projectsWith(["a", "b", "c"]),
      plots: { imp: { projects: ["a", "b", "c"] } },
    };
    reorderProjectInPlot(config, "imp", "c", 1);
    expect(config.plots.imp.projects).toEqual(["c", "a", "b"]);
  });

  it("rejects out-of-range positions", async () => {
    const { reorderProjectInPlot } = await importConfig();
    const config = {
      projects: projectsWith(["a", "b"]),
      plots: { imp: { projects: ["a", "b"] } },
    };
    expect(() => reorderProjectInPlot(config, "imp", "a", 0)).toThrow(/Position must be 1-2/);
    expect(() => reorderProjectInPlot(config, "imp", "a", 3)).toThrow(/Position must be 1-2/);
  });
});

describe("renamePlot", () => {
  it("preserves plot order when renaming", async () => {
    const { renamePlot } = await importConfig();
    const config = {
      projects: projectsWith(["a"]),
      plots: {
        first: { projects: ["a"] },
        second: { projects: [] },
        third: { projects: [] },
      },
    };
    renamePlot(config, "second", "middle");
    expect(Object.keys(config.plots!)).toEqual(["first", "middle", "third"]);
  });

  it("rejects an existing target name", async () => {
    const { renamePlot } = await importConfig();
    const config = {
      projects: {},
      plots: { a: { projects: [] }, b: { projects: [] } },
    };
    expect(() => renamePlot(config, "a", "b")).toThrow(/already exists/);
  });
});

describe("reorderPlotInCycle", () => {
  it("moves a plot within the ordered plots map", async () => {
    const { reorderPlotInCycle } = await importConfig();
    const config = {
      projects: {},
      plots: {
        a: { projects: [] },
        b: { projects: [] },
        c: { projects: [] },
      },
    };
    reorderPlotInCycle(config, "c", 1);
    expect(Object.keys(config.plots!)).toEqual(["c", "a", "b"]);
  });
});

describe("setPlotFocused", () => {
  it("omits focused: true from the stored plot", async () => {
    const { setPlotFocused } = await importConfig();
    const config = {
      projects: {},
      plots: { imp: { projects: [], focused: false as false | undefined } },
    };
    setPlotFocused(config, "imp", true);
    expect(config.plots!.imp).not.toHaveProperty("focused");
  });

  it("stores focused: false for unfocused plots", async () => {
    const { setPlotFocused } = await importConfig();
    const config = { projects: {}, plots: { imp: { projects: [] } } };
    setPlotFocused(config, "imp", false);
    expect(config.plots!.imp.focused).toBe(false);
  });
});

describe("purgeProjectFromPlots", () => {
  it("removes a project from every plot", async () => {
    const { purgeProjectFromPlots } = await importConfig();
    const config = {
      projects: projectsWith(["a", "b"]),
      plots: {
        one: { projects: ["a", "b"] },
        two: { projects: ["b"] },
      },
    };
    purgeProjectFromPlots(config, "b");
    expect(config.plots!.one.projects).toEqual(["a"]);
    expect(config.plots!.two.projects).toEqual([]);
  });
});

describe("firstFocusedPlotName", () => {
  it("returns the first plot whose focused flag is not false", async () => {
    const { firstFocusedPlotName } = await importConfig();
    const config = {
      projects: {},
      plots: {
        hidden: { projects: [], focused: false as const },
        visible: { projects: [] },
      },
    };
    expect(firstFocusedPlotName(config)).toBe("visible");
  });

  it("returns null when every plot is unfocused", async () => {
    const { firstFocusedPlotName } = await importConfig();
    const config = {
      projects: {},
      plots: {
        a: { projects: [], focused: false as const },
      },
    };
    expect(firstFocusedPlotName(config)).toBeNull();
  });
});

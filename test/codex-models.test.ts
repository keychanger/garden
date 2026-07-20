// The Codex model catalog reader. $CODEX_HOME is redirected to a temp dir so
// the real read/parse/filter/sort path is exercised against real files —
// the point of the module is that it survives whatever Codex left on disk.
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

const HOME = `${process.env.TMPDIR || "/tmp"}/garden-codex-models-${process.pid}`;
const savedCodexHome = process.env.CODEX_HOME;

const { codexModels, CODEX_FALLBACK_MODELS, CODEX_EFFORT_LEVELS } =
  await import("../src/dashboard/harness/codex-models.js");

const catalog = () => path.join(HOME, "models_cache.json");
const writeCatalog = (body: unknown) =>
  fs.writeFileSync(catalog(), typeof body === "string" ? body : JSON.stringify(body));

beforeEach(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  process.env.CODEX_HOME = HOME;
});
afterAll(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedCodexHome;
  vi.restoreAllMocks();
});

describe("codexModels", () => {
  it("returns visible slugs in Codex's own priority order", () => {
    writeCatalog({
      models: [
        { slug: "gpt-5.6-luna", visibility: "show", priority: 30 },
        { slug: "gpt-5.6-sol", visibility: "show", priority: 10 },
        { slug: "gpt-5.6-terra", visibility: "show", priority: 20 },
      ],
    });
    expect(codexModels()).toEqual(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
  });

  it("drops hidden models — the deprecated/internal entries Codex itself does not offer", () => {
    writeCatalog({
      models: [
        { slug: "gpt-5.6-sol", visibility: "show", priority: 1 },
        { slug: "gpt-internal-eval", visibility: "hide", priority: 2 },
      ],
    });
    expect(codexModels()).toEqual(["gpt-5.6-sol"]);
  });

  it("sorts a model missing its priority last rather than dropping it", () => {
    writeCatalog({
      models: [
        { slug: "gpt-no-priority" },
        { slug: "gpt-5.6-sol", priority: 5 },
      ],
    });
    expect(codexModels()).toEqual(["gpt-5.6-sol", "gpt-no-priority"]);
  });

  it("skips entries with a missing or non-string slug", () => {
    writeCatalog({
      models: [
        { visibility: "show", priority: 1 },
        { slug: 42, priority: 2 },
        { slug: "", priority: 3 },
        { slug: "gpt-5.6-sol", priority: 4 },
      ],
    });
    expect(codexModels()).toEqual(["gpt-5.6-sol"]);
  });

  // Every failure mode below is Codex's file being absent or shaped other than
  // we expect. A stale-but-valid list beats an empty submenu, so all of them
  // land on the fallback rather than throwing or returning [].
  it("falls back when the catalog is absent (Codex installed but never run)", () => {
    expect(codexModels()).toEqual(CODEX_FALLBACK_MODELS);
  });

  it("falls back when the catalog is not valid JSON", () => {
    writeCatalog("{ not json");
    expect(codexModels()).toEqual(CODEX_FALLBACK_MODELS);
  });

  it("falls back when `models` is absent or not an array (shape drift)", () => {
    writeCatalog({ version: 3 });
    expect(codexModels()).toEqual(CODEX_FALLBACK_MODELS);
    writeCatalog({ models: { "gpt-5.6-sol": {} } });
    expect(codexModels()).toEqual(CODEX_FALLBACK_MODELS);
  });

  it("falls back when every entry is unusable, rather than returning an empty menu", () => {
    writeCatalog({ models: [{ slug: "gpt-old", visibility: "hide" }, { priority: 1 }] });
    expect(codexModels()).toEqual(CODEX_FALLBACK_MODELS);
  });

  it("falls back when the catalog is unreadable (permissions)", () => {
    writeCatalog({ models: [{ slug: "gpt-5.6-sol", priority: 1 }] });
    const spy = vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    });
    expect(codexModels()).toEqual(CODEX_FALLBACK_MODELS);
    spy.mockRestore();
  });
});

describe("CODEX_EFFORT_LEVELS", () => {
  // The two ladders overlap but are NOT interchangeable — this is the invariant
  // that makes composerEfforts branch per-harness instead of sharing one list.
  it("is a superset of the claude-code rungs, adding max and Codex's own ultra", () => {
    for (const rung of ["low", "medium", "high", "xhigh"]) {
      expect(CODEX_EFFORT_LEVELS).toContain(rung);
    }
    expect(CODEX_EFFORT_LEVELS).toContain("max");
    expect(CODEX_EFFORT_LEVELS).toContain("ultra");
  });
});

// The `garden crew` command: CRUD over stored crew definitions plus binding a
// project to one. Exercised against a real on-disk config (the same pattern as
// test/config.test.ts) so the YAML round-trip is covered too.
import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "garden-crew-cli-"));
  vi.resetModules();
  vi.stubEnv("HOME", tmpHome);
});

async function setup() {
  const { saveConfig, GARDEN_DIR, loadConfig } = await import("../src/config.js");
  const { crew } = await import("../src/commands/crew.js");
  fs.mkdirSync(GARDEN_DIR, { recursive: true });
  saveConfig({ projects: { garden: { path: "/tmp/garden" } } });
  return { crew, loadConfig };
}

describe("garden crew add/edit", () => {
  it("creates a crew carrying model and effort", async () => {
    const { crew, loadConfig } = await setup();
    await crew(["add", "heavy",
      "--worker", "claude", "--model", "opus", "--effort", "xhigh",
      "--review", "claude", "--review-model", "opus"]);
    const def = loadConfig().crews?.heavy;
    expect(def).toEqual({
      worker: { member: "claude", model: "opus", effort: "xhigh" },
      review: { member: "claude", model: "opus" },
    });
  });

  it("--from clones any crew, builtin included, then applies overrides", async () => {
    const { crew, loadConfig } = await setup();
    await crew(["add", "base", "--worker", "claude", "--model", "opus", "--review", "codex"]);
    await crew(["add", "cheap", "--from", "base", "--model", "sonnet"]);
    expect(loadConfig().crews?.cheap).toEqual({
      worker: { member: "claude", model: "sonnet" },
      review: { member: "codex" },
    });
    // Cloning a builtin is the documented way to "edit" one.
    await crew(["add", "from-builtin", "--from", "all-codex"]);
    expect(loadConfig().crews?.["from-builtin"]).toEqual({
      worker: { member: "codex" }, review: { member: "codex" },
    });
  });

  it("edit changes one dimension and leaves the rest standing", async () => {
    const { crew, loadConfig } = await setup();
    await crew(["add", "heavy", "--worker", "claude", "--model", "opus", "--effort", "xhigh", "--review", "claude"]);
    await crew(["edit", "heavy", "--model", "sonnet"]);
    expect(loadConfig().crews?.heavy).toEqual({
      worker: { member: "claude", model: "sonnet", effort: "xhigh" },
      review: { member: "claude" },
    });
  });

  it("'none' clears a pinned dimension", async () => {
    const { crew, loadConfig } = await setup();
    await crew(["add", "heavy", "--worker", "claude", "--model", "opus", "--effort", "xhigh", "--review", "claude"]);
    await crew(["edit", "heavy", "--effort", "none"]);
    expect(loadConfig().crews?.heavy.worker.effort).toBeUndefined();
    expect(loadConfig().crews?.heavy.worker.model).toBe("opus");
  });

  it("refuses to overwrite an existing crew with add, or edit a missing one", async () => {
    const { crew } = await setup();
    await crew(["add", "heavy", "--worker", "claude", "--review", "claude"]);
    await expect(crew(["add", "heavy", "--worker", "claude", "--review", "claude"]))
      .rejects.toThrow(/already exists/);
    await expect(crew(["edit", "ghost", "--model", "opus"])).rejects.toThrow(/No stored crew 'ghost'/);
  });

  it("editing a builtin materializes an override under the same name", async () => {
    // Matches the ⌥⇧C picker, which lists builtins in its edit chooser. The
    // flags express a DELTA against the generated pairing rather than
    // restating it, and `crew remove` later restores the builtin.
    const { crew, loadConfig } = await setup();
    await crew(["edit", "all-codex", "--model", "opus"]);
    expect(loadConfig().crews?.["all-codex"]).toEqual({
      worker: { member: "codex", model: "opus" },
      review: { member: "codex" },
    });
    const { getCrew } = await import("../src/dashboard/crew.js");
    expect(getCrew("all-codex", loadConfig())!.builtin).toBe(false);
  });

  it("requires both halves when not cloning", async () => {
    const { crew } = await setup();
    await expect(crew(["add", "half", "--worker", "claude"])).rejects.toThrow(/requires --worker .* and --review/);
  });

  it("rejects an unknown flag rather than silently ignoring it", async () => {
    const { crew } = await setup();
    await expect(crew(["add", "x", "--worker", "claude", "--review", "claude", "--reviewer", "codex"]))
      .rejects.toThrow(/Unknown flag: --reviewer/);
  });
});

describe("garden crew remove", () => {
  it("removes a stored crew and reports the projects that referenced it", async () => {
    const { crew, loadConfig } = await setup();
    await crew(["add", "heavy", "--worker", "claude", "--review", "claude"]);
    await crew(["apply", "heavy", "garden"]);
    const logged: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((m) => { logged.push(String(m)); });
    await crew(["remove", "heavy"]);
    spy.mockRestore();
    expect(loadConfig().crews).toBeUndefined();
    expect(logged.join("\n")).toMatch(/garden referenced it/);
  });

  it("refuses to remove a builtin", async () => {
    const { crew } = await setup();
    await expect(crew(["remove", "all-codex"])).rejects.toThrow(/builtin crew and cannot be removed/);
  });
});

describe("garden crew apply", () => {
  it("binds the project by reference rather than expanding the crew", async () => {
    const { crew, loadConfig } = await setup();
    await crew(["add", "heavy", "--worker", "claude", "--model", "opus", "--review", "codex"]);
    await crew(["apply", "heavy", "garden"]);
    const p = loadConfig().projects.garden;
    expect(p.crew).toBe("heavy");
    expect(p.model).toBeUndefined();
    expect(p.roles).toBeUndefined();
  });

  it("rejects an unknown crew with the available names", async () => {
    const { crew } = await setup();
    await expect(crew(["apply", "nope", "garden"])).rejects.toThrow(/Unknown crew 'nope'\. Available:.*all-claude/);
  });
});

describe("garden crew list/show", () => {
  it("emits JSON when piped, tagging builtin vs defined", async () => {
    const { crew } = await setup();
    await crew(["add", "heavy", "--worker", "claude", "--model", "opus", "--review", "claude"]);
    const logged: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((m) => { logged.push(String(m)); });
    await crew(["list"]);
    spy.mockRestore();
    const parsed = JSON.parse(logged[0]) as { crews: Array<{ name: string; builtin: boolean; recipe: string }> };
    const heavy = parsed.crews.find((c) => c.name === "heavy")!;
    expect(heavy.builtin).toBe(false);
    expect(heavy.recipe).toBe("claude opus → claude");
    expect(parsed.crews.find((c) => c.name === "all-codex")!.builtin).toBe(true);
  });

  it("show reports the bound projects", async () => {
    const { crew } = await setup();
    await crew(["add", "heavy", "--worker", "claude", "--review", "claude"]);
    await crew(["apply", "heavy", "garden"]);
    const logged: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((m) => { logged.push(String(m)); });
    await crew(["show", "heavy"]);
    spy.mockRestore();
    expect(JSON.parse(logged[0]).projects).toEqual(["garden"]);
  });

  it("rejects an unknown subcommand", async () => {
    const { crew } = await setup();
    await expect(crew(["frobnicate"])).rejects.toThrow(/Unknown subcommand: frobnicate/);
  });
});

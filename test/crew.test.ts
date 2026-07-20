// Crew resolution: members derived from harnesses + providers, crews as member
// pairs, the worker-only-provider safety asymmetry, and round-tripping config.
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { GardenConfig, ProjectConfig } from "../src/config.js";

// applyCrew mutates config via loadConfig/saveConfig — back them with an
// in-memory store. The pure functions (listCrews/getCrew/deriveCrew) take
// config as an argument and are unaffected.
const { store } = vi.hoisted(() => ({ store: { value: null as unknown as GardenConfig } }));
vi.mock("../src/config.js", async (orig) => {
  const actual = await orig<typeof import("../src/config.js")>();
  return {
    ...actual,
    loadConfig: () => store.value,
    saveConfig: (c: GardenConfig) => { store.value = c; },
  };
});

// header.js is heavy and tmux-bound; the picker only needs refreshDashboard
// stubbed for the pure plan builder under test.
vi.mock("../src/dashboard/header.js", () => ({ refreshDashboard: vi.fn() }));

const { listMembers, reviewerMembers, listCrews, getCrew, deriveCrew, applyCrew,
  workerMemberName, projectWorkerMemberName, builtinCrews, storedCrews,
  resolveProjectCrew, crewOverridden, clearCrew, saveCrew, deleteCrew,
  isBuiltinCrew, validateCrewDef } =
  await import("../src/dashboard/crew.js");
const { buildCrewPickerPlan, buildCrewComposerPlan, buildCrewDimSubmenuPlan, buildStoredCrewPickerPlan } =
  await import("../src/dashboard/crew-picker.js");

function cfg(extra: Partial<GardenConfig> = {}): GardenConfig {
  return { projects: {}, ...extra } as GardenConfig;
}
function withDeepseek(extra: Partial<GardenConfig> = {}): GardenConfig {
  return cfg({ providers: { deepseek: { baseUrl: "x", authTokenEnv: "DEEPSEEK_API_KEY" } }, ...extra } as GardenConfig);
}

describe("crew members and listing", () => {
  it("lists the four harness crews when no provider is configured", () => {
    const names = listCrews(cfg()).map((c) => c.name).sort();
    expect(names).toEqual(["all-claude", "all-codex", "claude-codex", "codex-claude"].sort());
  });

  it("derives a worker member per provider, but never a reviewer member", () => {
    const c = withDeepseek();
    expect(listMembers(c).map((m) => m.name)).toContain("deepseek");
    // The safety asymmetry: a provider can build, but only harnesses review.
    expect(reviewerMembers(c).map((m) => m.name)).not.toContain("deepseek");
    const names = listCrews(c).map((cr) => cr.name);
    expect(names).toContain("deepseek-claude");
    expect(names).toContain("deepseek-codex");
    expect(names.some((n) => n.endsWith("-deepseek"))).toBe(false);
  });
});

describe("deriveCrew", () => {
  const P = (o: Partial<ProjectConfig> = {}): ProjectConfig => ({ path: "/p", ...o });
  it("all-claude for a default project", () => {
    expect(deriveCrew(P(), cfg())).toBe("all-claude");
  });
  it("codex-claude for a codex worker with default review", () => {
    expect(deriveCrew(P({ harness: "codex" }), cfg())).toBe("codex-claude");
  });
  it("all-codex when codex builds and reviews", () => {
    expect(deriveCrew(
      P({ harness: "codex", roles: { reviewer: { harness: "codex" }, resolver: { harness: "codex" }, ciFix: { harness: "codex" } } }),
      cfg(),
    )).toBe("all-codex");
  });
  it("deepseek-claude for a deepseek-provider worker", () => {
    expect(deriveCrew(P({ provider: "deepseek" }), withDeepseek())).toBe("deepseek-claude");
  });
  it("null when review roles diverge (hand-tuned config)", () => {
    expect(deriveCrew(P({ roles: { reviewer: { harness: "codex" } } }), cfg())).toBeNull();
  });
});

describe("worker member name (status-pane identity badge source)", () => {
  it("maps the default/claude-code harness to 'claude'", () => {
    expect(workerMemberName(undefined, undefined)).toBe("claude");
    expect(workerMemberName("claude-code", undefined)).toBe("claude");
  });

  it("uses the harness name for a foreign harness", () => {
    expect(workerMemberName("codex", undefined)).toBe("codex");
  });

  it("applies a provider ONLY to the claude-code harness (a foreign harness ignores it)", () => {
    // claude-code against a provider IS that provider member...
    expect(workerMemberName("claude-code", "deepseek")).toBe("deepseek");
    expect(workerMemberName(undefined, "deepseek")).toBe("deepseek");
    // ...but codex doesn't run through the Anthropic env swap, so it stays codex.
    expect(workerMemberName("codex", "deepseek")).toBe("codex");
  });

  it("reports the project's default member (harness + provider)", () => {
    expect(projectWorkerMemberName({ path: "/p" })).toBe("claude");
    expect(projectWorkerMemberName({ path: "/p", harness: "codex" })).toBe("codex");
    expect(projectWorkerMemberName({ path: "/p", provider: "deepseek" })).toBe("deepseek");
  });

  it("reads the bound crew's worker half, since the binding clears the flat key", () => {
    // applyCrew records `crew: codex-claude` and deletes project.harness, so a
    // flat-key-only baseline would report "claude" and badge every one of the
    // project's own default workers as an override.
    const c = cfg();
    expect(projectWorkerMemberName({ path: "/p", crew: "codex-claude" }, c)).toBe("codex");
    // The flat key is the override layer and still wins over the crew.
    expect(projectWorkerMemberName({ path: "/p", crew: "codex-claude", harness: "claude-code" }, c)).toBe("claude");
    // A dangling binding is inert, not a crash.
    expect(projectWorkerMemberName({ path: "/p", crew: "gone" }, c)).toBe("claude");
  });
});

describe("applyCrew", () => {
  beforeEach(() => {
    store.value = { projects: { garden: { path: "/p" } }, providers: { deepseek: { baseUrl: "x", authTokenEnv: "DEEPSEEK_API_KEY" } } } as GardenConfig;
  });

  // Binding is BY REFERENCE: applyCrew records the name and clears the flat
  // keys the crew now owns, rather than expanding into them. Clearing is what
  // keeps the binding live — a stale flat key would sit in the override layer
  // and permanently shadow the crew.
  it("all-codex records the binding and clears the flat harness + provider", () => {
    store.value.projects.garden.provider = "deepseek";
    applyCrew("garden", getCrew("all-codex", store.value)!);
    const p = store.value.projects.garden;
    expect(p.crew).toBe("all-codex");
    expect(p.harness).toBeUndefined();
    expect(p.roles).toBeUndefined();
    expect(p.provider).toBeUndefined();
  });

  // Provider is the one write-through dimension: its readers sit below crew.ts
  // in the import graph and cannot consult a crew without a cycle.
  it("deepseek-claude writes provider through while binding by reference", () => {
    store.value.projects.garden.harness = "codex";
    applyCrew("garden", getCrew("deepseek-claude", store.value)!);
    const p = store.value.projects.garden;
    expect(p.crew).toBe("deepseek-claude");
    expect(p.provider).toBe("deepseek");
    expect(p.harness).toBeUndefined();
    expect(p.roles).toBeUndefined();
  });

  it("all-claude clears everything the crew manages", () => {
    store.value.projects.garden = { path: "/p", harness: "codex", provider: "deepseek", roles: { reviewer: { harness: "codex" } } } as ProjectConfig;
    applyCrew("garden", getCrew("all-claude", store.value)!);
    const p = store.value.projects.garden;
    expect(p.crew).toBe("all-claude");
    expect(p.harness).toBeUndefined();
    expect(p.provider).toBeUndefined();
    expect(p.roles).toBeUndefined();
  });

  it("preserves a per-role model when only the harness is crew-managed", () => {
    store.value.projects.garden.roles = { reviewer: { model: "opus" } };
    applyCrew("garden", getCrew("codex-claude", store.value)!);
    // codex-claude review = claude-code (default harness) -> harness cleared,
    // but the pinned model stays.
    expect(store.value.projects.garden.roles?.reviewer?.model).toBe("opus");
  });

  it("round-trips: apply then derive returns the same crew", () => {
    for (const name of ["all-codex", "codex-claude", "claude-codex", "deepseek-claude", "all-claude"]) {
      applyCrew("garden", getCrew(name, store.value)!);
      expect(deriveCrew(store.value.projects.garden, store.value)).toBe(name);
    }
  });
});

describe("stored crews", () => {
  beforeEach(() => {
    store.value = { projects: { garden: { path: "/p" } } } as GardenConfig;
  });

  it("a stored crew carries model + effort the generated names cannot express", () => {
    saveCrew("heavy", {
      worker: { member: "claude", model: "opus", effort: "xhigh" },
      review: { member: "claude", model: "opus" },
    });
    const spec = getCrew("heavy", store.value)!;
    expect(spec.builtin).toBe(false);
    expect(spec.worker.model).toBe("opus");
    expect(spec.worker.effort).toBe("xhigh");
    expect(spec.review.model).toBe("opus");
  });

  it("listCrews returns stored first, then unshadowed builtins", () => {
    saveCrew("heavy", { worker: { member: "claude" }, review: { member: "claude" } });
    const names = listCrews(store.value).map((c) => c.name);
    expect(names[0]).toBe("heavy");
    expect(names).toContain("all-codex");
  });

  it("a stored crew shadows a builtin of the same name", () => {
    saveCrew("all-claude", {
      worker: { member: "claude", model: "sonnet" },
      review: { member: "claude" },
    });
    const spec = getCrew("all-claude", store.value)!;
    expect(spec.builtin).toBe(false);
    expect(spec.worker.model).toBe("sonnet");
    expect(listCrews(store.value).filter((c) => c.name === "all-claude")).toHaveLength(1);
    expect(isBuiltinCrew("all-claude", store.value)).toBe(false);
  });

  it("rejects a provider-backed reviewer — the safety-net asymmetry", () => {
    store.value.providers = { deepseek: { baseUrl: "x", authTokenEnv: "K" } } as GardenConfig["providers"];
    expect(() => saveCrew("bad", { worker: { member: "claude" }, review: { member: "deepseek" } }))
      .toThrow(/cannot review/);
    // ...but a provider may BUILD.
    expect(() => saveCrew("ok", { worker: { member: "deepseek" }, review: { member: "claude" } }))
      .not.toThrow();
  });

  it("rejects an unknown member and a review-side effort", () => {
    expect(() => validateCrewDef({ worker: { member: "nope" }, review: { member: "claude" } }, store.value))
      .toThrow(/Unknown member 'nope'/);
    expect(() => validateCrewDef(
      { worker: { member: "claude" }, review: { member: "claude", effort: "high" } },
      store.value,
    )).toThrow(/no effort/);
  });

  it("rejects a worker effort outside the rungs, like the flat effort key does", () => {
    // Unvalidated, a typo would ride all the way to `--effort bogus` on the
    // agent launch — `garden config <p> effort` rejects the same value.
    expect(() => saveCrew("bad", { worker: { member: "claude", effort: "max" }, review: { member: "claude" } }))
      .toThrow(/effort must be one of/);
    for (const rung of ["low", "medium", "high", "xhigh", "ultra"]) {
      expect(() => validateCrewDef(
        { worker: { member: "claude", effort: rung }, review: { member: "claude" } }, store.value,
      )).not.toThrow();
    }
  });

  it("drops a crew whose member no longer resolves rather than throwing", () => {
    store.value.providers = { deepseek: { baseUrl: "x", authTokenEnv: "K" } } as GardenConfig["providers"];
    saveCrew("cheap", { worker: { member: "deepseek" }, review: { member: "claude" } });
    expect(getCrew("cheap", store.value)).not.toBeNull();
    delete store.value.providers;
    expect(getCrew("cheap", store.value)).toBeNull();
    expect(storedCrews(store.value)).toHaveLength(0);
  });

  it("builtins never carry model or effort", () => {
    for (const c of builtinCrews(store.value)) {
      expect(c.worker.model).toBeUndefined();
      expect(c.worker.effort).toBeUndefined();
      expect(c.review.model).toBeUndefined();
      expect(c.builtin).toBe(true);
    }
  });

  it("deleting a crew reports its bound projects and leaves the reference inert", () => {
    saveCrew("heavy", { worker: { member: "claude" }, review: { member: "claude" } });
    applyCrew("garden", getCrew("heavy", store.value)!);
    expect(deleteCrew("heavy")).toEqual(["garden"]);
    // Dangling reference: resolution skips the crew layer rather than breaking.
    expect(store.value.projects.garden.crew).toBe("heavy");
    expect(resolveProjectCrew(store.value.projects.garden, store.value)).toBeNull();
    expect(deriveCrew(store.value.projects.garden, store.value)).toBeNull();
  });
});

describe("crew binding by reference", () => {
  beforeEach(() => {
    store.value = { projects: { garden: { path: "/p" } } } as GardenConfig;
    saveCrew("heavy", {
      worker: { member: "claude", model: "opus", effort: "xhigh" },
      review: { member: "claude", model: "opus" },
    });
  });

  it("editing a crew re-targets a bound project with no re-apply", () => {
    applyCrew("garden", getCrew("heavy", store.value)!);
    expect(resolveProjectCrew(store.value.projects.garden, store.value)!.worker.model).toBe("opus");
    saveCrew("heavy", { worker: { member: "claude", model: "sonnet" }, review: { member: "claude" } });
    expect(resolveProjectCrew(store.value.projects.garden, store.value)!.worker.model).toBe("sonnet");
  });

  it("applying a crew clears the flat keys it owns so they cannot shadow it", () => {
    store.value.projects.garden.model = "haiku";
    store.value.projects.garden.effort = "low";
    applyCrew("garden", getCrew("heavy", store.value)!);
    const p = store.value.projects.garden;
    expect(p.model).toBeUndefined();
    expect(p.effort).toBeUndefined();
    expect(crewOverridden(p, store.value)).toBe(false);
  });

  it("leaves a flat key the crew does not set, and flags a later override", () => {
    saveCrew("harness-only", { worker: { member: "claude" }, review: { member: "claude" } });
    store.value.projects.garden.model = "haiku";
    applyCrew("garden", getCrew("harness-only", store.value)!);
    // The crew asks no model question, so the project's answer stands.
    expect(store.value.projects.garden.model).toBe("haiku");
    expect(crewOverridden(store.value.projects.garden, store.value)).toBe(false);

    applyCrew("garden", getCrew("heavy", store.value)!);
    store.value.projects.garden.model = "haiku";
    expect(crewOverridden(store.value.projects.garden, store.value)).toBe(true);
  });

  it("clearCrew unbinds without touching the remaining keys", () => {
    applyCrew("garden", getCrew("heavy", store.value)!);
    store.value.projects.garden.checks = "npm test";
    clearCrew("garden");
    expect(store.value.projects.garden.crew).toBeUndefined();
    expect(store.value.projects.garden.checks).toBe("npm test");
  });

  it("deriveCrew prefers the binding but still reads legacy flat keys", () => {
    expect(deriveCrew({ path: "/p", crew: "heavy" } as ProjectConfig, store.value)).toBe("heavy");
    // A config written before crews were stored spells out its harness only:
    // a codex worker whose review roles are still the default claude-code.
    expect(deriveCrew({ path: "/p", harness: "codex" } as ProjectConfig, store.value)).toBe("codex-claude");
  });
});

describe("buildCrewPickerPlan", () => {
  it("renders one menu item per crew, marks the current, and dispatches _crew-set", () => {
    const crews = listCrews(withDeepseek());
    // A realistic runner (node + cli.js) — its first token is what tmux would
    // reject if the command were not run-shell wrapped.
    const plan = buildCrewPickerPlan("garden", "all-claude", crews, "/opt/homebrew/bin/node /g/dist/cli.js");
    expect(plan.title).toContain("garden");
    expect(plan.title).toContain("all-claude");
    // One row per crew, then a separator and the management rows.
    expect(plan.items.filter((i) => !i.sep && i.command.includes("_crew-set"))).toHaveLength(crews.length);
    expect(plan.items[0].key).toBe("1");
    expect(plan.items.find((i) => i.label.startsWith("all-claude"))?.label).toContain("✓");
    expect(plan.items[0].command).toContain("dashboard _crew-set");
    expect(plan.items.some((i) => i.command.includes("deepseek-claude"))).toBe(true);
  });

  it("offers new/edit/delete even with no stored crew, so an empty state cannot read as a missing feature", () => {
    // Regression: these were gated on a stored crew existing. With none, the
    // menu showed a lone "new crew…" and looked half-shipped — indistinguishable
    // from the feature not being there. The empty case is answered by a message
    // in runStoredCrewPicker, not by hiding the affordance.
    const runner = "/n /cli.js";
    const builtinOnly = buildCrewPickerPlan("garden", null, listCrews(cfg()), runner);
    const labels = (p: typeof builtinOnly) => p.items.map((i) => i.label);
    expect(labels(builtinOnly)).toContain("new crew…");
    expect(labels(builtinOnly)).toContain("edit crew…");
    expect(labels(builtinOnly)).toContain("delete crew…");

    const withStored = buildCrewPickerPlan("garden", null, [
      { name: "heavy", worker: { name: "claude", harness: "claude-code", model: "opus" }, review: { name: "claude", harness: "claude-code" }, builtin: false },
      ...listCrews(cfg()),
    ], runner);
    expect(labels(withStored)).toContain("edit crew…");
    expect(labels(withStored)).toContain("delete crew…");
    // A stored crew shows its recipe; a builtin's name already IS its recipe.
    expect(labels(withStored).find((l) => l.startsWith("heavy"))).toContain("claude opus → claude");
    expect(labels(withStored).find((l) => l.startsWith("all-codex"))).toBe("all-codex");
    // Exactly one rule divides the pick list from the management rows — the
    // runner must map `sep` rows through, or each becomes three blank items.
    expect(withStored.items.filter((i) => i.sep)).toHaveLength(1);
  });

  it("run-shell wraps every item command so tmux dispatches it (not parses it as a tmux command)", () => {
    // The bug that shipped: a bare `<node> <cli.js> …` menu command makes tmux
    // display-menu fail with "unknown command: <node>" and the crew never
    // changes. Every selectable item must be `run-shell "<cmd>"`.
    const crews = listCrews(withDeepseek());
    const plan = buildCrewPickerPlan("garden", "all-claude", crews, "/opt/homebrew/bin/node /g/dist/cli.js");
    for (const item of plan.items.filter((i) => !i.sep)) {
      expect(item.command.startsWith("run-shell ")).toBe(true);
      // The bare runner path must NOT be the first token of the tmux command.
      expect(item.command.startsWith("/opt/homebrew/bin/node")).toBe(false);
    }
  });
});

describe("crew composer plans", () => {
  const runner = "/n /cli.js";

  it("reads the recipe back in the title and offers every dimension", () => {
    const plan = buildCrewComposerPlan("garden", {
      worker: "claude", workerModel: "opus", workerEffort: "xhigh", review: "codex",
    }, runner);
    expect(plan.title).toBe("New crew (claude opus/xhigh → codex)");
    const labels = plan.items.map((i) => i.label);
    expect(labels).toContain("worker: claude");
    expect(labels).toContain("model: opus");
    expect(labels).toContain("effort: xhigh");
    expect(labels).toContain("reviewer: codex");
    expect(labels).toContain("review-model: (safe default)");
  });

  it("withholds save until both halves are named", () => {
    const partial = buildCrewComposerPlan("garden", { worker: "claude" }, runner);
    expect(partial.items.some((i) => i.label.startsWith("save"))).toBe(false);
    const complete = buildCrewComposerPlan("garden", { worker: "claude", review: "claude" }, runner);
    expect(complete.items.some((i) => i.label === "save as…")).toBe(true);
  });

  it("gives every row a distinct quick-key (tmux binds only the first duplicate)", () => {
    // `reviewer` and `review-model` both start with `r`, so a key derived from
    // the field name leaves one row unreachable.
    const plan = buildCrewComposerPlan("garden", { editing: "heavy", worker: "claude", review: "claude" }, runner);
    const keys = plan.items.filter((i) => !i.sep).map((i) => i.key);
    expect(keys.every(Boolean)).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("prompts for a name when creating, but saves straight to the name when editing", () => {
    const creating = buildCrewComposerPlan("garden", { worker: "claude", review: "claude" }, runner);
    const save = creating.items.find((i) => i.label === "save as…")!;
    // command-prompt is already a tmux command — it must NOT be run-shell wrapped
    // at the top level (the inner dispatch is).
    expect(save.command.startsWith("command-prompt ")).toBe(true);
    expect(save.command).toContain("_crew-save");

    const editing = buildCrewComposerPlan("garden", { editing: "heavy", worker: "claude", review: "claude" }, runner);
    expect(editing.title).toContain("Edit crew 'heavy'");
    const editSave = editing.items.find((i) => i.label === "save 'heavy'")!;
    expect(editSave.command.startsWith("run-shell ")).toBe(true);
    expect(editSave.command).toContain("heavy");
  });

  it("a dimension submenu offers a clear row only for optional dimensions", () => {
    const optional = buildCrewDimSubmenuPlan("garden", "model", ["opus"], "opus", "inherit", runner);
    expect(optional.items.some((i) => i.sep)).toBe(true);
    expect(optional.items.at(-1)!.label).toBe("inherit");
    expect(optional.items.at(-1)!.command).toContain("_crew-dim-set");
    expect(optional.items[0].label).toContain("✓");

    const required = buildCrewDimSubmenuPlan("garden", "worker", ["claude"], undefined, null, runner);
    expect(required.items.some((i) => i.sep)).toBe(false);
  });

  it("the stored-crew chooser lists only stored crews and targets the action", () => {
    const crews = [
      { name: "heavy", worker: { name: "claude", harness: "claude-code" }, review: { name: "claude", harness: "claude-code" }, builtin: false },
      ...listCrews(cfg()),
    ];
    const plan = buildStoredCrewPickerPlan("garden", "delete", crews, runner);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].command).toContain("_crew-delete");
    expect(plan.items[0].command).toContain("heavy");
  });
});

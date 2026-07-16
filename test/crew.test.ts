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
  workerMemberName, projectWorkerMemberName } =
  await import("../src/dashboard/crew.js");
const { buildCrewPickerPlan } = await import("../src/dashboard/crew-picker.js");

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
});

describe("applyCrew", () => {
  beforeEach(() => {
    store.value = { projects: { garden: { path: "/p" } }, providers: { deepseek: { baseUrl: "x", authTokenEnv: "DEEPSEEK_API_KEY" } } } as GardenConfig;
  });

  it("all-codex sets worker + review harness to codex and clears provider", () => {
    store.value.projects.garden.provider = "deepseek";
    applyCrew("garden", getCrew("all-codex", store.value)!);
    const p = store.value.projects.garden;
    expect(p.harness).toBe("codex");
    expect(p.roles?.reviewer?.harness).toBe("codex");
    expect(p.roles?.resolver?.harness).toBe("codex");
    expect(p.roles?.ciFix?.harness).toBe("codex");
    expect(p.provider).toBeUndefined();
  });

  it("deepseek-claude sets provider, leaves worker harness default, clears review", () => {
    store.value.projects.garden.harness = "codex";
    applyCrew("garden", getCrew("deepseek-claude", store.value)!);
    const p = store.value.projects.garden;
    expect(p.provider).toBe("deepseek");
    expect(p.harness).toBeUndefined();
    expect(p.roles).toBeUndefined();
  });

  it("all-claude clears everything the crew manages", () => {
    store.value.projects.garden = { path: "/p", harness: "codex", provider: "deepseek", roles: { reviewer: { harness: "codex" } } } as ProjectConfig;
    applyCrew("garden", getCrew("all-claude", store.value)!);
    const p = store.value.projects.garden;
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

describe("buildCrewPickerPlan", () => {
  it("renders one menu item per crew, marks the current, and dispatches _crew-set", () => {
    const crews = listCrews(withDeepseek());
    // A realistic runner (node + cli.js) — its first token is what tmux would
    // reject if the command were not run-shell wrapped.
    const plan = buildCrewPickerPlan("garden", "all-claude", crews, "/opt/homebrew/bin/node /g/dist/cli.js");
    expect(plan.title).toContain("garden");
    expect(plan.title).toContain("all-claude");
    expect(plan.items).toHaveLength(crews.length);
    expect(plan.items[0].key).toBe("1");
    expect(plan.items.find((i) => i.label.startsWith("all-claude"))?.label).toContain("✓");
    expect(plan.items[0].command).toContain("dashboard _crew-set");
    expect(plan.items.some((i) => i.command.includes("deepseek-claude"))).toBe(true);
  });

  it("run-shell wraps every item command so tmux dispatches it (not parses it as a tmux command)", () => {
    // The bug that shipped: a bare `<node> <cli.js> …` menu command makes tmux
    // display-menu fail with "unknown command: <node>" and the crew never
    // changes. Every item must be `run-shell "<cmd>"`.
    const crews = listCrews(withDeepseek());
    const plan = buildCrewPickerPlan("garden", "all-claude", crews, "/opt/homebrew/bin/node /g/dist/cli.js");
    for (const item of plan.items) {
      expect(item.command.startsWith("run-shell ")).toBe(true);
      // The bare runner path must NOT be the first token of the tmux command.
      expect(item.command.startsWith("/opt/homebrew/bin/node")).toBe(false);
    }
  });
});

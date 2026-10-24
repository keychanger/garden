// Per-role review resolution (docs/MULTI-MODEL.md "Phase 4"). Each review
// role independently resolves {harness, model, env}; the default is always a
// strong first-party Anthropic reviewer, and Codex-as-reviewer is selected by
// a per-role harness override without disturbing the other roles.
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { ProjectConfig, GardenConfig } from "../src/config.js";
import { useTmpHome } from "./helpers.js";

vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../src/dashboard/tmux.js", () => ({
  shellEscape: vi.fn((s: string) =>
    /^[a-zA-Z0-9_./:=-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`),
  pasteAndSubmit: vi.fn(),
}));

beforeEach(() => vi.clearAllMocks());

async function importRoles() {
  return await import("../src/dashboard/roles.js");
}

function project(partial: Partial<ProjectConfig> = {}): ProjectConfig {
  return { path: "/tmp/proj", ...partial };
}

describe("resolveReviewRole", () => {
  it("defaults every review role to claude-code + Opus", async () => {
    const { resolveReviewRole } = await importRoles();
    for (const role of ["reviewer", "resolver", "ciFix"] as const) {
      const r = resolveReviewRole(project(), "default", role);
      expect(r.harness).toBe("claude-code");
      expect(r.model).toBe("opus");
    }
  });

  it("routes a review role to Codex with its own auth and harness defaults", async () => {
    const { resolveReviewRole } = await importRoles();
    const r = resolveReviewRole(
      project({ roles: { reviewer: { harness: "codex" } } }), "default", "reviewer");
    expect(r.harness).toBe("codex");
    expect(r.model).toBe("gpt-6-astra");
    expect(r.effort).toBe("high");
    // Codex authenticates itself; it never gets the Anthropic env prefix.
    expect(r.envPrefix).toBe("");
  });

  it("honors an explicit model on a Codex review role", async () => {
    const { resolveReviewRole } = await importRoles();
    const r = resolveReviewRole(
      project({ roles: { reviewer: { harness: "codex", model: "gpt-5-codex" } } }), "default", "reviewer");
    expect(r.harness).toBe("codex");
    expect(r.model).toBe("gpt-5-codex");
  });

  it("lets an explicit per-role model override the safe default", async () => {
    const { resolveReviewRole } = await importRoles();
    const r = resolveReviewRole(
      project({ roles: { resolver: { model: "sonnet" } } }), "default", "resolver");
    expect(r.harness).toBe("claude-code");
    expect(r.model).toBe("sonnet");
  });

  // No shipped workflow pins a reviewer model, so these register one that does.
  // It pins "sonnet", which the Opus safety-net default cannot be mistaken for.
  async function pinnedReviewerWorkflow(): Promise<string> {
    const { registerWorkflow, defaultWorkflow } = await import("../src/dashboard/workflows/index.js");
    registerWorkflow({ ...defaultWorkflow, name: "pinned-reviewer", reviewerModel: "sonnet" });
    return "pinned-reviewer";
  }

  it("an explicit reviewer model beats the workflow's reviewerModel", async () => {
    const { resolveReviewRole } = await importRoles();
    const r = resolveReviewRole(
      project({ roles: { reviewer: { model: "haiku" } } }), await pinnedReviewerWorkflow(), "reviewer");
    expect(r.model).toBe("haiku");
  });

  it("still applies the workflow's reviewerModel on the claude-code path", async () => {
    const { resolveReviewRole } = await importRoles();
    const r = resolveReviewRole(project(), await pinnedReviewerWorkflow(), "reviewer");
    expect(r.harness).toBe("claude-code");
    expect(r.model).toBe("sonnet");
  });

  it("uses Codex defaults instead of leaking the workflow's reviewerModel", async () => {
    const { resolveReviewRole } = await importRoles();
    // The workflow model is an Anthropic alias, meaningless to Codex; the Codex
    // harness applies its own model and effort defaults instead.
    const r = resolveReviewRole(
      project({ roles: { reviewer: { harness: "codex" } } }), await pinnedReviewerWorkflow(), "reviewer");
    expect(r.harness).toBe("codex");
    expect(r.model).toBe("gpt-6-astra");
    expect(r.effort).toBe("high");
  });

  it("keeps role knobs independent — a Codex reviewer does not move the resolver", async () => {
    const { resolveReviewRole } = await importRoles();
    const p = project({ roles: { reviewer: { harness: "codex" } } });
    expect(resolveReviewRole(p, "default", "reviewer").harness).toBe("codex");
    // resolver reads only its own slot -> untouched safe default.
    const resolver = resolveReviewRole(p, "default", "resolver");
    expect(resolver.harness).toBe("claude-code");
    expect(resolver.model).toBe("opus");
  });

  it("neutralizes inherited provider env for a claude-code reviewer on a provider project", async () => {
    const { resolveReviewRole } = await importRoles();
    const p = project({ provider: "deepseek" });
    const config = {
      projects: { proj: p },
      providers: {
        deepseek: { baseUrl: "https://api.deepseek.com/anthropic", authTokenEnv: "DEEPSEEK_API_KEY" },
      },
    } as unknown as Parameters<typeof resolveReviewRole>[3];
    const r = resolveReviewRole(p, "default", "reviewer", config);
    expect(r.harness).toBe("claude-code");
    expect(r.envPrefix).toContain("ANTHROPIC_BASE_URL=''");
  });

  it("a Codex reviewer ignores the project provider entirely (empty env)", async () => {
    const { resolveReviewRole } = await importRoles();
    const p = project({ provider: "deepseek", roles: { reviewer: { harness: "codex" } } });
    const config = {
      projects: { proj: p },
      providers: {
        deepseek: { baseUrl: "https://api.deepseek.com/anthropic", authTokenEnv: "DEEPSEEK_API_KEY" },
      },
    } as unknown as Parameters<typeof resolveReviewRole>[3];
    const r = resolveReviewRole(p, "default", "reviewer", config);
    expect(r.envPrefix).toBe("");
  });

  // DESIGN.md accepts the member name `claude` wherever a harness is entered.
  // The CLI canonicalizes on set, but a hand-edited config.yml reaches here raw.
  it("keeps the Opus floor and the profile env for a role spelled harness: claude", async () => {
    const { resolveReviewRole } = await importRoles();
    const config = {
      projects: {},
      claudeProfiles: { imp: { configDir: "/tmp/claude-imp" } },
    } as unknown as GardenConfig;
    const canonical = resolveReviewRole(
      project({ claudeProfile: "imp", roles: { reviewer: { harness: "claude-code" } } }), "default", "reviewer", config);
    const alias = resolveReviewRole(
      project({ claudeProfile: "imp", roles: { reviewer: { harness: "claude" } } }), "default", "reviewer", config);
    expect(alias.harness).toBe("claude-code");
    expect(alias.model).toBe("opus");
    expect(alias.envPrefix).toBe("CLAUDE_CONFIG_DIR=/tmp/claude-imp ");
    expect(alias).toEqual(canonical);
  });

  it("neutralizes a provider's env for a role spelled harness: claude", async () => {
    const { resolveReviewRole } = await importRoles();
    const p = project({ provider: "deepseek", roles: { reviewer: { harness: "claude" } } });
    const config = {
      projects: { proj: p },
      providers: {
        deepseek: { baseUrl: "https://api.deepseek.com/anthropic", authTokenEnv: "DEEPSEEK_API_KEY" },
      },
    } as unknown as GardenConfig;
    expect(resolveReviewRole(p, "default", "reviewer", config).envPrefix).toContain("ANTHROPIC_BASE_URL=''");
  });

  // Per-worker crew (entry.crew) — the live-changeable review dimension.
  const emptyConfig = { projects: {} } as GardenConfig;

  it("a per-worker crew flips every review role's harness", async () => {
    const { resolveReviewRole } = await importRoles();
    for (const role of ["reviewer", "resolver", "ciFix"] as const) {
      const r = resolveReviewRole(project(), "default", role, emptyConfig, { crew: "all-codex" });
      expect(r.harness).toBe("codex");
    }
  });

  it("entry.crew wins over a conflicting project.roles harness (layered ahead)", async () => {
    const { resolveReviewRole } = await importRoles();
    const r = resolveReviewRole(
      project({ roles: { reviewer: { harness: "claude-code" } } }),
      "default", "reviewer", emptyConfig, { crew: "all-codex" });
    expect(r.harness).toBe("codex");
  });

  it("an all-claude crew reviews on claude-code with the ladder's strong model", async () => {
    const { resolveReviewRole } = await importRoles();
    const r = resolveReviewRole(project(), "default", "reviewer", emptyConfig, { crew: "all-claude" });
    expect(r.harness).toBe("claude-code");
    expect(r.model).toBe("fable");
  });

  it("is byte-identical to before when entry / entry.crew is unset (backward compat)", async () => {
    const { resolveReviewRole } = await importRoles();
    const without = resolveReviewRole(project(), "default", "reviewer", emptyConfig);
    const withEmpty = resolveReviewRole(project(), "default", "reviewer", emptyConfig, {});
    expect(withEmpty).toEqual(without);
    expect(without.harness).toBe("claude-code");
  });

  it("a non-existent crew falls through to the project/default harness (fail-safe)", async () => {
    const { resolveReviewRole } = await importRoles();
    const r = resolveReviewRole(project(), "default", "reviewer", emptyConfig, { crew: "no-such-crew" });
    expect(r.harness).toBe("claude-code");
  });

  // The project's bound crew (project.crew), resolved by reference. It sits
  // BELOW an explicit project.roles key and below a per-worker crew.
  const withCrews = (crews: GardenConfig["crews"]): GardenConfig =>
    ({ projects: {}, crews } as GardenConfig);

  it("a project's bound crew supplies the review harness and model", async () => {
    const { resolveReviewRole } = await importRoles();
    const config = withCrews({ heavy: { worker: { member: "claude" }, review: { member: "codex", model: "gpt-5" } } });
    for (const role of ["reviewer", "resolver", "ciFix"] as const) {
      const r = resolveReviewRole(project({ crew: "heavy" }), "default", role, config);
      expect(r.harness).toBe("codex");
      expect(r.model).toBe("gpt-5");
    }
  });

  it("an explicit project.roles key overrides the project's crew", async () => {
    const { resolveReviewRole } = await importRoles();
    const config = withCrews({ heavy: { worker: { member: "claude" }, review: { member: "codex" } } });
    const r = resolveReviewRole(
      project({ crew: "heavy", roles: { reviewer: { harness: "claude-code" } } }),
      "default", "reviewer", config);
    expect(r.harness).toBe("claude-code");
    // Only the reviewer was overridden; the other roles still follow the crew.
    expect(resolveReviewRole(project({ crew: "heavy" }), "default", "resolver", config).harness).toBe("codex");
  });

  it("a per-worker crew outranks the project's crew", async () => {
    const { resolveReviewRole } = await importRoles();
    const config = withCrews({ heavy: { worker: { member: "claude" }, review: { member: "codex" } } });
    const r = resolveReviewRole(project({ crew: "heavy" }), "default", "reviewer", config, { crew: "all-claude" });
    expect(r.harness).toBe("claude-code");
  });

  it("a crew review model reaches a foreign harness that would otherwise go unpinned", async () => {
    const { resolveReviewRole } = await importRoles();
    const unpinned = resolveReviewRole(project({ crew: "c" }), "default", "reviewer",
      withCrews({ c: { worker: { member: "claude" }, review: { member: "codex" } } }));
    expect(unpinned.model).toBe("gpt-6-astra");
    const pinned = resolveReviewRole(project({ crew: "c" }), "default", "reviewer",
      withCrews({ c: { worker: { member: "claude" }, review: { member: "codex", model: "gpt-5" } } }));
    expect(pinned.model).toBe("gpt-5");
  });

  // Effort: same resolution chain as model, but with no default floor and
  // claude-code only.
  it("resolves review effort from the crew, and lets an explicit role key override it", async () => {
    const { resolveReviewRole } = await importRoles();
    const config = withCrews({ thorough: { worker: { member: "claude" }, review: { member: "claude", effort: "max" } } });
    expect(resolveReviewRole(project({ crew: "thorough" }), "default", "reviewer", config).effort).toBe("max");
    expect(resolveReviewRole(
      project({ crew: "thorough", roles: { reviewer: { effort: "low" } } }),
      "default", "reviewer", config).effort).toBe("low");
    // A per-worker crew outranks both, like every other dimension.
    const perWorker = withCrews({
      thorough: { worker: { member: "claude" }, review: { member: "claude", effort: "max" } },
      quick: { worker: { member: "claude" }, review: { member: "claude", effort: "low" } },
    });
    expect(resolveReviewRole(
      project({ crew: "thorough" }), "default", "reviewer", perWorker, { crew: "quick" }).effort).toBe("low");
  });

  it("leaves effort unset by default — there is no floor, unlike the model", async () => {
    const { resolveReviewRole } = await importRoles();
    const r = resolveReviewRole(project(), "default", "reviewer", emptyConfig);
    // The model DOES have a floor (SAFE_REVIEW_MODEL, the safety net); effort
    // deliberately does not, since unset means "account default" — exactly the
    // behavior every review had before this dial existed.
    expect(r.model).toBe("opus");
    expect(r.effort).toBeUndefined();
  });

  it("passes an explicit review effort to Codex above its harness default", async () => {
    const { resolveReviewRole } = await importRoles();
    const config = withCrews({ c: { worker: { member: "claude" }, review: { member: "codex", effort: "max" } } });
    const r = resolveReviewRole(project({ crew: "c" }), "default", "reviewer", config);
    expect(r.harness).toBe("codex");
    expect(r.effort).toBe("max");
  });

  it("a bound crew that no longer exists falls back to the safe default", async () => {
    const { resolveReviewRole } = await importRoles();
    const r = resolveReviewRole(project({ crew: "deleted" }), "default", "reviewer", emptyConfig);
    expect(r.harness).toBe("claude-code");
    expect(r.model).toBe("opus");
  });

  // A layer's model and effort name things in its own harness's vocabulary,
  // so they apply only while that layer's harness is the one reviewing. The
  // builtin crews always pin a review model, so every crew-bound project hits
  // this the moment the documented per-role harness override is used.
  it("does not hand a Claude crew's review model to a Codex role override", async () => {
    const { resolveReviewRole } = await importRoles();
    const r = resolveReviewRole(
      project({ crew: "all-claude", roles: { reviewer: { harness: "codex" } } }),
      "default", "reviewer", emptyConfig);
    expect(r.harness).toBe("codex");
    expect(r.model).toBe("gpt-6-astra");
  });

  it("does not hand a Codex crew's review model to a claude-code role override", async () => {
    const { resolveReviewRole } = await importRoles();
    const r = resolveReviewRole(
      project({ crew: "claude-codex", roles: { reviewer: { harness: "claude-code" } } }),
      "default", "reviewer", emptyConfig);
    expect(r.harness).toBe("claude-code");
    expect(r.model).toBe("opus");
  });

  it("keeps a crew's review effort to its own harness, in both directions", async () => {
    const { resolveReviewRole } = await importRoles();
    const config = withCrews({
      thorough: { worker: { member: "claude" }, review: { member: "claude", effort: "max" } },
      quick: { worker: { member: "claude" }, review: { member: "codex", effort: "low" } },
    });
    const toCodex = resolveReviewRole(
      project({ crew: "thorough", roles: { reviewer: { harness: "codex" } } }), "default", "reviewer", config);
    expect(toCodex.harness).toBe("codex");
    expect(toCodex.effort).toBe("high");
    const toClaude = resolveReviewRole(
      project({ crew: "quick", roles: { reviewer: { harness: "claude-code" } } }), "default", "reviewer", config);
    expect(toClaude.harness).toBe("claude-code");
    expect(toClaude.effort).toBeUndefined();
    // The crew's own harness still gets its effort.
    expect(resolveReviewRole(project({ crew: "thorough" }), "default", "reviewer", config).effort).toBe("max");
  });

  it("does not hand a role's model or effort to a per-worker crew on another harness", async () => {
    const { resolveReviewRole } = await importRoles();
    // A stored crew that names no review model, so nothing above the role
    // layer pins one.
    const config = withCrews({ swap: { worker: { member: "claude" }, review: { member: "codex" } } });
    for (const roles of [
      { reviewer: { harness: "claude-code", model: "sonnet", effort: "max" } },
      // No role harness: the model was set for the harness inherited from below.
      { reviewer: { model: "sonnet", effort: "max" } },
    ]) {
      const r = resolveReviewRole(project({ roles }), "default", "reviewer", config, { crew: "swap" });
      expect(r.harness).toBe("codex");
      expect(r.model).toBe("gpt-6-astra");
      expect(r.effort).toBe("high");
    }
  });

  it("applies a role's model and effort set for the harness it overrides to", async () => {
    const { resolveReviewRole } = await importRoles();
    const r = resolveReviewRole(
      project({ crew: "all-claude", roles: { reviewer: { harness: "codex", model: "gpt-5", effort: "max" } } }),
      "default", "reviewer", emptyConfig);
    expect(r).toMatchObject({ harness: "codex", model: "gpt-5", effort: "max" });
    // With no role harness, the role tunes the crew's own reviewer.
    const inherited = resolveReviewRole(
      project({ crew: "claude-codex", roles: { reviewer: { model: "gpt-5" } } }),
      "default", "reviewer", emptyConfig);
    expect(inherited).toMatchObject({ harness: "codex", model: "gpt-5" });
  });

  it("compares layer harnesses by registry name, so the member name still matches its crew", async () => {
    const { resolveReviewRole } = await importRoles();
    const r = resolveReviewRole(
      project({ crew: "all-claude", roles: { reviewer: { harness: "claude" } } }),
      "default", "reviewer", emptyConfig);
    expect(r).toMatchObject({ harness: "claude-code", model: "fable" });
  });
});

// When to read config.yml at all. The crew-free chain consults nothing from
// the file, so it must not require an initialized garden — reading it there is
// what made every roles case fail on a bare CI runner while passing on the
// operator's workstation. A crew name is the one thing that does need the file,
// and a caller that passes no config must still resolve it from disk.
describe("resolveReviewRole config reads", () => {
  const tmp = useTmpHome();

  it("resolves without an initialized garden when no crew is involved", async () => {
    vi.resetModules();
    const { resolveReviewRole } = await importRoles();
    fs.rmSync(path.join(tmp.gardenDir, "config.yml"), { force: true });
    const r = resolveReviewRole(project(), "default", "reviewer");
    expect(r.harness).toBe("claude-code");
    expect(r.model).toBe("opus");
  });

  it("loads the on-disk config to resolve a bound crew when none is passed", async () => {
    fs.writeFileSync(
      path.join(tmp.gardenDir, "config.yml"),
      "projects: {}\ncrews:\n  heavy:\n    worker:\n      member: claude\n    review:\n      member: codex\n",
    );
    vi.resetModules();
    const { resolveReviewRole } = await importRoles();
    const r = resolveReviewRole(project({ crew: "heavy" }), "default", "reviewer");
    expect(r.harness).toBe("codex");
  });
});

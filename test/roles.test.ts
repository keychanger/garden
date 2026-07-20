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

  it("routes a review role to Codex with its own auth (no Anthropic env, no forced Opus)", async () => {
    const { resolveReviewRole } = await importRoles();
    const r = resolveReviewRole(
      project({ roles: { reviewer: { harness: "codex" } } }), "default", "reviewer");
    expect(r.harness).toBe("codex");
    // No SAFE_REVIEW_MODEL on a foreign harness — Codex uses its own default.
    expect(r.model).toBeUndefined();
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

  it("an explicit reviewer model beats the workflow's reviewerModel", async () => {
    const { resolveReviewRole } = await importRoles();
    // trellis pins reviewerModel=opus; an explicit override wins over it.
    const r = resolveReviewRole(
      project({ roles: { reviewer: { model: "haiku" } } }), "trellis", "reviewer");
    expect(r.model).toBe("haiku");
  });

  it("still applies the workflow's reviewerModel on the claude-code path", async () => {
    const { resolveReviewRole } = await importRoles();
    // trellis pins reviewerModel=opus; a default (unpinned) claude-code reviewer
    // on a trellis worker inherits it.
    const r = resolveReviewRole(project(), "trellis", "reviewer");
    expect(r.harness).toBe("claude-code");
    expect(r.model).toBe("opus");
  });

  it("does not leak the workflow's reviewerModel to an unpinned Codex reviewer", async () => {
    const { resolveReviewRole } = await importRoles();
    // trellis pins reviewerModel=opus, an Anthropic alias meaningless to Codex.
    // An unpinned Codex reviewer must get NO model so codex uses its own default
    // — the workflow model is a claude-code-only term.
    const r = resolveReviewRole(
      project({ roles: { reviewer: { harness: "codex" } } }), "trellis", "reviewer");
    expect(r.harness).toBe("codex");
    expect(r.model).toBeUndefined();
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

  it("an all-claude crew keeps the default claude-code reviewer", async () => {
    const { resolveReviewRole } = await importRoles();
    const r = resolveReviewRole(project(), "default", "reviewer", emptyConfig, { crew: "all-claude" });
    expect(r.harness).toBe("claude-code");
    expect(r.model).toBe("opus");
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
    expect(unpinned.model).toBeUndefined();
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

  it("never sends effort to a foreign harness, which has no --effort to render", async () => {
    const { resolveReviewRole } = await importRoles();
    const config = withCrews({ c: { worker: { member: "claude" }, review: { member: "codex", effort: "max" } } });
    const r = resolveReviewRole(project({ crew: "c" }), "default", "reviewer", config);
    expect(r.harness).toBe("codex");
    expect(r.effort).toBeUndefined();
  });

  it("a bound crew that no longer exists falls back to the safe default", async () => {
    const { resolveReviewRole } = await importRoles();
    const r = resolveReviewRole(project({ crew: "deleted" }), "default", "reviewer", emptyConfig);
    expect(r.harness).toBe("claude-code");
    expect(r.model).toBe("opus");
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

// Per-role review resolution (docs/MULTI-MODEL.md "Phase 4"). Each review
// role independently resolves {harness, model, env}; the default is always a
// strong first-party Anthropic reviewer, and Codex-as-reviewer is selected by
// a per-role harness override without disturbing the other roles.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProjectConfig } from "../src/config.js";

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
});

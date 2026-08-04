import { describe, expect, it } from "vitest";
import type { GardenConfig, ProjectConfig } from "../src/config.js";
import {
  resolveHeadlessLaunchPlan,
  resolveWorkerLaunchPlan,
} from "../src/dashboard/launch-plan.js";

const DEEPSEEK = {
  baseUrl: "https://api.deepseek.com/anthropic",
  authTokenEnv: "DEEPSEEK_API_KEY",
  modelMap: { opus: "deepseek-reasoner" },
};

const config: GardenConfig = {
  projects: {},
  providers: { deepseek: DEEPSEEK },
};

function project(partial: Partial<ProjectConfig> = {}): ProjectConfig {
  return { path: "/repo/garden", ...partial };
}

describe("resolveWorkerLaunchPlan", () => {
  it("binds backend, credential reference, tuning, policy, and requirements together", () => {
    const plan = resolveWorkerLaunchPlan({
      project: project({ provider: "deepseek" }),
      harness: "claude-code",
      workflow: "default",
      resume: true,
      model: "opus",
      effort: "xhigh",
    }, config);

    expect(plan).toMatchObject({
      role: "worker",
      harness: "claude-code",
      backend: {
        kind: "anthropic-compatible",
        provider: "deepseek",
        baseUrl: DEEPSEEK.baseUrl,
      },
      credential: {
        kind: "tmux-hidden-environment",
        sourceEnvironment: "DEEPSEEK_API_KEY",
      },
      model: "opus",
      effort: "xhigh",
      executionPolicy: "sandboxed-worker",
      requiredCapabilities: {
        turnEnd: true,
        sandbox: true,
        workflow: "default",
        resume: true,
        providerProfiles: true,
      },
    });
    expect(plan.credential.kind === "tmux-hidden-environment"
      ? plan.credential.variable
      : "").toMatch(/^GARDEN_PROVIDER_TOKEN_[A-F0-9]{16}$/);
    expect(plan.envPrefix).toContain("ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic");
    expect(plan.envPrefix).not.toContain("DEEPSEEK_API_KEY");
  });

  it("represents a harness-owned account without inventing a provider credential", () => {
    const plan = resolveWorkerLaunchPlan({
      project: project(), harness: "codex", workflow: "default", resume: false,
    }, config);
    expect(plan.backend).toEqual({ kind: "harness-account" });
    expect(plan.credential).toEqual({ kind: "harness-account" });
    expect(plan.envPrefix).toBe("");
  });

  it("fails closed on unknown providers, harnesses, and incompatible pairs", () => {
    expect(() => resolveWorkerLaunchPlan({
      project: project({ provider: "missing" }), workflow: "default", resume: false,
    }, config)).toThrow("unknown provider 'missing'");
    expect(() => resolveWorkerLaunchPlan({
      project: project(), harness: "missing", workflow: "default", resume: false,
    }, config)).toThrow("Unknown harness 'missing'");
    expect(() => resolveWorkerLaunchPlan({
      project: project({ provider: "deepseek" }),
      harness: "codex",
      workflow: "default",
      resume: false,
    }, config)).toThrow("does not support provider profiles");
  });

  it("preserves the explicit-first-party provider override", () => {
    const plan = resolveWorkerLaunchPlan({
      project: project({ provider: "deepseek" }),
      provider: "",
      workflow: "default",
      resume: false,
    }, config);
    expect(plan.backend).toEqual({ kind: "harness-account" });
    expect(plan.runtimeProject.provider).toBeUndefined();
  });
});

describe("resolveHeadlessLaunchPlan", () => {
  it("makes the trusted review policy and role capability explicit", () => {
    const plan = resolveHeadlessLaunchPlan({
      role: "reviewer",
      harness: "codex",
      model: "gpt-5.6-sol",
      envPrefix: "",
    });
    expect(plan).toEqual({
      role: "reviewer",
      harness: "codex",
      backend: { kind: "harness-account" },
      credential: { kind: "harness-account" },
      model: "gpt-5.6-sol",
      effort: undefined,
      envPrefix: "",
      executionPolicy: "trusted-headless",
      requiredCapabilities: { headlessRole: "reviewer" },
    });
  });

  it("rejects an unknown review harness instead of falling back", () => {
    expect(() => resolveHeadlessLaunchPlan({
      role: "resolver", harness: "missing", envPrefix: "",
    })).toThrow("Unknown harness 'missing'");
  });
});

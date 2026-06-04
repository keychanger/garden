// Provider layer (docs/MULTI-MODEL.md "Layer 1"): config schema + validation,
// worker env injection, sandbox egress union, command surface, usage gating.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

let tmpHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "garden-provider-test-"));
  originalHome = process.env.HOME;
  process.env.HOME = tmpHome;
});

afterEach(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.resetModules();
  vi.restoreAllMocks();
});

async function setup() {
  const config = await import("../src/config.js");
  fs.mkdirSync(config.GARDEN_DIR, { recursive: true });
  fs.mkdirSync(config.SESSIONS_DIR, { recursive: true });
  return config;
}

const DEEPSEEK = {
  baseUrl: "https://api.deepseek.com/anthropic",
  authTokenEnv: "DEEPSEEK_API_KEY",
  modelMap: { opus: "deepseek-v4-pro", sonnet: "deepseek-v4-flash" },
  egressHosts: ["cdn.deepseek.com"],
};

describe("assertValidProvider", () => {
  it("accepts a valid provider", async () => {
    const { assertValidProvider } = await setup();
    expect(() => assertValidProvider("deepseek", DEEPSEEK)).not.toThrow();
  });

  it("rejects an invalid name", async () => {
    const { assertValidProvider } = await setup();
    expect(() => assertValidProvider("bad name!", DEEPSEEK)).toThrow("Provider name");
  });

  it("rejects an unparseable baseUrl", async () => {
    const { assertValidProvider } = await setup();
    expect(() => assertValidProvider("p", { ...DEEPSEEK, baseUrl: "not a url" }))
      .toThrow("not a valid URL");
  });

  it("rejects a non-http(s) baseUrl", async () => {
    const { assertValidProvider } = await setup();
    expect(() => assertValidProvider("p", { ...DEEPSEEK, baseUrl: "ftp://x.com" }))
      .toThrow("must be http(s)");
  });

  it("rejects an authTokenEnv that is not an env var name", async () => {
    const { assertValidProvider } = await setup();
    // The env var name is interpolated unquoted into launch commands as
    // "$NAME" — this regex is the injection guard, so it must be strict.
    expect(() => assertValidProvider("p", { ...DEEPSEEK, authTokenEnv: "x; rm -rf /" }))
      .toThrow("authTokenEnv");
    expect(() => assertValidProvider("p", { ...DEEPSEEK, authTokenEnv: "lower_case" }))
      .toThrow("authTokenEnv");
  });

  it("rejects unknown modelMap aliases", async () => {
    const { assertValidProvider } = await setup();
    expect(() => assertValidProvider("p", { ...DEEPSEEK, modelMap: { turbo: "x" } as never }))
      .toThrow("unknown modelMap alias 'turbo'");
  });

  it("rejects egressHosts entries that are not bare hostnames", async () => {
    const { assertValidProvider } = await setup();
    expect(() => assertValidProvider("p", { ...DEEPSEEK, egressHosts: ["https://x.com"] }))
      .toThrow("bare hostnames");
    expect(() => assertValidProvider("p", { ...DEEPSEEK, egressHosts: ["a b.com"] }))
      .toThrow("bare hostnames");
    expect(() => assertValidProvider("p", { ...DEEPSEEK, egressHosts: [""] }))
      .toThrow("bare hostnames");
  });
});

describe("resolveProvider / tryResolveProvider", () => {
  it("returns null when the project has no provider", async () => {
    const config = await setup();
    config.saveConfig({ projects: {} });
    expect(config.resolveProvider({})).toBeNull();
  });

  it("throws on an unknown provider name", async () => {
    const config = await setup();
    config.saveConfig({ projects: {} });
    expect(() => config.resolveProvider({ provider: "ghost" }))
      .toThrow("unknown provider 'ghost'");
  });

  it("resolves with the name as default label", async () => {
    const config = await setup();
    config.saveConfig({ projects: {}, providers: { deepseek: DEEPSEEK } });
    const resolved = config.resolveProvider({ provider: "deepseek" });
    expect(resolved).toMatchObject({ name: "deepseek", label: "deepseek", baseUrl: DEEPSEEK.baseUrl });
  });

  it("re-validates hand-edited config entries at resolve time", async () => {
    const config = await setup();
    // Bypass the CLI validation by writing the config directly — the resolve
    // path must still refuse a malformed authTokenEnv before it reaches a
    // shell interpolation site.
    config.saveConfig({
      projects: {},
      providers: { evil: { baseUrl: "https://x.com", authTokenEnv: "$(boom)" } },
    });
    expect(() => config.resolveProvider({ provider: "evil" })).toThrow("authTokenEnv");
    expect(config.tryResolveProvider({ provider: "evil" })).toBeNull();
  });
});

describe("anyAnthropicMeteredProject", () => {
  it("is true with zero projects (fresh install defaults to Anthropic)", async () => {
    const config = await setup();
    config.saveConfig({ projects: {} });
    expect(config.anyAnthropicMeteredProject()).toBe(true);
  });

  it("is true when any project lacks a provider", async () => {
    const config = await setup();
    config.saveConfig({
      projects: { a: { path: "/a", provider: "deepseek" }, b: { path: "/b" } },
      providers: { deepseek: DEEPSEEK },
    });
    expect(config.anyAnthropicMeteredProject()).toBe(true);
  });

  it("is false when every project uses a provider", async () => {
    const config = await setup();
    config.saveConfig({
      projects: { a: { path: "/a", provider: "deepseek" } },
      providers: { deepseek: DEEPSEEK },
    });
    expect(config.anyAnthropicMeteredProject()).toBe(false);
  });
});

describe("providerEnvPrefix / workerEnvPrefix", () => {
  it("emits base URL, unexpanded token reference, and model map", async () => {
    const config = await setup();
    config.saveConfig({ projects: {}, providers: { deepseek: DEEPSEEK } });
    const { providerEnvPrefix } = await import("../src/dashboard/claude-env.js");
    const prefix = providerEnvPrefix(config.resolveProvider({ provider: "deepseek" })!);
    expect(prefix).toContain("ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic ");
    // The token is a "$VAR" reference expanded by the pane shell at spawn
    // time — the key value must never be inlined.
    expect(prefix).toContain('ANTHROPIC_AUTH_TOKEN="$DEEPSEEK_API_KEY"');
    expect(prefix).toContain("ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek-v4-pro");
    expect(prefix).toContain("ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-v4-flash");
    expect(prefix).not.toContain("ANTHROPIC_DEFAULT_HAIKU_MODEL");
    expect(prefix.endsWith(" ")).toBe(true);
  });

  it("routes workers to the provider env when configured", async () => {
    const config = await setup();
    config.saveConfig({
      projects: { a: { path: "/a", provider: "deepseek" } },
      providers: { deepseek: DEEPSEEK },
    });
    const { workerEnvPrefix } = await import("../src/dashboard/claude-env.js");
    expect(workerEnvPrefix(config.getProject("a"))).toContain("ANTHROPIC_BASE_URL=");
  });

  it("falls back to the claudeProfile env without a provider", async () => {
    const config = await setup();
    config.saveConfig({
      projects: { a: { path: "/a", claudeProfile: "work" } },
      claudeProfiles: { work: { configDir: "~/.claude-work" } },
    });
    const { workerEnvPrefix } = await import("../src/dashboard/claude-env.js");
    const prefix = workerEnvPrefix(config.getProject("a"));
    expect(prefix).toContain("CLAUDE_CONFIG_DIR=");
    expect(prefix).not.toContain("ANTHROPIC_BASE_URL");
  });

  it("falls back to the first-party path on a broken provider reference", async () => {
    const config = await setup();
    config.saveConfig({ projects: { a: { path: "/a", provider: "ghost" } } });
    const { workerEnvPrefix } = await import("../src/dashboard/claude-env.js");
    expect(workerEnvPrefix(config.getProject("a"))).toBe("");
  });
});

describe("buildSandboxConfig provider egress", () => {
  it("adds the baseUrl host and declared extras, keeping Anthropic domains", async () => {
    const config = await setup();
    config.saveConfig({
      projects: { a: { path: "/a", provider: "deepseek" } },
      providers: { deepseek: DEEPSEEK },
    });
    const { buildSandboxConfig } = await import("../src/dashboard/sandbox.js");
    const sandbox = buildSandboxConfig({
      worktreePath: "/wt", project: config.getProject("a"), remoteHost: null,
    });
    expect(sandbox.network.allowedDomains).toContain("api.deepseek.com");
    expect(sandbox.network.allowedDomains).toContain("cdn.deepseek.com");
    // The reviewer/resolver/ci-fix run on the Anthropic path in the same
    // worktree — its domains stay even for provider-backed projects.
    expect(sandbox.network.allowedDomains).toContain("api.anthropic.com");
  });

  it("is unchanged for projects without a provider", async () => {
    const config = await setup();
    config.saveConfig({ projects: { a: { path: "/a" } } });
    const { buildSandboxConfig } = await import("../src/dashboard/sandbox.js");
    const sandbox = buildSandboxConfig({
      worktreePath: "/wt", project: config.getProject("a"), remoteHost: null,
    });
    expect(sandbox.network.allowedDomains).not.toContain("api.deepseek.com");
  });
});

describe("garden provider command", () => {
  it("add persists a validated provider", async () => {
    const config = await setup();
    config.saveConfig({ projects: {} });
    const { provider } = await import("../src/commands/provider.js");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await provider([
      "add", "deepseek",
      "--base-url", "https://api.deepseek.com/anthropic",
      "--token-env", "DEEPSEEK_API_KEY",
      "--map", "opus=deepseek-v4-pro,sonnet=deepseek-v4-flash",
      "--egress", "cdn.deepseek.com",
    ]);
    logSpy.mockRestore();
    const cfg = config.loadConfig();
    expect(cfg.providers?.deepseek).toEqual({
      baseUrl: "https://api.deepseek.com/anthropic",
      authTokenEnv: "DEEPSEEK_API_KEY",
      modelMap: { opus: "deepseek-v4-pro", sonnet: "deepseek-v4-flash" },
      egressHosts: ["cdn.deepseek.com"],
    });
  });

  it("add rejects missing required flags", async () => {
    const config = await setup();
    config.saveConfig({ projects: {} });
    const { provider } = await import("../src/commands/provider.js");
    await expect(provider(["add", "p"])).rejects.toThrow("Usage: garden provider add");
  });

  it("add rejects an invalid token env var", async () => {
    const config = await setup();
    config.saveConfig({ projects: {} });
    const { provider } = await import("../src/commands/provider.js");
    await expect(provider([
      "add", "p", "--base-url", "https://x.com", "--token-env", "bad-name",
    ])).rejects.toThrow("authTokenEnv");
  });

  it("add rejects duplicates", async () => {
    const config = await setup();
    config.saveConfig({ projects: {}, providers: { deepseek: DEEPSEEK } });
    const { provider } = await import("../src/commands/provider.js");
    await expect(provider([
      "add", "deepseek", "--base-url", "https://x.com", "--token-env", "X",
    ])).rejects.toThrow("already exists");
  });

  it("remove refuses while projects reference the provider", async () => {
    const config = await setup();
    config.saveConfig({
      projects: { a: { path: "/a", provider: "deepseek" } },
      providers: { deepseek: DEEPSEEK },
    });
    const { provider } = await import("../src/commands/provider.js");
    await expect(provider(["remove", "deepseek"])).rejects.toThrow("still used by: a");
  });

  it("remove deletes an unreferenced provider", async () => {
    const config = await setup();
    config.saveConfig({ projects: {}, providers: { deepseek: DEEPSEEK } });
    const { provider } = await import("../src/commands/provider.js");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await provider(["remove", "deepseek"]);
    logSpy.mockRestore();
    expect(config.loadConfig().providers?.deepseek).toBeUndefined();
  });
});

describe("garden config provider key", () => {
  it("rejects an unregistered provider name", async () => {
    const config = await setup();
    config.saveConfig({ projects: { a: { path: "/a" } } });
    const { config: configCmd } = await import("../src/commands/config.js");
    await expect(configCmd(["a", "provider", "ghost"])).rejects.toThrow("Unknown provider 'ghost'");
  });

  it("sets and clears the provider key", async () => {
    const config = await setup();
    config.saveConfig({
      projects: { a: { path: "/a" } },
      providers: { deepseek: DEEPSEEK },
    });
    const { config: configCmd } = await import("../src/commands/config.js");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await configCmd(["a", "provider", "deepseek"]);
    expect(config.loadConfig().projects.a.provider).toBe("deepseek");
    await configCmd(["a", "provider", "unset"]);
    expect(config.loadConfig().projects.a.provider).toBeUndefined();
    logSpy.mockRestore();
  });
});

describe("usage meter gating", () => {
  it("renderUsagePane explains the off state for provider-only fleets", async () => {
    const config = await setup();
    config.saveConfig({
      projects: { a: { path: "/a", provider: "deepseek" } },
      providers: { deepseek: DEEPSEEK },
    });
    const { renderUsagePane } = await import("../src/dashboard/usage.js");
    expect(renderUsagePane()).toContain("off — every project uses a provider");
  });

  it("renderUsagePane keeps the meter when any project is Anthropic-metered", async () => {
    const config = await setup();
    config.saveConfig({
      projects: { a: { path: "/a", provider: "deepseek" }, b: { path: "/b" } },
      providers: { deepseek: DEEPSEEK },
    });
    const { renderUsagePane } = await import("../src/dashboard/usage.js");
    expect(renderUsagePane()).toContain("loading…");
  });
});

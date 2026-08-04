// Provider surfaces that touch the Keychain, tmux, or the live dashboard
// session: login guidance, auth status rows, token sync, usage-poller gate.
// Mocked separately from provider.test.ts so no test can reach the
// operator's real Keychain or running tmux server.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("../src/session.js", () => ({
  DASHBOARD_SESSION: "garden",
  dashboardExists: vi.fn(() => false),
}));

vi.mock("../src/dashboard/credentials.js", () => ({
  readKeychainCredential: vi.fn(() => null),
  readPersonalCredential: vi.fn(() => null),
  readFileCredential: vi.fn(() => null),
  captureKeychainTo: vi.fn(() => false),
  runClaudeLogin: vi.fn(),
}));

vi.mock("../src/dashboard/header.js", () => ({
  refreshDashboard: vi.fn(),
}));

vi.mock("../src/dashboard/tmux.js", () => ({
  tmux: vi.fn(),
  tmuxWithHiddenEnvironment: vi.fn(),
  newDashboardWindow: vi.fn(),
  tmuxOutput: vi.fn(() => ""),
  windowExists: vi.fn(() => false),
  killWindowSafe: vi.fn(),
  // Mirror the real shellEscape: safe tokens pass through unquoted.
  shellEscape: vi.fn((s: string) =>
    /^[a-zA-Z0-9_./:=-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`,
  ),
}));

let tmpHome: string;
let originalHome: string | undefined;
const TOKEN_ENV = "GARDEN_TEST_PROVIDER_KEY";

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "garden-provider-auth-test-"));
  originalHome = process.env.HOME;
  process.env.HOME = tmpHome;
  delete process.env[TOKEN_ENV];
});

afterEach(() => {
  process.env.HOME = originalHome;
  delete process.env[TOKEN_ENV];
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.resetModules();
  vi.clearAllMocks();
});

async function setup() {
  const config = await import("../src/config.js");
  fs.mkdirSync(config.GARDEN_DIR, { recursive: true });
  fs.mkdirSync(config.SESSIONS_DIR, { recursive: true });
  return config;
}

const PROVIDER = {
  baseUrl: "https://api.deepseek.com/anthropic",
  authTokenEnv: TOKEN_ENV,
};

describe("garden login <provider>", () => {
  it("prints API-key guidance instead of a login flow", async () => {
    const config = await setup();
    config.saveConfig({ projects: {}, providers: { deepseek: PROVIDER } });
    const { login } = await import("../src/commands/login.js");
    const lines: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((l) => { lines.push(String(l)); });
    await login(["deepseek"]);
    logSpy.mockRestore();
    expect(lines.join("\n")).toContain("is a provider (API-key auth)");
    expect(lines.join("\n")).toContain(TOKEN_ENV);
    const { runClaudeLogin } = await import("../src/dashboard/credentials.js");
    expect(runClaudeLogin).not.toHaveBeenCalled();
  });

  it("still rejects names that are neither profile nor provider", async () => {
    const config = await setup();
    config.saveConfig({ projects: {} });
    const { login } = await import("../src/commands/login.js");
    await expect(login(["ghost"])).rejects.toThrow("Unknown profile: ghost");
  });
});

describe("garden auth status provider rows", () => {
  it("reports shell and session presence in the JSON output", async () => {
    const config = await setup();
    config.saveConfig({ projects: {}, providers: { deepseek: PROVIDER } });
    process.env[TOKEN_ENV] = "sk-test";
    const { auth } = await import("../src/commands/auth.js");
    const lines: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((l) => { lines.push(String(l)); });
    await auth(["status"]);
    logSpy.mockRestore();
    const parsed = JSON.parse(lines.join("\n"));
    // No dashboard running in this test (dashboardExists mocked false), so
    // session presence is unknowable: null, not false.
    expect(parsed.providers.deepseek).toEqual({
      authTokenEnv: TOKEN_ENV, shell: true, session: null,
    });
  });

  it("reports an unset token env var", async () => {
    const config = await setup();
    config.saveConfig({ projects: {}, providers: { deepseek: PROVIDER } });
    const { auth } = await import("../src/commands/auth.js");
    const lines: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((l) => { lines.push(String(l)); });
    await auth(["status"]);
    logSpy.mockRestore();
    const parsed = JSON.parse(lines.join("\n"));
    expect(parsed.providers.deepseek.shell).toBe(false);
  });
});

describe("provider token sync", () => {
  it("builds blank new-session overrides so the first dashboard pane inherits no provider token", async () => {
    const config = await setup();
    const gardenConfig = {
      projects: {},
      providers: {
        deepseek: PROVIDER,
        shared: { ...PROVIDER, authTokenEnv: TOKEN_ENV },
        ollama: { ...PROVIDER, authTokenEnv: "OLLAMA_API_KEY" },
      },
    };
    const { providerSessionSanitizerArgs } = await import("../src/dashboard/claude-env.js");

    expect(providerSessionSanitizerArgs(gardenConfig)).toEqual([
      "-e", `${TOKEN_ENV}=`,
      "-e", "OLLAMA_API_KEY=",
    ]);
    expect(providerSessionSanitizerArgs(gardenConfig).join(" ")).not.toContain("sk-");
    expect(config.ENV_VAR_NAME_RE.test(TOKEN_ENV)).toBe(true);
  });

  it("rejects invalid provider source variables before building new-session arguments", async () => {
    const config = await setup();
    const { providerSessionSanitizerArgs } = await import("../src/dashboard/claude-env.js");

    expect(() => providerSessionSanitizerArgs({
      projects: {},
      providers: {
        broken: { baseUrl: "https://example.com", authTokenEnv: "HOME" },
      },
    })).toThrow(/process-critical env var 'HOME'/);
  });

  it("stores the key as hidden tmux state and removes the legacy inherited variable", async () => {
    const config = await setup();
    config.saveConfig({ projects: {}, providers: { deepseek: PROVIDER } });
    process.env[TOKEN_ENV] = "sk-test";
    const { dashboardExists } = await import("../src/session.js");
    vi.mocked(dashboardExists).mockReturnValue(true);
    const { tmux } = await import("../src/dashboard/tmux.js");
    const { providerTokenVaultEnv, syncProviderTokenToVault } = await import("../src/dashboard/claude-env.js");
    syncProviderTokenToVault(config.resolveProvider({ provider: "deepseek" })!);
    const vaultEnv = providerTokenVaultEnv(config.resolveProvider({ provider: "deepseek" })!);
    expect(tmux).toHaveBeenCalledWith(
      "set-environment", "-h", "-t", "garden", vaultEnv, "sk-test",
      ";", "set-environment", "-r", "-t", "garden", TOKEN_ENV,
    );
  });

  it("does nothing without the key or without a dashboard", async () => {
    const config = await setup();
    config.saveConfig({ projects: {}, providers: { deepseek: PROVIDER } });
    const { tmux } = await import("../src/dashboard/tmux.js");
    const { syncProviderTokenToVault } = await import("../src/dashboard/claude-env.js");
    syncProviderTokenToVault(config.resolveProvider({ provider: "deepseek" })!);
    expect(tmux).not.toHaveBeenCalled();
  });

  it("migrates a legacy inherited session token into the hidden vault", async () => {
    const config = await setup();
    config.saveConfig({ projects: {}, providers: { deepseek: PROVIDER } });
    const { dashboardExists } = await import("../src/session.js");
    vi.mocked(dashboardExists).mockReturnValue(true);
    const { tmux, tmuxOutput } = await import("../src/dashboard/tmux.js");
    vi.mocked(tmuxOutput).mockReturnValue(`${TOKEN_ENV}=legacy-token`);
    const { providerTokenVaultEnv, syncProviderTokenToVault } = await import("../src/dashboard/claude-env.js");
    const provider = config.resolveProvider({ provider: "deepseek" })!;

    syncProviderTokenToVault(provider);

    expect(tmux).toHaveBeenCalledWith(
      "set-environment", "-h", "-t", "garden",
      providerTokenVaultEnv(provider), "legacy-token",
      ";", "set-environment", "-r", "-t", "garden", TOKEN_ENV,
    );
  });

  it("migrates every configured provider before cleaning a shared legacy source", async () => {
    const config = await setup();
    config.saveConfig({
      projects: {},
      providers: {
        deepseek: PROVIDER,
        gateway: { ...PROVIDER, baseUrl: "https://gateway.example.com" },
      },
    });
    const { dashboardExists } = await import("../src/session.js");
    vi.mocked(dashboardExists).mockReturnValue(true);
    const { tmux, tmuxOutput } = await import("../src/dashboard/tmux.js");
    vi.mocked(tmuxOutput).mockReturnValue(`${TOKEN_ENV}=legacy-token`);
    const {
      providerTokenVaultEnv,
      syncAllProviderTokenVaults,
    } = await import("../src/dashboard/claude-env.js");
    const gardenConfig = config.loadConfig();

    syncAllProviderTokenVaults(gardenConfig);

    const resolved = ["deepseek", "gateway"]
      .map(provider => config.resolveProvider({ provider }, gardenConfig)!);
    for (const provider of resolved) {
      expect(tmux).toHaveBeenCalledWith(
        "set-environment", "-h", "-t", "garden",
        providerTokenVaultEnv(provider), "legacy-token",
        ";", "set-environment", "-r", "-t", "garden", TOKEN_ENV,
      );
    }
    expect(tmuxOutput).toHaveBeenCalledTimes(1);
  });

  it("checks hidden vault presence without reading the legacy variable", async () => {
    const config = await setup();
    config.saveConfig({ projects: {}, providers: { deepseek: PROVIDER } });
    const { dashboardExists } = await import("../src/session.js");
    vi.mocked(dashboardExists).mockReturnValue(true);
    const { tmuxOutput } = await import("../src/dashboard/tmux.js");
    const { providerTokenPresence, providerTokenVaultEnv } = await import("../src/dashboard/claude-env.js");
    const provider = config.resolveProvider({ provider: "deepseek" })!;
    const vaultEnv = providerTokenVaultEnv(provider);
    vi.mocked(tmuxOutput).mockReturnValue(`${vaultEnv}=stored-token`);

    expect(providerTokenPresence(provider).session).toBe(true);
    expect(tmuxOutput).toHaveBeenCalledWith(
      "show-environment", "-h", "-t", "garden", vaultEnv,
    );
    expect(vi.mocked(tmuxOutput).mock.calls.flat()).not.toContain(TOKEN_ENV);
  });

  it("removes the hidden value when its provider is deleted", async () => {
    const config = await setup();
    config.saveConfig({ projects: {}, providers: { deepseek: PROVIDER } });
    const { dashboardExists } = await import("../src/session.js");
    vi.mocked(dashboardExists).mockReturnValue(true);
    const { tmux } = await import("../src/dashboard/tmux.js");
    const { clearProviderTokenVault, providerTokenVaultEnv } = await import("../src/dashboard/claude-env.js");
    const provider = config.resolveProvider({ provider: "deepseek" })!;

    clearProviderTokenVault(provider);

    expect(tmux).toHaveBeenCalledWith(
      "set-environment", "-u", "-t", "garden", providerTokenVaultEnv(provider),
    );
  });

  it("scopes the hidden token to one worker tmux command", async () => {
    const config = await setup();
    config.saveConfig({
      projects: { garden: { path: "/repo", provider: "deepseek" } },
      providers: { deepseek: PROVIDER },
    });
    process.env[TOKEN_ENV] = "sk-test";
    const { dashboardExists } = await import("../src/session.js");
    vi.mocked(dashboardExists).mockReturnValue(true);
    const { tmuxOutput, tmuxWithHiddenEnvironment } = await import("../src/dashboard/tmux.js");
    const { providerTokenVaultEnv, tmuxWorkerCommand } = await import("../src/dashboard/claude-env.js");
    const { resolveWorkerLaunchPlan } = await import("../src/dashboard/launch-plan.js");
    const provider = config.resolveProvider({ provider: "deepseek" })!;
    const vaultEnv = providerTokenVaultEnv(provider);
    vi.mocked(tmuxOutput).mockReturnValue(`${vaultEnv}=sk-test`);

    const plan = resolveWorkerLaunchPlan({
      project: config.getProject("garden"), workflow: "default", resume: false,
    });
    tmuxWorkerCommand(plan, "respawn-pane", "-k", "-t", "%7");

    expect(tmuxWithHiddenEnvironment).toHaveBeenCalledWith(
      vaultEnv,
      "respawn-pane", "-k", "-t", "%7",
    );
  });

  it("reuses an existing hidden token without an extra tmux write", async () => {
    const config = await setup();
    config.saveConfig({
      projects: { garden: { path: "/repo", provider: "deepseek" } },
      providers: { deepseek: PROVIDER },
    });
    const { dashboardExists } = await import("../src/session.js");
    vi.mocked(dashboardExists).mockReturnValue(true);
    const { tmux, tmuxOutput, tmuxWithHiddenEnvironment } = await import("../src/dashboard/tmux.js");
    const { providerTokenVaultEnv, tmuxWorkerCommand } = await import("../src/dashboard/claude-env.js");
    const { resolveWorkerLaunchPlan } = await import("../src/dashboard/launch-plan.js");
    const provider = config.resolveProvider({ provider: "deepseek" })!;
    const vaultEnv = providerTokenVaultEnv(provider);
    vi.mocked(tmuxOutput).mockReturnValue(`${vaultEnv}=stored-token`);

    const plan = resolveWorkerLaunchPlan({
      project: config.getProject("garden"), workflow: "default", resume: false,
    });
    tmuxWorkerCommand(plan, "respawn-pane", "-k", "-t", "%7");

    expect(tmux).not.toHaveBeenCalled();
    expect(tmuxOutput).toHaveBeenCalledTimes(1);
    expect(tmuxWithHiddenEnvironment).toHaveBeenCalledWith(
      vaultEnv, "respawn-pane", "-k", "-t", "%7",
    );
  });

  it("refuses a provider launch when neither shell nor vault has a token", async () => {
    const config = await setup();
    config.saveConfig({
      projects: { garden: { path: "/repo", provider: "deepseek" } },
      providers: { deepseek: PROVIDER },
    });
    const { dashboardExists } = await import("../src/session.js");
    vi.mocked(dashboardExists).mockReturnValue(true);
    const { tmuxOutput, tmuxWithHiddenEnvironment } = await import("../src/dashboard/tmux.js");
    vi.mocked(tmuxOutput).mockReturnValue("");
    const { tmuxWorkerCommand } = await import("../src/dashboard/claude-env.js");
    const { resolveWorkerLaunchPlan } = await import("../src/dashboard/launch-plan.js");
    const plan = resolveWorkerLaunchPlan({
      project: config.getProject("garden"), workflow: "default", resume: false,
    });

    expect(() => tmuxWorkerCommand(
      plan, "respawn-pane", "-k", "-t", "%7",
    )).toThrow(`requires $${TOKEN_ENV}`);
    expect(tmuxWithHiddenEnvironment).not.toHaveBeenCalled();
  });

  it("keeps non-provider tmux commands on the ordinary path", async () => {
    const { tmux, tmuxWithHiddenEnvironment } = await import("../src/dashboard/tmux.js");
    const { tmuxWorkerCommand } = await import("../src/dashboard/claude-env.js");
    const { resolveWorkerLaunchPlan } = await import("../src/dashboard/launch-plan.js");
    const plan = resolveWorkerLaunchPlan({
      project: { path: "/repo" }, workflow: "default", resume: false,
    });

    tmuxWorkerCommand(plan, "respawn-pane", "-k", "-t", "%7");

    expect(tmux).toHaveBeenCalledWith("respawn-pane", "-k", "-t", "%7");
    expect(tmuxWithHiddenEnvironment).not.toHaveBeenCalled();
  });
});

describe("reviewerEnvPrefix neutralization", () => {
  it("empties inherited provider env for provider-backed projects", async () => {
    const config = await setup();
    config.saveConfig({
      projects: { a: { path: "/a", provider: "deepseek" } },
      providers: { deepseek: PROVIDER },
    });
    const { reviewerEnvPrefix } = await import("../src/dashboard/claude-env.js");
    const prefix = reviewerEnvPrefix(config.getProject("a"));
    expect(prefix).toContain("ANTHROPIC_BASE_URL=''");
    expect(prefix).toContain("ANTHROPIC_AUTH_TOKEN=''");
    expect(prefix).toContain("ANTHROPIC_DEFAULT_OPUS_MODEL=''");
  });

  it("leaves non-provider projects untouched", async () => {
    const config = await setup();
    config.saveConfig({ projects: { a: { path: "/a" } } });
    const { reviewerEnvPrefix } = await import("../src/dashboard/claude-env.js");
    expect(reviewerEnvPrefix(config.getProject("a"))).toBe("");
  });
});

describe("startUsagePoller provider gate", () => {
  it("does not spawn the poller window for a provider-only fleet", async () => {
    const config = await setup();
    config.saveConfig({
      projects: { a: { path: "/a", provider: "deepseek" } },
      providers: { deepseek: PROVIDER },
    });
    const { tmux } = await import("../src/dashboard/tmux.js");
    const { startUsagePoller } = await import("../src/dashboard/usage-poller.js");
    startUsagePoller("garden");
    expect(tmux).not.toHaveBeenCalled();
  });

  it("spawns the poller window when any project is Anthropic-metered", async () => {
    const config = await setup();
    config.saveConfig({
      projects: { a: { path: "/a", provider: "deepseek" }, b: { path: "/b" } },
      providers: { deepseek: PROVIDER },
    });
    const { newDashboardWindow } = await import("../src/dashboard/tmux.js");
    const { startUsagePoller } = await import("../src/dashboard/usage-poller.js");
    startUsagePoller("garden");
    expect(newDashboardWindow).toHaveBeenCalledWith(
      expect.any(String),
      "bash", "-c", expect.stringContaining("_usage-poll-loop"),
    );
  });
});

describe("providerEnvPrefix injection guard", () => {
  it("throws on a hand-built ResolvedProvider with an invalid env var name", async () => {
    await setup();
    const { providerEnvPrefix } = await import("../src/dashboard/claude-env.js");
    expect(() => providerEnvPrefix({
      name: "evil", label: "evil",
      baseUrl: "https://x.com", authTokenEnv: "$(boom)",
    })).toThrow("not a valid env var name");
  });
});

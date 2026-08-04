import {
  resolveProvider,
  type GardenConfig,
  type ProjectConfig,
} from "../config.js";
import {
  claudeEnvPrefix,
  providerEnvPrefix,
  providerTokenVaultEnv,
} from "./claude-env.js";
import {
  DEFAULT_HARNESS,
  canonicalHarnessName,
  getHarnessCore,
  harnessNames,
  isRegisteredHarness,
  workerLaunchCompatibilityError,
} from "./harness/core.js";
import type {
  HeadlessLaunchPlan,
  HeadlessRole,
  WorkerLaunchPlan,
} from "./harness/types.js";

export interface WorkerLaunchPlanInput {
  project: ProjectConfig;
  /** Undefined inherits project.provider; empty string explicitly clears it. */
  provider?: string;
  harness?: string;
  workflow: string;
  resume: boolean;
  model?: string;
  ultracode?: boolean;
  effort?: string;
}

export function workerProject<T extends { provider?: string }>(
  project: T,
  provider: string | undefined,
): T {
  if (provider === undefined) return project;
  return { ...project, provider: provider || undefined };
}

function strictHarness(name?: string): string {
  const harness = canonicalHarnessName(name ?? DEFAULT_HARNESS);
  if (!isRegisteredHarness(harness)) {
    throw new Error(`Unknown harness '${harness}'. Known: ${harnessNames().join(", ")}.`);
  }
  return harness;
}

export function resolveWorkerLaunchPlan(
  input: WorkerLaunchPlanInput,
  config?: GardenConfig,
): WorkerLaunchPlan {
  const harness = strictHarness(input.harness);
  const core = getHarnessCore(harness);
  const runtimeProject = workerProject(input.project, input.provider);
  // resolveProvider is intentionally strict: a present-but-unknown backend is
  // a configuration error, never permission to change vendor/account.
  const resolvedProvider = resolveProvider(runtimeProject, config);
  const compatibilityError = workerLaunchCompatibilityError(core, {
    workflow: input.workflow,
    provider: resolvedProvider?.name ?? null,
    resume: input.resume,
  });
  if (compatibilityError) throw new Error(compatibilityError);

  const backend = resolvedProvider
    ? {
        kind: "anthropic-compatible" as const,
        provider: resolvedProvider.name,
        baseUrl: resolvedProvider.baseUrl,
      }
    : { kind: "harness-account" as const };
  const credential = resolvedProvider
    ? {
        kind: "tmux-hidden-environment" as const,
        variable: providerTokenVaultEnv(resolvedProvider),
        sourceEnvironment: resolvedProvider.authTokenEnv,
      }
    : { kind: "harness-account" as const };
  const envPrefix = resolvedProvider
    ? providerEnvPrefix(resolvedProvider)
    : harness === "claude-code"
      ? claudeEnvPrefix(runtimeProject, config)
      : "";

  return {
    role: "worker",
    harness,
    backend,
    credential,
    model: input.model,
    ultracode: input.ultracode,
    effort: input.effort,
    envPrefix,
    executionPolicy: "sandboxed-worker",
    requiredCapabilities: {
      turnEnd: true,
      sandbox: true,
      workflow: input.workflow,
      resume: input.resume,
      providerProfiles: resolvedProvider !== null,
    },
    runtimeProject,
    resolvedProvider,
  };
}

export function resolveHeadlessLaunchPlan(input: {
  role: HeadlessRole;
  harness?: string;
  model?: string;
  effort?: string;
  envPrefix: string;
}): HeadlessLaunchPlan {
  const harness = strictHarness(input.harness);
  const core = getHarnessCore(harness);
  if (!core.capabilities.headlessRoles.includes(input.role)) {
    throw new Error(`Harness '${harness}' cannot run the '${input.role}' headless role.`);
  }
  return {
    role: input.role,
    harness,
    backend: { kind: "harness-account" },
    credential: { kind: "harness-account" },
    model: input.model,
    effort: input.effort,
    envPrefix: input.envPrefix,
    executionPolicy: "trusted-headless",
    requiredCapabilities: { headlessRole: input.role },
  };
}

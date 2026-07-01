// View or set project configuration values.
import { loadConfig, saveConfig, resolveProject, isValidConfigKey, type ProjectConfig } from "../config.js";
import { syncProviderTokenToSession } from "../dashboard/claude-env.js";
import { resolveReviewRole, type ReviewRole } from "../dashboard/roles.js";
import { isRegisteredHarness, harnessNames } from "../dashboard/harness/core.js";
import {
  ASSIGNABLE_LOG_COLOR_KEYS,
  RESERVED_LOG_COLOR_KEY,
  RESERVED_LOG_COLOR_PROJECT,
  isValidLogColorKey,
} from "../log-palette.js";
import { output } from "../output.js";

const SETTABLE_KEYS = [
  "checks", "postMerge", "sandboxDomains", "claudeProfile", "provider",
  "logColor", "trellisDir", "maxTrellisIterations", "trellisOpusFallback",
  "maxGrowIterations", "requireCiSuccess", "holisticReview",
] as const;
type SettableKey = typeof SETTABLE_KEYS[number];

export async function config(args: string[]): Promise<void> {
  const project = resolveProject(args[0]);
  const key = args[1];
  const value = args[2];

  if (!key) {
    showProjectConfig(project);
    return;
  }

  if (key === "focused") {
    throw new Error(
      "'focused' is no longer a project setting. Use 'garden plot focus <plot>' / 'garden plot unfocus <plot>' to control what appears in the dashboard.",
    );
  }

  // Per-role harness/model selection for the review family lives under a
  // subcommand, not the flat key ladder: `garden config <p> role <role>
  // [<harness|model> [<value|unset>]]`.
  if (key === "role") {
    handleRoleCommand(project, args.slice(2));
    return;
  }

  if (!isValidConfigKey(key)) {
    throw new Error(
      `Unknown config key: ${key}. Valid keys: ${SETTABLE_KEYS.join(", ")}`,
    );
  }

  if (key === "path") {
    throw new Error("Cannot set 'path' via config. Use 'garden add' instead.");
  }

  const settableKey = key as SettableKey;

  if (value === undefined) {
    showConfigKey(project, settableKey);
    return;
  }

  setConfigKey(project.name, settableKey, value);
}

function showProjectConfig(project: ProjectConfig & { name: string }): void {
  const data: Record<string, string> = { path: project.path };
  for (const key of SETTABLE_KEYS) {
    if (key === "sandboxDomains") {
      if (project.sandboxDomains && project.sandboxDomains.length > 0) {
        data.sandboxDomains = project.sandboxDomains.join(", ");
      }
    } else if (key === "claudeProfile") {
      if (project.claudeProfile) data.claudeProfile = project.claudeProfile;
    } else if (key === "provider") {
      if (project.provider) data.provider = project.provider;
    } else if (key === "logColor") {
      if (project.logColor) data.logColor = project.logColor;
    } else if (key === "maxTrellisIterations") {
      if (project.maxTrellisIterations !== undefined) {
        data.maxTrellisIterations = String(project.maxTrellisIterations);
      }
    } else if (key === "trellisOpusFallback") {
      if (project.trellisOpusFallback !== undefined) {
        data.trellisOpusFallback = String(project.trellisOpusFallback);
      }
    } else if (key === "maxGrowIterations") {
      if (project.maxGrowIterations !== undefined) {
        data.maxGrowIterations = String(project.maxGrowIterations);
      }
    } else if (key === "requireCiSuccess") {
      if (project.requireCiSuccess !== undefined) {
        data.requireCiSuccess = String(project.requireCiSuccess);
      }
    } else if (project[key]) {
      data[key] = project[key]!;
    }
  }

  output(data, (d) => {
    const entries = Object.entries(d as Record<string, string>);
    return entries.map(([k, v]) => `  ${k}: ${v}`).join("\n");
  });
}

function showConfigKey(project: ProjectConfig & { name: string }, key: SettableKey): void {
  if (key === "sandboxDomains") {
    const list = project.sandboxDomains ?? [];
    if (list.length > 0) {
      output({ [key]: list }, () => list.join(", "));
    } else {
      output({ [key]: null }, () => `(not set)`);
    }
    return;
  }
  if (key === "claudeProfile") {
    const v = project.claudeProfile;
    if (v) output({ [key]: v }, () => v);
    else output({ [key]: null }, () => `(not set)`);
    return;
  }
  if (key === "provider") {
    const v = project.provider;
    if (v) output({ [key]: v }, () => v);
    else output({ [key]: null }, () => `(not set)`);
    return;
  }
  if (key === "logColor") {
    const v = project.logColor;
    if (v) output({ [key]: v }, () => v);
    else output({ [key]: null }, () => `(not set)`);
    return;
  }
  if (key === "maxTrellisIterations") {
    const v = project.maxTrellisIterations;
    if (v !== undefined) output({ [key]: v }, () => String(v));
    else output({ [key]: null }, () => `(not set)`);
    return;
  }
  if (key === "trellisOpusFallback") {
    const v = project.trellisOpusFallback;
    if (v !== undefined) output({ [key]: v }, () => String(v));
    else output({ [key]: null }, () => `(not set)`);
    return;
  }
  if (key === "maxGrowIterations") {
    const v = project.maxGrowIterations;
    if (v !== undefined) output({ [key]: v }, () => String(v));
    else output({ [key]: null }, () => `(not set)`);
    return;
  }
  if (key === "requireCiSuccess") {
    const v = project.requireCiSuccess;
    if (v !== undefined) output({ [key]: v }, () => String(v));
    else output({ [key]: null }, () => `(not set)`);
    return;
  }
  const value = project[key];
  if (value) {
    output({ [key]: value }, () => String(value));
  } else {
    output({ [key]: null }, () => `(not set)`);
  }
}

// CLI role name -> config sub-object key. The review family only; the worker
// role selects its harness/model via `workers new --model` (and --harness in
// the worker-path slice), not this config surface.
const REVIEW_ROLE_KEYS: Record<string, ReviewRole> = {
  reviewer: "reviewer",
  resolver: "resolver",
  "ci-fix": "ciFix",
};
const ROLE_DIMS = ["harness", "model"] as const;
type RoleDim = typeof ROLE_DIMS[number];

function handleRoleCommand(
  project: ProjectConfig & { name: string },
  roleArgs: string[],
): void {
  const roleArg = roleArgs[0];
  if (!roleArg) {
    showRoleMatrix(project);
    return;
  }
  const roleKey = REVIEW_ROLE_KEYS[roleArg];
  if (!roleKey) {
    throw new Error(
      `Unknown role '${roleArg}'. Valid roles: ${Object.keys(REVIEW_ROLE_KEYS).join(", ")}.`,
    );
  }
  const dim = roleArgs[1];
  if (!dim) {
    showRoleResolution(project, roleArg, roleKey);
    return;
  }
  if (!ROLE_DIMS.includes(dim as RoleDim)) {
    throw new Error(`Unknown role dimension '${dim}'. Valid dimensions: ${ROLE_DIMS.join(", ")}.`);
  }
  const value = roleArgs[2];
  if (value === undefined) {
    showRoleDim(project, roleArg, roleKey, dim as RoleDim);
    return;
  }
  setRoleDim(project.name, roleArg, roleKey, dim as RoleDim, value);
}

function roleLine(project: ProjectConfig & { name: string }, roleKey: ReviewRole): string {
  const res = resolveReviewRole(project, "default", roleKey);
  return `harness=${res.harness} model=${res.model ?? "(harness default)"}`;
}

function showRoleMatrix(project: ProjectConfig & { name: string }): void {
  const data: Record<string, string> = {};
  for (const roleArg of Object.keys(REVIEW_ROLE_KEYS)) {
    data[roleArg] = roleLine(project, REVIEW_ROLE_KEYS[roleArg]);
  }
  output(data, (d) =>
    Object.entries(d as Record<string, string>).map(([k, v]) => `  ${k}: ${v}`).join("\n"));
}

function showRoleResolution(project: ProjectConfig & { name: string }, roleArg: string, roleKey: ReviewRole): void {
  const res = resolveReviewRole(project, "default", roleKey);
  output(
    { role: roleArg, harness: res.harness, model: res.model ?? null },
    () => `  ${roleArg}: ${roleLine(project, roleKey)}`,
  );
}

function showRoleDim(project: ProjectConfig & { name: string }, roleArg: string, roleKey: ReviewRole, dim: RoleDim): void {
  const v = project.roles?.[roleKey]?.[dim];
  if (v) output({ [dim]: v }, () => v);
  else output({ [dim]: null }, () => `(not set — using default)`);
}

function setRoleDim(projectName: string, roleArg: string, roleKey: ReviewRole, dim: RoleDim, value: string): void {
  const cfg = loadConfig();
  const project = cfg.projects[projectName];
  if (!project) throw new Error(`Unknown project: ${projectName}`);

  const clearing = value === "" || value === "unset" || value === "null";
  if (dim === "harness" && !clearing && !isRegisteredHarness(value)) {
    throw new Error(
      `Unknown harness '${value}'. Registered harnesses: ${harnessNames().join(", ")}.`,
    );
  }

  const roles = project.roles ?? (project.roles = {});
  const target = roles[roleKey] ?? (roles[roleKey] = {});
  if (clearing) {
    delete target[dim];
    // Prune empty objects so config.yml stays tidy.
    if (Object.keys(target).length === 0) delete roles[roleKey];
    if (Object.keys(roles).length === 0) delete project.roles;
    console.log(`Cleared ${roleArg} ${dim} for ${projectName} (using default)`);
  } else {
    target[dim] = value;
    console.log(`Set ${roleArg} ${dim} = ${value} for ${projectName}`);
    if (dim === "harness" && value !== "claude-code") {
      console.log(`  note: ${value} authenticates itself — the Anthropic provider/model neutralization does not apply to this role.`);
    }
  }
  saveConfig(cfg);
}

function setConfigKey(projectName: string, key: SettableKey, value: string): void {
  const cfg = loadConfig();
  const project = cfg.projects[projectName];
  if (!project) throw new Error(`Unknown project: ${projectName}`);

  if (key === "sandboxDomains") {
    if (value === "" || value === "unset" || value === "null") {
      delete project.sandboxDomains;
      console.log(`Cleared ${key} for ${projectName}`);
    } else {
      const domains = value.split(",").map((d) => d.trim()).filter(Boolean);
      project.sandboxDomains = domains;
      console.log(`Set ${key} = ${domains.join(", ")} for ${projectName}`);
    }
  } else if (key === "logColor") {
    if (value === "" || value === "unset" || value === "null") {
      delete project.logColor;
      console.log(`Cleared ${key} for ${projectName} (will be reassigned on next 'garden logs')`);
    } else if (projectName === RESERVED_LOG_COLOR_PROJECT) {
      throw new Error(
        `'${RESERVED_LOG_COLOR_PROJECT}' is pinned to ${RESERVED_LOG_COLOR_KEY}; logColor cannot be set explicitly.`,
      );
    } else if (!isValidLogColorKey(value) || value === RESERVED_LOG_COLOR_KEY) {
      throw new Error(
        `Unknown logColor '${value}'. Valid keys: ${ASSIGNABLE_LOG_COLOR_KEYS.join(", ")} ` +
        `('${RESERVED_LOG_COLOR_KEY}' is reserved for ${RESERVED_LOG_COLOR_PROJECT}).`,
      );
    } else {
      project.logColor = value;
      console.log(`Set ${key} = ${value} for ${projectName}`);
    }
  } else if (key === "claudeProfile") {
    if (value === "" || value === "unset" || value === "null") {
      delete project.claudeProfile;
      console.log(`Cleared ${key} for ${projectName} (default: personal Max plan)`);
    } else {
      if (!cfg.claudeProfiles?.[value]) {
        throw new Error(
          `Unknown claude profile '${value}'. Register it first with 'garden claude-profile add ${value}'.`,
        );
      }
      project.claudeProfile = value;
      console.log(`Set ${key} = ${value} for ${projectName}`);
    }
  } else if (key === "provider") {
    if (value === "" || value === "unset" || value === "null") {
      delete project.provider;
      console.log(`Cleared ${key} for ${projectName} (workers back on the first-party Anthropic path)`);
    } else {
      const providerEntry = cfg.providers?.[value];
      if (!providerEntry) {
        throw new Error(
          `Unknown provider '${value}'. Register it first with 'garden provider add ${value}'.`,
        );
      }
      project.provider = value;
      syncProviderTokenToSession({ ...providerEntry, name: value, label: providerEntry.label ?? value });
      console.log(`Set ${key} = ${value} for ${projectName} (applies to newly created or bounced workers; reviewers stay on Anthropic)`);
      if (!process.env[providerEntry.authTokenEnv]) {
        console.log(`  note: ${providerEntry.authTokenEnv} is not set in this shell — export it, then run 'garden auth status' to sync and verify.`);
      }
    }
  } else if (key === "maxTrellisIterations") {
    if (value === "" || value === "unset" || value === "null") {
      delete project.maxTrellisIterations;
      console.log(`Cleared ${key} for ${projectName} (default: 30)`);
    } else {
      const n = Number.parseInt(value, 10);
      if (!Number.isFinite(n) || n < 1) {
        throw new Error(`maxTrellisIterations must be a positive integer, got '${value}'`);
      }
      project.maxTrellisIterations = n;
      console.log(`Set ${key} = ${n} for ${projectName}`);
    }
  } else if (key === "trellisOpusFallback") {
    if (value === "" || value === "unset" || value === "null") {
      delete project.trellisOpusFallback;
      console.log(`Cleared ${key} for ${projectName} (default: true)`);
    } else if (value === "true" || value === "false") {
      project.trellisOpusFallback = value === "true";
      console.log(`Set ${key} = ${value} for ${projectName}`);
    } else {
      throw new Error(`trellisOpusFallback must be 'true' or 'false', got '${value}'`);
    }
  } else if (key === "maxGrowIterations") {
    if (value === "" || value === "unset" || value === "null") {
      delete project.maxGrowIterations;
      console.log(`Cleared ${key} for ${projectName} (default: 5)`);
    } else {
      const n = Number.parseInt(value, 10);
      if (!Number.isFinite(n) || n < 1) {
        throw new Error(`maxGrowIterations must be a positive integer, got '${value}'`);
      }
      project.maxGrowIterations = n;
      console.log(`Set ${key} = ${n} for ${projectName}`);
    }
  } else if (key === "requireCiSuccess") {
    if (value === "" || value === "unset" || value === "null") {
      delete project.requireCiSuccess;
      console.log(`Cleared ${key} for ${projectName} (default: true)`);
    } else if (value === "true" || value === "false") {
      project.requireCiSuccess = value === "true";
      console.log(`Set ${key} = ${value} for ${projectName}`);
    } else {
      throw new Error(`requireCiSuccess must be 'true' or 'false', got '${value}'`);
    }
  } else if (key === "holisticReview") {
    if (value === "" || value === "unset" || value === "null") {
      delete project.holisticReview;
      console.log(`Cleared ${key} for ${projectName} (default: off)`);
    } else if (value === "off" || value === "shadow" || value === "fix") {
      project.holisticReview = value;
      console.log(`Set ${key} = ${value} for ${projectName}`);
    } else {
      throw new Error(`holisticReview must be 'off', 'shadow', or 'fix', got '${value}'`);
    }
  } else if (value === "" || value === "unset" || value === "null") {
    delete project[key];
    console.log(`Cleared ${key} for ${projectName}`);
  } else {
    project[key] = value;
    console.log(`Set ${key} = ${value} for ${projectName}`);
  }

  saveConfig(cfg);
}

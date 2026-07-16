// View or set project configuration values. The flat-key and role mutators live
// in dashboard/project-config-mutate.ts (shared with the ⌥, project menu); this
// file is their CLI presenter plus the read (`show*`) and crew/role dispatch.
import { loadConfig, resolveProject, isValidConfigKey, type ProjectConfig } from "../config.js";
import { resolveReviewRole, type ReviewRole } from "../dashboard/roles.js";
import { listCrews, getCrew, applyCrew, deriveCrew } from "../dashboard/crew.js";
import {
  setProjectConfigKey, setProjectRoleDim,
  SETTABLE_KEYS, type SettableKey, REVIEW_ROLE_KEYS, ROLE_DIMS, type RoleDim,
} from "../dashboard/project-config-mutate.js";
import { output } from "../output.js";

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

  // `garden config <p> crew [<name>]` — a crew is sugar that sets the worker
  // harness/provider and the review-role harnesses together. Show current +
  // available when no name is given.
  if (key === "crew") {
    handleCrewCommand(project, args[2]);
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

function handleCrewCommand(
  project: ProjectConfig & { name: string },
  name: string | undefined,
): void {
  const config = loadConfig();
  if (!name) {
    const current = deriveCrew(project, config);
    const available = listCrews(config).map((c) => c.name);
    output(
      { crew: current, available },
      () =>
        [
          `  crew: ${current ?? "(custom — hand-tuned roles)"}`,
          `  available: ${available.join(", ")}`,
        ].join("\n"),
    );
    return;
  }
  const spec = getCrew(name, config);
  if (!spec) {
    throw new Error(
      `Unknown crew '${name}'. Available: ${listCrews(config).map((c) => c.name).join(", ")}.`,
    );
  }
  applyCrew(project.name, spec);
  const workerDesc = spec.worker.provider
    ? `${spec.worker.name} (claude-code via provider ${spec.worker.provider})`
    : spec.worker.name;
  console.log(`Set crew '${name}' for ${project.name}: worker=${workerDesc}, review=${spec.review.name}.`);
}

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

// Thin CLI presenter over the shared mutator.
function setRoleDim(projectName: string, roleArg: string, roleKey: ReviewRole, dim: RoleDim, value: string): void {
  const r = setProjectRoleDim(projectName, roleArg, roleKey, dim, value);
  console.log(r.message);
  r.notes?.forEach((n) => console.log(n));
}

// Thin CLI presenter over the shared mutator.
function setConfigKey(projectName: string, key: SettableKey, value: string): void {
  const r = setProjectConfigKey(projectName, key, value);
  console.log(r.message);
  r.notes?.forEach((n) => console.log(n));
}

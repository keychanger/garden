// Project-config mutators, shared by the `garden config` CLI (commands/config.ts)
// and the ⌥, project config menu (project-menu.ts). They live here — a dashboard
// module — rather than in the leaf config.ts because they reach into the
// dashboard graph (provider token sync, harness registry, branch existence);
// the crew mutator (applyCrew in crew.ts) set the same precedent.
//
// They return a MutateResult (a primary `message` + optional `notes`) instead
// of writing to stdout, so each surface presents the outcome its own way — the
// CLI prints them, the menu shows the primary via tmuxDisplay. Validation
// `throw`s stay here so both surfaces share them. Behavior is byte-identical to
// the pre-extraction CLI (guarded by a config-output test).
import path from "node:path";
import {
  mutateConfig, beadsStoreError, DEFAULT_HOLISTIC_REVIEW, REVIEW_EFFORT_LEVELS,
  isValidReviewEffort, type GardenConfig, type ResolvedProvider,
} from "../config.js";
import { syncProviderTokenToVault } from "./claude-env.js";
import {
  getHarnessCore, isRegisteredHarness, harnessNames, canonicalHarnessName,
  workerLaunchCompatibilityError,
} from "./harness/core.js";
import { resolveProjectCrew } from "./crew.js";
import { branchExistsOnOrigin } from "./git.js";
import type { ReviewRole } from "./roles.js";
import {
  ASSIGNABLE_LOG_COLOR_KEYS,
  RESERVED_LOG_COLOR_KEY,
  RESERVED_LOG_COLOR_PROJECT,
  isValidLogColorKey,
} from "../log-palette.js";

// The flat, single-value config keys settable via `garden config <p> <key>
// <value>` and the project menu. `path` is deliberately excluded (set via
// `garden add`); crew and the review roles have their own subcommands.
export const SETTABLE_KEYS = [
  "baseBranch", "checks", "postMerge", "sandboxDomains", "sandboxDenyCredentials",
  "claudeProfile", "provider",
  "harness", "model", "effort", "logColor", "trellisDir", "maxTrellisIterations",
  "trellisOpusFallback", "maxGrowIterations", "requireCiSuccess", "holisticReview",
  "beadIntake", "beadIntakeCap", "beadsDir",
] as const;
export type SettableKey = typeof SETTABLE_KEYS[number];

// CLI role name -> config sub-object key. The review family only; the worker
// role selects its harness/model via `workers new`, not this config surface.
// Valid values for the project-default `effort` key: the four claude-code
// reasoning rungs (mirrors WORKER_EFFORT_LEVELS in dashboard/create.ts) plus
// "ultra", the ultracode preset. Kept as a local literal so this leaf mutator
// does not import create.ts's heavy module graph.
const PROJECT_EFFORT_VALUES = ["low", "medium", "high", "xhigh", "ultra"] as const;

export const REVIEW_ROLE_KEYS: Record<string, ReviewRole> = {
  reviewer: "reviewer",
  resolver: "resolver",
  "ci-fix": "ciFix",
};
export const ROLE_DIMS = ["harness", "model", "effort"] as const;
export type RoleDim = typeof ROLE_DIMS[number];

// A mutation outcome: the primary confirmation line, plus any secondary notes
// (e.g. the provider token-env reminder). Presented by the caller.
export interface MutateResult {
  message: string;
  notes?: string[];
}

function result(message: string, notes: string[]): MutateResult {
  return notes.length > 0 ? { message, notes } : { message };
}

function assertWorkerConfigCompatible(
  project: { harness?: string; provider?: string; crew?: string },
  cfg: GardenConfig,
  override: { harness?: string; provider?: string },
): void {
  const crew = resolveProjectCrew(project, cfg);
  const harness = override.harness
    ?? project.harness
    ?? crew?.worker.harness
    ?? "claude-code";
  const provider = override.provider
    ?? project.provider
    ?? crew?.worker.provider
    ?? null;
  const compatibilityError = workerLaunchCompatibilityError(
    getHarnessCore(harness),
    { workflow: "default", provider },
  );
  if (compatibilityError) throw new Error(compatibilityError);
}

export function setProjectConfigKey(projectName: string, key: SettableKey, value: string): MutateResult {
  let providerToSync: ResolvedProvider | null = null;
  const mutationResult = mutateConfig(cfg => {
    const project = cfg.projects[projectName];
    if (!project) throw new Error(`Unknown project: ${projectName}`);
    const notes: string[] = [];
    let message: string;

    if (key === "sandboxDomains") {
      if (value === "" || value === "unset" || value === "null") {
        delete project.sandboxDomains;
        message = `Cleared ${key} for ${projectName}`;
      } else {
        const domains = value.split(",").map((d) => d.trim()).filter(Boolean);
        project.sandboxDomains = domains;
        message = `Set ${key} = ${domains.join(", ")} for ${projectName}`;
      }
    } else if (key === "logColor") {
      if (value === "" || value === "unset" || value === "null") {
        delete project.logColor;
        message = `Cleared ${key} for ${projectName} (will be reassigned on next 'garden logs')`;
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
        message = `Set ${key} = ${value} for ${projectName}`;
      }
    } else if (key === "claudeProfile") {
      if (value === "" || value === "unset" || value === "null") {
        delete project.claudeProfile;
        message = `Cleared ${key} for ${projectName} (default: personal Max plan)`;
      } else {
        if (!cfg.claudeProfiles?.[value]) {
          throw new Error(
            `Unknown claude profile '${value}'. Register it first with 'garden claude-profile add ${value}'.`,
          );
        }
        project.claudeProfile = value;
        message = `Set ${key} = ${value} for ${projectName}`;
      }
    } else if (key === "provider") {
      if (value === "" || value === "unset" || value === "null") {
        delete project.provider;
        message = `Cleared ${key} for ${projectName} (workers back on the first-party Anthropic path)`;
      } else {
        const providerEntry = cfg.providers?.[value];
        if (!providerEntry) {
          throw new Error(
            `Unknown provider '${value}'. Register it first with 'garden provider add ${value}'.`,
          );
        }
        assertWorkerConfigCompatible(project, cfg, { provider: value });
        project.provider = value;
        providerToSync = { ...providerEntry, name: value, label: providerEntry.label ?? value };
        message = `Set ${key} = ${value} for ${projectName} (applies to newly created or bounced workers; reviewers stay on Anthropic)`;
        if (!process.env[providerEntry.authTokenEnv]) {
          notes.push(`  note: ${providerEntry.authTokenEnv} is not set in this shell — export it, then run 'garden auth status' to sync and verify.`);
        }
      }
    } else if (key === "harness") {
      // Canonicalize the "claude" alias (the sentinels pass through unchanged).
      value = canonicalHarnessName(value);
      if (value === "" || value === "unset" || value === "null") {
        delete project.harness;
        message = `Cleared ${key} for ${projectName} (workers default to claude-code)`;
      } else if (!isRegisteredHarness(value)) {
        throw new Error(
          `Unknown harness '${value}'. Registered harnesses: ${harnessNames().join(", ")}.`,
        );
      } else {
        assertWorkerConfigCompatible(project, cfg, { harness: value });
        project.harness = value;
        message = `Set ${key} = ${value} for ${projectName} (applies to newly created or bounced workers; review family selects its own harness under 'role')`;
      }
    } else if (key === "model") {
      if (value === "" || value === "unset" || value === "null") {
        delete project.model;
        message = `Cleared ${key} for ${projectName} (workers use the account/provider default)`;
      } else {
        project.model = value.trim();
        message = `Set ${key} = ${project.model} for ${projectName} (default/grow workers; per-spawn --model and the ultracode preset override it; trellis and the review family ignore it)`;
      }
    } else if (key === "effort") {
      if (value === "" || value === "unset" || value === "null") {
        delete project.effort;
        message = `Cleared ${key} for ${projectName} (no effort passed)`;
      } else if ((PROJECT_EFFORT_VALUES as readonly string[]).includes(value)) {
        project.effort = value;
        const suffix = value === "ultra"
          ? " (ultracode preset: max effort + dynamic workflows)"
          : "";
        message = `Set ${key} = ${value} for ${projectName}${suffix} (default/grow workers; per-spawn --effort overrides it; trellis ignores it)`;
      } else {
        throw new Error(`effort must be one of: ${PROJECT_EFFORT_VALUES.join(", ")}, got '${value}'`);
      }
    } else if (key === "maxTrellisIterations") {
      if (value === "" || value === "unset" || value === "null") {
        delete project.maxTrellisIterations;
        message = `Cleared ${key} for ${projectName} (default: 30)`;
      } else {
        const n = Number.parseInt(value, 10);
        if (!Number.isFinite(n) || n < 1) {
          throw new Error(`maxTrellisIterations must be a positive integer, got '${value}'`);
        }
        project.maxTrellisIterations = n;
        message = `Set ${key} = ${n} for ${projectName}`;
      }
    } else if (key === "trellisOpusFallback") {
      if (value === "" || value === "unset" || value === "null") {
        delete project.trellisOpusFallback;
        message = `Cleared ${key} for ${projectName} (default: true)`;
      } else if (value === "true" || value === "false") {
        project.trellisOpusFallback = value === "true";
        message = `Set ${key} = ${value} for ${projectName}`;
      } else {
        throw new Error(`trellisOpusFallback must be 'true' or 'false', got '${value}'`);
      }
    } else if (key === "maxGrowIterations") {
      if (value === "" || value === "unset" || value === "null") {
        delete project.maxGrowIterations;
        message = `Cleared ${key} for ${projectName} (default: 5)`;
      } else {
        const n = Number.parseInt(value, 10);
        if (!Number.isFinite(n) || n < 1) {
          throw new Error(`maxGrowIterations must be a positive integer, got '${value}'`);
        }
        project.maxGrowIterations = n;
        message = `Set ${key} = ${n} for ${projectName}`;
      }
    } else if (key === "requireCiSuccess") {
      if (value === "" || value === "unset" || value === "null") {
        delete project.requireCiSuccess;
        message = `Cleared ${key} for ${projectName} (default: true)`;
      } else if (value === "true" || value === "false") {
        project.requireCiSuccess = value === "true";
        message = `Set ${key} = ${value} for ${projectName}`;
      } else {
        throw new Error(`requireCiSuccess must be 'true' or 'false', got '${value}'`);
      }
    } else if (key === "beadIntake") {
      if (value === "" || value === "unset" || value === "null") {
        delete project.beadIntake;
        message = `Cleared ${key} for ${projectName} (default: off)`;
      } else if (value === "true" || value === "false") {
        project.beadIntake = value === "true";
        message = `Set ${key} = ${value} for ${projectName} (dispatch-labeled epics in the project's .beads store drive worker intake; BEADS_ACTOR/BEADS_DIR injected into newly created or bounced workers)`;
      } else {
        throw new Error(`beadIntake must be 'true' or 'false', got '${value}'`);
      }
    } else if (key === "beadIntakeCap") {
      if (value === "" || value === "unset" || value === "null") {
        delete project.beadIntakeCap;
        message = `Cleared ${key} for ${projectName} (default: 3)`;
      } else {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) {
          throw new Error(`beadIntakeCap must be a positive integer, got '${value}'`);
        }
        project.beadIntakeCap = n;
        message = `Set ${key} = ${n} for ${projectName}`;
      }
    } else if (key === "beadsDir") {
      if (value === "" || value === "unset" || value === "null") {
        delete project.beadsDir;
        message = `Cleared ${key} for ${projectName} (bd resolves the checkout's own .beads)`;
      } else {
        const dir = value.trim();
        if (!path.isAbsolute(dir)) {
          throw new Error(`beadsDir must be an absolute path to a .beads directory, got '${value}'`);
        }
        project.beadsDir = dir;
        message = `Set ${key} = ${dir} for ${projectName} (intake and worker bd calls resolve this store; applies to newly created or bounced workers)`;
        // Soft notes only (mirroring baseBranch's origin note): the intake
        // pass and `garden doctor` do the hard dangling-store enforcement.
        if (path.basename(dir) !== ".beads") {
          notes.push(`  note: '${dir}' is not named .beads — bd expects a .beads store directory.`);
        }
        const storeNote = beadsStoreError({ path: project.path, beadsDir: dir });
        if (storeNote) {
          notes.push(`  note: ${storeNote} — intake will refuse to run until it is a directory.`);
        }
      }
    } else if (key === "sandboxDenyCredentials") {
      if (value === "" || value === "unset" || value === "null") {
        delete project.sandboxDenyCredentials;
        message = `Cleared ${key} for ${projectName} (default: false)`;
      } else if (value === "true" || value === "false") {
        project.sandboxDenyCredentials = value === "true";
        message = `Set ${key} = ${value} for ${projectName}`;
      } else {
        throw new Error(`sandboxDenyCredentials must be 'true' or 'false', got '${value}'`);
      }
    } else if (key === "holisticReview") {
      if (value === "" || value === "unset" || value === "null") {
        delete project.holisticReview;
        message = `Cleared ${key} for ${projectName} (default: ${DEFAULT_HOLISTIC_REVIEW})`;
      } else if (value === "off" || value === "shadow" || value === "fix") {
        project.holisticReview = value;
        message = `Set ${key} = ${value} for ${projectName}`;
      } else {
        throw new Error(`holisticReview must be 'off', 'shadow', or 'fix', got '${value}'`);
      }
    } else if (key === "baseBranch") {
      if (value === "" || value === "unset" || value === "null") {
        delete project.baseBranch;
        message = `Cleared ${key} for ${projectName} (workers follow the project checkout at spawn)`;
      } else if (!value.trim()) {
        throw new Error("baseBranch requires a non-empty branch name");
      } else {
        const branch = value.trim();
        project.baseBranch = branch;
        message = `Set ${key} = ${branch} for ${projectName} (applies to newly created workers; existing workers keep their pinned base)`;
        // Soft warning only. Keep `garden config` network-free and allow
        // configuring a base that doesn't exist on origin yet; the spawn path
        // (branchExistsOnOrigin + tryPublishBranch in newWorker) does the hard
        // validation and publishes it when the first worker is created.
        if (!branchExistsOnOrigin(project.path, branch)) {
          notes.push(`  note: '${branch}' is not on origin yet; it will be published when the first worker spawns.`);
        }
      }
    } else if (value === "" || value === "unset" || value === "null") {
      delete project[key];
      message = `Cleared ${key} for ${projectName}`;
    } else {
      project[key] = value;
      message = `Set ${key} = ${value} for ${projectName}`;
    }

    return result(message, notes);
  });
  if (providerToSync) syncProviderTokenToVault(providerToSync);
  return mutationResult;
}

export function setProjectRoleDim(projectName: string, roleArg: string, roleKey: ReviewRole, dim: RoleDim, value: string): MutateResult {
  return mutateConfig(cfg => {
    const project = cfg.projects[projectName];
    if (!project) throw new Error(`Unknown project: ${projectName}`);
    const notes: string[] = [];
    let message: string;

    const clearing = value === "" || value === "unset" || value === "null";
    if (dim === "harness" && !clearing) value = canonicalHarnessName(value);
    if (dim === "harness" && !clearing && !isRegisteredHarness(value)) {
      throw new Error(
        `Unknown harness '${value}'. Registered harnesses: ${harnessNames().join(", ")}.`,
      );
    }
    // Effort is a closed set the harness renders verbatim, so an unknown rung
    // would reach the CLI and fail the whole review rather than degrade.
    if (dim === "effort" && !clearing && !isValidReviewEffort(value)) {
      throw new Error(
        `Unknown effort '${value}'. Levels: ${REVIEW_EFFORT_LEVELS.join(", ")}.`,
      );
    }

    const roles = project.roles ?? (project.roles = {});
    const target = roles[roleKey] ?? (roles[roleKey] = {});
    if (clearing) {
      delete target[dim];
      // Prune empty objects so config.yml stays tidy.
      if (Object.keys(target).length === 0) delete roles[roleKey];
      if (Object.keys(roles).length === 0) delete project.roles;
      message = `Cleared ${roleArg} ${dim} for ${projectName} (using default)`;
    } else {
      target[dim] = value;
      message = `Set ${roleArg} ${dim} = ${value} for ${projectName}`;
      if (dim === "harness" && value !== "claude-code") {
        notes.push(`  note: ${value} authenticates itself — the Anthropic provider/model neutralization does not apply to this role.`);
      }
    }
    return result(message, notes);
  });
}

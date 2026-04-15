// View or set project configuration values.
import { loadConfig, saveConfig, resolveProject, isValidConfigKey, type ProjectConfig } from "../config.js";
import { output } from "../output.js";

const SETTABLE_KEYS = ["baseBranch", "checks", "postMerge", "focused", "sandboxDomains", "claudeProfile"] as const;
type SettableKey = typeof SETTABLE_KEYS[number];

export async function config(args: string[]): Promise<void> {
  const project = resolveProject(args[0]);
  const key = args[1];
  const value = args[2];

  if (!key) {
    showProjectConfig(project);
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
    if (key === "focused") {
      if (project.focused === false) data.focused = "false";
    } else if (key === "sandboxDomains") {
      if (project.sandboxDomains && project.sandboxDomains.length > 0) {
        data.sandboxDomains = project.sandboxDomains.join(", ");
      }
    } else if (key === "claudeProfile") {
      if (project.claudeProfile) data.claudeProfile = project.claudeProfile;
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
  if (key === "focused") {
    const val = project.focused !== false ? "true" : "false";
    output({ [key]: val }, () => val);
    return;
  }
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
  const value = project[key];
  if (value) {
    output({ [key]: value }, () => value);
  } else {
    output({ [key]: null }, () => `(not set)`);
  }
}

function setConfigKey(projectName: string, key: SettableKey, value: string): void {
  const cfg = loadConfig();
  const project = cfg.projects[projectName];
  if (!project) throw new Error(`Unknown project: ${projectName}`);

  if (key === "focused") {
    if (value === "false") {
      project.focused = false;
      console.log(`Set ${key} = false for ${projectName}`);
    } else {
      delete project.focused;
      console.log(`Cleared ${key} for ${projectName} (default: focused)`);
    }
  } else if (key === "sandboxDomains") {
    if (value === "" || value === "unset" || value === "null") {
      delete project.sandboxDomains;
      console.log(`Cleared ${key} for ${projectName}`);
    } else {
      const domains = value.split(",").map((d) => d.trim()).filter(Boolean);
      project.sandboxDomains = domains;
      console.log(`Set ${key} = ${domains.join(", ")} for ${projectName}`);
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
  } else if (value === "" || value === "unset" || value === "null") {
    delete project[key];
    console.log(`Cleared ${key} for ${projectName}`);
  } else {
    project[key] = value;
    console.log(`Set ${key} = ${value} for ${projectName}`);
  }

  saveConfig(cfg);
}

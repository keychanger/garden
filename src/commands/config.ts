// View or set project configuration values.
import { loadConfig, saveConfig, resolveProject, isValidConfigKey, type ProjectConfig } from "../config.js";
import { output } from "../output.js";

const SETTABLE_KEYS = ["baseBranch", "checks", "postMerge", "focused"] as const;
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
  } else if (value === "" || value === "unset" || value === "null") {
    delete project[key];
    console.log(`Cleared ${key} for ${projectName}`);
  } else {
    project[key] = value;
    console.log(`Set ${key} = ${value} for ${projectName}`);
  }

  saveConfig(cfg);
}

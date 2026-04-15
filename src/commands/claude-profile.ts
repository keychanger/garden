// Command: garden claude-profile — manage alternate Claude Code config dirs.
// Projects opt in via the `claudeProfile` config key; their workers run with
// CLAUDE_CONFIG_DIR set to the profile's dir, so a separate plan can be used
// without disturbing the personal Max plan default.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  loadConfig, saveConfig, expandHome,
  type ClaudeProfile, type GardenConfig,
} from "../config.js";
import { isTTY } from "../output.js";

export async function claudeProfile(args: string[]): Promise<void> {
  const sub = args[0] ?? "list";
  const rest = args.slice(1);

  if (sub === "list") return handleList();
  if (sub === "add") return handleAdd(rest);
  if (sub === "remove") return handleRemove(rest);
  if (sub === "login") return handleLogin(rest);

  throw new Error(
    `Unknown subcommand: ${sub}. Usage: garden claude-profile [list|add|remove|login]`,
  );
}

function handleList(): void {
  const cfg = loadConfig();
  const profiles = cfg.claudeProfiles ?? {};
  const usage = projectsByProfile(cfg);

  const data = Object.entries(profiles).map(([name, p]) => ({
    name,
    configDir: expandHome(p.configDir),
    label: p.label ?? name,
    projects: usage[name] ?? [],
  }));

  if (!isTTY) {
    console.log(JSON.stringify({ profiles: data }));
    return;
  }

  if (data.length === 0) {
    console.log("No claude profiles defined. Default: personal ~/.claude.");
    console.log("Add one with: garden claude-profile add <name>");
    return;
  }

  for (const p of data) {
    console.log(`  ${p.name}`);
    console.log(`    configDir: ${p.configDir}`);
    console.log(`    label:     ${p.label}`);
    console.log(`    projects:  ${p.projects.length > 0 ? p.projects.join(", ") : "(none)"}`);
  }
}

function projectsByProfile(cfg: GardenConfig): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [name, proj] of Object.entries(cfg.projects)) {
    if (proj.claudeProfile) {
      (out[proj.claudeProfile] ??= []).push(name);
    }
  }
  return out;
}

interface AddFlags {
  name: string;
  configDir?: string;
  label?: string;
}

function parseAddFlags(args: string[]): AddFlags {
  if (args.length === 0 || args[0].startsWith("--")) {
    throw new Error(`Usage: garden claude-profile add <name> [--config-dir <path>] [--label <label>]`);
  }
  const flags: AddFlags = { name: args[0] };
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "--config-dir") flags.configDir = args[++i];
    else if (a === "--label") flags.label = args[++i];
    else throw new Error(`Unknown flag: ${a}`);
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(flags.name)) {
    throw new Error(`Profile name must be alphanumeric/dash/underscore: ${flags.name}`);
  }
  return flags;
}

function handleAdd(args: string[]): void {
  const flags = parseAddFlags(args);
  const cfg = loadConfig();
  const profiles = cfg.claudeProfiles ?? {};
  if (profiles[flags.name]) {
    throw new Error(`Profile already exists: ${flags.name}`);
  }
  const configDir = flags.configDir ?? `~/.claude-${flags.name}`;
  const profile: ClaudeProfile = { configDir };
  if (flags.label && flags.label !== flags.name) profile.label = flags.label;

  const resolved = expandHome(configDir);
  fs.mkdirSync(resolved, { recursive: true });

  cfg.claudeProfiles = { ...profiles, [flags.name]: profile };
  saveConfig(cfg);

  console.log(`Added claude profile '${flags.name}'`);
  console.log(`  configDir: ${resolved}`);
  console.log(`  label:     ${profile.label ?? flags.name}`);
  console.log(`Next: garden claude-profile login ${flags.name}`);
}

function handleRemove(args: string[]): void {
  const name = args[0];
  if (!name) throw new Error(`Usage: garden claude-profile remove <name>`);
  const cfg = loadConfig();
  const profiles = cfg.claudeProfiles ?? {};
  if (!profiles[name]) throw new Error(`Unknown profile: ${name}`);

  const usage = projectsByProfile(cfg)[name] ?? [];
  if (usage.length > 0) {
    throw new Error(
      `Profile '${name}' is still used by: ${usage.join(", ")}. ` +
      `Run 'garden config <project> claudeProfile unset' first.`,
    );
  }

  delete profiles[name];
  cfg.claudeProfiles = profiles;
  saveConfig(cfg);
  console.log(`Removed claude profile '${name}' (config dir left intact on disk).`);
}

async function handleLogin(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) throw new Error(`Usage: garden claude-profile login <name>`);
  const cfg = loadConfig();
  const profile = cfg.claudeProfiles?.[name];
  if (!profile) throw new Error(`Unknown profile: ${name}. Add it with 'garden claude-profile add ${name}'.`);

  const configDir = expandHome(profile.configDir);
  fs.mkdirSync(configDir, { recursive: true });

  console.log(`Launching: CLAUDE_CONFIG_DIR=${configDir} claude /login`);
  console.log(`Pick the workspace bound to the '${name}' plan when prompted.`);
  console.log(`Your personal ~/.claude credentials are NOT touched.`);

  await new Promise<void>((resolve, reject) => {
    const child = spawn("claude", ["/login"], {
      stdio: "inherit",
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: configDir,
      },
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`claude /login exited with code ${code}`));
    });
    child.on("error", (err) => reject(err));
  });

  const credFile = path.join(configDir, ".credentials.json");
  if (fs.existsSync(credFile)) {
    console.log(`Credentials written to ${credFile}`);
  } else {
    console.log(`Warning: ${credFile} not found after login. Check whether claude wrote to the macOS Keychain instead — that entry is shared, which would collide with the personal plan.`);
  }
}

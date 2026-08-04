// Manage model providers: Anthropic-Messages-compatible backends that
// workers reach by env swap under the unchanged Claude Code harness.
// See docs/MULTI-MODEL.md "Layer 1: provider descriptors".
import {
  loadConfig, mutateConfig, assertValidProvider,
  type GardenConfig, type ProviderProfile,
} from "../config.js";
import {
  clearProviderTokenVault,
  syncProviderTokenToVault,
} from "../dashboard/claude-env.js";
import { readRegistry } from "../dashboard/registry.js";
import { isTTY } from "../output.js";

export async function provider(args: string[]): Promise<void> {
  const sub = args[0] ?? "list";
  const rest = args.slice(1);

  if (sub === "list") return handleList();
  if (sub === "add") return handleAdd(rest);
  if (sub === "remove") return handleRemove(rest);

  throw new Error(
    `Unknown subcommand: ${sub}. Usage: garden provider [list|add|remove]`,
  );
}

function handleList(): void {
  const cfg = loadConfig();
  const providers = cfg.providers ?? {};
  const usage = projectsByProvider(cfg);

  const data = Object.entries(providers).map(([name, p]) => ({
    name,
    baseUrl: p.baseUrl,
    authTokenEnv: p.authTokenEnv,
    tokenPresent: Boolean(process.env[p.authTokenEnv]),
    label: p.label ?? name,
    modelMap: p.modelMap ?? {},
    egressHosts: p.egressHosts ?? [],
    projects: usage[name] ?? [],
  }));

  if (!isTTY) {
    console.log(JSON.stringify({ providers: data }));
    return;
  }

  if (data.length === 0) {
    console.log("No providers defined. Workers run on the first-party Anthropic path.");
    console.log("Add one with: garden provider add <name> --base-url <url> --token-env <ENV_VAR>");
    return;
  }

  for (const p of data) {
    console.log(`  ${p.name}`);
    console.log(`    baseUrl:   ${p.baseUrl}`);
    console.log(`    tokenEnv:  ${p.authTokenEnv} ${p.tokenPresent ? "(set in this shell)" : `(not set — export ${p.authTokenEnv}, then run 'garden auth status' to sync and verify)`}`);
    if (Object.keys(p.modelMap).length > 0) {
      const map = Object.entries(p.modelMap).map(([k, v]) => `${k}=${v}`).join(", ");
      console.log(`    modelMap:  ${map}`);
    }
    if (p.egressHosts.length > 0) {
      console.log(`    egress:    ${p.egressHosts.join(", ")}`);
    }
    console.log(`    projects:  ${p.projects.length > 0 ? p.projects.join(", ") : "(none)"}`);
  }
}

function projectsByProvider(cfg: GardenConfig): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [name, proj] of Object.entries(cfg.projects)) {
    if (proj.provider) {
      (out[proj.provider] ??= []).push(name);
    }
  }
  return out;
}

function workersByProvider(name: string): string[] {
  const workers: string[] = [];
  for (const [project, entries] of Object.entries(readRegistry().workers)) {
    for (const entry of entries) {
      if (entry.provider === name) workers.push(`${project}/${entry.name}`);
    }
  }
  return workers;
}

interface AddFlags {
  name: string;
  baseUrl?: string;
  authTokenEnv?: string;
  label?: string;
  modelMap?: ProviderProfile["modelMap"];
  egressHosts?: string[];
}

const ADD_USAGE =
  "Usage: garden provider add <name> --base-url <url> --token-env <ENV_VAR> "
  + "[--label <label>] [--map opus=<model>,sonnet=<model>,haiku=<model>] [--egress <host1,host2>]";

function parseAddFlags(args: string[]): AddFlags {
  if (args.length === 0 || args[0].startsWith("--")) {
    throw new Error(ADD_USAGE);
  }
  const flags: AddFlags = { name: args[0] };
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    const next = (): string => {
      if (!args[i + 1]) throw new Error(`${a} requires a value`);
      return args[++i];
    };
    if (a === "--base-url") flags.baseUrl = next();
    else if (a === "--token-env") flags.authTokenEnv = next();
    else if (a === "--label") flags.label = next();
    else if (a === "--map") flags.modelMap = parseModelMap(next());
    else if (a === "--egress") {
      flags.egressHosts = next().split(",").map((h) => h.trim()).filter(Boolean);
    }
    else throw new Error(`Unknown flag: ${a}`);
  }
  return flags;
}

function parseModelMap(raw: string): ProviderProfile["modelMap"] {
  const map: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0 || eq === trimmed.length - 1) {
      throw new Error(`--map entries must be alias=model, got '${trimmed}'`);
    }
    map[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return map;
}

function handleAdd(args: string[]): void {
  const flags = parseAddFlags(args);
  if (!flags.baseUrl || !flags.authTokenEnv) {
    throw new Error(ADD_USAGE);
  }
  const profile: ProviderProfile = {
    baseUrl: flags.baseUrl,
    authTokenEnv: flags.authTokenEnv,
  };
  if (flags.label && flags.label !== flags.name) profile.label = flags.label;
  if (flags.modelMap && Object.keys(flags.modelMap).length > 0) profile.modelMap = flags.modelMap;
  if (flags.egressHosts && flags.egressHosts.length > 0) profile.egressHosts = flags.egressHosts;

  assertValidProvider(flags.name, profile);

  mutateConfig(cfg => {
    const providers = cfg.providers ?? {};
    if (providers[flags.name]) throw new Error(`Provider already exists: ${flags.name}`);
    cfg.providers = { ...providers, [flags.name]: profile };
  });

  // Retain the key in the running dashboard's hidden tmux vault while this
  // process has the operator's shell env. Worker launches receive only their
  // selected provider's key; ordinary panes inherit none of the vault.
  syncProviderTokenToVault({ ...profile, name: flags.name, label: profile.label ?? flags.name });

  console.log(`Added provider '${flags.name}'`);
  console.log(`  baseUrl:  ${profile.baseUrl}`);
  console.log(`  tokenEnv: ${profile.authTokenEnv}${process.env[profile.authTokenEnv] ? "" : `  (not set — export ${profile.authTokenEnv}, then run 'garden auth status' to sync and verify)`}`);
  console.log(`Next: garden config <project> provider ${flags.name}`);
}

function handleRemove(args: string[]): void {
  const name = args[0];
  if (!name) throw new Error(`Usage: garden provider remove <name>`);
  const workerUsage = workersByProvider(name);
  const profile = mutateConfig(cfg => {
    const providers = cfg.providers ?? {};
    const current = providers[name];
    if (!current) throw new Error(`Unknown provider: ${name}`);
    const projectUsage = projectsByProvider(cfg)[name] ?? [];
    const usage = [...projectUsage, ...workerUsage];
    if (usage.length > 0) {
      const remedies = [
        projectUsage.length > 0
          ? `Run 'garden config <project> provider unset' for the listed projects.`
          : "",
        workerUsage.length > 0
          ? "Close the listed workers before removing their provider."
          : "",
      ].filter(Boolean).join(" ");
      throw new Error(
        `Provider '${name}' is still used by: ${usage.join(", ")}. ${remedies}`,
      );
    }
    delete providers[name];
    cfg.providers = providers;
    return current;
  });
  clearProviderTokenVault({ ...profile, name, label: profile.label ?? name });
  console.log(`Removed provider '${name}'.`);
}

import fs from "node:fs";
import { loadConfig, expandHome } from "../config.js";
import { readProfileCredential, runClaudeLogin } from "../dashboard/credentials.js";
import { refreshUsage } from "../dashboard/usage.js";
import { refreshDashboard } from "../dashboard/header.js";

export async function login(args: string[]): Promise<void> {
  const profileName = args[0];

  if (!profileName) {
    return loginPersonal();
  }
  return loginProfile(profileName);
}

async function loginPersonal(): Promise<void> {
  console.log(`Launching: claude /login (no CLAUDE_CONFIG_DIR)`);
  console.log(`Pick your personal workspace when prompted.`);
  await runClaudeLogin();
  console.log(`✓ Personal credentials refreshed.`);
  await healUsageMeter();
}

async function loginProfile(name: string): Promise<void> {
  const cfg = loadConfig();

  // Providers are API-key-backed: there is no login flow to run. Point the
  // operator at the env var instead of failing with "unknown profile".
  const providerEntry = cfg.providers?.[name];
  if (providerEntry) {
    console.log(`'${name}' is a provider (API-key auth) — there is no login flow.`);
    console.log(`Export ${providerEntry.authTokenEnv} in the shell that starts garden; sessions reference it by name.`);
    console.log(`Check presence with: garden auth status`);
    return;
  }

  const profile = cfg.claudeProfiles?.[name];
  if (!profile) {
    throw new Error(`Unknown profile: ${name}. Add it with 'garden claude-profile add ${name}'.`);
  }

  const configDir = expandHome(profile.configDir);
  fs.mkdirSync(configDir, { recursive: true });

  console.log(`Launching: CLAUDE_CONFIG_DIR=${configDir} claude /login`);
  console.log(`Sign your browser into the account that owns the '${name}' plan before approving.`);
  await runClaudeLogin(configDir);

  if (!readProfileCredential(configDir)) {
    console.log(`Warning: no '${name}' credentials found after login. Claude may not have saved them.`);
    return;
  }
  console.log(`✓ '${name}' credentials saved.`);
  console.log(`  Confirm the account with: garden auth status`);
}

// Heal the dashboard meter now instead of waiting for the poller's auth backoff to elapse.
// Force past that backoff: a stale "login expired" snapshot would otherwise short-circuit
// this refresh for up to 30 min and the just-completed login would appear to do nothing.
async function healUsageMeter(): Promise<void> {
  try {
    const snap = await refreshUsage(true);
    try { refreshDashboard(); } catch { /* no dashboard running */ }
    if (snap.error) {
      console.log(`⚠ Usage refresh: ${snap.error}`);
    } else {
      console.log(`✓ Usage meter refreshed.`);
    }
  } catch (err) {
    console.log(`⚠ Usage refresh skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}

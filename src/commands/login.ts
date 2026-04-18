import fs from "node:fs";
import path from "node:path";
import { loadConfig, expandHome } from "../config.js";
import { captureKeychainTo, runClaudeLogin } from "../dashboard/credentials.js";
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
  const profile = cfg.claudeProfiles?.[name];
  if (!profile) {
    throw new Error(`Unknown profile: ${name}. Add it with 'garden claude-profile add ${name}'.`);
  }

  const configDir = expandHome(profile.configDir);
  fs.mkdirSync(configDir, { recursive: true });

  console.log(`Launching: CLAUDE_CONFIG_DIR=${configDir} claude /login`);
  console.log(`Pick the workspace bound to the '${name}' plan when prompted.`);
  await runClaudeLogin(configDir);

  const credFile = path.join(configDir, ".credentials.json");
  if (fs.existsSync(credFile)) {
    console.log(`✓ Credentials written to ${credFile}`);
    return;
  }

  if (process.platform === "darwin" && captureKeychainTo(credFile)) {
    console.log(`✓ Captured '${name}' token to ${credFile}.`);
    console.log(`⚠ macOS Keychain currently holds the '${name}' token, displacing the personal account.`);
    console.log(`  Run 'garden login' next to restore the Keychain to your personal account.`);
    return;
  }

  console.log(`Warning: ${credFile} not found after login. Claude may not have written credentials.`);
}

// Heal the dashboard meter now instead of waiting for the poller's auth backoff to elapse.
async function healUsageMeter(): Promise<void> {
  try {
    const snap = await refreshUsage();
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

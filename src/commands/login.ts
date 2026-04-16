// Command: garden login [profile] — authenticate Claude Code, optionally to
// an alternate Claude profile. With no argument, refreshes the personal
// account into the default credential store. With a profile name, runs
// `claude /login` against the profile's CLAUDE_CONFIG_DIR and (on macOS)
// captures the resulting Keychain entry to the profile's .credentials.json
// so the personal account can be restored on the next `garden login`.
import fs from "node:fs";
import path from "node:path";
import { loadConfig, expandHome } from "../config.js";
import { captureKeychainTo, runClaudeLogin } from "../dashboard/credentials.js";

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

import path from "node:path";

function requireHome(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) {
    throw new Error("Cannot determine home directory: neither HOME nor USERPROFILE is set.");
  }
  return home;
}

export const HOME_DIR = requireHome();
export const GARDEN_DIR = path.join(HOME_DIR, ".garden");
export const CONFIG_PATH = path.join(GARDEN_DIR, "config.yml");
export const SESSIONS_DIR = path.join(GARDEN_DIR, "sessions");

// Trusted runtime files are intentionally outside SESSIONS_DIR. Worker
// sandboxes can write the sessions tree for request IPC, but reviewer-family
// prompts and verdicts are control-plane inputs and must only be writable by
// garden's unsandboxed pollers and headless-agent launch shells.
export const CONTROL_DIR = path.join(GARDEN_DIR, "control");
export const HEADLESS_RUNS_DIR = path.join(CONTROL_DIR, "headless");
export const CONTROL_REPORTS_DIR = path.join(CONTROL_DIR, "reports");

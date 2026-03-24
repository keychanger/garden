// Internal command: launches claude with rules context for a given directory.
// Used by the dashboard keybinding (prefix + C) to start Claude with project rules.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, SESSIONS_DIR } from "./config.js";
import { buildRulesContext } from "./rules.js";

/**
 * Resolve a project name from a directory path by matching against registered projects.
 */
function projectFromPath(dir: string): { name: string; path: string } | null {
  try {
    const config = loadConfig();
    for (const [name, project] of Object.entries(config.projects)) {
      if (dir === project.path || dir.startsWith(project.path + "/")) {
        return { name, path: project.path };
      }
    }
  } catch {
    // Config not initialized
  }
  return null;
}

export async function launchDashboardClaude(args: string[]): Promise<void> {
  const dir = args[0] ?? process.cwd();
  const project = projectFromPath(dir);

  const claudeArgs: string[] = [];

  if (project) {
    const context = buildRulesContext(project.name, project.path);
    const contextFile = path.join(SESSIONS_DIR, `dashboard-${project.name}.context`);
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    fs.writeFileSync(contextFile, context);
    claudeArgs.push("--append-system-prompt-file", contextFile);
  }

  // Exec claude, replacing this process
  const child = spawn("claude", claudeArgs, {
    cwd: dir,
    stdio: "inherit",
    env: {
      ...process.env,
      ...(project ? { GARDEN_PROJECT: project.name } : {}),
    },
  });

  child.on("close", (code) => {
    process.exit(code ?? 0);
  });

  child.on("error", (err) => {
    console.error(`Failed to start claude: ${err.message}`);
    process.exit(1);
  });

  // Keep the process alive until claude exits
  await new Promise(() => {});
}

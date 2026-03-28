// Adds a project directory to the garden config. Name is derived from the directory basename.
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { loadConfig, saveConfig } from "../config.js";

export async function add(args: string[]): Promise<void> {
  const rawPath = args[0] ?? ".";
  const resolved = path.resolve(rawPath);

  if (!fs.existsSync(resolved)) {
    throw new Error(`Path does not exist: ${resolved}`);
  }

  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${resolved}`);
  }

  const name = path.basename(resolved);
  const config = loadConfig();

  if (config.projects[name]) {
    const existing = config.projects[name].path;
    if (existing === resolved) {
      console.log(`Project '${name}' is already added.`);
      return;
    }
    throw new Error(
      `A project named '${name}' already exists at ${existing}. Remove it first.`
    );
  }

  config.projects[name] = { path: resolved };
  saveConfig(config);
  console.log(`Added project '${name}' (${resolved})`);

  if (isGitRepo(resolved)) {
    setupPrePushHook(resolved);
    setupBranchProtection(resolved, name);
  }
}

function isGitRepo(dir: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], {
      cwd: dir,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

const PRE_PUSH_HOOK = `#!/bin/bash
# Prevent direct pushes to main. All changes must go through PRs.
# The merge queue uses \`gh pr merge\` (GitHub API), which bypasses this hook.

while read local_ref local_sha remote_ref remote_sha; do
  if [ "$remote_ref" = "refs/heads/main" ]; then
    echo "Push to main blocked. All changes must go through a pull request."
    echo "Create a branch, open a PR, and let the merge queue handle it."
    exit 1
  fi
done
`;

function setupPrePushHook(projectPath: string): void {
  const hooksDir = path.join(projectPath, ".githooks");
  const hookFile = path.join(hooksDir, "pre-push");

  if (fs.existsSync(hookFile)) return;

  try {
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(hookFile, PRE_PUSH_HOOK, { mode: 0o755 });
    execFileSync("git", ["config", "core.hooksPath", ".githooks"], {
      cwd: projectPath,
      stdio: "ignore",
    });
    console.log(`  Set up pre-push hook (.githooks/pre-push)`);
  } catch {
    console.log(`  Warning: could not set up pre-push hook`);
  }
}

function setupBranchProtection(projectPath: string, projectName: string): void {
  try {
    const remote = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: projectPath,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    const match = remote.match(/github\.com[:/](.+?)(?:\.git)?$/);
    if (!match) return;

    const repo = match[1];

    // Check if already protected
    try {
      execFileSync("gh", ["api", `repos/${repo}/branches/main/protection`], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      return; // Already protected
    } catch {
      // Not protected, set it up
    }

    execFileSync("gh", [
      "api", `repos/${repo}/branches/main/protection`,
      "-X", "PUT", "--input", "-",
    ], {
      input: JSON.stringify({
        required_pull_request_reviews: {
          dismiss_stale_reviews: false,
          require_code_owner_reviews: false,
          required_approving_review_count: 0,
        },
        enforce_admins: false,
        required_status_checks: null,
        restrictions: null,
      }),
      cwd: projectPath,
      stdio: ["pipe", "ignore", "ignore"],
    });
    console.log(`  Enabled branch protection on main`);
  } catch {
    console.log(`  Warning: could not set up branch protection for ${projectName}`);
  }
}


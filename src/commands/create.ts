// Scaffolds a new project: mkdir + git init + private GitHub repo, then registers it (and adds to active plot if any).
import path from "node:path";
import fs from "node:fs";
import readline from "node:readline";
import { execFileSync, spawnSync } from "node:child_process";
import { loadConfig, saveConfig, addProjectToPlot, tryGetPlot, PLOT_MAX_PROJECTS } from "../config.js";
import { readDashState } from "../dashboard/state.js";
import { dashboardExists } from "../session.js";
import { refreshDashboard } from "../dashboard/header.js";
import { validateProjectName } from "./add.js";

const GITHUB_ORG = "keychange";

export async function create(args: string[]): Promise<void> {
  const rawPath = args[0];
  if (!rawPath) {
    throw new Error("Usage: garden create <path>");
  }
  const resolved = path.resolve(rawPath);
  const name = path.basename(resolved);
  validateProjectName(name);

  const config = loadConfig();
  if (config.projects[name]) {
    throw new Error(
      `A project named '${name}' already exists at ${config.projects[name].path}.`,
    );
  }
  if (fs.existsSync(resolved)) {
    throw new Error(`Path already exists: ${resolved}`);
  }

  const activePlot = readDashState().activePlot;
  if (activePlot) {
    const plot = tryGetPlot(config, activePlot);
    if (!plot) {
      throw new Error(`Active plot '${activePlot}' is missing from config.`);
    }
    if (plot.projects.length >= PLOT_MAX_PROJECTS) {
      throw new Error(
        `Active plot '${activePlot}' is full (${PLOT_MAX_PROJECTS} projects). Activate a different plot or remove a project first.`,
      );
    }
  }

  // Pre-flight before any side effects so a missing token doesn't leave a half-initialized dir behind.
  await ensureGhAuth();

  // Remote-first: org-permission failures must abort before we touch the filesystem.
  const slug = `${GITHUB_ORG}/${name}`;
  console.log(`Creating GitHub repo ${slug}...`);
  try {
    execFileSync("gh", ["repo", "create", slug, "--private"], { stdio: "inherit" });
  } catch {
    throw new Error(
      `'gh repo create ${slug}' failed (see gh's error above). Auth pre-flight passed, so re-running 'gh auth login' will not change this.`,
    );
  }

  fs.mkdirSync(resolved, { recursive: true });

  const readmePath = path.join(resolved, "README.md");
  fs.writeFileSync(readmePath, `# ${name}\n`);

  const git = (gitArgs: string[]) =>
    execFileSync("git", gitArgs, { cwd: resolved, stdio: "inherit" });

  git(["init", "-b", "main"]);
  git(["add", "README.md"]);
  git(["commit", "-m", "Initial commit"]);
  git(["remote", "add", "origin", remoteUrlFor(slug)]);
  git(["push", "-u", "origin", "main"]);

  config.projects[name] = { path: resolved };
  if (activePlot) {
    addProjectToPlot(config, activePlot, name);
  }
  saveConfig(config);

  if (activePlot) {
    console.log(`Added project '${name}' (${resolved}) to plot '${activePlot}'.`);
  } else {
    console.log(`Added project '${name}' (${resolved}). No active plot — use 'garden plot add <plot> ${name}' to attach it.`);
  }

  if (dashboardExists()) refreshDashboard();
}

function remoteUrlFor(slug: string): string {
  const r = spawnSync("gh", ["config", "get", "git_protocol"], { encoding: "utf-8" });
  const protocol = r.status === 0 ? (r.stdout ?? "").trim() : "";
  return protocol === "ssh"
    ? `git@github.com:${slug}.git`
    : `https://github.com/${slug}.git`;
}

function ghAuthOk(): boolean {
  const result = spawnSync("gh", ["auth", "status"], { stdio: "ignore" });
  return result.status === 0;
}

async function ensureGhAuth(): Promise<void> {
  if (ghAuthOk()) return;

  console.log("\x1b[33mGitHub CLI is not authenticated.\x1b[0m");
  if (!process.stdin.isTTY) {
    throw new Error("gh auth required. Run 'gh auth login -h github.com' and retry.");
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>(resolve => {
    rl.question("Run 'gh auth login' now? [y/N] ", resolve);
  });
  rl.close();

  if (answer.trim().toLowerCase() !== "y") {
    throw new Error("Aborted: gh auth required.");
  }

  const login = spawnSync("gh", ["auth", "login", "-h", "github.com"], { stdio: "inherit" });
  if (login.status !== 0) {
    throw new Error("gh auth login failed or was cancelled.");
  }
  if (!ghAuthOk()) {
    throw new Error("gh auth still not active after login. Inspect with 'gh auth status'.");
  }
}

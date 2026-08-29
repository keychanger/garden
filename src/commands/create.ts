// Scaffolds a new project: creates a private GitHub repo under the gh-authed account (or --org), then mkdir + git init + push, then registers it (and adds to active plot if any).
import path from "node:path";
import fs from "node:fs";
import readline from "node:readline";
import { execFileSync, spawnSync } from "node:child_process";
import { loadConfig, mutateConfig, addProjectToPlot, tryGetPlot, PLOT_MAX_PROJECTS, assignLogColor } from "../config.js";
import { readDashState } from "../dashboard/state.js";
import { dashboardExists } from "../session.js";
import { refreshDashboard } from "../dashboard/header.js";
import { validateProjectName } from "./add.js";

export async function create(args: string[]): Promise<void> {
  const { rawPath, org } = parseCreateArgs(args);
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

  // Remote-first: any failure here must abort before we touch the filesystem.
  const owner = org ?? currentGhUser();
  const slug = `${owner}/${name}`;
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

  mutateConfig(current => {
    if (current.projects[name]) {
      throw new Error(
        `A project named '${name}' was added concurrently at ${current.projects[name].path}.`,
      );
    }
    if (activePlot) {
      const plot = tryGetPlot(current, activePlot);
      if (!plot) throw new Error(`Active plot '${activePlot}' is missing from config.`);
      if (plot.projects.length >= PLOT_MAX_PROJECTS) {
        throw new Error(
          `Active plot '${activePlot}' became full while the repository was being created.`,
        );
      }
    }
    current.projects[name] = { path: resolved };
    assignLogColor(current, name);
    if (activePlot) addProjectToPlot(current, activePlot, name);
  });

  if (activePlot) {
    console.log(`Added project '${name}' (${resolved}) to plot '${activePlot}'.`);
  } else {
    console.log(`Added project '${name}' (${resolved}). No active plot — use 'garden plot add <plot> ${name}' to attach it.`);
  }

  if (dashboardExists()) refreshDashboard();
}

const USAGE = "Usage: garden create <path> [--org <org>]";

function parseCreateArgs(args: string[]): { rawPath: string; org?: string } {
  let rawPath: string | undefined;
  let org: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--org") {
      const value = args[++i];
      if (!value || value.startsWith("-")) {
        throw new Error("--org requires an organization name.");
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(value)) {
        throw new Error(
          `--org '${value}' is not a valid GitHub owner name (letters, digits and hyphens only).`,
        );
      }
      org = value;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown flag '${arg}'. ${USAGE}`);
    } else if (rawPath === undefined) {
      rawPath = arg;
    } else {
      throw new Error(`Unexpected argument '${arg}'. ${USAGE}`);
    }
  }

  if (!rawPath) throw new Error(USAGE);
  return { rawPath, org };
}

function currentGhUser(): string {
  const r = spawnSync("gh", ["api", "user", "-q", ".login"], { encoding: "utf-8" });
  if (r.status !== 0 || !r.stdout?.trim()) {
    throw new Error("Could not read the authenticated gh user. Run 'gh auth status' to inspect.");
  }
  return r.stdout.trim();
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

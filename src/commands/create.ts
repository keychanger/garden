// Scaffolds a new project: mkdir + git init + private GitHub repo, then registers it (and adds to active plot if any).
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
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

  fs.mkdirSync(resolved, { recursive: true });

  const readmePath = path.join(resolved, "README.md");
  fs.writeFileSync(readmePath, `# ${name}\n`);

  const git = (gitArgs: string[]) =>
    execFileSync("git", gitArgs, { cwd: resolved, stdio: "inherit" });

  git(["init", "-b", "main"]);
  git(["add", "README.md"]);
  git(["commit", "-m", "Initial commit"]);

  const slug = `${GITHUB_ORG}/${name}`;
  console.log(`Creating GitHub repo ${slug}...`);
  execFileSync(
    "gh",
    ["repo", "create", slug, "--private", "--source=.", "--remote=origin", "--push"],
    { cwd: resolved, stdio: "inherit" },
  );

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

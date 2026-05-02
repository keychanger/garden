import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import yaml from "js-yaml";
import { runCli, useGitTmpHome } from "./helpers.js";

const env = useGitTmpHome();

const PROJECT = "myproject";
const WORKER = "bold-ash";
let projectPath: string;
let originPath: string;

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function seedRegistry(workerCount: number) {
  const file = path.join(env.sessionsDir, "dashboard.registry.json");
  const workers = Array.from({ length: workerCount }, (_, i) => ({
    name: `${WORKER}-${i}`,
    sessionId: `sess-${i}`,
    task: "",
    branchName: `${WORKER}-${i}`,
    baseBranch: "main",
  }));
  fs.writeFileSync(file, JSON.stringify({ workers: { [PROJECT]: workers } }));
}

beforeEach(() => {
  // Set up a real project so reset's deleteRemoteBranch path can run without
  // throwing (no-op when origin doesn't have the branch, which is fine).
  originPath = path.join(env.home, "origin.git");
  spawnSync("git", ["init", "--bare", "-b", "main", originPath], { stdio: "ignore" });
  projectPath = path.join(env.home, "projects", PROJECT);
  fs.mkdirSync(projectPath, { recursive: true });
  spawnSync("git", ["init", "-b", "main", projectPath], { stdio: "ignore" });
  git(projectPath, "config", "user.email", "t@g.l");
  git(projectPath, "config", "user.name", "t");
  git(projectPath, "remote", "add", "origin", originPath);
  fs.writeFileSync(path.join(projectPath, "README.md"), "x\n");
  git(projectPath, "add", ".");
  git(projectPath, "commit", "-m", "init");
  git(projectPath, "push", "-u", "origin", "main");

  // Garden config so tryGetProject finds the project.
  const cfgFile = path.join(env.gardenDir, "config.yml");
  fs.writeFileSync(cfgFile, yaml.dump({
    projects: { [PROJECT]: { path: projectPath } },
  }));
});

describe("garden reset (destructive)", () => {
  it("does nothing when registry is empty", () => {
    const result = runCli(["reset"], { home: env.home, stdin: "y\n" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Registry is already empty");
  });

  it("with 'n' answer leaves registry intact", () => {
    seedRegistry(2);
    const before = fs.readFileSync(
      path.join(env.sessionsDir, "dashboard.registry.json"), "utf-8");

    const result = runCli(["reset"], { home: env.home, stdin: "n\n" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Cancelled");

    const after = fs.readFileSync(
      path.join(env.sessionsDir, "dashboard.registry.json"), "utf-8");
    expect(after).toBe(before);
  });

  it("with empty answer (default N) leaves registry intact", () => {
    seedRegistry(2);
    const result = runCli(["reset"], { home: env.home, stdin: "\n" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Cancelled");
    expect(fs.existsSync(
      path.join(env.sessionsDir, "dashboard.registry.json"))).toBe(true);
  });

  it("with 'y' answer deletes the registry file", () => {
    seedRegistry(2);
    const result = runCli(["reset"], { home: env.home, stdin: "y\n" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Registry cleared");
    expect(fs.existsSync(
      path.join(env.sessionsDir, "dashboard.registry.json"))).toBe(false);
  });

  it("preserves config.yml project entries — only the registry is destroyed", () => {
    seedRegistry(1);
    const cfgFile = path.join(env.gardenDir, "config.yml");

    runCli(["reset"], { home: env.home, stdin: "y\n" });

    // loadConfig auto-migrates (adds logColor + plots), so byte equality would
    // be too strict. The contract is: the project entry survives.
    expect(fs.existsSync(cfgFile)).toBe(true);
    const after = yaml.load(fs.readFileSync(cfgFile, "utf-8")) as {
      projects: Record<string, { path: string }>;
    };
    expect(after.projects[PROJECT].path).toBe(projectPath);
  });

  it("reports the worker count and project count in the confirmation prompt", () => {
    seedRegistry(3);
    const result = runCli(["reset"], { home: env.home, stdin: "n\n" });
    expect(result.stdout).toContain("3 worker");
    expect(result.stdout).toContain("1 project");
  });
});

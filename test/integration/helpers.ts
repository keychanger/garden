import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { beforeEach, afterEach } from "vitest";

let tmpHome: string;
let originalHome: string | undefined;

// Real-fs + real-git tmp HOME. Extends test/helpers.ts:useTmpHome by also
// initializing a git repo at <home>/repo with an initial commit, configured
// with hermetic local user.email/user.name so tests don't depend on the
// caller's git config.
export function useGitTmpHome() {
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "garden-int-"));
    originalHome = process.env.HOME;
    process.env.HOME = tmpHome;
    fs.mkdirSync(path.join(tmpHome, ".garden", "sessions"), { recursive: true });

    const repoPath = path.join(tmpHome, "repo");
    fs.mkdirSync(repoPath, { recursive: true });
    spawnSync("git", ["init", "-b", "main", repoPath], { stdio: "ignore" });
    spawnSync("git", ["config", "user.email", "test@garden.local"], { cwd: repoPath, stdio: "ignore" });
    spawnSync("git", ["config", "user.name", "garden-test"], { cwd: repoPath, stdio: "ignore" });
    fs.writeFileSync(path.join(repoPath, "README.md"), "# test\n");
    spawnSync("git", ["add", "."], { cwd: repoPath, stdio: "ignore" });
    spawnSync("git", ["commit", "-m", "init"], { cwd: repoPath, stdio: "ignore" });
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  return {
    get home() { return tmpHome; },
    get gardenDir() { return path.join(tmpHome, ".garden"); },
    get sessionsDir() { return path.join(tmpHome, ".garden", "sessions"); },
    get repoPath() { return path.join(tmpHome, "repo"); },
  };
}

export interface RunCliResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

export interface RunCliOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  home?: string;
}

// Spawns the built CLI as a real subprocess. Requires `npm run build` to have
// produced dist/cli.js (CI runs build before test:integration). HOME defaults
// to the active useGitTmpHome's tmp dir if process.env.HOME points there.
export function runCli(args: string[], opts: RunCliOptions = {}): RunCliResult {
  const cliPath = path.resolve(process.cwd(), "dist/cli.js");
  if (!fs.existsSync(cliPath)) {
    throw new Error(
      `runCli: ${cliPath} does not exist — run \`npm run build\` before integration tests`,
    );
  }
  const env = {
    ...process.env,
    ...(opts.home ? { HOME: opts.home } : {}),
    ...opts.env,
  };
  const result = spawnSync("node", [cliPath, ...args], {
    cwd: opts.cwd,
    env,
    input: opts.stdin,
    encoding: "utf8",
    timeout: 15000,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status,
  };
}

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { beforeEach, afterEach, vi } from "vitest";
import { SAFE_GIT_CONFIG } from "../src/dashboard/git-exec.js";

// A git argv as the subcommand sees it: garden prefixes its own git with
// SAFE_GIT_CONFIG (hooks and fsmonitor off), which mocks routing on the
// subcommand should look past.
export function gitSubcommandArgs(argv: readonly string[] | undefined): readonly string[] | undefined {
  if (!argv) return argv;
  const prefixed = SAFE_GIT_CONFIG.every((arg, i) => argv[i] === arg);
  return prefixed ? argv.slice(SAFE_GIT_CONFIG.length) : argv;
}

let tmpHome: string;
let originalHome: string | undefined;

export async function captureConsoleLog(fn: () => Promise<void> | void): Promise<string[]> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try { await fn(); } finally { console.log = orig; }
  return lines;
}

export function useTmpHome() {
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "garden-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tmpHome;
    fs.mkdirSync(path.join(tmpHome, ".garden", "sessions"), { recursive: true });
    fs.mkdirSync(path.join(tmpHome, ".garden", "control"), { recursive: true });
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
    vi.resetModules();
  });

  return {
    get home() { return tmpHome; },
    get gardenDir() { return path.join(tmpHome, ".garden"); },
    get sessionsDir() { return path.join(tmpHome, ".garden", "sessions"); },
    get controlDir() { return path.join(tmpHome, ".garden", "control"); },
  };
}

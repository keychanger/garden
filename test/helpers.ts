import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { beforeEach, afterEach, vi } from "vitest";

let tmpHome: string;
let originalHome: string | undefined;

export function useTmpHome() {
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "garden-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tmpHome;
    fs.mkdirSync(path.join(tmpHome, ".garden", "sessions"), { recursive: true });
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
  };
}

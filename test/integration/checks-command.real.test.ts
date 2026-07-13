// `garden checks` end-to-end through the real CLI: runs the project's
// configured checks command under the machine-wide slot semaphore, passes
// the child's exit code through, and leaves no slot file behind. Queueing
// behavior under contention is covered at the primitive level in
// test/checks-semaphore.test.ts — the slot count here is hardware-derived,
// so a multi-run contention test would be machine-dependent.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { runCli, useGitTmpHome } from "./helpers.js";

const env = useGitTmpHome();

// `garden add` derives the project name from the path basename — the
// hermetic repo registers as "repo".
function setup(checksCommand?: string): void {
  runCli(["init"], { home: env.home });
  runCli(["add", env.repoPath], { home: env.home });
  if (checksCommand) {
    runCli(["config", "repo", "checks", checksCommand], { home: env.home });
  }
}

function slotFiles(): string[] {
  return fs
    .readdirSync(path.join(env.gardenDir, "sessions"))
    .filter((f) => f.startsWith("checks-slot-"));
}

describe("garden checks (real CLI)", () => {
  it("runs the configured command and exits 0 on success", () => {
    setup("echo checks-ran && exit 0");
    const result = runCli(["checks", "repo"], { home: env.home });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("checks-ran");
    expect(result.stderr).toContain("running:");
    expect(slotFiles()).toEqual([]);
  });

  it("passes the command's non-zero exit code through and still releases the slot", () => {
    setup("exit 3");
    const result = runCli(["checks", "repo"], { home: env.home });
    expect(result.status).toBe(3);
    expect(slotFiles()).toEqual([]);
  });

  it("errors when the project has no checks command configured", () => {
    setup();
    const result = runCli(["checks", "repo"], { home: env.home });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no checks command configured");
  });

  it("runs the command in the caller's cwd, not the project root", () => {
    setup("pwd");
    const sub = path.join(env.repoPath, "sub");
    fs.mkdirSync(sub);
    const result = runCli(["checks", "repo"], { home: env.home, cwd: sub });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(fs.realpathSync(sub));
  });
});

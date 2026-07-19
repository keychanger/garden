import { describe, it, expect } from "vitest";
import { runCli, useGitTmpHome } from "./helpers.js";

const env = useGitTmpHome();

describe("cli version + help (canary)", () => {
  it("prints the version and exits 0 on --version", () => {
    const result = runCli(["--version"], { home: env.home });
    expect(result.status).toBe(0);
    const out = result.stdout.trim();
    // Stamped git SHA under a real build, "dev" under tsx — either way a single
    // non-empty token, never the help text.
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toContain(" ");
    expect(out).not.toContain("Usage:");
  });

  it("prints the version on the bare `version` subcommand", () => {
    const result = runCli(["version"], { home: env.home });
    expect(result.status).toBe(0);
    expect(result.stdout.trim().length).toBeGreaterThan(0);
  });

  it("prints help text and exits 0", () => {
    const result = runCli(["help"], { home: env.home });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("garden");
    expect(result.stdout).toContain("Usage:");
  });

  it("prints help when given --help", () => {
    const result = runCli(["--help"], { home: env.home });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage:");
  });

  it("exits non-zero on unknown command", () => {
    const result = runCli(["definitely-not-a-command"], { home: env.home });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unknown command");
  });
});

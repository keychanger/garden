import { describe, it, expect } from "vitest";
import { runCli, useGitTmpHome } from "./helpers.js";

const env = useGitTmpHome();

describe("cli help (canary)", () => {
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

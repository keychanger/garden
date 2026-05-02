import { describe, it, expect } from "vitest";
import { runCli, useGitTmpHome } from "./helpers.js";

const env = useGitTmpHome();

describe("cli dispatch", () => {
  it("with no args prints help and exits 0", () => {
    const result = runCli([], { home: env.home });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage:");
  });

  it("resolves the 'ls' alias to the list command", () => {
    runCli(["init"], { home: env.home });
    const result = runCli(["ls"], { home: env.home });
    expect(result.status).toBe(0);
  });

  it("resolves the 'p' alias to the plot command", () => {
    runCli(["init"], { home: env.home });
    const result = runCli(["p"], { home: env.home });
    expect(result.status).toBe(0);
  });

  it("resolves the 'register' alias to the add command", () => {
    runCli(["init"], { home: env.home });
    const result = runCli(["register", "--help"], { home: env.home });
    // register is an alias; doesn't error on dispatch even if the underlying
    // command rejects --help. The point is the dispatcher routed it.
    expect(result.stderr).not.toContain("Unknown command");
  });

  it("emits the help-pointer hint on unknown command", () => {
    const result = runCli(["nope"], { home: env.home });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown command");
    expect(result.stderr).toContain("Run 'garden help'");
  });

  it("commands that throw exit non-zero with Error: prefix", () => {
    // pause requires a worker arg; missing arg throws "Usage: garden pause <worker>"
    const result = runCli(["pause"], { home: env.home });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Error:");
    expect(result.stderr).toContain("Usage:");
  });
});

import { describe, it, expect } from "vitest";
import { buildSandboxConfig } from "../src/dashboard/sandbox.js";

describe("buildSandboxConfig", () => {
  it("enables sandbox with auto-allow for bash", () => {
    const cfg = buildSandboxConfig({
      worktreePath: "/wt/alpha",
      project: { path: "/repo" },
      remoteHost: null,
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.autoAllowBashIfSandboxed).toBe(true);
  });

  it("includes the worktree path and standard subprocess cache paths in allowWrite", () => {
    const cfg = buildSandboxConfig({
      worktreePath: "/wt/alpha",
      project: { path: "/repo" },
      remoteHost: null,
    });
    expect(cfg.filesystem.allowWrite).toContain("/wt/alpha");
    expect(cfg.filesystem.allowWrite).toContain("~/.npm");
    expect(cfg.filesystem.allowWrite).toContain("/tmp");
  });

  it("includes Anthropic, github, and npm in default domains", () => {
    const cfg = buildSandboxConfig({
      worktreePath: "/wt/alpha",
      project: { path: "/repo" },
      remoteHost: null,
    });
    expect(cfg.network.allowedDomains).toContain("api.anthropic.com");
    expect(cfg.network.allowedDomains).toContain("github.com");
    expect(cfg.network.allowedDomains).toContain("registry.npmjs.org");
  });

  it("adds the git remote host when provided", () => {
    const cfg = buildSandboxConfig({
      worktreePath: "/wt/alpha",
      project: { path: "/repo" },
      remoteHost: "gitlab.example.com",
    });
    expect(cfg.network.allowedDomains).toContain("gitlab.example.com");
  });

  it("extends allowed domains with per-project sandboxDomains", () => {
    const cfg = buildSandboxConfig({
      worktreePath: "/wt/alpha",
      project: { path: "/repo", sandboxDomains: ["private.example.com", "cdn.example.com"] },
      remoteHost: null,
    });
    expect(cfg.network.allowedDomains).toContain("private.example.com");
    expect(cfg.network.allowedDomains).toContain("cdn.example.com");
  });

  it("does not duplicate the remote host when it is already a default domain", () => {
    const cfg = buildSandboxConfig({
      worktreePath: "/wt/alpha",
      project: { path: "/repo" },
      remoteHost: "github.com",
    });
    const occurrences = cfg.network.allowedDomains.filter((d) => d === "github.com").length;
    expect(occurrences).toBe(1);
  });
});

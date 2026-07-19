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

  // The convert path's primary DX is `/grow N` typed inside a worker pane,
  // which runs `garden workers grow $GARDEN_WORKER ...`. That CLI mutates
  // the registry at ~/.garden/sessions/dashboard.registry.json via the
  // withFileLock + atomicWriteFile pattern (lock file + temp staging file
  // in the same directory). Without the sessions dir in allowWrite, every
  // convert invocation hits an EPERM and requires a sandbox-bypass
  // approval — friction the slash skill UX cannot afford.
  it("allows writes to ~/.garden/sessions so the convert CLI works without bypass", () => {
    const cfg = buildSandboxConfig({
      worktreePath: "/wt/alpha",
      project: { path: "/repo" },
      remoteHost: null,
    });
    expect(cfg.filesystem.allowWrite).toContain("~/.garden/sessions");
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

  it("retains both the bare and wildcard forms for the same host (sandbox runtime matches both)", () => {
    // The defaults declare both `api.anthropic.com` and `*.anthropic.com`
    // intentionally — the bare form covers the load-bearing API host even
    // if the runtime sandbox's wildcard implementation is conservative.
    // A future cleanup that drops one form should be a deliberate spec
    // decision, not an accident; this test pins both.
    const cfg = buildSandboxConfig({
      worktreePath: "/wt/alpha",
      project: { path: "/repo" },
      remoteHost: null,
    });
    expect(cfg.network.allowedDomains).toContain("api.anthropic.com");
    expect(cfg.network.allowedDomains).toContain("*.anthropic.com");
    expect(cfg.network.allowedDomains).toContain("github.com");
    expect(cfg.network.allowedDomains).toContain("*.github.com");
  });

  it("dedupes per-project domains when they overlap with defaults", () => {
    // Operator types `api.anthropic.com` into sandboxDomains by mistake —
    // already a default; should not appear twice.
    const cfg = buildSandboxConfig({
      worktreePath: "/wt/alpha",
      project: { path: "/repo", sandboxDomains: ["api.anthropic.com", "private.example.com"] },
      remoteHost: null,
    });
    const occurrences = cfg.network.allowedDomains.filter((d) => d === "api.anthropic.com").length;
    expect(occurrences).toBe(1);
    expect(cfg.network.allowedDomains).toContain("private.example.com");
  });

  it("dedupes overlapping allowWrite paths (worktree path passed twice)", () => {
    // The worktree path is added unconditionally; if the operator also
    // passed it explicitly (or a future config layer adds duplicates),
    // it shouldn't appear twice. Guards against accidental list bloat
    // that would obscure the actual write surface in audit output.
    const cfg = buildSandboxConfig({
      worktreePath: "/tmp",
      project: { path: "/repo" },
      remoteHost: null,
    });
    const occurrences = cfg.filesystem.allowWrite.filter((p) => p === "/tmp").length;
    expect(occurrences).toBe(1);
  });

  it("emits no credential read-deny by default (opt-in, must not change existing fleets)", () => {
    const cfg = buildSandboxConfig({
      worktreePath: "/wt/alpha",
      project: { path: "/repo" },
      remoteHost: null,
    });
    expect(cfg.credentials).toBeUndefined();
    expect(cfg.filesystem.denyRead).toBeUndefined();
  });

  it("denies read of operator credentials when sandboxDenyCredentials is set", () => {
    const cfg = buildSandboxConfig({
      worktreePath: "/wt/alpha",
      project: { path: "/repo", sandboxDenyCredentials: true },
      remoteHost: null,
    });
    // Purpose-built credentials guard, deny mode only (mask is ignored in repo
    // settings, so never emitted).
    expect(cfg.credentials?.files).toEqual(
      expect.arrayContaining([{ path: "~/.claude", mode: "deny" }, { path: "~/.ssh", mode: "deny" }]),
    );
    expect(cfg.credentials?.files.every((f) => f.mode === "deny")).toBe(true);
    // Plus the OS-level read-deny for the same paths.
    expect(cfg.filesystem.denyRead).toContain("~/.claude");
    expect(cfg.filesystem.denyRead).toContain("~/.ssh");
  });
});

// Harness registry + claude-code adapter dialect (docs/MULTI-MODEL.md
// "Layer 3"). The command-shape tests pin the exact strings the launch
// paths previously inlined — the Phase 3 extraction is bit-for-bit, so
// these are the regression net for the collapse.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/dashboard/tmux.js", () => ({
  // Mirror the real shellEscape: safe tokens pass through unquoted.
  shellEscape: vi.fn((s: string) =>
    /^[a-zA-Z0-9_./:=-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`,
  ),
  pasteAndSubmit: vi.fn(),
}));

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.resetModules());

async function importHarness() {
  return await import("../src/dashboard/harness/index.js");
}
async function importCore() {
  return await import("../src/dashboard/harness/core.js");
}

describe("harness registries", () => {
  it("resolves the default adapter when no name is given", async () => {
    const { getHarness } = await importHarness();
    expect(getHarness().name).toBe("claude-code");
    expect(getHarness(undefined).name).toBe("claude-code");
  });

  it("falls back to the default on unknown names with a warning", async () => {
    const { getHarness } = await importHarness();
    const { log } = await import("../src/dashboard/log.js");
    expect(getHarness("opencode").name).toBe("claude-code");
    expect(log.warn).toHaveBeenCalledWith(
      "harness", expect.stringContaining("unknown harness"), expect.anything(),
    );
  });

  it("core registry resolves the same names with the same fallback", async () => {
    const { getHarnessCore } = await importCore();
    expect(getHarnessCore().name).toBe("claude-code");
    expect(getHarnessCore("ghost").name).toBe("claude-code");
  });

  it("the full adapter is the core plus installRuntimeConfig", async () => {
    const { getHarness } = await importHarness();
    const { getHarnessCore } = await importCore();
    const full = getHarness();
    const core = getHarnessCore();
    expect(typeof full.installRuntimeConfig).toBe("function");
    expect(full.buildAgentCommand).toBe(core.buildAgentCommand);
    expect(full.isTransientError).toBe(core.isTransientError);
  });
});

describe("claude-code adapter dialect", () => {
  it("builds the interactive launch command (new session)", async () => {
    const { getHarnessCore } = await importCore();
    const cmd = getHarnessCore().buildAgentCommand({
      sessionId: "abc-123", resume: false, contextFile: "/tmp/ctx.md",
      envPrefix: "CLAUDE_CONFIG_DIR=/p ",
    });
    expect(cmd).toBe(
      "CLAUDE_CONFIG_DIR=/p claude --rc --session-id abc-123 --append-system-prompt-file /tmp/ctx.md",
    );
  });

  it("builds the resume command with a model pin", async () => {
    const { getHarnessCore } = await importCore();
    const cmd = getHarnessCore().buildAgentCommand({
      sessionId: "abc-123", resume: true, contextFile: "/tmp/ctx.md",
      model: "deepseek-v4-pro", envPrefix: "",
    });
    expect(cmd).toBe(
      "claude --rc --model deepseek-v4-pro --resume abc-123 --append-system-prompt-file /tmp/ctx.md",
    );
  });

  it("builds the ultracode launch command (max effort + workflow trigger + Opus pin)", async () => {
    const { getHarnessCore } = await importCore();
    const cmd = getHarnessCore().buildAgentCommand({
      sessionId: "abc-123", resume: false, contextFile: "/tmp/ctx.md",
      model: "opus[1m]", ultracode: true, envPrefix: "",
    });
    expect(cmd).toBe(
      "claude --rc --model 'opus[1m]' --effort max "
      + "--settings '{\"ultracodeKeywordTrigger\":\"on\"}' "
      + "--session-id abc-123 --append-system-prompt-file /tmp/ctx.md",
    );
  });

  it("omits ultracode flags when the flag is unset", async () => {
    const { getHarnessCore } = await importCore();
    const cmd = getHarnessCore().buildAgentCommand({
      sessionId: "abc-123", resume: false, contextFile: "/tmp/ctx.md",
      envPrefix: "",
    });
    expect(cmd).not.toContain("--effort");
    expect(cmd).not.toContain("--settings");
  });

  it("builds the headless command core", async () => {
    const { getHarnessCore } = await importCore();
    const cmd = getHarnessCore().buildHeadlessCommand({
      promptFile: "/tmp/p.txt", resultFile: "/tmp/r.txt",
      model: "opus", envPrefix: "CLAUDE_CONFIG_DIR=/p ", inlineEnv: "GARDEN_REVIEWER=1 ",
    });
    expect(cmd).toBe(
      "GARDEN_REVIEWER=1 CLAUDE_CONFIG_DIR=/p claude -p --model opus < /tmp/p.txt > /tmp/r.txt 2>&1",
    );
  });

  it("mints UUID session ids", async () => {
    const { getHarnessCore } = await importCore();
    expect(getHarnessCore().allocateSessionId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("declares Tier A capabilities", async () => {
    const { getHarnessCore } = await importCore();
    expect(getHarnessCore().capabilities).toEqual({
      turnEnd: true,
      promptSubmitted: true,
      toolActivity: true,
      askingSignal: true,
      resume: true,
      sandbox: true,
      skills: true,
    });
  });

  it("routes prompt delivery through pasteAndSubmit", async () => {
    const { getHarnessCore } = await importCore();
    const { pasteAndSubmit } = await import("../src/dashboard/tmux.js");
    getHarnessCore().deliverPrompt("%5", "hello");
    expect(pasteAndSubmit).toHaveBeenCalledWith("%5", "hello");
  });
});

describe("codex adapter dialect", () => {
  it("is registered in both registries", async () => {
    const { getHarness } = await importHarness();
    const { getHarnessCore } = await importCore();
    expect(getHarnessCore("codex").name).toBe("codex");
    expect(getHarness("codex").name).toBe("codex");
    expect(typeof getHarness("codex").installRuntimeConfig).toBe("function");
  });

  it("builds the headless command: stdout->result, stderr->sidecar, no hook-trust bypass", async () => {
    const { getHarnessCore } = await importCore();
    const cmd = getHarnessCore("codex").buildHeadlessCommand({
      promptFile: "/tmp/p.txt", resultFile: "/tmp/r.txt",
      model: "gpt-5-codex", envPrefix: "", inlineEnv: "GARDEN_REVIEWER=1 ",
    });
    // The verdict is stdout's last line; the token trailer is stderr, so the
    // result file is stdout-only (not 2>&1) with stderr to a sidecar.
    expect(cmd).toBe(
      "GARDEN_REVIEWER=1 codex exec --dangerously-bypass-approvals-and-sandbox -m gpt-5-codex"
      + " < /tmp/p.txt > /tmp/r.txt 2> /tmp/r.txt.stderr",
    );
    // A headless reviewer must NOT bypass hook trust — it wants Codex to skip
    // the worktree's untrusted hooks so it fires no relay of its own.
    expect(cmd).not.toContain("--dangerously-bypass-hook-trust");
  });

  it("builds the interactive launch: no --session-id, hook-trust bypass on, real workspace-write sandbox", async () => {
    const { getHarnessCore } = await importCore();
    const fresh = getHarnessCore("codex").buildAgentCommand({
      sessionId: "", resume: false, contextFile: "/ignored", model: "gpt-5-codex", envPrefix: "",
    });
    // Event relay needs the hook-trust bypass; the model flag rides through.
    expect(fresh).toContain("codex --dangerously-bypass-hook-trust");
    expect(fresh).toContain("-m gpt-5-codex");
    expect(fresh).not.toContain("--session-id");
    // A worker runs under Codex's own workspace-write sandbox, NOT the
    // reviewer's blanket bypass. Network on (for `git push`), approvals off.
    expect(fresh).toContain("-s workspace-write");
    expect(fresh).toContain("-a never");
    expect(fresh).toContain("sandbox_workspace_write.network_access=true");
    expect(fresh).toContain("sandbox_workspace_write.writable_roots=[");
    expect(fresh).not.toContain("--dangerously-bypass-approvals-and-sandbox");

    // Pin HOME to assert the writable_roots content, comma-joining, TOML
    // quoting, and shell-escaping the loose toContain above cannot see — the
    // three roots must mirror the HOME-based entries of DEFAULT_ALLOW_WRITE.
    const savedHome = process.env.HOME;
    process.env.HOME = "/home/fixture";
    try {
      const pinned = getHarnessCore("codex").buildAgentCommand({
        sessionId: "", resume: false, contextFile: "/ignored", envPrefix: "",
      });
      expect(pinned).toContain(
        `-c 'sandbox_workspace_write.writable_roots=["/home/fixture/.npm", ` +
        `"/home/fixture/.cache", "/home/fixture/.garden/sessions"]'`,
      );
    } finally {
      process.env.HOME = savedHome;
    }

    const resume = getHarnessCore("codex").buildAgentCommand({
      sessionId: "019f-abc", resume: true, contextFile: "/ignored", envPrefix: "",
    });
    expect(resume).toContain("codex resume 019f-abc --dangerously-bypass-hook-trust");
    expect(resume).toContain("-s workspace-write");
    expect(resume).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("adds the worktree git common dir to the sandbox writable roots", async () => {
    const { getHarnessCore } = await importCore();
    // A linked worktree's git store lives at the main checkout's .git, outside
    // cwd — Codex workspace-write must be granted it or the worker cannot
    // commit/push (claude-code's sandbox auto-grants it; Codex's does not).
    const withGit = getHarnessCore("codex").buildAgentCommand({
      sessionId: "", resume: false, contextFile: "/ignored", envPrefix: "",
      worktreeGitDir: "/Users/x/proj/.git",
    });
    expect(withGit).toContain('"/Users/x/proj/.git"');
    expect(withGit).toContain("sandbox_workspace_write.writable_roots=[");
    // Absent when no git dir is threaded (e.g. the ad-hoc project-dir launch).
    const withoutGit = getHarnessCore("codex").buildAgentCommand({
      sessionId: "", resume: false, contextFile: "/ignored", envPrefix: "",
    });
    expect(withoutGit).not.toContain("/.git\"");
  });

  it("allocateSessionId returns the empty sentinel (Codex assigns its own)", async () => {
    const { getHarnessCore } = await importCore();
    expect(getHarnessCore("codex").allocateSessionId()).toBe("");
  });

  it("declares capabilities (skills folded into rules)", async () => {
    const { getHarnessCore } = await importCore();
    expect(getHarnessCore("codex").capabilities).toEqual({
      turnEnd: true, promptSubmitted: true, toolActivity: true, askingSignal: true,
      resume: true, sandbox: true, skills: false,
    });
  });

  it("classifies a transient backend error but not a clean verdict", async () => {
    const { getHarnessCore } = await importCore();
    const t = getHarnessCore("codex").isTransientError;
    expect(t("some progress\nERROR: 429 rate limit exceeded")).toBe(true);
    expect(t('done\n{"type":"server_error","message":"x"}')).toBe(true);
    expect(t("Reviewed the diff.\nFIXED")).toBe(false);
  });

  it("claude quotaLimitResetHint detects a session-limit cutoff, not a verdict body", async () => {
    const { getHarnessCore } = await importCore();
    const q = getHarnessCore("claude-code").quotaLimitResetHint;
    // Observed message (middle-dot separator) -> reset hint extracted.
    expect(q("Reviewing…\nYou've hit your session limit · resets 3:40pm (America/Denver)"))
      .toBe("3:40pm (America/Denver)");
    // Apostrophe-agnostic; a hit with no parseable reset -> "" (not null).
    expect(q("Youve hit your usage limit")).toBe("");
    // Line-start anchored: a verdict body merely mentioning it is NOT a hit.
    expect(q("We gracefully handle the session limit reset here.\nCLEAN")).toBeNull();
    // A transient API error is not a quota cutoff.
    expect(q("API Error: 529 overloaded")).toBeNull();
  });

  it("codex quotaLimitResetHint detects insufficient_quota / usage-limit, not a transient 429", async () => {
    const { getHarnessCore } = await importCore();
    const q = getHarnessCore("codex").quotaLimitResetHint;
    expect(q('stream\nERROR: 429 {"type":"insufficient_quota"}')).toBe("");
    expect(q("error: usage limit reached, resets in 2h")).toBe("2h");
    // A bare 429 rate-limit is transient, not a quota cutoff -> null.
    expect(q("some progress\nERROR: 429 rate limit exceeded")).toBeNull();
    expect(q("Reviewed the diff.\nFIXED")).toBeNull();
  });

  it("readTurns parses the rollout into turns with verb tagging", async () => {
    const { getHarnessCore } = await importCore();
    const fixture = path.join(HERE, "fixtures/codex/rollout-sample.jsonl");
    const turns = getHarnessCore("codex").readTurns(fixture);
    expect(turns).toHaveLength(4);
    expect(turns[0]).toMatchObject({ role: "user", text: "Review calc.py for bugs and fix them." });
    // a patch_apply_end since the last prompt -> "worked"
    expect(turns[1]).toMatchObject({ role: "assistant", text: "Fixed the off-by-sign bug in add().", verb: "worked" });
    expect(turns[2]).toMatchObject({ role: "user", text: "What does calc.py do now?" });
    // no tools since the last prompt -> "answered"
    expect(turns[3]).toMatchObject({ role: "assistant", verb: "answered" });
  });

  it("readTurns tags a tool-only turn (no edit) as planned", async () => {
    const { getHarnessCore } = await importCore();
    const fixture = path.join(HERE, "fixtures/codex/rollout-planned.jsonl");
    const turns = getHarnessCore("codex").readTurns(fixture);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ role: "user", text: "What files are in the repo?" });
    // a non-edit tool call (exec_command) since the last prompt, no patch_apply_end -> "planned"
    expect(turns[1]).toMatchObject({ role: "assistant", verb: "planned" });
  });

  it("readTurns returns [] for a null or unreadable path", async () => {
    const { getHarnessCore } = await importCore();
    expect(getHarnessCore("codex").readTurns(null)).toEqual([]);
    expect(getHarnessCore("codex").readTurns("/no/such/rollout.jsonl")).toEqual([]);
  });
});

describe("codex -c hook injection (worker turn-end relay)", () => {
  it("injects the lifecycle hooks with garden's wire event names", async () => {
    const { getHarnessCore } = await importCore();
    // Hooks ride the launch command as -c overrides, NOT a .codex/hooks.json
    // file: Codex resolves project hooks at the repo root, so a file written
    // into a linked worktree never fires (verified 2026-07-06).
    const cmd = getHarnessCore("codex").buildAgentCommand({
      sessionId: "", resume: false, contextFile: "/ignored", envPrefix: "",
    });
    expect(cmd).toMatch(/hooks\.SessionStart=.*sessionstart"/);
    expect(cmd).toMatch(/hooks\.UserPromptSubmit=.* prompt"/);
    expect(cmd).toMatch(/hooks\.Stop=.* stop"/);
    expect(cmd).toMatch(/hooks\.PostToolUse=.*posttooluse"/);
    // Codex PreToolUse fires for every tool -> a working heartbeat, not asking.
    expect(cmd).toMatch(/hooks\.PreToolUse=.*posttooluse"/);
    // PermissionRequest is the real blocked-on-operator signal.
    expect(cmd).toMatch(/hooks\.PermissionRequest=.*pretooluse"/);
    // The relay only fires with the hook-trust bypass (garden's hooks are
    // programmatically written, hence untrusted).
    expect(cmd).toContain("--dangerously-bypass-hook-trust");
  });
});

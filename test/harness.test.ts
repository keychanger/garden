// Harness registry + claude-code adapter dialect (docs/MULTI-MODEL.md
// "Layer 3"). The command-shape tests pin the exact strings the launch
// paths previously inlined — the Phase 3 extraction is bit-for-bit, so
// these are the regression net for the collapse.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  HeadlessLaunchPlan,
  HeadlessRole,
  WorkerLaunchPlan,
} from "../src/dashboard/harness/types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function workerPlan(
  harness: string,
  overrides: Partial<WorkerLaunchPlan> = {},
): WorkerLaunchPlan {
  return {
    role: "worker",
    harness,
    backend: { kind: "harness-account" },
    credential: { kind: "harness-account" },
    envPrefix: "",
    executionPolicy: "sandboxed-worker",
    requiredCapabilities: {
      turnEnd: true, sandbox: true, workflow: "default",
      resume: false, providerProfiles: false,
    },
    runtimeProject: { path: "/repo" },
    resolvedProvider: null,
    ...overrides,
  };
}

function headlessPlan(
  harness: string,
  role: HeadlessRole = "reviewer",
  overrides: Partial<HeadlessLaunchPlan> = {},
): HeadlessLaunchPlan {
  return {
    role,
    harness,
    backend: { kind: "harness-account" },
    credential: { kind: "harness-account" },
    envPrefix: "",
    executionPolicy: "trusted-headless",
    requiredCapabilities: { headlessRole: role },
    ...overrides,
  };
}

// Real captured `codex exec` stderr (codex 0.144.5, 2026-07-16) — a
// ChatGPT-subscription account out of quota. stdout was empty; this line
// appeared on stderr (twice). The reset is a concrete far-future date phrased
// as "try again at <date>", NOT the "resets …" phrasing claude-code uses.
const REAL_CODEX_QUOTA_STDERR =
  "ERROR: You've hit your usage limit. Upgrade to Plus to continue using Codex " +
  "(https://chatgpt.com/explore/plus), or try again at Jul 31st, 2026 11:43 AM.";

vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/dashboard/tmux.js", () => ({
  // Mirror the real shellEscape: safe tokens pass through unquoted.
  shellEscape: vi.fn((s: string) =>
    /^[a-zA-Z0-9_./:=-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`,
  ),
  pasteAndSubmit: vi.fn(),
  // conversation.ts strips terminal escapes from transcript text before it is
  // summarized; the codex reader reaches it through summarizeTurn/promptTurn.
  stripControlSequences: vi.fn((s: string) => s),
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

  it("resolveWorkerActivity reads the pane title only for a harness without its own source", async () => {
    const { resolveWorkerActivity } = await importCore();
    const paneTitle = vi.fn(() => "Analyze bot performance");

    const claude = { name: "w", harness: "claude-code", task: "" } as never;
    expect(resolveWorkerActivity(claude, paneTitle)).toBe("Analyze bot performance");

    // Codex owns the field: the pane title thunk is never even invoked, so its
    // tmux forks are not paid, and a null read means "keep the previous
    // summary" rather than falling through to the (useless) title.
    paneTitle.mockClear();
    const codex = { name: "w", harness: "codex", task: "", transcriptPath: "/no/such.jsonl" } as never;
    expect(resolveWorkerActivity(codex, paneTitle)).toBeNull();
    expect(paneTitle).not.toHaveBeenCalled();
  });

  it("canonicalHarnessName maps the 'claude' alias to the registry name", async () => {
    const { canonicalHarnessName } = await importCore();
    // The crew member name for claude-code is "claude"; accept it as an alias.
    expect(canonicalHarnessName("claude")).toBe("claude-code");
    // Registry names and genuine unknowns pass through unchanged so validation
    // still rejects a true unknown.
    expect(canonicalHarnessName("claude-code")).toBe("claude-code");
    expect(canonicalHarnessName("codex")).toBe("codex");
    expect(canonicalHarnessName("bogus")).toBe("bogus");
  });
});

describe("claude-code adapter dialect", () => {
  it("builds the interactive launch command (new session)", async () => {
    const { getHarnessCore } = await importCore();
    const cmd = getHarnessCore().buildAgentCommand({
      sessionId: "abc-123", resume: false, contextFile: "/tmp/ctx.md",
      launchPlan: workerPlan("claude-code", { envPrefix: "CLAUDE_CONFIG_DIR=/p " }),
    });
    expect(cmd).toBe(
      "CLAUDE_CONFIG_DIR=/p claude --rc --session-id abc-123 --append-system-prompt-file /tmp/ctx.md",
    );
  });

  it("builds the resume command with a model pin", async () => {
    const { getHarnessCore } = await importCore();
    const cmd = getHarnessCore().buildAgentCommand({
      sessionId: "abc-123", resume: true, contextFile: "/tmp/ctx.md",
      launchPlan: workerPlan("claude-code", { model: "deepseek-v4-pro" }),
    });
    expect(cmd).toBe(
      "claude --rc --model deepseek-v4-pro --resume abc-123 --append-system-prompt-file /tmp/ctx.md",
    );
  });

  it("builds the ultracode launch command (max effort + workflow trigger + Opus pin)", async () => {
    const { getHarnessCore } = await importCore();
    const cmd = getHarnessCore().buildAgentCommand({
      sessionId: "abc-123", resume: false, contextFile: "/tmp/ctx.md",
      launchPlan: workerPlan("claude-code", { model: "opus[1m]", ultracode: true }),
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
      launchPlan: workerPlan("claude-code"),
    });
    expect(cmd).not.toContain("--effort");
    expect(cmd).not.toContain("--settings");
  });

  it("renders --effort for a plain effort rung, after --model", async () => {
    const { getHarnessCore } = await importCore();
    const cmd = getHarnessCore().buildAgentCommand({
      sessionId: "abc-123", resume: false, contextFile: "/tmp/ctx.md",
      launchPlan: workerPlan("claude-code", { model: "sonnet", effort: "xhigh" }),
    });
    expect(cmd).toBe(
      "claude --rc --model sonnet --effort xhigh "
      + "--session-id abc-123 --append-system-prompt-file /tmp/ctx.md",
    );
  });

  it("suppresses effort when ultracode is set (ultracode already fixes max effort)", async () => {
    const { getHarnessCore } = await importCore();
    const cmd = getHarnessCore().buildAgentCommand({
      sessionId: "abc-123", resume: false, contextFile: "/tmp/ctx.md",
      launchPlan: workerPlan("claude-code", { effort: "high", ultracode: true }),
    });
    // Exactly one --effort (max), no duplicate from the effort rung.
    expect(cmd.match(/--effort/g)).toHaveLength(1);
    expect(cmd).toContain("--effort max");
    expect(cmd).not.toContain("--effort high");
  });

  it("builds the headless command core", async () => {
    const { getHarnessCore } = await importCore();
    const cmd = getHarnessCore().buildHeadlessCommand({
      promptFile: "/tmp/p.txt", resultFile: "/tmp/r.txt",
      launchPlan: headlessPlan("claude-code", "reviewer", {
        model: "opus", envPrefix: "CLAUDE_CONFIG_DIR=/p ",
      }),
      inlineEnv: "GARDEN_REVIEWER=1 ",
    });
    expect(cmd).toBe(
      "GARDEN_REVIEWER=1 CLAUDE_CONFIG_DIR=/p claude -p --permission-mode acceptEdits --model opus < /tmp/p.txt > /tmp/r.txt 2>&1",
    );
  });

  it("renders --effort on the headless command when the role resolves one", async () => {
    // `--effort` is a TOP-LEVEL claude flag, so it composes with `-p` exactly
    // as with the interactive launch — verified against claude 2.1.215, which
    // is what makes a review-effort dial possible at all.
    const { getHarnessCore } = await importCore();
    const cmd = getHarnessCore().buildHeadlessCommand({
      promptFile: "/tmp/p.txt", resultFile: "/tmp/r.txt",
      launchPlan: headlessPlan("claude-code", "reviewer", {
        model: "opus", effort: "max",
      }),
      inlineEnv: "",
    });
    expect(cmd).toBe("claude -p --permission-mode acceptEdits --model opus --effort max < /tmp/p.txt > /tmp/r.txt 2>&1");
  });

  it("omits --effort entirely when unset, keeping the pre-dial command byte-identical", async () => {
    const { getHarnessCore } = await importCore();
    const cmd = getHarnessCore().buildHeadlessCommand({
      promptFile: "/tmp/p.txt", resultFile: "/tmp/r.txt",
      launchPlan: headlessPlan("claude-code"), inlineEnv: "",
    });
    expect(cmd).toBe("claude -p --permission-mode acceptEdits < /tmp/p.txt > /tmp/r.txt 2>&1");
    expect(cmd).not.toContain("--effort");
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
      providerProfiles: true,
      workerWorkflows: ["default", "grow", "trellis", "designer", "planner"],
      headlessRoles: ["reviewer", "resolver", "ciFix"],
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
      launchPlan: headlessPlan("codex", "reviewer", {
        model: "gpt-5-codex", effort: "max",
      }),
      inlineEnv: "GARDEN_REVIEWER=1 ",
    });
    // The verdict is stdout's last line; the token trailer is stderr, so the
    // result file is stdout-only (not 2>&1) with stderr to a sidecar.
    expect(cmd).toBe(
      "GARDEN_REVIEWER=1 codex exec --dangerously-bypass-approvals-and-sandbox -m gpt-5-codex"
      + " -c model_reasoning_effort=max"
      + " < /tmp/p.txt > /tmp/r.txt 2> /tmp/r.txt.stderr",
    );
    // A headless reviewer must NOT bypass hook trust — it wants Codex to skip
    // the worktree's untrusted hooks so it fires no relay of its own.
    expect(cmd).not.toContain("--dangerously-bypass-hook-trust");
  });

  it("builds the interactive launch: no --session-id, hook-trust bypass on, real workspace-write sandbox", async () => {
    const { getHarnessCore } = await importCore();
    const fresh = getHarnessCore("codex").buildAgentCommand({
      sessionId: "", resume: false, contextFile: "/ignored",
      launchPlan: workerPlan("codex", { model: "gpt-5-codex" }),
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
        sessionId: "", resume: false, contextFile: "/ignored",
        launchPlan: workerPlan("codex"),
      });
      expect(pinned).toContain(
        `-c 'sandbox_workspace_write.writable_roots=["/home/fixture/.npm", ` +
        `"/home/fixture/.cache", "/home/fixture/.garden/sessions"]'`,
      );
    } finally {
      process.env.HOME = savedHome;
    }

    const resume = getHarnessCore("codex").buildAgentCommand({
      sessionId: "019f-abc", resume: true, contextFile: "/ignored",
      launchPlan: workerPlan("codex", {
        requiredCapabilities: {
          turnEnd: true, sandbox: true, workflow: "default",
          resume: true, providerProfiles: false,
        },
      }),
    });
    expect(resume).toContain("codex resume 019f-abc --dangerously-bypass-hook-trust");
    expect(resume).toContain("-s workspace-write");
    expect(resume).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("renders the effort rung as model_reasoning_effort, and keeps ultracode a no-op", async () => {
    const { getHarnessCore } = await importCore();
    const codex = getHarnessCore("codex");
    // Codex's reasoning dial is a config key, not a flag, so it rides the same
    // `-c` channel as the hooks and sandbox.
    const withEffort = codex.buildAgentCommand({
      sessionId: "", resume: false, contextFile: "/ignored",
      launchPlan: workerPlan("codex", { effort: "xhigh" }),
    });
    expect(withEffort).toContain("-c model_reasoning_effort=xhigh");

    // Codex has its own "ultra" reasoning level. It must pass through as a
    // config value — it is NOT garden's ultracode sentinel, which has no Codex
    // analog and stays a no-op.
    const ultra = codex.buildAgentCommand({
      sessionId: "", resume: false, contextFile: "/ignored",
      launchPlan: workerPlan("codex", { effort: "ultra" }),
    });
    expect(ultra).toContain("-c model_reasoning_effort=ultra");

    const ultracodeOnly = codex.buildAgentCommand({
      sessionId: "", resume: false, contextFile: "/ignored",
      launchPlan: workerPlan("codex", { ultracode: true }),
    });
    expect(ultracodeOnly).not.toContain("model_reasoning_effort");
    expect(ultracodeOnly).not.toContain("--effort");

    // No rung requested = no override; Codex uses the model's own default.
    const bare = codex.buildAgentCommand({
      sessionId: "", resume: false, contextFile: "/ignored",
      launchPlan: workerPlan("codex"),
    });
    expect(bare).not.toContain("model_reasoning_effort");

    // The rung survives a resume, so a bounced worker keeps its reasoning depth.
    const resumed = codex.buildAgentCommand({
      sessionId: "019f-abc", resume: true, contextFile: "/ignored",
      launchPlan: workerPlan("codex", { effort: "high" }),
    });
    expect(resumed).toContain("-c model_reasoning_effort=high");
  });

  it("adds the worktree git common dir to the sandbox writable roots", async () => {
    const { getHarnessCore } = await importCore();
    // A linked worktree's git store lives at the main checkout's .git, outside
    // cwd — Codex workspace-write must be granted it or the worker cannot
    // commit/push (claude-code's sandbox auto-grants it; Codex's does not).
    const withGit = getHarnessCore("codex").buildAgentCommand({
      sessionId: "", resume: false, contextFile: "/ignored",
      launchPlan: workerPlan("codex"),
      worktreeGitDir: "/Users/x/proj/.git",
    });
    expect(withGit).toContain('"/Users/x/proj/.git"');
    expect(withGit).toContain("sandbox_workspace_write.writable_roots=[");
    // Absent when no git dir is threaded (e.g. the ad-hoc project-dir launch).
    const withoutGit = getHarnessCore("codex").buildAgentCommand({
      sessionId: "", resume: false, contextFile: "/ignored",
      launchPlan: workerPlan("codex"),
    });
    expect(withoutGit).not.toContain("/.git\"");
  });

  it("adds the resolved beads store to an intake worker's sandbox", async () => {
    const { getHarnessCore } = await importCore();
    const codex = getHarnessCore("codex");
    const ownStore = codex.buildAgentCommand({
      sessionId: "", resume: false, contextFile: "/ignored",
      launchPlan: workerPlan("codex", {
        runtimeProject: { path: "/repo", beadIntake: true },
      }),
    });
    expect(ownStore).toContain('"/repo/.beads"');

    const sharedStore = codex.buildAgentCommand({
      sessionId: "", resume: false, contextFile: "/ignored",
      launchPlan: workerPlan("codex", {
        runtimeProject: { path: "/repo", beadIntake: true, beadsDir: "/board/.beads" },
      }),
    });
    expect(sharedStore).toContain('"/board/.beads"');
    expect(sharedStore).not.toContain('"/repo/.beads"');

    const quotedStore = codex.buildAgentCommand({
      sessionId: "", resume: false, contextFile: "/ignored",
      launchPlan: workerPlan("codex", {
        runtimeProject: { path: "/repo", beadIntake: true, beadsDir: '/board/"primary"/.beads' },
      }),
    });
    expect(quotedStore).toContain(String.raw`"/board/\"primary\"/.beads"`);
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
      providerProfiles: false, workerWorkflows: ["default", "designer"],
      headlessRoles: ["reviewer", "resolver", "ciFix"],
    });
  });

  it("rejects unsupported autonomous-worker requirements before launch", async () => {
    const { getHarnessCore, workerLaunchCompatibilityError } = await importCore();
    const codex = getHarnessCore("codex");

    expect(workerLaunchCompatibilityError(codex, {
      workflow: "default", provider: "deepseek",
    })).toMatch(/does not support provider profiles/);
    expect(workerLaunchCompatibilityError(codex, {
      workflow: "grow", provider: null,
    })).toMatch(/does not support workflow 'grow'/);

    const unsafe = {
      ...getHarnessCore(),
      name: "unsafe",
      capabilities: { ...getHarnessCore().capabilities, sandbox: false },
    };
    expect(workerLaunchCompatibilityError(unsafe, {
      workflow: "default", provider: null,
    })).toMatch(/does not provide a sandbox/);

    const noResume = {
      ...getHarnessCore(),
      name: "no-resume",
      capabilities: { ...getHarnessCore().capabilities, resume: false },
    };
    expect(workerLaunchCompatibilityError(noResume, {
      workflow: "default", provider: null, resume: true,
    })).toMatch(/cannot resume sessions/);
    expect(workerLaunchCompatibilityError(noResume, {
      workflow: "default", provider: null, resume: false,
    })).toBeNull();
  });

  it("classifies a transient backend error but not a clean verdict", async () => {
    const { getHarnessCore } = await importCore();
    const t = getHarnessCore("codex").isTransientError;
    expect(t("some progress\nERROR: 429 rate limit exceeded")).toBe(true);
    expect(t('done\n{"type":"server_error","message":"x"}')).toBe(true);
    expect(t("Reviewed the diff.\nFIXED")).toBe(false);
    // The real usage-quota cutoff is NOT transient — it needs an hours/days
    // wait for the window to reset, not a seconds-scale retry.
    expect(t(REAL_CODEX_QUOTA_STDERR)).toBe(false);
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
    // Real captured cutoff: "try again at <date>" phrasing, trailing "." stripped.
    expect(q(REAL_CODEX_QUOTA_STDERR)).toBe("Jul 31st, 2026 11:43 AM");
    // The "try again in <duration>" variant.
    expect(q("ERROR: You've hit your usage limit. Try again in 2h30m.")).toBe("2h30m");
    // A bare 429 rate-limit is transient, not a quota cutoff -> null.
    expect(q("some progress\nERROR: 429 rate limit exceeded")).toBeNull();
    expect(q("Reviewed the diff.\nFIXED")).toBeNull();
  });

  // Parity with the claude-code reader: the history view is a summary, so an
  // assistant turn is described by what it DID, and one exchange yields one
  // assistant entry no matter how many progress messages the model emitted.
  it("readTurns summarizes an exchange by its actions, not the model's prose", async () => {
    const { getHarnessCore } = await importCore();
    const fixture = path.join(HERE, "fixtures/codex/rollout-sample.jsonl");
    const turns = getHarnessCore("codex").readTurns(fixture);
    expect(turns).toHaveLength(4);
    expect(turns[0]).toMatchObject({ role: "user", text: "Review calc.py for bugs and fix them." });
    // Two agent_messages (commentary + final_answer) fold into ONE turn, named
    // by the patch it applied and the shell it ran inside the `exec` wrapper.
    expect(turns[1]).toMatchObject({
      role: "assistant",
      text: "edited calc.py · ran tests · committed",
      verb: "worked",
    });
    expect(turns[2]).toMatchObject({ role: "user", text: "What does calc.py do now?" });
    // No tools since the last prompt -> "answered", and with no action to name
    // the summary falls back to the opening sentence of the reply.
    expect(turns[3]).toMatchObject({
      role: "assistant",
      text: "It adds two numbers correctly.",
      verb: "answered",
    });
  });

  // Codex 0.147 moved prompts, assistant text AND applied edits into
  // event_msg/item_completed items. Missing the edit half leaves a coding turn
  // summarized by everything except the thing it did.
  it("readTurns parses current item_completed message and file-change records", async () => {
    const { getHarnessCore } = await importCore();
    const fixture = path.join(HERE, "fixtures/codex/rollout-item-completed.jsonl");
    const turns = getHarnessCore("codex").readTurns(fixture);
    // Two AgentMessages (commentary + final_answer) still fold into ONE turn.
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({
      role: "user",
      text: "Fix the empty Codex history.",
      image: true,
    });
    expect(turns[1]).toMatchObject({
      role: "assistant",
      text: "edited codex-core.ts",
      verb: "worked",
    });
  });

  // The FileChange item carries the same `changes` map patch_apply_end did, so
  // an edit whose paths are unreadable still registers as an edit.
  it("readTurns names an item_completed edit with no readable paths", async () => {
    const { getHarnessCore } = await importCore();
    const fixture = path.join(HERE, "fixtures/codex/rollout-file-change-bare.jsonl");
    const turns = getHarnessCore("codex").readTurns(fixture);
    expect(turns).toHaveLength(2);
    expect(turns[1]).toMatchObject({ role: "assistant", text: "edited files" });
  });

  it("readTurns tags a tool-only turn (no edit) as planned", async () => {
    const { getHarnessCore } = await importCore();
    const fixture = path.join(HERE, "fixtures/codex/rollout-planned.jsonl");
    const turns = getHarnessCore("codex").readTurns(fixture);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ role: "user", text: "What files are in the repo?" });
    // a non-edit tool call (exec_command) since the last prompt, no patch_apply_end -> "planned"
    expect(turns[1]).toMatchObject({ role: "assistant", text: "ran commands", verb: "planned" });
  });

  it("readTurns recognizes a search at the start of an exec wrapper", async () => {
    const { getHarnessCore } = await importCore();
    const fixture = path.join(HERE, "fixtures/codex/rollout-exec-search.jsonl");
    const turns = getHarnessCore("codex").readTurns(fixture);
    expect(turns[1]).toMatchObject({
      role: "assistant",
      text: "searched the codebase",
      verb: "planned",
    });
  });

  // Codex reads and searches through the shell, so those actions have to be
  // derived from the command text or every exploration turn reads "ran commands".
  it("readTurns names shell reads and searches, and collapses garden prompts", async () => {
    const { getHarnessCore } = await importCore();
    const fixture = path.join(HERE, "fixtures/codex/rollout-garden.jsonl");
    const turns = getHarnessCore("codex").readTurns(fixture);
    expect(turns).toHaveLength(4);
    // A handoff seed briefing is garden-injected: a compact source-labeled
    // marker, not the multi-paragraph text.
    expect(turns[0]).toMatchObject({ role: "garden", text: "handoff from garden/plush-faint-dusk" });
    // rg + sed + cat inside one `exec` snippet -> the files it opened.
    expect(turns[1]).toMatchObject({ role: "assistant", text: "explored 2 files", verb: "planned" });
    // A [garden] continuation collapses to its labeled kind.
    expect(turns[2]).toMatchObject({ role: "garden", text: "continue after merge" });
    expect(turns[3]).toMatchObject({ role: "assistant", text: "pushed", verb: "worked" });
  });

  // The bound that actually broke a real worker: a four-day Codex rollout
  // reached 178MB (78% of it inlined command stdout), so a fixed 16MB tail held
  // 4 of its 32 prompts and the history view showed the last few hours of a
  // four-day run. Exercised here at the REAL constants — the escalation is
  // worthless if it only works at the sizes a unit test finds convenient.
  it("readTurns widens past the first window on a rollout with huge records", async () => {
    const { getHarnessCore } = await importCore();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-rollout-"));
    const rollout = path.join(dir, "rollout-fat.jsonl");
    try {
      const prompt = (text: string): string => JSON.stringify({
        timestamp: "2026-08-30T00:00:00Z",
        type: "event_msg",
        payload: { type: "item_completed", item: { type: "UserMessage", content: [{ type: "text", text }] } },
      });
      // 2MB of command output per exchange: the first window holds a handful of
      // prompts, the rest are only reachable by widening.
      const bulk = JSON.stringify({
        timestamp: "2026-08-30T00:00:01Z",
        type: "event_msg",
        payload: { type: "item_completed", item: { type: "CommandExecution", output: "x".repeat(2 * 1024 * 1024) } },
      });
      const fh = fs.openSync(rollout, "w");
      try {
        for (let i = 0; i < 12; i++) fs.writeSync(fh, `${prompt(`q${i}`)}\n${bulk}\n`);
      } finally {
        fs.closeSync(fh);
      }
      expect(fs.statSync(rollout).size).toBeGreaterThan(16 * 1024 * 1024);

      const prompts = getHarnessCore("codex").readTurns(rollout, 40)
        .filter(t => t.role !== "assistant")
        .map(t => t.text);
      // Without escalation only the last ~8 fit in 16MB; q0 proves it widened.
      expect(prompts).toContain("q0");
      expect(prompts).toContain("q11");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("readTurns returns [] for a null or unreadable path", async () => {
    const { getHarnessCore } = await importCore();
    expect(getHarnessCore("codex").readTurns(null)).toEqual([]);
    expect(getHarnessCore("codex").readTurns("/no/such/rollout.jsonl")).toEqual([]);
  });
});

// Codex's terminal title carries no rolling summary (verified against codex
// 0.144.6: `activity` is a spinner, `task-progress` a counter, `thread-title`
// the thread UUID, `project-name` the worktree basename), so the status pane's
// detail column is derived from the rollout instead.
describe("codex readActivity (status-pane summary)", () => {
  const entryFor = (fixture: string, over: Record<string, unknown> = {}) => ({
    name: "weak-brave-snow", transcriptPath: path.join(HERE, "fixtures/codex", fixture),
    task: "", ...over,
  }) as never;

  it("reports the step the newest plan is on", async () => {
    const { getHarnessCore } = await importCore();
    // Two update_plan calls in the file; the newer one is in progress on step 2.
    expect(getHarnessCore("codex").readActivity!(entryFor("rollout-plan.jsonl")))
      .toBe("Add the .gitignore");
  });

  it("falls back to the last completed step once the plan is finished", async () => {
    const { getHarnessCore } = await importCore();
    expect(getHarnessCore("codex").readActivity!(entryFor("rollout-plan-done.jsonl")))
      .toBe("Add the .gitignore");
  });

  // codex 0.146.0 (gpt-5-codex) routes update_plan through its generic `exec`
  // tool, whose input is JS source rather than JSON arguments. Reading only
  // the direct-call shape left every current Codex worker's summary frozen at
  // its opening prompt.
  it("reads the plan when update_plan is called through the exec tool", async () => {
    const { getHarnessCore } = await importCore();
    expect(getHarnessCore("codex").readActivity!(entryFor("rollout-plan-exec.jsonl")))
      .toBe("Design the module boundaries");
  });

  it("names the worker from its opening prompt until a plan exists", async () => {
    const { getHarnessCore } = await importCore();
    // First line only — the seed briefing is a paragraph, the detail column a row.
    expect(getHarnessCore("codex").readActivity!(entryFor("rollout-sample.jsonl")))
      .toBe("Review calc.py for bugs and fix them.");
  });

  it("names a current-schema worker from its opening prompt", async () => {
    const { getHarnessCore } = await importCore();
    expect(getHarnessCore("codex").readActivity!(entryFor("rollout-item-completed.jsonl")))
      .toBe("Fix the empty Codex history. [Image #1]");
  });

  it("reads current response-item prompts without naming injected context", async () => {
    const { getHarnessCore } = await importCore();
    expect(getHarnessCore("codex").readActivity!(entryFor("rollout-response-messages.jsonl")))
      .toBe("Investigate why Codex workers have blank task summaries.");
  });

  it("replaces the creation placeholder with the opening prompt", async () => {
    const { getHarnessCore } = await importCore();
    const entry = entryFor("rollout-response-messages.jsonl", { task: "awaiting task" });
    expect(getHarnessCore("codex").readActivity!(entry))
      .toBe("Investigate why Codex workers have blank task summaries.");
  });

  it("keeps an established summary rather than re-reporting the opening prompt", async () => {
    const { getHarnessCore } = await importCore();
    const entry = entryFor("rollout-sample.jsonl", { task: "Fix the calc.py sign bug" });
    expect(getHarnessCore("codex").readActivity!(entry)).toBeNull();
  });

  // The title generator (task-title.ts) titles from the WHOLE opening prompt:
  // a briefing routinely states its subject past the first line, which the
  // row's one-line cut throws away.
  it("exposes the whole opening prompt, past the line the row shows", async () => {
    const { readCodexOpeningPrompt } = await import("../src/dashboard/harness/codex-core.js");
    expect(readCodexOpeningPrompt(path.join(HERE, "fixtures/codex/rollout-response-messages.jsonl")))
      .toBe("Investigate why Codex workers have blank task summaries.\nPlease implement the fix.");
  });

  it("heals a task left as the worker's own name by the default codex title", async () => {
    const { getHarnessCore } = await importCore();
    const entry = entryFor("rollout-sample.jsonl", { task: "weak-brave-snow" });
    expect(getHarnessCore("codex").readActivity!(entry))
      .toBe("Review calc.py for bugs and fix them.");
  });

  it("returns null when the transcript is missing", async () => {
    const { getHarnessCore } = await importCore();
    const entry = { name: "w", transcriptPath: "/no/such/rollout.jsonl", task: "" } as never;
    expect(getHarnessCore("codex").readActivity!(entry)).toBeNull();
  });

  it("returns null when a readable transcript path cannot be read as a file", async () => {
    const { getHarnessCore } = await importCore();
    const entry = {
      name: "w",
      transcriptPath: path.join(HERE, "fixtures/codex"),
      task: "",
    } as never;
    expect(getHarnessCore("codex").readActivity!(entry)).toBeNull();
  });

  it("is not implemented for claude-code, whose pane title carries the summary", async () => {
    const { getHarnessCore } = await importCore();
    expect(getHarnessCore("claude-code").readActivity).toBeUndefined();
  });
});

describe("codex -c hook injection (worker turn-end relay)", () => {
  it("injects the lifecycle hooks with garden's wire event names", async () => {
    const { getHarnessCore } = await importCore();
    // Hooks ride the launch command as -c overrides, NOT a .codex/hooks.json
    // file: Codex resolves project hooks at the repo root, so a file written
    // into a linked worktree never fires (verified 2026-07-06).
    const cmd = getHarnessCore("codex").buildAgentCommand({
      sessionId: "", resume: false, contextFile: "/ignored",
      launchPlan: workerPlan("codex"),
    });
    expect(cmd).toMatch(/hooks\.SessionStart=.*sessionstart"/);
    expect(cmd).toMatch(/hooks\.UserPromptSubmit=.* prompt"/);
    expect(cmd).toMatch(/hooks\.Stop=.* stop"/);
    expect(cmd).toMatch(/hooks\.PostToolUse=.*posttooluse"/);
    // Codex PreToolUse fires for ordinary tools -> a working heartbeat. Its
    // built-in request_user_input bypasses this hook and is watched via the
    // rollout instead.
    expect(cmd).toMatch(/hooks\.PreToolUse=.*posttooluse"/);
    // PermissionRequest is the real blocked-on-operator signal.
    expect(cmd).toMatch(/hooks\.PermissionRequest=.*pretooluse"/);
    // The relay only fires with the hook-trust bypass (garden's hooks are
    // programmatically written, hence untrusted).
    expect(cmd).toContain("--dangerously-bypass-hook-trust");
  });
});

// Codex fires SessionStart at the first turn, not at boot, so a Codex worker
// stays at agentStatus "loading" until something prompts it — while the seed
// path withholds the prompt until "loading" clears. Every handoff into a Codex
// worker paid the full 180s backstop before the briefing appeared. The empty
// composer signature is the boot signal that breaks the deadlock.
describe("promptReady (harness boot probe)", () => {
  // A real booted-but-unprompted Codex pane (lean-stout-quartz, 2026-08-25).
  const BOOTED = [
    "",
    "› Ask Codex to do anything",
    "",
    "  gpt-5.6-sol high · ~/.garden/worktrees/leadingtone-io/lean-stout-quartz",
  ].join("\n");

  // A real Codex startup dialog (captured 2026-08-25 booting against an
  // untrusted cwd). Codex reuses the composer glyph as its selection cursor, so
  // this pane is NOT ready even though it carries a `›` row.
  const TRUST_DIALOG = [
    "> You are in /private/tmp/scratch/codex-cwd",
    "",
    "  Do you trust the contents of this directory? Working with untrusted contents comes with",
    "  higher risk of prompt injection.",
    "",
    "› 1. Yes, continue",
    "  2. No, quit",
    "",
    "  Press enter to continue",
  ].join("\n");

  it("reports a booted Codex composer as ready", async () => {
    const { getHarnessCore } = await importCore();
    expect(getHarnessCore("codex").promptReady!(BOOTED)).toBe(true);
  });

  // The glyph alone would say "ready" here and the seed would be pasted into a
  // menu, where Enter picks a menu item and the briefing is lost to a retry.
  it("does not report a Codex startup dialog as ready", async () => {
    const { getHarnessCore } = await importCore();
    expect(getHarnessCore("codex").promptReady!(TRUST_DIALOG)).toBe(false);
  });

  // A composer holding text has no placeholder, so the probe declines and the
  // wait falls back to its agentStatus backstop — the safe direction.
  it("does not report a composer that already holds text as ready", async () => {
    const { getHarnessCore } = await importCore();
    expect(getHarnessCore("codex").promptReady!("› half-typed operator message")).toBe(false);
  });

  it("does not report a pane still running the bootstrap as ready", async () => {
    const { getHarnessCore } = await importCore();
    const booting = "+ npm ci\nadded 214 packages\n$ codex --sandbox workspace-write";
    expect(getHarnessCore("codex").promptReady!(booting)).toBe(false);
  });

  it("is not defined for claude-code, whose SessionStart fires at boot", async () => {
    const { getHarnessCore } = await importCore();
    expect(getHarnessCore("claude-code").promptReady).toBeUndefined();
  });

  it("never captures the pane for a harness with no probe", async () => {
    const { harnessSignalsPromptReady } = await importCore();
    const capture = vi.fn(() => BOOTED);
    expect(harnessSignalsPromptReady("claude-code", capture)).toBe(false);
    expect(capture).not.toHaveBeenCalled();
  });

  it("reports not-ready when the worker has no pane to capture", async () => {
    const { harnessSignalsPromptReady } = await importCore();
    expect(harnessSignalsPromptReady("codex", () => null)).toBe(false);
  });

  it("reports ready from a booted Codex pane", async () => {
    const { harnessSignalsPromptReady } = await importCore();
    expect(harnessSignalsPromptReady("codex", () => BOOTED)).toBe(true);
  });
});

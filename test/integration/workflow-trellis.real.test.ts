// Integration test for the trellis workflow's state machine. Drives a vine
// through working → reviewing → merge-pending → done (ALIGNED) and a
// multi-iteration DRIFT cycle on real fs/git. Validates iteration counter,
// budget cap, FLAGGED disposition, and per-iteration sessionId regeneration
// (Invariant 8).
//
// Tmux and dashboard refresh are mocked. The reviewer subprocess is not
// actually spawned — we simulate its exit by writing the result file and
// flipping windowExists to false before the next poll cycle. The
// trellisAutoContinueAfterMerge respawn is also mocked (no real claude
// subprocess), but we assert that the new sessionId was generated and
// persisted.
import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { useGitTmpHome } from "./helpers.js";

const env = useGitTmpHome();

const PROJECT = "myproject";
const WORKER = "swift-vine";

vi.mock("../../src/dashboard/tmux.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/dashboard/tmux.js")>(
    "../../src/dashboard/tmux.js",
  );
  return {
    ...actual,
    tmux: vi.fn(),
    tmuxOutput: vi.fn(() => ""),
    windowExists: vi.fn(() => false),
    killWindowSafe: vi.fn(),
    getFirstPaneId: vi.fn(() => null),
    getPaneSize: vi.fn(() => null),
    setPaneVar: vi.fn(),
    listAllWindowNames: vi.fn(() => []),
  };
});

vi.mock("../../src/dashboard/header.js", () => ({
  refreshDashboard: vi.fn(),
  setupStatusBar: vi.fn(),
}));

vi.mock("../../src/dashboard/hotkeys.js", () => ({
  setupKeybindings: vi.fn(),
}));

vi.mock("../../src/dashboard/validate.js", () => ({
  healStatusPane: vi.fn(),
}));

vi.mock("../../src/dashboard/usage-poller.js", () => ({
  startUsagePoller: vi.fn(),
  stopUsagePoller: vi.fn(),
}));

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

let projectPath: string;
let originPath: string;
let worktreePath: string;
let trellisPath: string;

beforeEach(() => {
  vi.clearAllMocks();

  originPath = path.join(env.home, "origin.git");
  spawnSync("git", ["init", "--bare", "-b", "main", originPath], { stdio: "ignore" });

  projectPath = path.join(env.home, "projects", PROJECT);
  fs.mkdirSync(projectPath, { recursive: true });
  spawnSync("git", ["init", "-b", "main", projectPath], { stdio: "ignore" });
  git(projectPath, "config", "user.email", "test@garden.local");
  git(projectPath, "config", "user.name", "garden-test");
  git(projectPath, "remote", "add", "origin", originPath);
  fs.writeFileSync(path.join(projectPath, "README.md"), "# proj\n");
  // Trellis lives at <project>/.garden/trellises/auth.md and is committed
  // to main so the reviewer (post-rebase) sees it from the worktree.
  const trellisDir = path.join(projectPath, ".garden", "trellises");
  fs.mkdirSync(trellisDir, { recursive: true });
  trellisPath = path.join(trellisDir, "auth.md");
  fs.writeFileSync(trellisPath, `# auth

A trellis for the auth feature. **If the code disagrees with this document, the code is wrong.**

<!-- trellis: v1 -->

## Surface

- exports \`auth()\` from src/auth.ts

## Tests

- test/auth.test.ts
`);
  git(projectPath, "add", ".");
  git(projectPath, "commit", "-m", "init");
  git(projectPath, "push", "-u", "origin", "main");

  worktreePath = path.join(env.home, ".garden", "worktrees", PROJECT, WORKER);

  const configPath = path.join(env.home, ".garden", "config.yml");
  fs.writeFileSync(
    configPath,
    `projects:\n  ${PROJECT}:\n    path: ${projectPath}\n    logColor: red\n`,
  );
});

async function plantVine(fields: Record<string, unknown> = {}): Promise<void> {
  const { addWorker } = await import("../../src/dashboard/registry.js");
  addWorker(PROJECT, {
    name: WORKER,
    sessionId: "session-id-iter-0",
    task: "",
    branchName: WORKER,
    baseBranch: "main",
    worktreePath,
    workflow: "trellis",
    trellisName: "auth",
    trellisPath,
    trellisIteration: 0,
    trellisMaxIterations: 30,
    ...fields,
  });
}

async function setupWorktreeAndCommit(): Promise<string> {
  const { createWorktree } = await import("../../src/dashboard/git.js");
  createWorktree(projectPath, worktreePath, WORKER);
  fs.writeFileSync(path.join(worktreePath, "src-auth.ts"), "// auth impl\n");
  git(worktreePath, "add", "src-auth.ts");
  git(worktreePath, "commit", "-m", "feat: auth impl");
  git(worktreePath, "push", "origin", WORKER);
  return git(worktreePath, "rev-parse", "HEAD");
}

describe("trellis workflow — state machine drive on real fs/git", () => {
  it("ALIGNED verdict terminates the loop with prState=done and trellisAligned=true", async () => {
    await setupWorktreeAndCommit();
    await plantVine({
      prState: "working",
      claudeStatus: "idle",
      pendingReviewAt: Date.now(),
    });

    // --- Transition 1: working → reviewing ---
    const { poll } = await import("../../src/dashboard/poller.js");
    poll(PROJECT);

    const { findWorkerByName } = await import("../../src/dashboard/registry.js");
    let entry = findWorkerByName(PROJECT, WORKER);
    expect(entry?.prState).toBe("reviewing");
    // Iteration counter incremented from 0 to 1 BEFORE dispatch.
    expect(entry?.trellisIteration).toBe(1);

    // Simulate the trellis reviewer producing ALIGNED.
    const { reviewResultPath } = await import("../../src/dashboard/poller-review.js");
    const resultFile = reviewResultPath(PROJECT, WORKER);
    fs.mkdirSync(path.dirname(resultFile), { recursive: true });
    fs.writeFileSync(resultFile, "Aligned: 2\n\nEverything matches the trellis.\nALIGNED\n");

    const { windowExists } = await import("../../src/dashboard/tmux.js");
    vi.mocked(windowExists).mockReturnValue(false);

    // --- Transition 2: reviewing → merge-pending (ALIGNED writes sentinel) ---
    poll(PROJECT);
    entry = findWorkerByName(PROJECT, WORKER);
    expect(entry?.prState).toBe("merge-pending");
    expect(entry?.trellisLastVerdict).toBe("ALIGNED");
    expect(entry?.trellisAligned).toBe(true);
    // Sentinel written by the workflow handler (writes synchronously).
    expect(fs.existsSync(path.join(worktreePath, ".garden-done"))).toBe(true);

    // --- Transition 3: merge-pending → done (sentinel-aware finalize) ---
    poll(PROJECT);
    entry = findWorkerByName(PROJECT, WORKER);
    expect(entry?.prState).toBe("done");
    expect(entry?.trellisAligned).toBe(true);
  });

  it("DRIFT verdict transitions through merge-pending → merged, preserving drift list", async () => {
    await setupWorktreeAndCommit();
    await plantVine({
      prState: "working",
      claudeStatus: "idle",
      pendingReviewAt: Date.now(),
    });

    const { poll } = await import("../../src/dashboard/poller.js");
    poll(PROJECT);

    // Reviewer emits DRIFT with two items.
    const { reviewResultPath } = await import("../../src/dashboard/poller-review.js");
    const resultFile = reviewResultPath(PROJECT, WORKER);
    fs.mkdirSync(path.dirname(resultFile), { recursive: true });
    fs.writeFileSync(
      resultFile,
      `Aligned: 1

1. [tests] no test for the timeout (trellis line 47)
2. [docs] CLAUDE.md unchanged

DRIFT
`,
    );

    const { windowExists } = await import("../../src/dashboard/tmux.js");
    vi.mocked(windowExists).mockReturnValue(false);

    poll(PROJECT);
    const { findWorkerByName } = await import("../../src/dashboard/registry.js");
    let entry = findWorkerByName(PROJECT, WORKER);
    expect(entry?.prState).toBe("merge-pending");
    expect(entry?.trellisLastVerdict).toBe("DRIFT");
    expect(entry?.trellisLastDrift).toHaveLength(2);
    expect(entry?.trellisLastDrift?.[0]).toContain("[tests]");
    expect(entry?.trellisAlignedCount).toBe(1);
    // No sentinel — DRIFT doesn't write it.
    expect(fs.existsSync(path.join(worktreePath, ".garden-done"))).toBe(false);

    poll(PROJECT);
    entry = findWorkerByName(PROJECT, WORKER);
    expect(entry?.prState).toBe("merged");
    // trellisLastDrift survives into merged so the auto-continue prompt
    // can render it.
    expect(entry?.trellisLastDrift).toHaveLength(2);
  });

  it("budget exhaustion short-circuits to failing with iteration-budget reason", async () => {
    await setupWorktreeAndCommit();
    // Plant with iteration already at the cap so the next launchReview
    // tries to increment to 2 (which exceeds maxIterations=1).
    await plantVine({
      prState: "working",
      claudeStatus: "idle",
      pendingReviewAt: Date.now(),
      trellisIteration: 1,
      trellisMaxIterations: 1,
      trellisLastDrift: ["1. [tests] still missing"],
    });

    const { poll } = await import("../../src/dashboard/poller.js");
    poll(PROJECT);

    const { findWorkerByName } = await import("../../src/dashboard/registry.js");
    const entry = findWorkerByName(PROJECT, WORKER);
    expect(entry?.prState).toBe("failing");
    expect(entry?.failingReason).toBe("iteration-budget");
    // No reviewer was launched (no review window).
    expect(entry?.reviewWindowName).toBeUndefined();

    // Alert was raised.
    const { readAlerts } = await import("../../src/dashboard/alerts.js");
    const alerts = readAlerts().alerts;
    const trellisAlerts = alerts.filter(a => a.source === "trellis");
    expect(trellisAlerts.length).toBeGreaterThan(0);
    expect(trellisAlerts[0].message).toContain("iteration budget exhausted");
  });

  it("FLAGGED verdict transitions to failing with trellis-flagged and skips push debounce", async () => {
    await setupWorktreeAndCommit();
    await plantVine({
      prState: "working",
      claudeStatus: "idle",
      pendingReviewAt: Date.now(),
    });

    const { poll } = await import("../../src/dashboard/poller.js");
    poll(PROJECT);

    const { reviewResultPath } = await import("../../src/dashboard/poller-review.js");
    const resultFile = reviewResultPath(PROJECT, WORKER);
    fs.mkdirSync(path.dirname(resultFile), { recursive: true });
    fs.writeFileSync(
      resultFile,
      "Trellis line 47 contradicts trellis line 91; no implementation can satisfy both.\nFLAGGED\n",
    );

    const { windowExists } = await import("../../src/dashboard/tmux.js");
    vi.mocked(windowExists).mockReturnValue(false);

    poll(PROJECT);
    const { findWorkerByName } = await import("../../src/dashboard/registry.js");
    let entry = findWorkerByName(PROJECT, WORKER);
    expect(entry?.prState).toBe("failing");
    expect(entry?.failingReason).toBe("trellis-flagged");
    expect(entry?.trellisLastVerdict).toBe("FLAGGED");
    expect(entry?.trellisFlaggedClauses?.length).toBeGreaterThan(0);

    // Alert was raised.
    const { readAlerts } = await import("../../src/dashboard/alerts.js");
    const alerts = readAlerts().alerts;
    expect(alerts.some(a => a.source === "trellis" && a.message.includes("flagged"))).toBe(true);

    // Worker pushes a new commit. handleFailing must NOT auto-resume on
    // push debounce — flagged vines wait for `garden trellis resume`.
    fs.writeFileSync(path.join(worktreePath, "fix.txt"), "fix\n");
    git(worktreePath, "add", "fix.txt");
    git(worktreePath, "commit", "-m", "attempted fix");
    git(worktreePath, "push", "origin", WORKER);

    // Several pokes shouldn't move the state.
    poll(PROJECT);
    poll(PROJECT);
    entry = findWorkerByName(PROJECT, WORKER);
    expect(entry?.prState).toBe("failing");
    expect(entry?.failingReason).toBe("trellis-flagged");
  });

  it("reviewer always launches with --model opus regardless of worker model", async () => {
    await setupWorktreeAndCommit();
    // Plant a vine on Sonnet to verify the reviewer is independent.
    await plantVine({
      prState: "working",
      claudeStatus: "idle",
      pendingReviewAt: Date.now(),
      workerModel: "sonnet",
    });

    const { poll } = await import("../../src/dashboard/poller.js");
    const { tmux } = await import("../../src/dashboard/tmux.js");
    poll(PROJECT);

    // The reviewer was launched via launchHeadlessAgent → tmux new-window.
    // Inspect the recorded tmux calls for the bash -c command and confirm
    // it contains '--model opus' (Invariant 10).
    const launchCalls = vi.mocked(tmux).mock.calls.filter(
      args => args[0] === "new-window" && args.includes("bash"),
    );
    expect(launchCalls.length).toBeGreaterThan(0);
    const reviewLaunch = launchCalls.find(args =>
      args.some(a => typeof a === "string" && a.includes("claude -p")),
    );
    expect(reviewLaunch).toBeDefined();
    const cmd = reviewLaunch!.find(a => typeof a === "string" && a.includes("claude -p"))!;
    expect(cmd).toContain("--model opus");
  });

  it("Sonnet exhaustion + trellisOpusFallback=true falls back to Opus on respawn", async () => {
    await setupWorktreeAndCommit();
    await plantVine({
      prState: "merged",
      claudeStatus: "idle",
      trellisLastVerdict: "DRIFT",
      trellisLastDrift: ["1. [tests] missing"],
    });

    // Write a fake usage snapshot with Sonnet at 99%.
    const { USAGE_FILE } = await import("../../src/dashboard/usage.js");
    fs.mkdirSync(path.dirname(USAGE_FILE), { recursive: true });
    fs.writeFileSync(USAGE_FILE, JSON.stringify({
      fetchedAt: new Date().toISOString(),
      data: { sonnet: { pct: 99, resetsAt: "2026-05-13T00:00:00Z" } },
    }));

    // Mock paneExists / windowExists so resolveWorkerPaneId returns a pane.
    const tmuxMod = await import("../../src/dashboard/tmux.js");
    vi.mocked(tmuxMod.windowExists).mockReturnValue(true);
    vi.mocked(tmuxMod.getFirstPaneId).mockReturnValue("%fake-pane");

    // Drive trellisAutoContinueAfterMerge directly (bypass the detached
    // subprocess dispatch — we want to inspect the tmux respawn args).
    const { trellisAutoContinueAfterMerge } = await import("../../src/dashboard/trellis-continue.js");
    trellisAutoContinueAfterMerge(PROJECT, WORKER);

    // Inspect the respawn-pane call's command string.
    const respawnCalls = vi.mocked(tmuxMod.tmux).mock.calls.filter(
      args => args[0] === "respawn-pane",
    );
    expect(respawnCalls.length).toBeGreaterThan(0);
    const cmd = respawnCalls[0].find(a => typeof a === "string" && a.includes("claude --rc"))!;
    expect(cmd).toContain("--model opus");
    expect(cmd).not.toContain("--model sonnet");

    // The fallback alert was fired and the entry stamped.
    const { readAlerts } = await import("../../src/dashboard/alerts.js");
    const { findWorkerByName } = await import("../../src/dashboard/registry.js");
    expect(readAlerts().alerts.some(a => a.source === "trellis-budget")).toBe(true);
    expect(findWorkerByName(PROJECT, WORKER)?.trellisModelFallbackAt).toBeDefined();
  });

  it("Sonnet exhaustion + trellisOpusFallback=false pauses the loop instead of respawning", async () => {
    await setupWorktreeAndCommit();
    // Re-write project config to disable the fallback.
    const { saveConfig, loadConfig } = await import("../../src/config.js");
    const cfg = loadConfig();
    cfg.projects[PROJECT] = { ...cfg.projects[PROJECT], trellisOpusFallback: false };
    saveConfig(cfg);

    await plantVine({
      prState: "merged",
      claudeStatus: "idle",
      trellisLastVerdict: "DRIFT",
      trellisLastDrift: ["1. [tests] missing"],
    });

    const { USAGE_FILE } = await import("../../src/dashboard/usage.js");
    fs.mkdirSync(path.dirname(USAGE_FILE), { recursive: true });
    fs.writeFileSync(USAGE_FILE, JSON.stringify({
      fetchedAt: new Date().toISOString(),
      data: { sonnet: { pct: 99, resetsAt: "2026-05-13T00:00:00Z" } },
    }));

    const tmuxMod = await import("../../src/dashboard/tmux.js");
    vi.mocked(tmuxMod.windowExists).mockReturnValue(true);
    vi.mocked(tmuxMod.getFirstPaneId).mockReturnValue("%fake-pane");

    const { trellisAutoContinueAfterMerge } = await import("../../src/dashboard/trellis-continue.js");
    trellisAutoContinueAfterMerge(PROJECT, WORKER);

    // No respawn-pane call should have happened — the loop is paused.
    const respawnCalls = vi.mocked(tmuxMod.tmux).mock.calls.filter(
      args => args[0] === "respawn-pane",
    );
    expect(respawnCalls).toHaveLength(0);

    // The global usage gate is paused.
    const { getAutoContinueConfig } = await import("../../src/config.js");
    const ac = getAutoContinueConfig();
    expect(ac.enabled).toBe(false);
    expect(ac.pausedUntil).toBe("2026-05-13T00:00:00Z");

    // A usage-source alert was raised (not trellis-budget).
    const { readAlerts } = await import("../../src/dashboard/alerts.js");
    const alerts = readAlerts().alerts;
    expect(alerts.some(a => a.source === "usage")).toBe(true);
  });
});

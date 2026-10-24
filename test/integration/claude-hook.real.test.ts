import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import yaml from "js-yaml";
import { useGitTmpHome } from "./helpers.js";

// handleClaudeHook spawns tmux and refresh subprocesses as side effects of
// the registry update we actually care about. Mock the side-effect modules
// (tmux pane reads, refresh, usage refresh, poller poke) so the test runs
// in a CI environment without a live tmux server. The data layer (registry,
// state, config) stays on real fs — that's what we're testing.
vi.mock("../../src/dashboard/tmux.js", () => ({
  tmux: vi.fn(),
  tmuxOutput: vi.fn(() => ""),
  getPanePid: vi.fn(() => null),
  getPaneTitle: vi.fn(() => null),
  getFirstPaneId: vi.fn(() => null),
  windowExists: vi.fn(() => false),
  setPaneVar: vi.fn(),
  getPaneSize: vi.fn(() => null),
  listAllWindowNames: vi.fn(() => []),
  listHiddenWorkerWindows: vi.fn(() => []),
}));
vi.mock("../../src/dashboard/usage.js", () => ({
  maybeRefreshUsage: vi.fn(),
  renderUsagePane: vi.fn(() => ""),
}));
vi.mock("../../src/dashboard/poller.js", () => ({
  triggerProjectPoll: vi.fn(),
  signalFifoPath: vi.fn(() => "/tmp/fake-fifo"),
}));
// hooks/default.ts pokes the poller through poller-fifo directly (not
// poller.ts). Mock it so the dirty-worktree tests can assert no review wake
// was produced, not just that pendingReviewAt stayed unset.
vi.mock("../../src/dashboard/poller-fifo.js", () => ({
  triggerProjectPoll: vi.fn(),
  signalFifoPath: vi.fn(() => "/tmp/fake-fifo"),
  pollerSpawnLockPath: vi.fn(() => "/tmp/fake-spawn-lock"),
  scheduleDelayedPoke: vi.fn(),
  isWorkerClaudeWorking: vi.fn(() => false),
  ensureSignalFifo: vi.fn(() => true),
}));
vi.mock("../../src/dashboard/runner.js", () => ({
  resolveGardenRunner: vi.fn(() => "garden"),
}));
vi.mock("../../src/commands/status.js", () => ({
  renderQuickStatus: vi.fn(() => ""),
  resolveWorkerStatus: vi.fn(() => "idle"),
  refreshWorkerTasks: vi.fn(() => null),
}));

const env = useGitTmpHome();

const PROJECT = "myproject";
const WORKER = "bold-ash";
let originPath: string;
let projectPath: string;
let worktreePath: string;
let originalCwd: string;

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function readRegistryFile(): { workers: Record<string, unknown[]> } {
  const file = path.join(env.sessionsDir, "dashboard.registry.json");
  if (!fs.existsSync(file)) return { workers: {} };
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

function seedRegistry(agentStatus: string, extra: Record<string, unknown> = {}) {
  const file = path.join(env.sessionsDir, "dashboard.registry.json");
  const reg = {
    workers: {
      [PROJECT]: [{
        name: WORKER,
        sessionId: "session-id-1",
        task: "do the thing",
        worktreePath,
        branchName: WORKER,
        baseBranch: "main",
        agentStatus,
        ...extra,
      }],
    },
  };
  fs.writeFileSync(file, JSON.stringify(reg));
}

function seedConfig() {
  const file = path.join(env.gardenDir, "config.yml");
  fs.writeFileSync(file, yaml.dump({
    projects: { [PROJECT]: { path: projectPath } },
    plots: { all: { projects: [PROJECT] } },
    activePlot: "all",
  }));
}

beforeEach(() => {
  originalCwd = process.cwd();
  // Reviewer env var leaks in when these tests run inside `garden review`.
  // Clear it so handleClaudeHook treats the test process as a worker, not a
  // reviewer. Tests that exercise the reviewer-skip path set it explicitly.
  delete process.env.GARDEN_REVIEWER;

  // Origin remote and project checkout so routeStopHookEnd's rev-list works.
  originPath = path.join(env.home, "origin.git");
  spawnSync("git", ["init", "--bare", "-b", "main", originPath], { stdio: "ignore" });

  projectPath = path.join(env.home, "projects", PROJECT);
  fs.mkdirSync(projectPath, { recursive: true });
  spawnSync("git", ["init", "-b", "main", projectPath], { stdio: "ignore" });
  git(projectPath, "config", "user.email", "test@garden.local");
  git(projectPath, "config", "user.name", "garden-test");
  git(projectPath, "remote", "add", "origin", originPath);
  fs.writeFileSync(path.join(projectPath, "README.md"), "# proj\n");
  git(projectPath, "add", ".");
  git(projectPath, "commit", "-m", "init");
  git(projectPath, "push", "-u", "origin", "main");

  // Worker worktree at the path workerFromCwd expects.
  worktreePath = path.join(env.home, ".garden", "worktrees", PROJECT, WORKER);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  git(projectPath, "worktree", "add", worktreePath, "-b", WORKER);

  seedConfig();
});

afterEach(() => {
  process.chdir(originalCwd);
});

describe("handleClaudeHook (real fs + real git)", () => {
  it("notification with agentStatus=working flips to asking", async () => {
    seedRegistry("working");
    process.chdir(worktreePath);
    const { handleClaudeHook } = await import("../../src/dashboard/hook-dispatcher.js");
    handleClaudeHook("notification");
    const reg = readRegistryFile();
    const w = reg.workers[PROJECT][0] as { agentStatus: string };
    expect(w.agentStatus).toBe("asking");
  });

  it("notification with agentStatus=idle self-heals to asking", async () => {
    seedRegistry("idle");
    process.chdir(worktreePath);
    const { handleClaudeHook } = await import("../../src/dashboard/hook-dispatcher.js");
    handleClaudeHook("notification");
    const w = readRegistryFile().workers[PROJECT][0] as { agentStatus: string };
    expect(w.agentStatus).toBe("asking");
  });

  it("notification with agentStatus=ready does NOT flip (not in working/idle set)", async () => {
    seedRegistry("ready");
    process.chdir(worktreePath);
    const { handleClaudeHook } = await import("../../src/dashboard/hook-dispatcher.js");
    handleClaudeHook("notification");
    const w = readRegistryFile().workers[PROJECT][0] as { agentStatus: string };
    expect(w.agentStatus).toBe("ready");
  });

  it("notification with agentStatus=asking stays asking (not in working/idle set)", async () => {
    seedRegistry("asking");
    process.chdir(worktreePath);
    const { handleClaudeHook } = await import("../../src/dashboard/hook-dispatcher.js");
    handleClaudeHook("notification");
    const w = readRegistryFile().workers[PROJECT][0] as { agentStatus: string };
    expect(w.agentStatus).toBe("asking");
  });

  it("pretooluse and posttooluse have OPPOSITE effects on the same starting state", async () => {
    seedRegistry("working");
    process.chdir(worktreePath);
    const { handleClaudeHook } = await import("../../src/dashboard/hook-dispatcher.js");

    handleClaudeHook("pretooluse");
    expect((readRegistryFile().workers[PROJECT][0] as { agentStatus: string }).agentStatus).toBe("asking");

    handleClaudeHook("posttooluse");
    expect((readRegistryFile().workers[PROJECT][0] as { agentStatus: string }).agentStatus).toBe("working");
  });

  it("posttooluse with idle self-heals to working", async () => {
    seedRegistry("idle");
    process.chdir(worktreePath);
    const { handleClaudeHook } = await import("../../src/dashboard/hook-dispatcher.js");
    handleClaudeHook("posttooluse");
    const w = readRegistryFile().workers[PROJECT][0] as { agentStatus: string };
    expect(w.agentStatus).toBe("working");
  });

  it("posttooluse with ready does NOT flip", async () => {
    seedRegistry("ready");
    process.chdir(worktreePath);
    const { handleClaudeHook } = await import("../../src/dashboard/hook-dispatcher.js");
    handleClaudeHook("posttooluse");
    const w = readRegistryFile().workers[PROJECT][0] as { agentStatus: string };
    expect(w.agentStatus).toBe("ready");
  });

  // The record of which subagent raised `asking` has to survive the registry
  // file and its shape guard between hook processes: a rejected shape drops
  // the worker's whole entry on the next read.
  it("a subagent's permission request over an idle worker ends with that agent's next tool event", async () => {
    seedRegistry("idle");
    process.chdir(worktreePath);
    const { handleClaudeHook } = await import("../../src/dashboard/hook-dispatcher.js");
    const { resolveGardenRunner } = await import("../../src/dashboard/runner.js");
    // The request spawns the answered-dialog watcher; `true` stands in for garden.
    vi.mocked(resolveGardenRunner).mockReturnValueOnce("true");
    const readFileSync = fs.readFileSync;
    const fire = (event: string, input: Record<string, unknown>) => {
      const stdin = vi.spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, options?: never) =>
        file === 0 ? JSON.stringify({ session_id: "session-id-1", ...input }) : readFileSync(file, options)) as typeof fs.readFileSync);
      try {
        handleClaudeHook(event);
      } finally {
        stdin.mockRestore();
      }
    };
    const worker = () => readRegistryFile().workers[PROJECT][0] as { agentStatus: string; subagentAsk?: unknown };

    fire("pretooluse", { hook_event_name: "PermissionRequest", tool_name: "Bash", agent_id: "agent-a" });
    expect(worker().agentStatus).toBe("asking");
    expect(worker().subagentAsk).toMatchObject({ agent: "agent-a", resume: "idle" });

    fire("posttooluse", { hook_event_name: "PostToolUse", tool_name: "Read", agent_id: "agent-b" });
    expect(worker().agentStatus).toBe("asking");

    fire("posttooluse", { hook_event_name: "PostToolUse", tool_name: "Read", agent_id: "agent-a" });
    expect(worker().agentStatus).toBe("idle");
    expect(worker().subagentAsk).toBeUndefined();
  });

  it("prompt sets working and clears merged prState", async () => {
    seedRegistry("idle", { prState: "merged" });
    process.chdir(worktreePath);
    const { handleClaudeHook } = await import("../../src/dashboard/hook-dispatcher.js");
    handleClaudeHook("prompt");
    const w = readRegistryFile().workers[PROJECT][0] as { agentStatus: string; prState?: string };
    expect(w.agentStatus).toBe("working");
    expect(w.prState).toBeUndefined();
  });

  it("prompt does not clear non-merged prState", async () => {
    seedRegistry("idle", { prState: "failing" });
    process.chdir(worktreePath);
    const { handleClaudeHook } = await import("../../src/dashboard/hook-dispatcher.js");
    handleClaudeHook("prompt");
    const w = readRegistryFile().workers[PROJECT][0] as { prState?: string };
    expect(w.prState).toBe("failing");
  });

  it("stop sets agentStatus to idle when no commits are ahead", async () => {
    seedRegistry("working");
    process.chdir(worktreePath);
    const { handleClaudeHook } = await import("../../src/dashboard/hook-dispatcher.js");
    handleClaudeHook("stop");
    const w = readRegistryFile().workers[PROJECT][0] as { agentStatus: string; pendingReviewAt?: number };
    expect(w.agentStatus).toBe("idle");
    expect(w.pendingReviewAt).toBeUndefined();
  });

  it("stop with commits ahead of base sets pendingReviewAt and pokes the poller", async () => {
    seedRegistry("working");
    fs.writeFileSync(path.join(worktreePath, "ahead.txt"), "x\n");
    git(worktreePath, "add", "ahead.txt");
    git(worktreePath, "commit", "-m", "ahead");
    process.chdir(worktreePath);
    const { handleClaudeHook } = await import("../../src/dashboard/hook-dispatcher.js");
    const { triggerProjectPoll } = await import("../../src/dashboard/poller-fifo.js");
    vi.mocked(triggerProjectPoll).mockClear();
    handleClaudeHook("stop");
    const w = readRegistryFile().workers[PROJECT][0] as { agentStatus: string; pendingReviewAt?: number };
    expect(w.agentStatus).toBe("idle");
    expect(typeof w.pendingReviewAt).toBe("number");
    expect(triggerProjectPoll).toHaveBeenCalledWith(PROJECT);
  });

  it("stop with commits ahead but unstaged tracked changes does NOT queue a review", async () => {
    // The wolf reproduction: commits ahead of base plus WIP edits to tracked
    // files. The worker only paused mid-work (e.g. to answer an operator
    // question) — reviewing now would certify a stale committed snapshot and
    // force-push under live edits.
    seedRegistry("working");
    fs.writeFileSync(path.join(worktreePath, "ahead.txt"), "x\n");
    git(worktreePath, "add", "ahead.txt");
    git(worktreePath, "commit", "-m", "ahead");
    fs.writeFileSync(path.join(worktreePath, "ahead.txt"), "work in progress\n");
    process.chdir(worktreePath);
    const { handleClaudeHook } = await import("../../src/dashboard/hook-dispatcher.js");
    const { triggerProjectPoll } = await import("../../src/dashboard/poller-fifo.js");
    vi.mocked(triggerProjectPoll).mockClear();
    handleClaudeHook("stop");
    const w = readRegistryFile().workers[PROJECT][0] as { agentStatus: string; pendingReviewAt?: number };
    expect(w.agentStatus).toBe("idle");
    expect(w.pendingReviewAt).toBeUndefined();
    expect(triggerProjectPoll).not.toHaveBeenCalled();
  });

  it("stop with commits ahead but an untracked file does NOT queue a review", async () => {
    seedRegistry("working");
    fs.writeFileSync(path.join(worktreePath, "ahead.txt"), "x\n");
    git(worktreePath, "add", "ahead.txt");
    git(worktreePath, "commit", "-m", "ahead");
    fs.writeFileSync(path.join(worktreePath, "scratch.txt"), "untracked wip\n");
    process.chdir(worktreePath);
    const { handleClaudeHook } = await import("../../src/dashboard/hook-dispatcher.js");
    const { triggerProjectPoll } = await import("../../src/dashboard/poller-fifo.js");
    vi.mocked(triggerProjectPoll).mockClear();
    handleClaudeHook("stop");
    const w = readRegistryFile().workers[PROJECT][0] as { agentStatus: string; pendingReviewAt?: number };
    expect(w.agentStatus).toBe("idle");
    expect(w.pendingReviewAt).toBeUndefined();
    expect(triggerProjectPoll).not.toHaveBeenCalled();
  });

  it("stop with commits ahead but staged uncommitted changes does NOT queue a review", async () => {
    seedRegistry("working");
    fs.writeFileSync(path.join(worktreePath, "ahead.txt"), "x\n");
    git(worktreePath, "add", "ahead.txt");
    git(worktreePath, "commit", "-m", "ahead");
    fs.writeFileSync(path.join(worktreePath, "staged.txt"), "staged wip\n");
    git(worktreePath, "add", "staged.txt");
    process.chdir(worktreePath);
    const { handleClaudeHook } = await import("../../src/dashboard/hook-dispatcher.js");
    const { triggerProjectPoll } = await import("../../src/dashboard/poller-fifo.js");
    vi.mocked(triggerProjectPoll).mockClear();
    handleClaudeHook("stop");
    const w = readRegistryFile().workers[PROJECT][0] as { pendingReviewAt?: number };
    expect(w.pendingReviewAt).toBeUndefined();
    expect(triggerProjectPoll).not.toHaveBeenCalled();
  });

  it("stop with a dirty tree but NO commits ahead still leaves pendingReviewAt unset", async () => {
    // Guards the clean-vs-dirty gate from accidentally inverting the
    // no-commits path: nothing to review either way.
    seedRegistry("working");
    fs.writeFileSync(path.join(worktreePath, "scratch.txt"), "untracked wip\n");
    process.chdir(worktreePath);
    const { handleClaudeHook } = await import("../../src/dashboard/hook-dispatcher.js");
    handleClaudeHook("stop");
    const w = readRegistryFile().workers[PROJECT][0] as { agentStatus: string; pendingReviewAt?: number };
    expect(w.agentStatus).toBe("idle");
    expect(w.pendingReviewAt).toBeUndefined();
  });

  it("sessionstart sets ready when no source", async () => {
    seedRegistry("idle");
    process.chdir(worktreePath);
    const { handleClaudeHook } = await import("../../src/dashboard/hook-dispatcher.js");
    handleClaudeHook("sessionstart");
    const w = readRegistryFile().workers[PROJECT][0] as { agentStatus: string };
    expect(w.agentStatus).toBe("ready");
  });

  it("ignores hook when cwd is outside any worktree", async () => {
    seedRegistry("working");
    process.chdir(env.home);
    const { handleClaudeHook } = await import("../../src/dashboard/hook-dispatcher.js");
    handleClaudeHook("notification");
    const w = readRegistryFile().workers[PROJECT][0] as { agentStatus: string };
    expect(w.agentStatus).toBe("working");
  });

  it("ignores hook when GARDEN_REVIEWER=1 (reviewer hooks must not write registry)", async () => {
    seedRegistry("working");
    process.chdir(worktreePath);
    process.env.GARDEN_REVIEWER = "1";
    try {
      const { handleClaudeHook } = await import("../../src/dashboard/hook-dispatcher.js");
      handleClaudeHook("notification");
      const w = readRegistryFile().workers[PROJECT][0] as { agentStatus: string };
      expect(w.agentStatus).toBe("working");
    } finally {
      delete process.env.GARDEN_REVIEWER;
    }
  });

  it("unknown event is a no-op", async () => {
    seedRegistry("working");
    process.chdir(worktreePath);
    const { handleClaudeHook } = await import("../../src/dashboard/hook-dispatcher.js");
    handleClaudeHook("totally-not-an-event");
    const w = readRegistryFile().workers[PROJECT][0] as { agentStatus: string };
    expect(w.agentStatus).toBe("working");
  });
});

// The watchdog's stand-in for a Stop that Codex did not fire. Codex fires Stop
// on only some of a turn's task_complete events, so the commits that end a
// turn often land after its last fired Stop, and only the heal sees the turn
// end. Run from the watchdog, not the worktree, so nothing here chdirs.
describe("Codex missed-Stop heal (real fs + real git)", () => {
  const CODEX_WORKER = "burnt-mild-reed";
  // Turn activity in the fixture precedes its final task_complete.
  const TURN_ACTIVITY_AT = Date.parse("2026-08-09T09:36:43.187Z");

  function seedCodexWorker(): string {
    const wt = path.join(env.home, ".garden", "worktrees", PROJECT, CODEX_WORKER);
    git(projectPath, "worktree", "add", wt, "-b", CODEX_WORKER);
    fs.writeFileSync(path.join(env.sessionsDir, "dashboard.registry.json"), JSON.stringify({
      workers: {
        [PROJECT]: [{
          name: CODEX_WORKER,
          sessionId: "codex-thread-1",
          task: "do the thing",
          worktreePath: wt,
          branchName: CODEX_WORKER,
          baseBranch: "main",
          harness: "codex",
          agentStatus: "working",
          lastEventAt: TURN_ACTIVITY_AT,
          transcriptPath: path.resolve(__dirname, "../fixtures/codex/rollout-turn-complete.jsonl"),
        }],
      },
    }));
    return wt;
  }

  it("arms the review for commits the turn made after its last fired Stop", async () => {
    const wt = seedCodexWorker();
    fs.writeFileSync(path.join(wt, "ahead.txt"), "x\n");
    git(wt, "add", "ahead.txt");
    git(wt, "commit", "-m", "ahead");
    const { reconcileCodexInputRequests } = await import("../../src/dashboard/codex-input.js");

    expect(reconcileCodexInputRequests()).toBe(true);

    const w = readRegistryFile().workers[PROJECT][0] as { agentStatus: string; pendingReviewAt?: number };
    expect(w.agentStatus).toBe("idle");
    expect(typeof w.pendingReviewAt).toBe("number");
  });

  it("marks a worker done when the turn ended on .garden-done with nothing ahead", async () => {
    const wt = seedCodexWorker();
    fs.writeFileSync(path.join(wt, ".garden-done"), "");
    const { reconcileCodexInputRequests } = await import("../../src/dashboard/codex-input.js");

    expect(reconcileCodexInputRequests()).toBe(true);

    const w = readRegistryFile().workers[PROJECT][0] as { agentStatus: string; prState?: string };
    expect(w.agentStatus).toBe("idle");
    expect(w.prState).toBe("done");
  });
});

// The launch wrapper's record of its agent exiting. The pane outlives the agent
// (`exec $SHELL` follows it), so tmux reports nothing, and an agent that dies
// mid-turn fires no Stop. STATUS.md: `exited` means the worker process is gone.
describe("agent exit (real fs + real git)", () => {
  type Row = {
    agentStatus: string; interruptedWhileWorking?: boolean;
    lastStateChangeAt?: number; pendingReviewAt?: number;
  };

  it("marks the worker exited, and interrupted when the agent died mid-turn", async () => {
    seedRegistry("working");
    process.chdir(worktreePath);
    const { handleAgentExited } = await import("../../src/dashboard/hooks/default.js");

    handleAgentExited(PROJECT, WORKER);

    const w = readRegistryFile().workers[PROJECT][0] as Row;
    expect(w.agentStatus).toBe("exited");
    expect(w.interruptedWhileWorking).toBe(true);
    expect(typeof w.lastStateChangeAt).toBe("number");
  });

  it("does not flag an agent that ended its turn before exiting", async () => {
    seedRegistry("idle");
    process.chdir(worktreePath);
    const { handleAgentExited } = await import("../../src/dashboard/hooks/default.js");

    handleAgentExited(PROJECT, WORKER);

    const w = readRegistryFile().workers[PROJECT][0] as Row;
    expect(w.agentStatus).toBe("exited");
    expect(w.interruptedWhileWorking).toBeUndefined();
  });

  it("arms the review for commits the cut-short turn left behind", async () => {
    seedRegistry("working");
    fs.writeFileSync(path.join(worktreePath, "ahead.txt"), "x\n");
    git(worktreePath, "add", "ahead.txt");
    git(worktreePath, "commit", "-m", "ahead");
    process.chdir(worktreePath);
    const { handleAgentExited } = await import("../../src/dashboard/hooks/default.js");
    const { triggerProjectPoll } = await import("../../src/dashboard/poller-fifo.js");
    vi.mocked(triggerProjectPoll).mockClear();

    handleAgentExited(PROJECT, WORKER);

    const w = readRegistryFile().workers[PROJECT][0] as Row;
    expect(w.agentStatus).toBe("exited");
    expect(typeof w.pendingReviewAt).toBe("number");
    expect(triggerProjectPoll).toHaveBeenCalledWith(PROJECT);
  });

  it("does nothing for a worker the registry does not hold", async () => {
    seedRegistry("working");
    process.chdir(worktreePath);
    const before = readRegistryFile();
    const { handleAgentExited } = await import("../../src/dashboard/hooks/default.js");

    handleAgentExited(PROJECT, "not-a-worker");

    expect(readRegistryFile()).toEqual(before);
    const logFile = path.join(env.sessionsDir, "dashboard.log");
    expect(fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf-8") : "").not.toContain("agent exited");
  });
});

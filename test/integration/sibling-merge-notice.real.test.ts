// The sibling merge notice on a real merge (real fs/git). Its title and its
// recipients depend on git state the unit tests mock away: after the merge,
// origin/<base>..HEAD is empty (a title read from that range is blank), and a
// sibling on another base sees that base's own divergence as overlap. Tmux,
// dashboard refresh and the detached spawns are mocked, so nothing reaches a
// tmux server.
import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { useGitTmpHome } from "./helpers.js";

const env = useGitTmpHome();
const PROJECT = "myproject";

const PANES: Record<string, string> = {
  "_myproject-worker-calm-bay": "%7",
  "_myproject-worker-far-elm": "%8",
};

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
    pasteAndSubmit: vi.fn(),
    capturePaneText: vi.fn(() => ""),
    capturePaneCursor: vi.fn(() => null),
    paneRunningOnlyShell: vi.fn(() => false),
    paneExists: vi.fn(() => false),
  };
});
vi.mock("../../src/dashboard/header.js", () => ({ refreshDashboard: vi.fn(), setupStatusBar: vi.fn() }));
vi.mock("../../src/dashboard/hotkeys.js", () => ({ setupKeybindings: vi.fn() }));
vi.mock("../../src/dashboard/validate.js", () => ({ healStatusPane: vi.fn() }));
vi.mock("../../src/dashboard/usage-poller.js", () => ({ startUsagePoller: vi.fn(), stopUsagePoller: vi.fn() }));
vi.mock("../../src/dashboard/continue.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/dashboard/continue.js")>(
    "../../src/dashboard/continue.js",
  );
  return { ...actual, dispatchDelayedAutoContinue: vi.fn() };
});
vi.mock("../../src/dashboard/poller-fifo.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/dashboard/poller-fifo.js")>(
    "../../src/dashboard/poller-fifo.js",
  );
  return { ...actual, scheduleDelayedPoke: vi.fn() };
});

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

let projectPath: string;
let originPath: string;
const wt = (name: string) => path.join(env.home, ".garden", "worktrees", PROJECT, name);

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
  fs.writeFileSync(path.join(projectPath, "shared.txt"), "base\n");
  fs.writeFileSync(path.join(projectPath, "other.txt"), "base\n");
  git(projectPath, "add", ".");
  git(projectPath, "commit", "-m", "init");
  git(projectPath, "push", "-u", "origin", "main");
  // A second base whose own divergence touches shared.txt.
  git(projectPath, "checkout", "-b", "feat/x");
  fs.writeFileSync(path.join(projectPath, "shared.txt"), "feat/x divergence\n");
  git(projectPath, "commit", "-am", "feat/x divergence");
  git(projectPath, "push", "-u", "origin", "feat/x");
  git(projectPath, "checkout", "main");
  fs.writeFileSync(
    path.join(env.home, ".garden", "config.yml"),
    `projects:\n  ${PROJECT}:\n    path: ${projectPath}\n    logColor: red\n`,
  );
});

async function addWorktreeWorker(
  name: string, base: string, file: string, msg: string, fields: Record<string, unknown>,
): Promise<string> {
  git(projectPath, "fetch", "origin");
  git(projectPath, "worktree", "add", "-b", name, wt(name), `origin/${base}`);
  git(wt(name), "config", "user.email", "test@garden.local");
  git(wt(name), "config", "user.name", "garden-test");
  fs.writeFileSync(path.join(wt(name), file), `${name} change\n`);
  git(wt(name), "commit", "-am", msg);
  git(wt(name), "push", "-u", "origin", name);
  const head = git(wt(name), "rev-parse", "HEAD");
  const { addWorker } = await import("../../src/dashboard/registry.js");
  addWorker(PROJECT, {
    name, sessionId: `s-${name}`, task: "", branchName: name, baseBranch: base,
    worktreePath: wt(name), workflow: "default", ...fields,
  });
  return head;
}

describe("sibling merge notice (real git)", () => {
  it("titles the notice with the merged commit and skips a sibling on another base", async () => {
    const tmuxMod = await import("../../src/dashboard/tmux.js");
    vi.mocked(tmuxMod.windowExists).mockImplementation((n: string) => n in PANES);
    vi.mocked(tmuxMod.getFirstPaneId).mockImplementation((t: string) => PANES[t.split(":")[1]] ?? null);

    const head = await addWorktreeWorker("swift-oak", "main", "shared.txt", "feat: tweak the shared file", {
      prState: "merge-pending", agentStatus: "idle",
      mergePendingAt: new Date(Date.now() - 1000).toISOString(),
    });
    const { updateWorkerFields } = await import("../../src/dashboard/registry.js");
    updateWorkerFields(PROJECT, "swift-oak", { mergeReadySha: head });
    await addWorktreeWorker("calm-bay", "main", "shared.txt", "calm-bay work", {
      prState: "working", agentStatus: "idle",
    });
    await addWorktreeWorker("far-elm", "feat/x", "other.txt", "far-elm work", {
      prState: "working", agentStatus: "idle",
    });

    const { poll } = await import("../../src/dashboard/poller.js");
    poll(PROJECT);

    const { findWorkerByName } = await import("../../src/dashboard/registry.js");
    expect(findWorkerByName(PROJECT, "swift-oak")?.prState).toBe("merged");
    expect(git(originPath, "rev-parse", "main")).toBe(head);

    // The original mechanism: after the merge, origin/main..HEAD is empty.
    const { getCommitSummary, getHeadSubject } = await import("../../src/dashboard/git.js");
    expect(getCommitSummary(wt("swift-oak"), "main")).toBe("");
    expect(getHeadSubject(wt("swift-oak"))).toBe(`${head.slice(0, 7)} feat: tweak the shared file`);

    const calls = vi.mocked(tmuxMod.pasteAndSubmit).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("%7");
    expect(calls[0][1]).toContain(
      `just merged into main: ${head.slice(0, 7)} feat: tweak the shared file`,
    );
  });
});

// How garden runs git. Every git command garden issues is unsandboxed and runs
// as the operator, but most run inside a worker's worktree, where the worker
// decides what git finds there. core.hooksPath points each worktree at its own
// `.garden-hooks`, a git-excluded directory inside the worker's write grant, so
// a pre-push or post-checkout script a worker wrote would run outside its
// sandbox the next time the poller pushed or checked out. Commands therefore
// run with hooks and fsmonitor off unless they ask for the repository's own
// hooks, which only garden's operations on the operator's checkout do: there
// the hooks are the operator's (board's beads hooks import on post-merge).
//
// A leaf module: the hook bundle (hooks/default.ts) runs git on every Stop and
// Bash tool call, so this must stay free of imports beyond child_process.
import { execFileSync } from "node:child_process";

// --no-optional-locks: a plain `git status` takes index.lock to write back the
// stat data it refreshed, and garden reads worktrees while their worker,
// reviewer or resolver commits there, whose own lock then fails ("File exists").
export const SAFE_GIT_CONFIG: readonly string[] = [
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.fsmonitor=false",
  "--no-optional-locks",
];

// Replace refs (refs/replace/<sha>) make git read another object in place of
// the one named, and they live in the shared refs every worker sandbox can
// write: a replacement for origin's tip would hand garden a worker's tree under
// the very SHA origin reported, and the checkout it advances, the worktree it
// creates and the commits it pushes would carry it. Garden's git ignores them.
function gitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" };
}

export interface RunGitOptions {
  /** Keep the repository's hooks and fsmonitor. For commands run in the
   *  operator's own checkout only, never in a worker's worktree. */
  operatorHooks?: boolean;
  timeout?: number;
  /** Discard stderr rather than capture it. */
  quietStderr?: boolean;
}

// Returns stdout untrimmed; throws as execFileSync does when git fails.
export function runGit(cwd: string, args: readonly string[], opts: RunGitOptions = {}): string {
  const argv = opts.operatorHooks ? [...args] : [...SAFE_GIT_CONFIG, ...args];
  return execFileSync("git", argv, {
    cwd,
    env: gitEnv(),
    encoding: "utf-8",
    stdio: ["ignore", "pipe", opts.quietStderr ? "ignore" : "pipe"],
    timeout: opts.timeout ?? 60_000,
    maxBuffer: 256 * 1024 * 1024,
  });
}

// runGit for a command that reads stdin and whose output is binary-safe bytes
// (`cat-file --batch`, which frames each object by its byte length).
export function runGitBytes(cwd: string, args: readonly string[], input: string): Buffer {
  return execFileSync("git", [...SAFE_GIT_CONFIG, ...args], {
    cwd,
    env: gitEnv(),
    input,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 60_000,
    maxBuffer: 256 * 1024 * 1024,
  });
}

// True when the error is execFileSync killing git at its timeout, as opposed
// to git exiting non-zero on its own.
export function gitTimedOut(err: unknown): boolean {
  const e = err as { code?: string; signal?: string };
  return e.code === "ETIMEDOUT" || e.signal === "SIGTERM";
}

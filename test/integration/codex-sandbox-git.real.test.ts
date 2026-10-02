// A Codex worker must be able to stage and commit in its linked worktree under
// the sandbox garden generates for it, and must still be denied an unrelated
// path. The launch settings are taken from the real fresh and resume command
// builders, then applied by the installed `codex sandbox` — Codex's own policy
// code, not a reimplementation of it.
//
// Codex 0.160.0 began carving a writable worktree's resolved gitdir
// (`.git/worktrees/<name>`) out of every broader writable root, so granting
// only the common dir left `git add` denied on index.lock. The grant now names
// the admin dir itself; this test is what notices the next such change.
//
// The sandbox legs skip where Codex is absent or cannot apply a sandbox (a
// nested Seatbelt sandbox refuses `sandbox_apply`, so this runs on the host,
// not inside a worker). The command-builder assertions always run.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildWorktreeWorkerCommand, buildWorktreeResumeCommand } from "../../src/dashboard/create.js";

function git(cwd: string, ...args: string[]) {
  return spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
}

// The `-c` values the generated launch passes to Codex. shellEscape renders
// each as a single-quoted literal, and none of these TOML values holds a quote.
function sandboxOverrides(command: string): string[] {
  expect(command).toContain("-s workspace-write -a never");
  return [...command.matchAll(/-c '([^']*)'/g)]
    .map(m => m[1])
    .filter(v => v.startsWith("sandbox_workspace_write."));
}

describe("codex worker sandbox: git in a linked worktree", () => {
  let tmp: string;
  let proj: string;
  let wt: string;
  let outside: string;
  let codexHome: string;
  let fresh: string[];
  let resumed: string[];

  beforeAll(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-sbx-git-")));
    proj = path.join(tmp, "proj");
    wt = path.join(tmp, "worktrees", "wrk");
    outside = path.join(tmp, "unrelated");
    codexHome = path.join(tmp, "codexhome");
    fs.mkdirSync(outside);
    fs.mkdirSync(codexHome);
    spawnSync("git", ["init", "-q", "-b", "main", proj]);
    git(proj, "-c", "user.email=t@garden.local", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");

    const opts = { harness: "codex", worktreePath: wt };
    // Fresh launch commands are built before the bootstrap creates the worktree.
    fresh = sandboxOverrides(buildWorktreeWorkerCommand("proj", proj, "wrk", "wrk", "", "main", opts));
    expect(git(proj, "worktree", "add", "-q", wt, "-b", "wrk").status).toBe(0);
    resumed = sandboxOverrides(buildWorktreeResumeCommand("proj", proj, "wrk", "wrk", "019f-abc", "main", opts));
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("grants the common dir and the worktree's own admin dir, fresh and resumed", () => {
    const pointer = fs.readFileSync(path.join(wt, ".git"), "utf-8").trim();
    const adminDir = pointer.replace(/^gitdir:\s*/, "");
    for (const overrides of [fresh, resumed]) {
      const roots = overrides.find(v => v.startsWith("sandbox_workspace_write.writable_roots="));
      expect(roots).toContain(JSON.stringify(path.join(proj, ".git")));
      expect(roots).toContain(JSON.stringify(adminDir));
    }
  });

  // Codex grants the temp dirs by default, and this fixture lives in one, so
  // the run excludes them: every write must then come from garden's roots.
  function runSandboxed(overrides: string[], script: string) {
    const config = [
      'sandbox_mode="workspace-write"',
      ...overrides,
      "sandbox_workspace_write.exclude_tmpdir_env_var=true",
      "sandbox_workspace_write.exclude_slash_tmp=true",
    ];
    return spawnSync("codex", [
      "sandbox", "-C", wt, ...config.flatMap(c => ["-c", c]), "--", "/bin/sh", "-c", script,
    ], { encoding: "utf-8", env: { ...process.env, CODEX_HOME: codexHome }, timeout: 60_000 });
  }

  const probe = spawnSync("codex", ["sandbox", "-C", os.tmpdir(), "--", "/usr/bin/true"], {
    encoding: "utf-8",
    env: { ...process.env, CODEX_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "codex-probe-")) },
    timeout: 60_000,
  });
  const sandboxAvailable = probe.error === undefined && probe.status === 0;

  for (const [label, pick] of [["fresh", () => fresh], ["resumed", () => resumed]] as const) {
    it.skipIf(!sandboxAvailable)(`stages and commits under the ${label} launch sandbox`, () => {
      fs.writeFileSync(path.join(wt, `${label}.txt`), `${label}\n`);
      const result = runSandboxed(pick(),
        `git add ${label}.txt && git -c user.email=t@garden.local -c user.name=t commit -q -m ${label}`);
      expect(result.stderr + result.stdout).not.toContain("Operation not permitted");
      expect(result.status).toBe(0);
      expect(git(wt, "log", "-1", "--format=%s").stdout.trim()).toBe(label);
    });

    it.skipIf(!sandboxAvailable)(`still denies an unrelated path under the ${label} launch sandbox`, () => {
      const target = path.join(outside, `${label}.txt`);
      const result = runSandboxed(pick(), `echo leaked > ${target}`);
      expect(result.status).not.toBe(0);
      expect(fs.existsSync(target)).toBe(false);
    });
  }
});

import { describe, it, expect, beforeEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { runCli, useGitTmpHome } from "./helpers.js";

// Run the minimal hook entrypoint bundle (dist/hook.js) directly, the way a
// worker's settings.json hook command does via resolveHookRunner. Extra args
// after the event let a test reproduce a stale session's cached command shape.
function runHookBundle(args: string[], opts: { home: string; cwd: string; logLevel?: string }) {
  const hookPath = path.resolve(process.cwd(), "dist/hook.js");
  if (!fs.existsSync(hookPath)) {
    throw new Error(`runHookBundle: ${hookPath} does not exist — run \`npm run build\` before integration tests`);
  }
  return spawnSync("node", [hookPath, ...args], {
    cwd: opts.cwd,
    env: { ...process.env, HOME: opts.home, ...(opts.logLevel ? { GARDEN_LOG_LEVEL: opts.logLevel } : {}) },
    input: "{}",
    encoding: "utf8",
    timeout: 15000,
  });
}

// Regression: when hooks/default.ts and workflows/default.ts participated in
// a module-init cycle, esbuild captured workflow.hookHandlers as undefined
// and every Claude Code hook crashed with
//   "Cannot read properties of undefined (reading 'onStop')"
// Vitest's source-level module resolution doesn't reproduce the bundling
// order, so the broken bundle could still pass unit tests. This test runs
// the real bundle from inside a worktree-shaped cwd so the hook actually
// reaches pickHookMethod (the crash site) — when cwd is outside any
// worktree, handleClaudeHook short-circuits at workerFromCwd and never
// dereferences workflow.hookHandlers.
const env = useGitTmpHome();

const PROJECT = "myproject";
const WORKER = "bold-ash";
let worktreePath: string;

beforeEach(() => {
  // Reviewer env var leaks in when these tests run inside `garden review`
  // (the reviewer process exports GARDEN_REVIEWER=1, and the spawn helpers
  // inherit process.env). handleClaudeHook short-circuits on it before
  // dispatching, so the bundled-hook regression checks would silently pass
  // without exercising the dispatcher. Clear it so the child behaves as a
  // worker regardless of host — matching the sibling claude-hook.real.test.ts.
  delete process.env.GARDEN_REVIEWER;

  runCli(["init"], { home: env.home });

  // Seed a worktree-shaped cwd. We don't need a real git worktree — just a
  // path that workerFromCwd parses as <home>/.garden/worktrees/<proj>/<wkr>.
  worktreePath = path.join(env.home, ".garden", "worktrees", PROJECT, WORKER);
  fs.mkdirSync(worktreePath, { recursive: true });

  // Seed the registry with a worker entry so findWorkerByName returns truthy
  // and the dispatcher proceeds into pickHookMethod.
  const registryFile = path.join(env.sessionsDir, "dashboard.registry.json");
  fs.writeFileSync(registryFile, JSON.stringify({
    workers: {
      [PROJECT]: [{
        name: WORKER,
        sessionId: "session-id-1",
        worktreePath,
        branchName: WORKER,
        baseBranch: "main",
        agentStatus: "working",
      }],
    },
  }));
});

describe("dashboard _claude-hook (bundled)", () => {
  it("exits cleanly for every Claude Code hook event", () => {
    // Each event routes through pickHookMethod into a different hook method
    // on workflow.hookHandlers. If any handler is undefined (cycle bug) the
    // hook crashes with "Cannot read properties of undefined".
    for (const event of ["sessionstart", "prompt", "notification", "pretooluse", "posttooluse"]) {
      const result = runCli(["dashboard", "_claude-hook", event], {
        home: env.home,
        cwd: worktreePath,
        stdin: "{}",
      });
      expect(result.stderr, `event=${event}`).not.toContain("Cannot read properties of undefined");
      expect(result.status, `event=${event}`).toBe(0);
    }
  });

  it("stop hook (which also exercises routeStopHookEnd) does not crash", () => {
    // Stop is exercised separately because it touches more code — it calls
    // routeStopHookEnd which shells out to git. A cycle-induced undefined
    // here would still surface as the same JS TypeError.
    const result = runCli(["dashboard", "_claude-hook", "stop"], {
      home: env.home,
      cwd: worktreePath,
      stdin: "{}",
    });
    expect(result.stderr).not.toContain("Cannot read properties of undefined");
    expect(result.status).toBe(0);
  });

  // The dedicated minimal bundle (dist/hook.js) has its own import closure, so
  // it needs the same module-init-cycle guard the full cli.js path gets above:
  // a cycle that left workflow.hookHandlers undefined would crash here too.
  it("the minimal hook bundle exits cleanly for every event", () => {
    for (const event of ["sessionstart", "prompt", "notification", "pretooluse", "posttooluse", "stop"]) {
      const result = runHookBundle([event], { home: env.home, cwd: worktreePath });
      expect(result.stderr ?? "", `event=${event}`).not.toContain("Cannot read properties of undefined");
      expect(result.status, `event=${event}`).toBe(0);
    }
  });

  // Regression: a worker Claude session caches its hook command at SessionStart
  // and never reloads it, so a session that started mid-migration still fires
  // the old cli-style shape (`hook.js dashboard _claude-hook posttooluse`)
  // against this entrypoint. argv[2] is then the literal "dashboard" — the bug
  // that logged "unknown claude hook event" with event="dashboard". hook-entry
  // recovers the real event from after the "_claude-hook" token.
  const logFile = () => path.join(env.sessionsDir, "dashboard.log");
  const readLog = () => (fs.existsSync(logFile()) ? fs.readFileSync(logFile(), "utf8") : "");

  it("recovers the real event from a stale session's cli-style arg shape", () => {
    if (fs.existsSync(logFile())) fs.rmSync(logFile());
    const result = runHookBundle(["dashboard", "_claude-hook", "posttooluse"], {
      home: env.home,
      cwd: worktreePath,
      logLevel: "debug",
    });
    expect(result.status).toBe(0);
    // Recovered to "posttooluse" and dispatched — never fell through to the
    // unhandled branch, and never saw the literal "dashboard" as the event.
    expect(readLog()).not.toContain("unhandled claude hook event");
    expect(readLog()).not.toContain('"event":"dashboard"');
  });

  it("logs an unhandled event at debug for a genuinely unknown event", () => {
    if (fs.existsSync(logFile())) fs.rmSync(logFile());
    const result = runHookBundle(["bogus-event"], {
      home: env.home,
      cwd: worktreePath,
      logLevel: "debug",
    });
    expect(result.status).toBe(0);
    const log = readLog();
    expect(log).toContain("unhandled claude hook event");
    expect(log).toContain('"event":"bogus-event"');
    expect(log).toContain('"level":"debug"');
  });
});

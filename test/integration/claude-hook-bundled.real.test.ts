import { describe, it, expect, beforeEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { runCli, useGitTmpHome } from "./helpers.js";

// Run the minimal hook entrypoint bundle (dist/hook.js) directly, the way a
// worker's settings.json hook command does via resolveHookRunner. Extra args
// after the event let a test reproduce a stale session's cached command shape.
// `dist` runs the bundle from another directory; `env` adds to its environment.
function runHookBundle(
  args: string[],
  opts: { home: string; cwd: string; logLevel?: string; dist?: string; env?: NodeJS.ProcessEnv },
) {
  const hookPath = path.join(opts.dist ?? path.resolve(process.cwd(), "dist"), "hook.js");
  if (!fs.existsSync(hookPath)) {
    throw new Error(`runHookBundle: ${hookPath} does not exist — run \`npm run build\` before integration tests`);
  }
  return spawnSync("node", [hookPath, ...args], {
    cwd: opts.cwd,
    env: {
      ...process.env,
      HOME: opts.home,
      ...(opts.logLevel ? { GARDEN_LOG_LEVEL: opts.logLevel } : {}),
      ...opts.env,
    },
    input: "{}",
    encoding: "utf8",
    timeout: 15000,
  });
}

// Regression: hook dispatch has previously failed only in the production
// esbuild bundle because module-init ordering differed from Vitest's
// source-module execution. This test runs the real bundle from inside a
// worktree-shaped cwd so the hook reaches pickHookMethod instead of returning
// early from workerFromCwd.
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
    // Each event routes through pickHookMethod into a different shared hook
    // method. A missing handler must fail in the production bundle too.
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
  // exercise it separately from the full cli.js path above.
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

  // A route a hook spawns (the alerts repaint, the Stop hook's usage refresh,
  // the permission-dialog watcher, owed handoff callbacks) has to run in the
  // CLI. The hook bundle reads its first argument as an event, so a route
  // started through it lands in the dispatcher as event "dashboard" and does
  // nothing but log at debug. This drives the alerts repaint, the one whose
  // effect needs neither a tmux server nor the network: the Stop hook raises an
  // alert while the alerts view is open, and only the CLI carries the renderer
  // that writes the view.
  it("runs a route the hook spawns in the CLI beside the bundle", async () => {
    // Run the built bundles through a link that sits outside any worktree. A
    // garden worker runs this suite inside its own worktree, and from there
    // resolveGardenRunner prefers the `garden` installed on PATH: the route
    // would run the operator's installed build, and a hook bundle that no
    // longer found the CLI beside it would still pass.
    const installDir = path.join(env.home, "install");
    fs.mkdirSync(installDir);
    fs.symlinkSync(path.resolve(process.cwd(), "dist"), path.join(installDir, "dist"));

    // The Stop hook checks a configured project's worker against
    // origin/<base>. The worktree is a repository with no origin, so the check
    // fails and raises the base-drift alert.
    fs.writeFileSync(path.join(env.gardenDir, "config.yml"), yaml.dump({
      projects: { [PROJECT]: { path: env.repoPath } },
    }));
    spawnSync("git", ["init", "-q", worktreePath], { stdio: "ignore" });

    const { readDashState, writeDashState } = await import("../../src/dashboard/state.js");
    const { writeUsageSnapshot } = await import("../../src/dashboard/usage.js");
    // The alerts view open in the garden pane: the hook checks this before it
    // spawns the repaint, and the route checks it again before writing. After
    // writing, the route signals the process in the named pane, so the id is
    // one no pane has.
    writeDashState({ ...readDashState(), gardenPaneType: "alerts", gardenShellPaneId: "%99999999" });
    // A usage snapshot stamped now keeps the Stop hook's usage refresh inside
    // its cooldown: that route calls the real usage endpoint with whatever
    // login this machine has.
    writeUsageSnapshot({ fetchedAt: new Date().toISOString() });

    const result = runHookBundle(["stop"], {
      home: env.home,
      cwd: worktreePath,
      dist: path.join(installDir, "dist"),
      // Puts the dispatcher's "unhandled claude hook event" line in the
      // failure message when the route lands in the hook bundle.
      logLevel: "debug",
      // A socket no tmux server listens on, so neither the hook nor the route
      // can reach the operator's dashboard.
      env: { TMUX: `${path.join(env.home, "no-tmux-server")},0,0` },
    });
    expect(result.status, result.stderr).toBe(0);

    // The hook spawns the route detached and exits without waiting for it.
    const rendered = path.join(env.sessionsDir, "alerts.rendered");
    await vi.waitFor(() => {
      expect(fs.existsSync(rendered), `no alerts view was written; dashboard.log:\n${readLog()}`).toBe(true);
    }, { timeout: 10_000, interval: 100 });
    expect(fs.readFileSync(rendered, "utf8")).toContain(`${PROJECT}/${WORKER}`);
  });
});

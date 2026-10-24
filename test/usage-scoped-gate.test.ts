// The scoped (Fable) meter's active gate, end to end through refreshUsage: a
// worker's headless reviewer counts as Fable spend when the project's real crew
// binding puts Fable on the review seat. The network is a stand-in for
// api.anthropic.com that records which endpoints a refresh reached.
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useTmpHome } from "./helpers.js";

const mockHttps = { paths: [] as string[] };
vi.mock("node:https", async () => {
  const { EventEmitter } = await import("node:events");
  const reset = String(Math.floor(Date.now() / 1000) + 3600);
  const request = (opts: { path: string }, onResponse: (res: InstanceType<typeof EventEmitter>) => void) =>
    Object.assign(new EventEmitter(), {
      write: () => {},
      destroy: () => {},
      end: () => {
        mockHttps.paths.push(opts.path);
        const headers = opts.path === "/v1/messages"
          ? {
              "anthropic-ratelimit-unified-5h-utilization": "0.4",
              "anthropic-ratelimit-unified-5h-reset": reset,
              "anthropic-ratelimit-unified-7d-utilization": "0.41",
              "anthropic-ratelimit-unified-7d-reset": reset,
            }
          : {};
        const res = Object.assign(new EventEmitter(), { statusCode: 200, headers });
        setImmediate(() => {
          onResponse(res);
          res.emit("data", JSON.stringify({ five_hour: null, seven_day: null }));
          res.emit("end");
        });
      },
    });
  return { default: { request }, request };
});

describe("scoped meter gate — a worker's headless reviewer", () => {
  const env = useTmpHome();

  beforeEach(() => {
    vi.resetModules();
    mockHttps.paths.length = 0;
    process.env.GARDEN_CLAUDE_SESSION_KEY = "sk-ant-test-token";
  });
  afterEach(() => {
    delete process.env.GARDEN_CLAUDE_SESSION_KEY;
  });

  function seed(crewLine: string): void {
    const now = Date.now();
    fs.writeFileSync(path.join(env.gardenDir, "config.yml"), `projects:\n  garden:\n    path: /tmp/garden\n${crewLine}`);
    // The worker ended its turn hours ago; only its reviewer is running.
    fs.writeFileSync(path.join(env.sessionsDir, "dashboard.registry.json"), JSON.stringify({
      workers: {
        garden: [{
          name: "lone-oak", sessionId: "s", task: "t", model: "opus",
          prState: "reviewing", reviewStartedAt: now - 60_000, lastEventAt: now - 3 * 60 * 60_000,
        }],
      },
    }));
    // Past the active backstop, well inside the idle keepalive.
    fs.writeFileSync(path.join(env.controlDir, "claude-usage.json"), JSON.stringify({
      fetchedAt: new Date(now - 60 * 60_000).toISOString(),
      scopedAttemptedAt: new Date(now - 2 * 60 * 60_000).toISOString(),
    }));
  }

  it("refreshes the scoped bar while a Fable review seat is reviewing", async () => {
    seed("    crew: all-claude\n");
    const { refreshUsage } = await import("../src/dashboard/usage.js");

    await refreshUsage(false, "poller");

    expect(mockHttps.paths).toEqual(["/v1/messages", "/api/oauth/usage"]);
  });

  it("keeps the idle keepalive while the reviewer runs the default Opus", async () => {
    seed("");
    const { refreshUsage } = await import("../src/dashboard/usage.js");

    await refreshUsage(false, "poller");

    expect(mockHttps.paths).toEqual(["/v1/messages"]);
  });
});

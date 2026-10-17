import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/dashboard/usage.js", () => ({
  decideRefresh: vi.fn(),
  readUsageSnapshot: vi.fn(),
  refreshUsage: vi.fn(),
  POLL_ERR_MS: 600_000,
}));
vi.mock("../src/dashboard/header.js", () => ({ refreshDashboard: vi.fn() }));
vi.mock("../src/dashboard/tmux.js", () => ({
  newDashboardWindow: vi.fn(),
  windowExists: vi.fn(),
  killWindowSafe: vi.fn(),
}));
vi.mock("../src/config.js", () => ({
  anyAnthropicMeteredProject: vi.fn(),
  getAutoContinueConfig: vi.fn(() => ({ enabled: true })),
  loadConfig: vi.fn(() => ({ projects: {} })),
}));
vi.mock("../src/dashboard/poller-fifo.js", () => ({ triggerProjectPoll: vi.fn() }));
vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { usagePollerPass, ensureUsagePoller } from "../src/dashboard/usage-poller.js";
import { decideRefresh, refreshUsage } from "../src/dashboard/usage.js";
import { newDashboardWindow, windowExists } from "../src/dashboard/tmux.js";
import { anyAnthropicMeteredProject } from "../src/config.js";
import { log } from "../src/dashboard/log.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("usagePollerPass", () => {
  it("sleeps until the snapshot says the next refresh is due", async () => {
    vi.mocked(refreshUsage).mockResolvedValue({} as Awaited<ReturnType<typeof refreshUsage>>);
    vi.mocked(decideRefresh).mockReturnValue({ nextAttemptInMs: 90_000 } as ReturnType<typeof decideRefresh>);

    await expect(usagePollerPass()).resolves.toBe(90_000);
    expect(log.warn).not.toHaveBeenCalled();
  });

  // One throw used to end the loop and its window, freezing the bars with no
  // log line until the next dashboard attach.
  it("survives a failed refresh, logs it, and backs off", async () => {
    vi.mocked(refreshUsage).mockRejectedValue(new Error("Could not acquire claude-usage lock after 5000ms"));

    await expect(usagePollerPass()).resolves.toBe(600_000);
    expect(log.warn).toHaveBeenCalledWith("usage-poller", "refresh failed", {
      data: { error: "Error: Could not acquire claude-usage lock after 5000ms", retryInMs: 600_000 },
    });
  });
});

describe("ensureUsagePoller", () => {
  it("leaves a live usage poller alone", () => {
    vi.mocked(windowExists).mockReturnValue(true);
    vi.mocked(anyAnthropicMeteredProject).mockReturnValue(true);

    ensureUsagePoller("node /usr/local/bin/garden");

    expect(newDashboardWindow).not.toHaveBeenCalled();
  });

  it("revives a usage poller whose window is gone", () => {
    vi.mocked(windowExists).mockReturnValue(false);
    vi.mocked(anyAnthropicMeteredProject).mockReturnValue(true);

    ensureUsagePoller("node /usr/local/bin/garden");

    expect(vi.mocked(newDashboardWindow).mock.calls.map(c => c[0])).toEqual(["_garden-usage-poller"]);
  });

  // The watchdog calls this every tick; startUsagePoller logs its own skip.
  it("does nothing, silently, on a provider-only fleet", () => {
    vi.mocked(windowExists).mockReturnValue(false);
    vi.mocked(anyAnthropicMeteredProject).mockReturnValue(false);

    ensureUsagePoller("node /usr/local/bin/garden");

    expect(newDashboardWindow).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });
});

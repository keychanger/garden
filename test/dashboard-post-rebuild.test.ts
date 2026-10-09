import { describe, it, expect, vi } from "vitest";

vi.mock("../src/session.js", async (orig) => ({
  ...(await orig<typeof import("../src/session.js")>()),
  dashboardExists: vi.fn(() => true),
}));
vi.mock("../src/dashboard/hotkeys.js", () => ({ setupKeybindings: vi.fn() }));
vi.mock("../src/dashboard/runner.js", async (orig) => ({
  ...(await orig<typeof import("../src/dashboard/runner.js")>()),
  resolveGardenRunner: vi.fn(() => "/new/garden"),
}));
vi.mock("../src/dashboard/state.js", async (orig) => ({
  ...(await orig<typeof import("../src/dashboard/state.js")>()),
  readDashState: vi.fn(() => ({})),
}));
vi.mock("../src/dashboard/header.js", async (orig) => ({
  ...(await orig<typeof import("../src/dashboard/header.js")>()),
  setupStatusBar: vi.fn(),
  refreshDashboard: vi.fn(),
}));
vi.mock("../src/dashboard/create.js", async (orig) => ({
  ...(await orig<typeof import("../src/dashboard/create.js")>()),
  respawnStatusPane: vi.fn(),
  respawnLogsPane: vi.fn(),
}));
vi.mock("../src/dashboard/poller.js", async (orig) => ({
  ...(await orig<typeof import("../src/dashboard/poller.js")>()),
  restartLongLivedPollers: vi.fn(),
}));

import { dashboard } from "../src/dashboard/index.js";
import { setupKeybindings } from "../src/dashboard/hotkeys.js";

describe("dashboard _post-rebuild-refresh", () => {
  it("reinstalls key bindings from the rebuilt binary", async () => {
    // The poller that ran the rebuild still holds pre-rebuild code, so a
    // binding change only reaches tmux when the rebuilt binary installs it.
    await dashboard(["_post-rebuild-refresh"]);
    expect(setupKeybindings).toHaveBeenCalledWith("/new/garden");
  });
});

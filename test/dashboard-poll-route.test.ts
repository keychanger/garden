import { describe, it, expect, vi } from "vitest";

vi.mock("../src/dashboard/poller.js", async (orig) => ({
  ...(await orig<typeof import("../src/dashboard/poller.js")>()),
  poll: vi.fn(() => { throw new Error("registry unreadable"); }),
}));
vi.mock("../src/dashboard/log.js", async (orig) => ({
  ...(await orig<typeof import("../src/dashboard/log.js")>()),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { dashboard } from "../src/dashboard/index.js";
import { log } from "../src/dashboard/log.js";

describe("dashboard _poll", () => {
  // The poller loop sends stderr to /dev/null, so this log line is the only
  // trace a poll that throws on every pass leaves.
  it("logs a poll that throws, then rethrows it", async () => {
    await expect(dashboard(["_poll", "alpha"])).rejects.toThrow("registry unreadable");
    expect(log.error).toHaveBeenCalledWith("poller", "poll crashed", {
      data: expect.objectContaining({ project: "alpha", error: "Error: registry unreadable" }),
    });
  });
});

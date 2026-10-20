import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/dashboard/tmux.js", async (orig) => ({
  ...(await orig<typeof import("../src/dashboard/tmux.js")>()),
  takePromptReply: vi.fn(),
}));
vi.mock("../src/dashboard/logs-filter.js", () => ({
  openLogsFilterPrompt: vi.fn(),
  applyLogsFilter: vi.fn(),
}));

import { dashboard } from "../src/dashboard/index.js";
import { takePromptReply } from "../src/dashboard/tmux.js";
import { applyLogsFilter } from "../src/dashboard/logs-filter.js";

beforeEach(() => vi.clearAllMocks());

describe("dashboard _prompt-reply", () => {
  it("hands the stored reply to the named route as one argument, as typed", async () => {
    vi.mocked(takePromptReply).mockReturnValue("w:bold-ash $(id) \"q\"");

    await dashboard(["_prompt-reply", "_logs-filter-apply"]);

    expect(applyLogsFilter).toHaveBeenCalledWith("w:bold-ash $(id) \"q\"");
  });

  it("does nothing when no reply is waiting", async () => {
    vi.mocked(takePromptReply).mockReturnValue(null);

    await dashboard(["_prompt-reply", "_logs-filter-apply"]);

    expect(applyLogsFilter).not.toHaveBeenCalled();
  });
});

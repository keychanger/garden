import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/dashboard/tmux.js", async (orig) => ({
  ...(await orig<typeof import("../src/dashboard/tmux.js")>()),
  takePromptReply: vi.fn(),
  tmuxDisplay: vi.fn(),
}));
vi.mock("../src/dashboard/logs-filter.js", () => ({
  openLogsFilterPrompt: vi.fn(),
  applyLogsFilter: vi.fn(),
}));
vi.mock("../src/commands/trellis.js", () => ({ trellis: vi.fn() }));

import { dashboard } from "../src/dashboard/index.js";
import { takePromptReply, tmuxDisplay } from "../src/dashboard/tmux.js";
import { applyLogsFilter } from "../src/dashboard/logs-filter.js";
import { trellis } from "../src/commands/trellis.js";

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

  it("scaffolds a trellis from the picker's typed name", async () => {
    vi.mocked(takePromptReply).mockReturnValue("auth rewrite #(id)");

    await dashboard(["_prompt-reply", "_trellis-new", "proj"]);

    expect(trellis).toHaveBeenCalledWith(["new", "proj", "auth rewrite #(id)"]);
  });

  it("shows a scaffold failure in the status line instead of losing it", async () => {
    vi.mocked(takePromptReply).mockReturnValue("auth");
    vi.mocked(trellis).mockRejectedValueOnce(new Error("Trellis already exists at /x/auth.md"));

    await dashboard(["_prompt-reply", "_trellis-new", "proj"]);

    expect(tmuxDisplay).toHaveBeenCalledWith("Trellis already exists at /x/auth.md", { untilKey: true });
  });
});

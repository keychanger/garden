// The project shell's Claude launch: its rules come from the control tree.
import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import { useTmpHome } from "./helpers.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn(() => ({ on: vi.fn() })) }));
vi.mock("../src/config.js", async (orig) => ({
  ...(await orig<typeof import("../src/config.js")>()),
  detectProjectFromPath: vi.fn(() => "proj"),
  getProject: vi.fn(() => ({ name: "proj", path: "/repo/proj" })),
}));
vi.mock("../src/rules.js", () => ({ buildRulesContext: vi.fn(() => "project rules") }));
vi.mock("../src/dashboard/claude-env.js", () => ({ claudeEnvObject: vi.fn(() => ({})) }));

useTmpHome();

describe("launchDashboardClaude", () => {
  it("hands Claude the project's rules from the control tree, not the worker-writable sessions dir", async () => {
    const { launchDashboardClaude } = await import("../src/dashboard-claude.js");
    const { contextFilePath } = await import("../src/dashboard/headless-paths.js");
    const { spawn } = await import("node:child_process");

    void launchDashboardClaude(["/repo/proj"]);

    const context = contextFilePath("/repo/proj");
    expect(spawn).toHaveBeenCalledWith("claude", ["--append-system-prompt-file", context], expect.anything());
    expect(fs.readFileSync(context, "utf8")).toBe("project rules");
  });
});

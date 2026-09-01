import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { STATUS_LINE_SCRIPT } from "../src/dashboard/harness/claude-code.js";

function renderStatusLine(input: unknown): string {
  return execFileSync(
    process.execPath,
    ["--input-type=module", "--eval", STATUS_LINE_SCRIPT],
    { input: JSON.stringify(input), encoding: "utf8" },
  );
}

describe("Claude Code worker status line", () => {
  it("renders model, effort, and remaining context from the session payload", () => {
    expect(renderStatusLine({
      model: { display_name: "Opus 5" },
      effort: { level: "xhigh" },
      context_window: { remaining_percentage: 62.4, context_window_size: 200_000 },
    })).toBe("Opus 5 · xhigh · 62% of 200k context left");
  });

  it("omits unavailable readings and degrades cleanly when the window size is absent", () => {
    expect(renderStatusLine({
      model: { display_name: "Sonnet 5" },
      context_window: { remaining_percentage: 100 },
    })).toBe("Sonnet 5 · 100% context left");
  });
});

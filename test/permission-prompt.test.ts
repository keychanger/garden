import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerEntry } from "../src/dashboard/registry.js";
import type { PaneCursorState } from "../src/dashboard/tmux.js";

const workers: Record<string, WorkerEntry[]> = {};
let pane = { text: "", cursor: null as PaneCursorState | null };

vi.mock("../src/dashboard/registry.js", () => ({
  readRegistry: vi.fn(() => ({ workers })),
  updateWorkerFieldsIf: vi.fn((
    project: string,
    workerName: string,
    decide: (entry: WorkerEntry) => { fields: Partial<WorkerEntry> | null; result: unknown },
  ) => {
    const entry = workers[project]?.find(candidate => candidate.name === workerName);
    if (!entry) return undefined;
    const decision = decide(entry);
    if (decision.fields !== null) Object.assign(entry, decision.fields);
    return decision.result;
  }),
}));

vi.mock("../src/dashboard/header.js", () => ({
  findWorkerPaneId: vi.fn(() => "%1"),
  refreshDashboard: vi.fn(),
}));

vi.mock("../src/dashboard/tmux.js", () => ({
  capturePaneText: vi.fn(() => pane.text),
  readPaneCursorState: vi.fn(() => pane.cursor),
}));

vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  composerHasCursor,
  sweepAnsweredPermissionPrompts,
  watchPermissionPrompt,
} from "../src/dashboard/permission-prompt.js";
import { findWorkerPaneId, refreshDashboard } from "../src/dashboard/header.js";

const RULE = "─".repeat(60);
const DASHED = "╌".repeat(60);

// Captured from Claude Code 2.1.292 in manual mode: a Bash permission dialog
// (caret hidden), then the same pane after approving it.
const DIALOG = [
  "❯ Run exactly this bash command: sleep 20",
  "⏺ Bash(sleep 20)",
  "  ⎿  Waiting…",
  RULE,
  " Bash command",
  DASHED,
  " sleep 20",
  DASHED,
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. Yes, and always allow access to /tmp from this project",
  "   3. No",
  " Esc to cancel · Tab to amend",
].join("\n");

const RUNNING = [
  "❯ Run exactly this bash command: sleep 20",
  "⏺ Bash(sleep 20)",
  "  ⎿  Running… (3s)",
  "     (ctrl+b ctrl+b (twice) to run in background)",
  "✽ Polishing… (6s · ↓ 220 tokens)",
  RULE,
  "❯ ",
  RULE,
  "  ⏸ manual mode on · esc to interrupt · ← for agents",
].join("\n");

// AskUserQuestion puts its own unindented "❯" on an option row.
const QUESTION = [
  RULE,
  "←  ☐ Lex base  ☐ Website PR  ✔ Submit  →",
  "Which branch should the Lex PR target?",
  "❯ 1. develop (Recommended)",
  "  2. main",
  "  3. Type something.",
  RULE,
  "  4. Chat about this",
].join("\n");

describe("composerHasCursor", () => {
  it("is false while a permission dialog hides the caret", () => {
    expect(composerHasCursor(DIALOG, { x: 1, y: 9, visible: false })).toBe(false);
  });

  it("is true once the caret is back in the composer", () => {
    expect(composerHasCursor(RUNNING, { x: 2, y: 6, visible: true })).toBe(true);
  });

  it("follows a wrapped draft back up to the composer row", () => {
    const wrapped = RUNNING.replace("❯ ", "❯ a long draft that wraps\n  onto a second row");
    expect(composerHasCursor(wrapped, { x: 18, y: 7, visible: true })).toBe(true);
  });

  it("is false for a visible caret on a dialog's own option rows", () => {
    expect(composerHasCursor(DIALOG, { x: 3, y: 9, visible: true })).toBe(false);
    expect(composerHasCursor(QUESTION, { x: 5, y: 5, visible: true })).toBe(false);
    expect(composerHasCursor(QUESTION, { x: 2, y: 3, visible: true })).toBe(false);
  });

  it("is false when the cursor is unknown", () => {
    expect(composerHasCursor(RUNNING, null)).toBe(false);
  });
});

function seed(fields: Partial<WorkerEntry>): WorkerEntry {
  const entry = { name: "bold-ash", sessionId: "s", task: "", ...fields } as WorkerEntry;
  workers.wolf = [entry];
  return entry;
}

const closed = () => { pane = { text: RUNNING, cursor: { x: 2, y: 6, visible: true } }; };
const open = () => { pane = { text: DIALOG, cursor: { x: 1, y: 9, visible: false } }; };

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  for (const key of Object.keys(workers)) delete workers[key];
  vi.mocked(findWorkerPaneId).mockReturnValue("%1");
});

describe("watchPermissionPrompt", () => {
  it("returns the worker to working once the dialog has closed", async () => {
    vi.useFakeTimers();
    const entry = seed({ agentStatus: "asking", lastStateChangeAt: 1000 });
    open();
    const done = watchPermissionPrompt("wolf", "bold-ash", 1000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(entry.agentStatus).toBe("asking");

    closed();
    await vi.advanceTimersByTimeAsync(2_000);
    await done;
    expect(entry.agentStatus).toBe("working");
    expect(entry.lastStateChangeAt).not.toBe(1000);
    expect(refreshDashboard).toHaveBeenCalledTimes(1);
  });

  it("needs two closed readings in a row", async () => {
    vi.useFakeTimers();
    const entry = seed({ agentStatus: "asking", lastStateChangeAt: 1000 });
    closed();
    const done = watchPermissionPrompt("wolf", "bold-ash", 1000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(entry.agentStatus).toBe("asking");
    open();
    await vi.advanceTimersByTimeAsync(1_000);
    closed();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(entry.agentStatus).toBe("asking");
    await vi.advanceTimersByTimeAsync(1_000);
    await done;
    expect(entry.agentStatus).toBe("working");
  });

  it("stops without writing when a newer episode replaced the one it watched", async () => {
    vi.useFakeTimers();
    const entry = seed({ agentStatus: "asking", lastStateChangeAt: 2000 });
    closed();
    const done = watchPermissionPrompt("wolf", "bold-ash", 1000);
    await vi.advanceTimersByTimeAsync(3_000);
    await done;
    expect(entry.agentStatus).toBe("asking");
    expect(findWorkerPaneId).not.toHaveBeenCalled();
  });

  it("gives up after its window while the dialog stays open", async () => {
    vi.useFakeTimers();
    const entry = seed({ agentStatus: "asking", lastStateChangeAt: 1000 });
    open();
    const done = watchPermissionPrompt("wolf", "bold-ash", 1000);
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    await done;
    expect(entry.agentStatus).toBe("asking");
  });
});

describe("sweepAnsweredPermissionPrompts", () => {
  const now = 100_000;

  it("clears an asking claude-code worker whose dialog has closed", () => {
    const entry = seed({ agentStatus: "asking", lastStateChangeAt: now - 60_000 });
    closed();
    expect(sweepAnsweredPermissionPrompts({ workers }, now)).toBe(true);
    expect(entry.agentStatus).toBe("working");
  });

  it("leaves a worker whose dialog is still open", () => {
    const entry = seed({ agentStatus: "asking", lastStateChangeAt: now - 60_000 });
    open();
    expect(sweepAnsweredPermissionPrompts({ workers }, now)).toBe(false);
    expect(entry.agentStatus).toBe("asking");
  });

  it("leaves a fresh episode the dialog may not have drawn yet", () => {
    const entry = seed({ agentStatus: "asking", lastStateChangeAt: now - 1_000 });
    closed();
    expect(sweepAnsweredPermissionPrompts({ workers }, now)).toBe(false);
    expect(entry.agentStatus).toBe("asking");
  });

  it("leaves Codex workers and workers it cannot find a pane for", () => {
    const codex = seed({ agentStatus: "asking", harness: "codex", lastStateChangeAt: now - 60_000 });
    closed();
    expect(sweepAnsweredPermissionPrompts({ workers }, now)).toBe(false);
    expect(codex.agentStatus).toBe("asking");

    const claude = seed({ agentStatus: "asking", lastStateChangeAt: now - 60_000 });
    vi.mocked(findWorkerPaneId).mockReturnValue(null);
    expect(sweepAnsweredPermissionPrompts({ workers }, now)).toBe(false);
    expect(claude.agentStatus).toBe("asking");
  });
});

// Delivery of a handoff callback to the parent's pane. The callback is owed to
// the parent until a paste actually lands: a parent that is mid-turn, held, or
// drafting when its child settles must still receive it, at its next turn end.
// Real registry on disk; tmux, telemetry, and transcript reads are stubbed.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useTmpHome } from "./helpers.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}));

vi.mock("../src/dashboard/state.js", () => ({
  readDashState: vi.fn(() => ({
    activeProject: "fox",
    statusPaneId: null,
    gardenShellPaneId: null,
    gardenPaneType: null,
    gardenWindowName: null,
    activePaneId: "%5",
    activePaneType: null,
    activeWindowName: "_fox-worker-calm-bay",
    lastActiveWorker: {},
    lastActiveProjectByPlot: {},
  })),
}));

vi.mock("../src/dashboard/tmux.js", () => ({
  tmux: vi.fn(),
  pasteAndSubmit: vi.fn(),
  shellEscape: vi.fn((s: string) => `'${s}'`),
  getFirstPaneId: vi.fn(() => "%5"),
  paneExists: vi.fn(() => true),
  windowExists: vi.fn(() => true),
  capturePaneText: vi.fn(() => ""),
  capturePaneCursor: vi.fn(() => null),
  paneRunningOnlyShell: vi.fn(() => false),
  pressEnter: vi.fn(),
}));

vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/dashboard/telemetry.js", () => ({
  recordContinueDispatched: vi.fn(),
}));

vi.mock("../src/dashboard/prompt-verify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/dashboard/prompt-verify.js")>()),
  readLandedPrompt: vi.fn(() => null),
}));

vi.mock("../src/dashboard/alerts.js", () => ({
  addAlert: vi.fn(),
}));

useTmpHome();

const CHILD = {
  childProject: "wolf",
  childWorker: "bold-ash",
  childBranch: "bold-ash",
  terminalState: "merged" as const,
  parentProject: "fox",
  parentWorker: "calm-bay",
  replyNote: undefined,
};

async function seedParent(agentStatus: "idle" | "working" | "paused"): Promise<void> {
  const { addWorker } = await import("../src/dashboard/registry.js");
  addWorker("fox", { name: "calm-bay", sessionId: "s", task: "", agentStatus });
}

async function setParentStatus(agentStatus: "idle" | "working"): Promise<void> {
  const { updateWorkerFields } = await import("../src/dashboard/registry.js");
  updateWorkerFields("fox", "calm-bay", { agentStatus });
}

async function pastedMessages(): Promise<string[]> {
  const { pasteAndSubmit } = await import("../src/dashboard/tmux.js");
  return vi.mocked(pasteAndSubmit).mock.calls.map(call => call[1]);
}

describe("handoff callback delivery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it("pastes a callback naming the child, its state, branch, and reply note", async () => {
    await seedParent("idle");
    const { notifyHandoffCallback } = await import("../src/dashboard/continue.js");

    notifyHandoffCallback({ ...CHILD, replyNote: "Root cause is in src/foo.ts:42." });

    const messages = await pastedMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("Handoff callback");
    expect(messages[0]).toContain("wolf/bold-ash");
    expect(messages[0]).toContain("merged");
    expect(messages[0]).toContain("branch: bold-ash");
    expect(messages[0]).toContain("Reply from bold-ash:");
    expect(messages[0]).toContain("Root cause is in src/foo.ts:42.");
  });

  it("labels a failing child as needing operator attention", async () => {
    await seedParent("idle");
    const { notifyHandoffCallback } = await import("../src/dashboard/continue.js");

    notifyHandoffCallback({ ...CHILD, terminalState: "failing" });

    const [message] = await pastedMessages();
    expect(message).toContain("failing");
    expect(message).toContain("operator attention");
  });

  it("does not deliver a callback twice once it has landed", async () => {
    await seedParent("idle");
    const { notifyHandoffCallback, deliverHandoffCallbacks } = await import("../src/dashboard/continue.js");

    notifyHandoffCallback(CHILD);
    deliverHandoffCallbacks("fox", "calm-bay");

    expect(await pastedMessages()).toHaveLength(1);
  });

  it("keeps the callback owed when delivery only re-submits an older stuck paste", async () => {
    await seedParent("idle");
    const { updateWorkerFields, findWorkerByName } = await import("../src/dashboard/registry.js");
    const { capturePaneText, pasteAndSubmit, pressEnter } = await import("../src/dashboard/tmux.js");
    const { notifyHandoffCallback, deliverHandoffCallbacks } = await import("../src/dashboard/continue.js");
    updateWorkerFields("fox", "calm-bay", { continueSentAt: 123 });
    vi.mocked(capturePaneText).mockReturnValue("❯ [garden] An older prompt is still unsent");

    notifyHandoffCallback(CHILD);

    expect(pressEnter).toHaveBeenCalledWith("%5");
    expect(pasteAndSubmit).not.toHaveBeenCalled();
    expect(findWorkerByName("fox", "calm-bay")?.pendingHandoffCallbacks).toHaveLength(1);

    vi.mocked(capturePaneText).mockReturnValue("");
    expect(deliverHandoffCallbacks("fox", "calm-bay")).toBe(true);
    expect(pasteAndSubmit).toHaveBeenCalledTimes(1);
    expect(findWorkerByName("fox", "calm-bay")?.pendingHandoffCallbacks).toBeUndefined();
  });

  it("keeps the callback owed while the parent is mid-turn and delivers it once the parent is idle", async () => {
    await seedParent("working");
    const { notifyHandoffCallback, deliverHandoffCallbacks } = await import("../src/dashboard/continue.js");

    notifyHandoffCallback(CHILD);
    expect(await pastedMessages()).toHaveLength(0);

    await setParentStatus("idle");
    deliverHandoffCallbacks("fox", "calm-bay");

    const messages = await pastedMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("wolf/bold-ash");

    deliverHandoffCallbacks("fox", "calm-bay");
    expect(await pastedMessages()).toHaveLength(1);
  });

  it("keeps the callback owed while the operator holds the parent", async () => {
    await seedParent("paused");
    const { notifyHandoffCallback, deliverHandoffCallbacks } = await import("../src/dashboard/continue.js");

    notifyHandoffCallback(CHILD);
    expect(await pastedMessages()).toHaveLength(0);

    await setParentStatus("idle");
    deliverHandoffCallbacks("fox", "calm-bay");
    expect(await pastedMessages()).toHaveLength(1);
  });

  it("folds every child that settled during the parent's turn into one prompt", async () => {
    await seedParent("working");
    const { notifyHandoffCallback, deliverHandoffCallbacks } = await import("../src/dashboard/continue.js");

    notifyHandoffCallback(CHILD);
    notifyHandoffCallback({ ...CHILD, childWorker: "dry-elm", childBranch: "dry-elm" });

    await setParentStatus("idle");
    deliverHandoffCallbacks("fox", "calm-bay");

    const messages = await pastedMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("wolf/bold-ash");
    expect(messages[0]).toContain("wolf/dry-elm");
  });

  it("schedules delivery at the parent's turn end only when a callback is owed", async () => {
    await seedParent("working");
    const { notifyHandoffCallback, dispatchOwedHandoffCallbacks } = await import("../src/dashboard/continue.js");
    const { spawn } = await import("node:child_process");

    dispatchOwedHandoffCallbacks("fox", "calm-bay");
    expect(spawn).not.toHaveBeenCalled();

    notifyHandoffCallback(CHILD);
    dispatchOwedHandoffCallbacks("fox", "calm-bay");

    const commands = vi.mocked(spawn).mock.calls.map(call => String(call[1]?.[1]));
    expect(commands.some(cmd => cmd.includes("_deliver-handoff-callbacks") && cmd.includes("'calm-bay'")))
      .toBe(true);
  });

  it("drops the callback without error when the parent worker no longer exists", async () => {
    const { notifyHandoffCallback, dispatchOwedHandoffCallbacks } = await import("../src/dashboard/continue.js");

    expect(() => notifyHandoffCallback(CHILD)).not.toThrow();
    dispatchOwedHandoffCallbacks("fox", "calm-bay");
    expect(await pastedMessages()).toHaveLength(0);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}));

vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn(() => false),
    unlinkSync: vi.fn(),
    readFileSync: vi.fn(() => "seed body"),
  },
}));

vi.mock("../src/session.js", () => ({
  DASHBOARD_SESSION: "garden-dashboard",
}));

vi.mock("../src/dashboard/state.js", () => ({
  readDashState: vi.fn(),
}));

vi.mock("../src/config.js", () => ({
  tryGetProject: vi.fn(() => null),
}));

vi.mock("../src/dashboard/registry.js", () => ({
  findWorkerByName: vi.fn(),
  updateWorkerFields: vi.fn(),
}));

vi.mock("../src/dashboard/tmux.js", () => ({
  tmux: vi.fn(),
  pasteAndSubmit: vi.fn(),
  // Match real shellEscape: pass safe-token strings through unquoted, and
  // single-quote anything else. Tests must reflect actual behavior so
  // round-tripping a path with spaces produces the same shell.
  shellEscape: vi.fn((s: string) =>
    /^[a-zA-Z0-9_./:=-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`),
  getFirstPaneId: vi.fn(() => "%20"),
  paneExists: vi.fn(() => true),
  windowExists: vi.fn(() => true),
  // Default: empty box → no operator draft → continue prompts deliver as before.
  // Tests that exercise the draft gate override this per-case.
  capturePaneText: vi.fn(() => ""),
  // Default: cursor unknown → extractOperatorDraft falls back to the whole
  // post-marker remainder. Tests that exercise ghost-text exclusion override it.
  capturePaneCursor: vi.fn(() => null),
  // Default: pane is a live agent (not a bare shell) → continue prompts deliver.
  // The exited-pane test overrides this to true.
  paneRunningOnlyShell: vi.fn(() => false),
  pressEnter: vi.fn(),
}));

vi.mock("../src/dashboard/window-names.js", () => ({
  workerWindowName: (project: string, worker: string) => `_${project}-worker-${worker}`,
}));

vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Spy the one telemetry sink continue.ts reaches, so the caller-side counting
// invariant (continue.dispatched fires once per real delivery, never on a skip)
// is asserted here — mirroring test/poller.test.ts's recordCiFixOutcome spy.
vi.mock("../src/dashboard/telemetry.js", () => ({
  recordContinueDispatched: vi.fn(),
}));

import {
  continueWorker, continueWorkerAfterMerge, continueWorkerAfterMergeIfStuck,
  continueWorkerIfStuck,
  dispatchDelayedContinue, dispatchDelayedAutoContinue,
  dispatchDelayedSeed, seedWorker, notifyHandoffCallback,
  donePath, isDoneSet, clearDoneSentinel,
  extractOperatorDraft, rearmContinueIfDrafting,
} from "../src/dashboard/continue.js";
import { readDashState } from "../src/dashboard/state.js";
import { findWorkerByName, updateWorkerFields } from "../src/dashboard/registry.js";
import { tmux, pasteAndSubmit, paneExists, windowExists, getFirstPaneId, capturePaneText, capturePaneCursor, paneRunningOnlyShell, pressEnter } from "../src/dashboard/tmux.js";
import { recordContinueDispatched } from "../src/dashboard/telemetry.js";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { tryGetProject } from "../src/config.js";
import type { DashboardState } from "../src/dashboard/state.js";

function makeState(overrides: Partial<DashboardState> = {}): DashboardState {
  return {
    activeProject: "myproject",
    statusPaneId: null,
    gardenShellPaneId: null,
    gardenPaneType: null,
    gardenWindowName: null,
    activePaneId: null,
    activePaneType: null,
    activeWindowName: null,
    lastActiveWorker: {},
    lastActiveProjectByPlot: {},
    ...overrides,
  };
}

// Real captures from a Claude worker pane (see the draft-detection design):
// the empty input box is the prompt marker followed only by padding; a draft
// puts the operator's text right after it. RULE mimics the box's ─ border.
const RULE = "─".repeat(80);
const EMPTY_BOX = [
  RULE,
  "❯ " + " ".repeat(60),
  RULE,
  "  garden·proud-brief-sedge | Opus 4.8 (1M context) | ctx:10%" + " ".repeat(20) + "/rc active",
  "  ⏵⏵ auto mode on (shift+tab to cycle)",
].join("\n");
const DRAFT_BOX = [
  RULE,
  "❯ the quick brown fox" + " ".repeat(40),
  RULE,
  "  garden·proud-brief-sedge | Opus 4.8 | ctx:10%" + " ".repeat(20) + "/rc active",
  "  ⏵⏵ auto mode on (shift+tab to cycle)",
].join("\n");
// An empty box with Claude Code's dimmed ghost/placeholder text rendered into
// it — capture-pane strips the dimming, so the suggestion text lands right after
// the marker looking exactly like a draft. The caret stays at the input origin
// (column 2, just past "❯ "), which is what tells the two apart. Row index 1.
const GHOST_BOX = [
  RULE,
  "❯ Try \"how does auth work?\"" + " ".repeat(20),
  RULE,
  "  garden·vain-tall-brush | Opus 4.8 | ctx:10%",
  "  ⏵⏵ auto mode on (shift+tab to cycle)",
].join("\n");
// A stuck garden paste: an earlier continueWorker pasted the prompt but its
// Enter taps were eaten, so the message sits unsent in the box. Claude Code
// collapses a multi-line paste to the [Pasted text …] placeholder; smaller
// pastes render verbatim, so the visible first row starts with the prompt's
// literal "[garden]" head. Both are garden-paste signatures.
const STUCK_PLACEHOLDER_BOX = [
  RULE,
  "❯ [Pasted text #1 +9 lines]" + " ".repeat(40),
  RULE,
  "  garden·bold-ash | Opus 4.8 | ctx:10%",
  "  ⏵⏵ auto mode on (shift+tab to cycle)",
].join("\n");
const STUCK_VERBATIM_BOX = [
  RULE,
  "❯ [garden] Your previous changes were reviewed and merged. Before you",
  RULE,
  "  garden·bold-ash | Opus 4.8 | ctx:10%",
  "  ⏵⏵ auto mode on (shift+tab to cycle)",
].join("\n");

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(paneExists).mockReturnValue(true);
  vi.mocked(windowExists).mockReturnValue(true);
  vi.mocked(getFirstPaneId).mockReturnValue("%30");
  vi.mocked(readDashState).mockReturnValue(makeState());
  // clearAllMocks resets call history but NOT return values, so re-arm the
  // empty-box default each test; draft cases override it locally.
  vi.mocked(capturePaneText).mockReturnValue("");
  vi.mocked(capturePaneCursor).mockReturnValue(null);
  vi.mocked(paneRunningOnlyShell).mockReturnValue(false);
});

describe("continueWorker", () => {
  it("is a no-op when the worker entry is missing", () => {
    vi.mocked(findWorkerByName).mockReturnValue(undefined);
    continueWorker("myproject", "ghost");
    expect(pasteAndSubmit).not.toHaveBeenCalled();
    expect(updateWorkerFields).not.toHaveBeenCalled();
  });

  it("skips the send when no pane can be located and does not clear the flag", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash", sessionId: "s", task: "",
      agentStatus: "idle", interruptedWhileWorking: true,
    });
    vi.mocked(windowExists).mockReturnValue(false);
    // activePaneId path also fails
    vi.mocked(readDashState).mockReturnValue(makeState({ activePaneId: null }));

    continueWorker("myproject", "bold-ash");

    expect(pasteAndSubmit).not.toHaveBeenCalled();
    // Flag must remain so a future resume can retry.
    expect(updateWorkerFields).not.toHaveBeenCalled();
  });

  it("skips the send when the worker is already working (operator typed first) and clears the flag", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash", sessionId: "s", task: "",
      agentStatus: "working", interruptedWhileWorking: true,
    });
    continueWorker("myproject", "bold-ash");

    expect(pasteAndSubmit).not.toHaveBeenCalled();
    expect(updateWorkerFields).toHaveBeenCalledWith(
      "myproject", "bold-ash", { interruptedWhileWorking: undefined },
    );
  });

  it("skips the send when the worker is asking and clears the flag", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash", sessionId: "s", task: "",
      agentStatus: "asking", interruptedWhileWorking: true,
    });
    continueWorker("myproject", "bold-ash");

    expect(pasteAndSubmit).not.toHaveBeenCalled();
    expect(updateWorkerFields).toHaveBeenCalledWith(
      "myproject", "bold-ash", { interruptedWhileWorking: undefined },
    );
  });

  it("skips the send when the worker is held (paused) and leaves the prompt owed", () => {
    // A worker the operator held (garden hold / ⌥e → paused) must not be
    // auto-resumed — most reachably a post-merge continue on a worker held
    // while in `merged`. The operator's own redirect is the resume, so the
    // owed-prompt flag stays set rather than being cleared.
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash", sessionId: "s", task: "",
      agentStatus: "paused", interruptedWhileWorking: true,
    });
    continueWorker("myproject", "bold-ash");

    expect(pasteAndSubmit).not.toHaveBeenCalled();
    expect(updateWorkerFields).not.toHaveBeenCalled();
  });

  it("skips the send when the pane is a bare shell (agent exited) and leaves the prompt owed", () => {
    // A clean Claude exit exec-replaces the pane with a shell without firing
    // pane-died, so agentStatus reads idle. Pasting the continue prompt would
    // run its backticked git commands in the shell — skip and leave the prompt
    // owed for a `garden bounce`.
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash", sessionId: "s", task: "",
      agentStatus: "idle", interruptedWhileWorking: true,
    });
    vi.mocked(readDashState).mockReturnValue(makeState({
      activeWindowName: "_myproject-worker-bold-ash",
      activePaneId: "%9",
    }));
    vi.mocked(paneRunningOnlyShell).mockReturnValue(true);

    continueWorker("myproject", "bold-ash");

    expect(pasteAndSubmit).not.toHaveBeenCalled();
    expect(updateWorkerFields).not.toHaveBeenCalled();
  });

  it("sends the literal continue prompt followed by Enter when worker is idle, then clears the flag", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash", sessionId: "s", task: "",
      agentStatus: "idle", interruptedWhileWorking: true,
    });
    // Prefer activePaneId path
    vi.mocked(readDashState).mockReturnValue(makeState({
      activeWindowName: "_myproject-worker-bold-ash",
      activePaneId: "%9",
    }));

    continueWorker("myproject", "bold-ash");

    expect(pasteAndSubmit).toHaveBeenCalledWith(
      "%9", expect.stringContaining("[garden]"),
    );
    // Delivery also stamps continueSentAt — the marker the stuck-paste
    // recovery keys on (cleared by the UserPromptSubmit hook when the
    // prompt actually lands).
    expect(updateWorkerFields).toHaveBeenCalledWith(
      "myproject", "bold-ash",
      { interruptedWhileWorking: undefined, continueSentAt: expect.any(Number) },
    );
  });

  it("names the worker's own branch in the interrupt-recovery default prompt", () => {
    // The interrupt prompt is branch-pinned too: a worker resumed after a
    // dashboard restart must not be tempted onto a sibling's branch either.
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "blithe-bold-wren", sessionId: "s", task: "", agentStatus: "idle",
      branchName: "blithe-bold-wren", baseBranch: "main",
    });
    vi.mocked(readDashState).mockReturnValue(makeState({
      activeWindowName: "_lex-worker-blithe-bold-wren",
      activePaneId: "%9",
    }));

    continueWorker("lex", "blithe-bold-wren");

    const message = vi.mocked(pasteAndSubmit).mock.calls[0][1];
    expect(message).toContain("branch `blithe-bold-wren`");
    expect(message).toContain("do NOT rebase");
    expect(message).toContain("interrupted by a restart");
  });

  it("falls back to the hidden window pane id when the worker is parked", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash", sessionId: "s", task: "", agentStatus: "idle",
    });
    // Active pane points elsewhere; window-resolution path fires.
    vi.mocked(readDashState).mockReturnValue(makeState({
      activeWindowName: "_myproject-worker-other",
      activePaneId: "%99",
    }));
    vi.mocked(getFirstPaneId).mockReturnValue("%41");

    continueWorker("myproject", "bold-ash");

    expect(pasteAndSubmit).toHaveBeenCalledWith("%41", expect.any(String));
  });

  it("does not clear the flag when the send-keys call throws", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash", sessionId: "s", task: "", agentStatus: "idle",
    });
    // mockImplementationOnce, not mockImplementation: clearAllMocks (in
    // beforeEach) clears call records but NOT implementations, so a persistent
    // throwing impl would leak into every later test in this file. One-shot
    // keeps the throw scoped to this single continueWorker call.
    vi.mocked(pasteAndSubmit).mockImplementationOnce(() => { throw new Error("tmux died"); });

    expect(() => continueWorker("myproject", "bold-ash")).not.toThrow();
    // Flag stays so a later attempt can retry.
    expect(updateWorkerFields).not.toHaveBeenCalled();
  });

  it("skips the send when the operator has an unsent draft, and leaves interruptedWhileWorking set", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash", sessionId: "s", task: "",
      agentStatus: "idle", interruptedWhileWorking: true,
    });
    vi.mocked(readDashState).mockReturnValue(makeState({
      activeWindowName: "_myproject-worker-bold-ash",
      activePaneId: "%9",
    }));
    vi.mocked(capturePaneText).mockReturnValue(DRAFT_BOX);

    const delivered = continueWorker("myproject", "bold-ash");

    expect(delivered).toBe(false);
    expect(pasteAndSubmit).not.toHaveBeenCalled();
    // Unlike the active-worker gate, the draft skip must NOT clear the flag —
    // the backoff re-arm still owes this worker a prompt once the box clears.
    expect(updateWorkerFields).not.toHaveBeenCalled();
  });

  it("delivers when the pane resolves but the box is empty (no false-positive)", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash", sessionId: "s", task: "", agentStatus: "idle",
    });
    vi.mocked(readDashState).mockReturnValue(makeState({
      activeWindowName: "_myproject-worker-bold-ash",
      activePaneId: "%9",
    }));
    vi.mocked(capturePaneText).mockReturnValue(EMPTY_BOX);

    const delivered = continueWorker("myproject", "bold-ash");

    expect(delivered).toBe(true);
    expect(pasteAndSubmit).toHaveBeenCalledWith("%9", expect.any(String));
  });

  // The stuck-paste recovery: a garden paste whose Enter taps were eaten sits
  // unsent in the box, and the draft guard used to misread it as an operator
  // draft — deferring every retry forever, since a stuck paste never clears
  // itself (the starvation that made bead workers miss their seeded bd close,
  // board acceptance run 2026-08-14). continueSentAt proves garden pasted and
  // no prompt landed since (the prompt hook clears it), and the draft's
  // garden-paste signature confirms the box holds our own text — so the fix
  // is to press Enter and submit it, not to re-paste or defer.
  it("re-submits garden's own stuck paste with Enter instead of deferring (collapsed rendering)", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash", sessionId: "s", task: "",
      agentStatus: "idle", interruptedWhileWorking: true,
      continueSentAt: 1_700_000_000_000,
    });
    vi.mocked(readDashState).mockReturnValue(makeState({
      activeWindowName: "_myproject-worker-bold-ash",
      activePaneId: "%9",
    }));
    vi.mocked(capturePaneText).mockReturnValue(STUCK_PLACEHOLDER_BOX);

    const delivered = continueWorker("myproject", "bold-ash");

    expect(delivered).toBe(true);
    expect(pressEnter).toHaveBeenCalledWith("%9");
    // The message is already in the box — re-pasting would double it.
    expect(pasteAndSubmit).not.toHaveBeenCalled();
    // The original paste already recorded its dispatch; the Enter is a
    // re-submit of that same delivery, not a second one.
    expect(recordContinueDispatched).not.toHaveBeenCalled();
    expect(updateWorkerFields).toHaveBeenCalledWith(
      "myproject", "bold-ash", { interruptedWhileWorking: undefined },
    );
  });

  it("re-submits garden's own stuck paste when the prompt head renders verbatim", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash", sessionId: "s", task: "",
      agentStatus: "idle", continueSentAt: 1_700_000_000_000,
    });
    vi.mocked(readDashState).mockReturnValue(makeState({
      activeWindowName: "_myproject-worker-bold-ash",
      activePaneId: "%9",
    }));
    vi.mocked(capturePaneText).mockReturnValue(STUCK_VERBATIM_BOX);

    expect(continueWorker("myproject", "bold-ash")).toBe(true);
    expect(pressEnter).toHaveBeenCalledWith("%9");
    expect(pasteAndSubmit).not.toHaveBeenCalled();
  });

  it("still defers a signature-bearing draft when garden never pasted (operator's own paste)", () => {
    // Without continueSentAt there is no evidence the box holds garden's text
    // — an operator can paste multi-line content too, and submitting their
    // half-composed message would be exactly the mangling the guard exists
    // to prevent.
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash", sessionId: "s", task: "", agentStatus: "idle",
    });
    vi.mocked(readDashState).mockReturnValue(makeState({
      activeWindowName: "_myproject-worker-bold-ash",
      activePaneId: "%9",
    }));
    vi.mocked(capturePaneText).mockReturnValue(STUCK_PLACEHOLDER_BOX);

    expect(continueWorker("myproject", "bold-ash")).toBe(false);
    expect(pressEnter).not.toHaveBeenCalled();
    expect(pasteAndSubmit).not.toHaveBeenCalled();
  });

  it("still defers a plain operator draft even when a garden paste is outstanding", () => {
    // continueSentAt set but the draft carries no garden signature: the
    // operator cleared our stuck paste and is composing their own message.
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash", sessionId: "s", task: "",
      agentStatus: "idle", continueSentAt: 1_700_000_000_000,
    });
    vi.mocked(readDashState).mockReturnValue(makeState({
      activeWindowName: "_myproject-worker-bold-ash",
      activePaneId: "%9",
    }));
    vi.mocked(capturePaneText).mockReturnValue(DRAFT_BOX);

    expect(continueWorker("myproject", "bold-ash")).toBe(false);
    expect(pressEnter).not.toHaveBeenCalled();
    expect(pasteAndSubmit).not.toHaveBeenCalled();
  });

  it("delivers when the empty box shows dimmed ghost/placeholder text and the caret is at the origin", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "vain-tall-brush", sessionId: "s", task: "", agentStatus: "idle",
    });
    vi.mocked(readDashState).mockReturnValue(makeState({
      activeWindowName: "_myproject-worker-vain-tall-brush",
      activePaneId: "%9",
    }));
    // Ghost text after the marker would read as a draft on its own; the caret at
    // the input origin (row 1, column 2) is what proves the box is really empty.
    vi.mocked(capturePaneText).mockReturnValue(GHOST_BOX);
    vi.mocked(capturePaneCursor).mockReturnValue({ x: 2, y: 1 });

    const delivered = continueWorker("myproject", "vain-tall-brush");

    expect(delivered).toBe(true);
    expect(pasteAndSubmit).toHaveBeenCalledWith("%9", expect.any(String));
  });
});

// The autonomy metric (DESIGN.md: "operator work = all prompts − garden's")
// depends on continue.dispatched firing ONLY on a real garden-initiated
// delivery and never on continueWorker's skip paths. The record call sits at
// the single success exit after pasteAndSubmit; these lock that placement so a
// future refactor that hoists it above a guard — or a new skip path that fails
// to return early — can't silently over-count. Mirrors the caller-side spy the
// prior review commit added for recordCiFixOutcome in test/poller.test.ts.
describe("continueWorker telemetry (continue.dispatched counting)", () => {
  it("records continue.dispatched once on a real delivery, defaulting to the interrupt kind", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash", sessionId: "s", task: "", agentStatus: "idle",
    });
    vi.mocked(readDashState).mockReturnValue(makeState({
      activeWindowName: "_myproject-worker-bold-ash",
      activePaneId: "%9",
    }));

    expect(continueWorker("myproject", "bold-ash")).toBe(true);

    expect(recordContinueDispatched).toHaveBeenCalledTimes(1);
    expect(recordContinueDispatched).toHaveBeenCalledWith(
      "myproject", "bold-ash", undefined, "default", "interrupt",
    );
  });

  it("threads the post-merge kind through continueWorkerAfterMerge", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash", sessionId: "s", task: "", agentStatus: "idle",
      branchName: "bold-ash", baseBranch: "main",
    });
    vi.mocked(readDashState).mockReturnValue(makeState({
      activeWindowName: "_myproject-worker-bold-ash",
      activePaneId: "%9",
    }));

    continueWorkerAfterMerge("myproject", "bold-ash");

    expect(recordContinueDispatched).toHaveBeenCalledTimes(1);
    expect(recordContinueDispatched).toHaveBeenCalledWith(
      "myproject", "bold-ash", undefined, "default", "post-merge",
    );
  });

  it("does NOT record when the send is skipped because the worker is mid-turn", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash", sessionId: "s", task: "", agentStatus: "working",
    });

    expect(continueWorker("myproject", "bold-ash")).toBe(false);
    expect(recordContinueDispatched).not.toHaveBeenCalled();
  });

  it("does NOT record when the send is skipped because the operator has an unsent draft", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash", sessionId: "s", task: "", agentStatus: "idle",
    });
    vi.mocked(readDashState).mockReturnValue(makeState({
      activeWindowName: "_myproject-worker-bold-ash",
      activePaneId: "%9",
    }));
    vi.mocked(capturePaneText).mockReturnValue(DRAFT_BOX);

    expect(continueWorker("myproject", "bold-ash")).toBe(false);
    expect(recordContinueDispatched).not.toHaveBeenCalled();
  });

  it("does NOT record when the pane is a bare shell (agent exited)", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash", sessionId: "s", task: "", agentStatus: "idle",
    });
    vi.mocked(readDashState).mockReturnValue(makeState({
      activeWindowName: "_myproject-worker-bold-ash",
      activePaneId: "%9",
    }));
    vi.mocked(paneRunningOnlyShell).mockReturnValue(true);

    expect(continueWorker("myproject", "bold-ash")).toBe(false);
    expect(recordContinueDispatched).not.toHaveBeenCalled();
  });
});

describe("extractOperatorDraft (cursor unknown → whole-remainder fallback)", () => {
  it("returns empty for an empty Claude input box (marker + padding only)", () => {
    expect(extractOperatorDraft(EMPTY_BOX, null)).toBe("");
  });

  it("extracts the unsent draft text after the prompt marker", () => {
    expect(extractOperatorDraft(DRAFT_BOX, null)).toBe("the quick brown fox");
  });

  it("tolerates a marker indented by leading whitespace", () => {
    expect(extractOperatorDraft("────\n   ❯ hello there   \n────\n  status", null)).toBe("hello there");
  });

  it("takes the bottom-most prompt line so a stale ❯ above the box is ignored", () => {
    const captured = [
      "❯ stale echoed prompt from earlier",
      "─".repeat(40),
      "❯ " + " ".repeat(30), // the live, empty box
      "─".repeat(40),
      "  garden·proj | Opus 4.8 | ctx:5%",
    ].join("\n");
    expect(extractOperatorDraft(captured, null)).toBe("");
  });

  it("keeps a draft that itself contains the marker glyph", () => {
    expect(extractOperatorDraft("❯ use the ❯ symbol", null)).toBe("use the ❯ symbol");
  });

  it("treats a whitespace-only draft as empty (safe to deliver)", () => {
    expect(extractOperatorDraft("❯        ", null)).toBe("");
  });

  it("returns empty when no prompt line is visible (capture failed / odd state)", () => {
    expect(extractOperatorDraft("", null)).toBe("");
    expect(extractOperatorDraft("just some text\nno box here", null)).toBe("");
  });
});

describe("extractOperatorDraft (cursor-bounded — excludes ghost/placeholder text)", () => {
  // The regression: dimmed ghost/placeholder text in an EMPTY box looks like a
  // draft once capture-pane strips the color, but the caret is still at the
  // input origin (column 2, on the marker row). Span marker→cursor is empty.
  it("ignores ghost/placeholder text when the caret is at the input origin", () => {
    expect(extractOperatorDraft(GHOST_BOX, { x: 2, y: 1 })).toBe("");
  });

  it("extracts only the text left of the caret, dropping a trailing ghost completion", () => {
    // "❯ fix " typed (caret at column 6), "the auth bug" is the dimmed ghost.
    expect(extractOperatorDraft("❯ fix the auth bug", { x: 6, y: 0 })).toBe("fix");
  });

  it("extracts a full real draft bounded by the caret at its end", () => {
    // "❯ the quick brown fox" — caret sits just past the 'x' at column 21.
    expect(extractOperatorDraft(DRAFT_BOX, { x: 21, y: 1 })).toBe("the quick brown fox");
  });

  it("treats a caret on a row below the marker as a wrapped (non-empty) draft", () => {
    expect(extractOperatorDraft(DRAFT_BOX, { x: 4, y: 2 })).toBe("the quick brown fox");
  });

  it("returns empty when the caret is above the marker row (not on the input line)", () => {
    expect(extractOperatorDraft(DRAFT_BOX, { x: 10, y: 0 })).toBe("");
  });
});

describe("rearmContinueIfDrafting", () => {
  beforeEach(() => {
    // Pane resolves via the hidden-window fallback to %30 (getFirstPaneId).
    vi.mocked(readDashState).mockReturnValue(makeState());
    vi.mocked(windowExists).mockReturnValue(true);
    vi.mocked(getFirstPaneId).mockReturnValue("%30");
    // Guard against a throwing spawn impl leaking from a later describe.
    vi.mocked(spawn).mockImplementation(() => ({ unref: vi.fn() }) as never);
  });

  it("re-arms the same subcommand with attempt+1 while the operator is still drafting", () => {
    vi.mocked(capturePaneText).mockReturnValue(DRAFT_BOX);

    rearmContinueIfDrafting("_continue-worker", "myproject", "bold-ash", 0);

    expect(spawn).toHaveBeenCalledTimes(1);
    const cmd = (vi.mocked(spawn).mock.calls[0][1] as string[])[1];
    expect(cmd).toContain("dashboard _continue-worker --delay-ms 12000");
    expect(cmd).toContain(" myproject ");
    expect(cmd).toContain(" bold-ash ");
    expect(cmd).toContain("--attempt 1");
  });

  it("does not re-arm when the box is empty (the skip was not draft-related)", () => {
    vi.mocked(capturePaneText).mockReturnValue(EMPTY_BOX);
    rearmContinueIfDrafting("_continue-worker-after-merge", "myproject", "bold-ash", 0);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("stops re-arming once the attempt cap is reached, even with a draft present", () => {
    vi.mocked(capturePaneText).mockReturnValue(DRAFT_BOX);
    rearmContinueIfDrafting("_continue-worker", "myproject", "bold-ash", 15);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("threads the merge subcommand through so the re-fire rebuilds the enriched prompt", () => {
    vi.mocked(capturePaneText).mockReturnValue(DRAFT_BOX);
    rearmContinueIfDrafting("_continue-worker-after-merge", "myproject", "bold-ash", 3);
    const cmd = (vi.mocked(spawn).mock.calls[0][1] as string[])[1];
    expect(cmd).toContain("dashboard _continue-worker-after-merge --delay-ms 12000");
    expect(cmd).toContain("--attempt 4");
  });
});

describe("continueWorkerIfStuck", () => {
  beforeEach(() => {
    vi.mocked(readDashState).mockReturnValue({
      activeProject: "myproject",
      activePaneType: "worker",
      activePaneId: "%20",
      activeWindowName: "_myproject-worker-bold-ash",
      projects: { myproject: { workerWindows: ["_myproject-worker-bold-ash"] } },
    } as unknown as DashboardState);
  });

  it("re-pastes when the worker is still parked at ready (cold-start retry path)", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash", sessionId: "s", task: "", agentStatus: "ready",
    });

    continueWorkerIfStuck("myproject", "bold-ash");

    expect(pasteAndSubmit).toHaveBeenCalledTimes(1);
  });

  it("skips when the worker has moved to working (first paste landed, response in flight)", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash", sessionId: "s", task: "", agentStatus: "working",
    });

    continueWorkerIfStuck("myproject", "bold-ash");

    expect(pasteAndSubmit).not.toHaveBeenCalled();
  });

  it("skips when the worker has moved to idle (first paste landed, response already finished inside the retry window)", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash", sessionId: "s", task: "", agentStatus: "idle",
    });

    continueWorkerIfStuck("myproject", "bold-ash");

    expect(pasteAndSubmit).not.toHaveBeenCalled();
  });

  it("no-ops when the registry entry is gone", () => {
    vi.mocked(findWorkerByName).mockReturnValue(undefined);

    expect(() => continueWorkerIfStuck("myproject", "bold-ash")).not.toThrow();
    expect(pasteAndSubmit).not.toHaveBeenCalled();
  });
});

describe("dispatchDelayedContinue", () => {
  it("spawns two detached children: _continue-worker at +6s and _continue-worker-if-stuck at +16s", () => {
    dispatchDelayedContinue("/usr/local/bin/garden", "myproject", "bold-ash");

    // Primary + retry legs are now independent detached children, each with
    // its own --delay-ms held by the spawned Node process. The `sh -c`
    // trampoline stays (gardenRunner is a multi-token shell command), but
    // there is no `sleep N &&` prefix — the shell exec's straight into garden.
    // Retry's stuck-only re-paste behavior lives in continueWorkerIfStuck.
    expect(spawn).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(spawn).mock.calls;

    const [primaryShell, primaryArgs, primaryOpts] = calls[0];
    expect(primaryShell).toBe("sh");
    expect(primaryArgs).toEqual(["-c", expect.any(String)]);
    const primaryCmd = (primaryArgs as string[])[1];
    expect(primaryCmd).not.toMatch(/\bsleep\b/);
    expect(primaryCmd).toContain("/usr/local/bin/garden dashboard _continue-worker --delay-ms 6000");
    expect(primaryCmd).toContain(" myproject ");
    expect(primaryCmd).toContain(" bold-ash ");
    expect(primaryOpts).toEqual(expect.objectContaining({ detached: true, stdio: "ignore" }));

    const retryCmd = (calls[1][1] as string[])[1];
    expect(retryCmd).not.toMatch(/\bsleep\b/);
    expect(retryCmd).toContain("/usr/local/bin/garden dashboard _continue-worker-if-stuck --delay-ms 16000");
    expect(retryCmd).toContain(" myproject ");
    expect(retryCmd).toContain(" bold-ash ");
  });

  it("swallows spawn errors so a failed dispatch never crashes the caller", () => {
    vi.mocked(spawn).mockImplementation(() => { throw new Error("EAGAIN"); });
    expect(() => dispatchDelayedContinue("garden", "p", "w")).not.toThrow();
  });
});

describe("dispatchDelayedAutoContinue", () => {
  it("spawns two detached children: _continue-worker-after-merge at +5s and _continue-worker-after-merge-if-stuck at +16s", () => {
    dispatchDelayedAutoContinue("/usr/local/bin/garden", "myproject", "bold-ash");

    // Primary 5s + retry 16s, mirroring dispatchDelayedContinue. The retry
    // recovers a worker that read as working/asking at the 5s mark (the
    // single-shot prompt would otherwise be lost); continueWorkerAfterMergeIfStuck
    // gates re-fire on prState still === "merged".
    expect(spawn).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(spawn).mock.calls;

    const primaryCmd = (calls[0][1] as string[])[1];
    expect(primaryCmd).not.toMatch(/\bsleep\b/);
    expect(primaryCmd).toContain("/usr/local/bin/garden dashboard _continue-worker-after-merge --delay-ms 5000");
    expect(primaryCmd).toContain(" myproject ");
    expect(primaryCmd).toContain(" bold-ash ");

    const retryCmd = (calls[1][1] as string[])[1];
    expect(retryCmd).not.toMatch(/\bsleep\b/);
    expect(retryCmd).toContain("/usr/local/bin/garden dashboard _continue-worker-after-merge-if-stuck --delay-ms 16000");
    expect(retryCmd).toContain(" myproject ");
    expect(retryCmd).toContain(" bold-ash ");
  });

  it("swallows spawn errors", () => {
    vi.mocked(spawn).mockImplementation(() => { throw new Error("EAGAIN"); });
    expect(() => dispatchDelayedAutoContinue("garden", "p", "w")).not.toThrow();
  });
});

describe("continueWorkerAfterMergeIfStuck", () => {
  it("re-fires the merge prompt when prState is still `merged` (prompt never landed)", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash", sessionId: "s", task: "", agentStatus: "idle",
      prState: "merged",
    });
    vi.mocked(readDashState).mockReturnValue(makeState({
      activeWindowName: "_myproject-worker-bold-ash",
      activePaneId: "%9",
    }));

    continueWorkerAfterMergeIfStuck("myproject", "bold-ash");

    expect(pasteAndSubmit).toHaveBeenCalledTimes(1);
    const message = vi.mocked(pasteAndSubmit).mock.calls[0][1];
    expect(message).toContain("[garden]");
    expect(message).toContain("merged");
  });

  it("no-ops when prState has moved off `merged` (delivered prompt cleared it via UserPromptSubmit)", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash", sessionId: "s", task: "", agentStatus: "idle",
      prState: "working",
    });

    continueWorkerAfterMergeIfStuck("myproject", "bold-ash");

    expect(pasteAndSubmit).not.toHaveBeenCalled();
  });

  it("no-ops when prState is `done` (worker self-declared; never re-prompt)", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash", sessionId: "s", task: "", agentStatus: "idle",
      prState: "done",
    });

    continueWorkerAfterMergeIfStuck("myproject", "bold-ash");

    expect(pasteAndSubmit).not.toHaveBeenCalled();
  });

  it("does not double-prompt: when prState is `merged` but the worker is working again, the inner agentStatus gate skips the paste", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash", sessionId: "s", task: "", agentStatus: "working",
      prState: "merged",
    });

    continueWorkerAfterMergeIfStuck("myproject", "bold-ash");

    expect(pasteAndSubmit).not.toHaveBeenCalled();
  });

  it("no-ops when the registry entry is gone", () => {
    vi.mocked(findWorkerByName).mockReturnValue(undefined);

    expect(() => continueWorkerAfterMergeIfStuck("myproject", "bold-ash")).not.toThrow();
    expect(pasteAndSubmit).not.toHaveBeenCalled();
  });
});

describe("continueWorkerAfterMerge", () => {
  it("sends the merge-flavored prompt referencing the .garden-done sentinel", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash", sessionId: "s", task: "", agentStatus: "idle",
    });
    vi.mocked(readDashState).mockReturnValue(makeState({
      activeWindowName: "_myproject-worker-bold-ash",
      activePaneId: "%9",
    }));

    continueWorkerAfterMerge("myproject", "bold-ash");

    expect(pasteAndSubmit).toHaveBeenCalledTimes(1);
    const message = vi.mocked(pasteAndSubmit).mock.calls[0][1];
    expect(message).toContain("[garden]");
    expect(message).toContain("merged");
    expect(message).toContain(".garden-done");
  });

  it("skips when the worker is already working", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash", sessionId: "s", task: "", agentStatus: "working",
    });
    continueWorkerAfterMerge("myproject", "bold-ash");
    expect(pasteAndSubmit).not.toHaveBeenCalled();
  });

  it("names the worker's own branch and forbids rebasing onto a sibling's branch", () => {
    // Regression: the post-merge prompt was branch-agnostic, so a worker on a
    // multi-worker project (two workers on `lex`) rebased onto the OTHER
    // worker's branch — sibling branches are visible via `git branch -a` across
    // worktrees of the shared repo. The prompt must pin the worker to its own
    // branch and point any base sync at origin/<base>, never a sibling.
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "blithe-bold-wren", sessionId: "s", task: "", agentStatus: "idle",
      branchName: "blithe-bold-wren", baseBranch: "main",
    });
    vi.mocked(readDashState).mockReturnValue(makeState({
      activeWindowName: "_lex-worker-blithe-bold-wren",
      activePaneId: "%9",
    }));

    continueWorkerAfterMerge("lex", "blithe-bold-wren");

    const message = vi.mocked(pasteAndSubmit).mock.calls[0][1];
    expect(message).toContain("branch `blithe-bold-wren`");
    expect(message).toContain("do NOT rebase");
    expect(message).toContain("origin/main");
  });

  it("falls back to the worker name for the branch when branchName is unset", () => {
    // Old on-disk entries predate branchName; the branch is always named after
    // the worker, so the worker name is the correct fallback.
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash", sessionId: "s", task: "", agentStatus: "idle",
    });
    vi.mocked(readDashState).mockReturnValue(makeState({
      activeWindowName: "_myproject-worker-bold-ash",
      activePaneId: "%9",
    }));

    continueWorkerAfterMerge("myproject", "bold-ash");

    const message = vi.mocked(pasteAndSubmit).mock.calls[0][1];
    expect(message).toContain("branch `bold-ash`");
  });

  it("preserves the stale-files context when delivery is skipped, so the +16s retry can re-emit it", () => {
    // The central mechanism of the post-merge retry leg: when the first
    // attempt is skipped because the worker is mid-turn (delivered=false),
    // the transient pendingContinue* fields must NOT be cleared — otherwise
    // continueWorkerAfterMergeIfStuck would re-fire a bare prompt that drops
    // the reviewer's changed-files list. continueWorker still clears
    // interruptedWhileWorking on the working-gate (one updateWorkerFields
    // call); the pendingContinue*-clearing call must NOT happen. Asserting on
    // call count rather than args: vitest deep-equality treats every
    // all-undefined object as equal, so not.toHaveBeenCalledWith can't
    // distinguish the interrupted-clear from the pending-clear.
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash", sessionId: "s", task: "", agentStatus: "working",
      branchName: "bold-ash",
      pendingContinueChangedFiles: ["src/foo.ts"],
    });
    continueWorkerAfterMerge("myproject", "bold-ash");
    expect(pasteAndSubmit).not.toHaveBeenCalled();
    expect(updateWorkerFields).toHaveBeenCalledTimes(1);
  });

  it("prepends a stale-files preamble when the reviewer modified files", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash", sessionId: "s", task: "", agentStatus: "idle",
      branchName: "bold-ash",
      pendingContinueChangedFiles: ["src/foo.ts", "src/bar.ts"],
    });
    vi.mocked(readDashState).mockReturnValue(makeState({
      activeWindowName: "_myproject-worker-bold-ash",
      activePaneId: "%9",
    }));

    continueWorkerAfterMerge("myproject", "bold-ash");

    const message = vi.mocked(pasteAndSubmit).mock.calls[0][1];
    expect(message).toContain("During review");
    expect(message).toContain("src/foo.ts");
    expect(message).toContain("src/bar.ts");
    expect(message).toContain("re-read");
    expect(message).toContain("merged");
    expect(updateWorkerFields).toHaveBeenCalledWith("myproject", "bold-ash", {
      pendingContinueChangedFiles: undefined,
      pendingContinueSyncFailed: undefined,
    });
  });

  it("truncates the file list past 20 entries", () => {
    const files = Array.from({ length: 25 }, (_, i) => `src/file${i}.ts`);
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash", sessionId: "s", task: "", agentStatus: "idle",
      branchName: "bold-ash",
      pendingContinueChangedFiles: files,
    });
    vi.mocked(readDashState).mockReturnValue(makeState({
      activeWindowName: "_myproject-worker-bold-ash",
      activePaneId: "%9",
    }));

    continueWorkerAfterMerge("myproject", "bold-ash");

    const message = vi.mocked(pasteAndSubmit).mock.calls[0][1];
    expect(message).toContain("src/file0.ts");
    expect(message).toContain("src/file19.ts");
    expect(message).not.toContain("src/file20.ts");
    expect(message).toContain("(and 5 more)");
  });

  it("appends a manual-sync nudge targeting the base branch when the post-merge sync failed", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash", sessionId: "s", task: "", agentStatus: "idle",
      branchName: "bold-ash",
      baseBranch: "main",
      pendingContinueSyncFailed: true,
    });
    vi.mocked(readDashState).mockReturnValue(makeState({
      activeWindowName: "_myproject-worker-bold-ash",
      activePaneId: "%9",
    }));

    continueWorkerAfterMerge("myproject", "bold-ash");

    const message = vi.mocked(pasteAndSubmit).mock.calls[0][1];
    expect(message).toContain("could not auto-sync");
    // The worker branch is deleted from origin post-merge, so the hint must
    // target origin/<base>, not origin/<branch>.
    expect(message).toContain("git fetch origin main && git reset --hard origin/main");
    expect(message).not.toContain("origin/bold-ash");
  });

  it("includes postMerge context when the project has a postMerge hook configured", () => {
    vi.mocked(tryGetProject).mockReturnValueOnce({
      name: "myproject", path: "/tmp/myproject", postMerge: "npm install && npm run build",
    });
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash", sessionId: "s", task: "", agentStatus: "idle",
    });
    vi.mocked(readDashState).mockReturnValue(makeState({
      activeWindowName: "_myproject-worker-bold-ash",
      activePaneId: "%9",
    }));

    continueWorkerAfterMerge("myproject", "bold-ash");

    const message = vi.mocked(pasteAndSubmit).mock.calls[0][1];
    expect(message).toContain("postMerge hook already ran");
    expect(message).toContain("npm install && npm run build");
    expect(message).toContain("Do not tell the operator to pull");
  });

  it("uses the bare base prompt when no transient fields are set", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash", sessionId: "s", task: "", agentStatus: "idle",
    });
    vi.mocked(readDashState).mockReturnValue(makeState({
      activeWindowName: "_myproject-worker-bold-ash",
      activePaneId: "%9",
    }));

    continueWorkerAfterMerge("myproject", "bold-ash");

    const message = vi.mocked(pasteAndSubmit).mock.calls[0][1];
    expect(message).not.toContain("During review");
    expect(message).not.toContain("could not auto-sync");
    expect(message).not.toContain("postMerge");
    expect(message).toContain("merged");
    expect(message).toContain(".garden-done");
    // The re-gated done contract: enumerate the operator's deliverables,
    // distinguish them from internal workflow stages, and verify before done.
    expect(message).toContain("deliverable");
    expect(message).toContain("NOT operator deliverables");
    expect(message).toContain("verified it works");
    // continueWorker makes exactly one updateWorkerFields call on a successful
    // send (clearing interruptedWhileWorking). The bare-base path must NOT make
    // the second, pendingContinue*-clearing call — there was nothing to clear.
    // (Asserting on call count rather than args: vitest deep-equality treats
    // every all-undefined object as equal, so not.toHaveBeenCalledWith can't
    // distinguish the interrupted-clear from the pending-clear.)
    expect(updateWorkerFields).toHaveBeenCalledTimes(1);
  });
});

describe("done-sentinel helpers", () => {
  const wt = "/Users/x/.garden/worktrees/myproject/bold-ash";

  it("donePath joins the worktree root with .garden-done", () => {
    expect(donePath(wt)).toBe(`${wt}/.garden-done`);
  });

  it("isDoneSet reflects fs.existsSync at the donePath", () => {
    vi.mocked(fs.existsSync).mockReturnValueOnce(true);
    expect(isDoneSet(wt)).toBe(true);
    vi.mocked(fs.existsSync).mockReturnValueOnce(false);
    expect(isDoneSet(wt)).toBe(false);
  });

  it("isDoneSet returns false for legacy entries with no worktreePath", () => {
    expect(isDoneSet(undefined)).toBe(false);
    expect(fs.existsSync).not.toHaveBeenCalled();
  });

  it("clearDoneSentinel unlinks the donePath and tolerates ENOENT", () => {
    clearDoneSentinel(wt);
    expect(fs.unlinkSync).toHaveBeenCalledWith(`${wt}/.garden-done`);

    vi.mocked(fs.unlinkSync).mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });
    expect(() => clearDoneSentinel(wt)).not.toThrow();
  });

  it("clearDoneSentinel is a no-op for legacy entries with no worktreePath", () => {
    clearDoneSentinel(undefined);
    expect(fs.unlinkSync).not.toHaveBeenCalled();
  });
});

describe("dispatchDelayedSeed", () => {
  it("spawns one detached child invoking _seed-worker with --delay-ms 6000 and the message-file path", () => {
    dispatchDelayedSeed("/usr/local/bin/garden", "myproject", "bold-ash", "/tmp/seed.txt");

    expect(spawn).toHaveBeenCalledTimes(1);
    const [, args] = vi.mocked(spawn).mock.calls[0];
    const cmd = (args as string[])[1];
    // 6s delay covers bootstrap (git fetch + worktree add + claude TUI init)
    // — longer than a normal end-of-turn so keys don't land in a still-
    // initializing TUI. The Node child holds the timer via --delay-ms.
    expect(cmd).not.toMatch(/\bsleep\b/);
    expect(cmd).toContain("/usr/local/bin/garden dashboard _seed-worker --delay-ms 6000");
    expect(cmd).toContain(" myproject ");
    expect(cmd).toContain(" bold-ash ");
    expect(cmd).toContain(" /tmp/seed.txt ");
  });

  it("swallows spawn errors so a failed dispatch never crashes the caller", () => {
    vi.mocked(spawn).mockImplementation(() => { throw new Error("EAGAIN"); });
    expect(() => dispatchDelayedSeed("garden", "p", "w", "/tmp/x.txt")).not.toThrow();
  });
});

describe("seedWorker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(fs.readFileSync).mockReturnValue("[handoff from src/worker]\n\nbriefing body");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads the briefing, sends it once the worker leaves loading, and unlinks the file", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash", sessionId: "s", task: "", agentStatus: "ready",
    });
    vi.mocked(readDashState).mockReturnValue(makeState({
      activeWindowName: "_myproject-worker-bold-ash",
      activePaneId: "%9",
    }));

    seedWorker("myproject", "bold-ash", "/tmp/seed.txt");

    expect(fs.readFileSync).toHaveBeenCalledWith("/tmp/seed.txt", "utf8");
    expect(pasteAndSubmit).toHaveBeenCalledTimes(1);
    const message = vi.mocked(pasteAndSubmit).mock.calls[0][1];
    expect(message).toContain("[handoff from src/worker]");
    expect(message).toContain("briefing body");
    expect(fs.unlinkSync).toHaveBeenCalledWith("/tmp/seed.txt");
  });

  it("polls while the worker is still loading and sends as soon as it transitions", () => {
    let status: "loading" | "ready" = "loading";
    vi.mocked(findWorkerByName).mockImplementation(() => ({
      name: "bold-ash", sessionId: "s", task: "", agentStatus: status,
    }));
    vi.mocked(readDashState).mockReturnValue(makeState({
      activeWindowName: "_myproject-worker-bold-ash",
      activePaneId: "%9",
    }));

    seedWorker("myproject", "bold-ash", "/tmp/seed.txt");
    // First poll sees "loading" — no send yet.
    expect(vi.mocked(pasteAndSubmit)).not.toHaveBeenCalled();

    // Worker finishes bootstrap; next 2s tick sends the briefing.
    status = "ready";
    vi.advanceTimersByTime(2000);
    expect(vi.mocked(pasteAndSubmit)).toHaveBeenCalled();
    expect(fs.unlinkSync).toHaveBeenCalledWith("/tmp/seed.txt");
  });

  it("times out after 90s if the worker never leaves loading, sends anyway, and unlinks", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash", sessionId: "s", task: "", agentStatus: "loading",
    });
    vi.mocked(readDashState).mockReturnValue(makeState({
      activeWindowName: "_myproject-worker-bold-ash",
      activePaneId: "%9",
    }));

    seedWorker("myproject", "bold-ash", "/tmp/seed.txt");
    expect(vi.mocked(pasteAndSubmit)).not.toHaveBeenCalled();

    vi.advanceTimersByTime(90_000);
    // After deadline elapses, the next poll sends regardless of status so the
    // briefing isn't silently lost on a stuck worker.
    expect(vi.mocked(pasteAndSubmit)).toHaveBeenCalled();
    expect(fs.unlinkSync).toHaveBeenCalledWith("/tmp/seed.txt");
  });

  it("aborts and unlinks the file when the worker has already been killed", () => {
    vi.mocked(findWorkerByName).mockReturnValue(undefined);

    seedWorker("myproject", "bold-ash", "/tmp/seed.txt");

    expect(vi.mocked(pasteAndSubmit)).not.toHaveBeenCalled();
    expect(fs.unlinkSync).toHaveBeenCalledWith("/tmp/seed.txt");
  });

  it("aborts silently when the seed file can't be read (already cleaned up)", () => {
    vi.mocked(fs.readFileSync).mockImplementationOnce(() => { throw new Error("ENOENT"); });

    seedWorker("myproject", "bold-ash", "/tmp/seed.txt");

    expect(vi.mocked(findWorkerByName)).not.toHaveBeenCalled();
    expect(vi.mocked(pasteAndSubmit)).not.toHaveBeenCalled();
    // No re-unlink — there's nothing to clean up if the file was already gone.
    expect(fs.unlinkSync).not.toHaveBeenCalled();
  });
});

describe("notifyHandoffCallback", () => {
  beforeEach(() => {
    // Default: parent is idle in a known window, pane resolves cleanly.
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "calm-bay", sessionId: "s", task: "",
      agentStatus: "idle",
    });
    vi.mocked(readDashState).mockReturnValue(makeState({
      activeWindowName: "_fox-worker-calm-bay",
      activePaneId: "%5",
      activeProject: "fox",
    }));
    vi.mocked(paneExists).mockReturnValue(true);
    vi.mocked(windowExists).mockReturnValue(true);
  });

  it("pastes a callback prompt naming the child + state into the parent pane", () => {
    notifyHandoffCallback({
      childProject: "wolf",
      childWorker: "bold-ash",
      childBranch: "bold-ash",
      terminalState: "merged",
      parentProject: "fox",
      parentWorker: "calm-bay",
      replyNote: undefined,
    });

    expect(pasteAndSubmit).toHaveBeenCalledTimes(1);
    const [, message] = vi.mocked(pasteAndSubmit).mock.calls[0];
    expect(message).toContain("Handoff callback");
    expect(message).toContain("wolf/bold-ash");
    expect(message).toContain("merged");
    expect(message).toContain("branch: bold-ash");
  });

  it("inlines the reply note when present", () => {
    notifyHandoffCallback({
      childProject: "wolf",
      childWorker: "bold-ash",
      childBranch: "bold-ash",
      terminalState: "done",
      parentProject: "fox",
      parentWorker: "calm-bay",
      replyNote: "Investigated the bug — root cause is in src/foo.ts:42.",
    });

    const [, message] = vi.mocked(pasteAndSubmit).mock.calls[0];
    expect(message).toContain("Reply from bold-ash:");
    expect(message).toContain("root cause is in src/foo.ts:42");
  });

  it("labels failing terminal state distinctly so the parent knows it needs attention", () => {
    notifyHandoffCallback({
      childProject: "wolf",
      childWorker: "bold-ash",
      childBranch: undefined,
      terminalState: "failing",
      parentProject: "fox",
      parentWorker: "calm-bay",
      replyNote: undefined,
    });

    const [, message] = vi.mocked(pasteAndSubmit).mock.calls[0];
    expect(message).toContain("failing");
    expect(message).toContain("operator attention");
  });

  it("silently no-ops when the parent is currently working (continueWorker gate)", () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "calm-bay", sessionId: "s", task: "",
      agentStatus: "working",
    });

    notifyHandoffCallback({
      childProject: "wolf",
      childWorker: "bold-ash",
      childBranch: "bold-ash",
      terminalState: "merged",
      parentProject: "fox",
      parentWorker: "calm-bay",
      replyNote: undefined,
    });

    expect(pasteAndSubmit).not.toHaveBeenCalled();
  });
});

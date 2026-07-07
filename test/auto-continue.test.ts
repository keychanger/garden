// Tests for the auto-continue config + gate behavior.
//
// Config helpers run against a real on-disk ~/.garden/config.yml in a tmp HOME.
// The gate (checkUsageThreshold / autoContinueGateReason) is tested by stubbing
// readUsageSnapshot to control the meter inputs and a mocked alert sink.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

let tmpHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "garden-auto-test-"));
  originalHome = process.env.HOME;
  process.env.HOME = tmpHome;
  vi.resetModules();
});

afterEach(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.resetModules();
});

async function importConfig() {
  return await import("../src/config.js");
}

async function initEmptyConfig() {
  const { saveConfig, GARDEN_DIR } = await importConfig();
  fs.mkdirSync(GARDEN_DIR, { recursive: true });
  saveConfig({ projects: {} });
}

describe("getAutoContinueConfig", () => {
  it("returns defaults when nothing is persisted", async () => {
    await initEmptyConfig();
    const { getAutoContinueConfig, AUTO_CONTINUE_DEFAULTS } = await importConfig();
    expect(getAutoContinueConfig()).toEqual(AUTO_CONTINUE_DEFAULTS);
  });

  it("merges persisted values over defaults", async () => {
    await initEmptyConfig();
    const { setAutoContinueConfig, getAutoContinueConfig } = await importConfig();
    setAutoContinueConfig({ usageThreshold: 80 });
    const cfg = getAutoContinueConfig();
    expect(cfg.usageThreshold).toBe(80);
    expect(cfg.enabled).toBe(true);
    expect(cfg.resumeAfterReset).toBe(false);
  });
});

describe("setAutoContinueConfig", () => {
  it("strips paused metadata when set undefined", async () => {
    await initEmptyConfig();
    const { setAutoContinueConfig, CONFIG_PATH } = await importConfig();
    setAutoContinueConfig({
      enabled: false,
      pausedUntil: "2026-05-09T00:00:00.000Z",
      pausedReason: "5h at 96%",
    });
    setAutoContinueConfig({ enabled: true, pausedUntil: undefined, pausedReason: undefined });
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    expect(raw).not.toMatch(/pausedUntil/);
    expect(raw).not.toMatch(/pausedReason/);
  });
});

// ---------------------------------------------------------------------------
// Gate tests — mock readUsageSnapshot + alert sink so we can drive scenarios
// without touching tmux or real http.
// ---------------------------------------------------------------------------

const addAlertMock = vi.fn();

function mockGateDeps(snap: unknown) {
  // Keep the real snapshotMeters (the accessor under test reads through it);
  // only the snapshot source is stubbed.
  vi.doMock("../src/dashboard/usage.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../src/dashboard/usage.js")>()),
    readUsageSnapshot: () => snap,
  }));
  vi.doMock("../src/dashboard/alerts.js", () => ({
    addAlert: addAlertMock,
  }));
  vi.doMock("../src/dashboard/log.js", () => ({
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }));
}

async function importGate() {
  return await import("../src/dashboard/poller.js");
}

describe("checkUsageThreshold", () => {
  // Pin "now" before the fixtures' reset instants so their windows read as
  // still-open regardless of the wall clock — the gate now skips meters whose
  // window has already reset, and these fixtures use near-real dates.
  beforeEach(() => {
    addAlertMock.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T00:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("returns null when no meters are present", async () => {
    mockGateDeps({ fetchedAt: "2026-05-02T00:00:00Z", data: {} });
    const { checkUsageThreshold } = await importGate();
    expect(checkUsageThreshold(95)).toBeNull();
  });

  it("ignores sonnet entirely", async () => {
    mockGateDeps({
      fetchedAt: "2026-05-02T00:00:00Z",
      data: {
        fiveHour: { pct: 10, resetsAt: "2026-05-02T05:00:00Z" },
        weekly: { pct: 20, resetsAt: "2026-05-09T00:00:00Z" },
        sonnet: { pct: 99, resetsAt: "2026-05-09T00:00:00Z" },
      },
    });
    const { checkUsageThreshold } = await importGate();
    expect(checkUsageThreshold(95)).toBeNull();
  });

  it("trips when 5h crosses threshold", async () => {
    mockGateDeps({
      fetchedAt: "2026-05-02T00:00:00Z",
      data: {
        fiveHour: { pct: 96, resetsAt: "2026-05-02T05:00:00Z" },
        weekly: { pct: 50, resetsAt: "2026-05-09T00:00:00Z" },
      },
    });
    const { checkUsageThreshold } = await importGate();
    const tripped = checkUsageThreshold(95);
    expect(tripped).not.toBeNull();
    expect(tripped!.pausedUntil).toBe("2026-05-02T05:00:00Z");
    expect(tripped!.reason).toContain("5h");
    expect(tripped!.reason).not.toContain("week");
  });

  it("picks the later resetsAt when multiple meters trip", async () => {
    mockGateDeps({
      fetchedAt: "2026-05-02T00:00:00Z",
      data: {
        fiveHour: { pct: 99, resetsAt: "2026-05-02T05:00:00Z" },
        weekly: { pct: 96, resetsAt: "2026-05-09T00:00:00Z" },
      },
    });
    const { checkUsageThreshold } = await importGate();
    const tripped = checkUsageThreshold(95);
    expect(tripped!.pausedUntil).toBe("2026-05-09T00:00:00Z");
    expect(tripped!.reason).toContain("5h");
    expect(tripped!.reason).toContain("week");
  });

  it("does not trip on a meter whose window has already reset", async () => {
    // Boundary storm: the 5h window maxed out and then reset, but the on-disk
    // snapshot still shows the old window at 100% with a now-past resets_at
    // (the usage poller has not re-fetched yet). Tripping here would set
    // pausedUntil to a past instant and flip-flop the gate every poll.
    mockGateDeps({
      fetchedAt: "2026-04-30T00:00:00Z",
      data: {
        fiveHour: { pct: 100, resetsAt: "2026-04-30T05:00:00Z" },
        weekly: { pct: 50, resetsAt: "2026-05-09T00:00:00Z" },
      },
    });
    const { checkUsageThreshold } = await importGate();
    expect(checkUsageThreshold(95)).toBeNull();
  });

  it("still trips on a fresh meter alongside a reset one", async () => {
    // Only the stale (already-reset) meter is skipped; a genuinely-exhausted
    // meter with a future reset must still pause.
    mockGateDeps({
      fetchedAt: "2026-04-30T00:00:00Z",
      data: {
        fiveHour: { pct: 100, resetsAt: "2026-04-30T05:00:00Z" },
        weekly: { pct: 99, resetsAt: "2026-05-09T00:00:00Z" },
      },
    });
    const { checkUsageThreshold } = await importGate();
    const tripped = checkUsageThreshold(95);
    expect(tripped!.pausedUntil).toBe("2026-05-09T00:00:00Z");
    expect(tripped!.reason).toContain("week");
    expect(tripped!.reason).not.toContain("5h");
  });

  it("still trips on a high meter with an unparseable resetsAt", async () => {
    // The reset-skip guard keeps a meter whose resetsAt does not parse, so a
    // malformed-but-high snapshot still pauses rather than silently disabling
    // the gate. (It just won't auto-resume until the operator intervenes,
    // since autoContinueGateReason can't parse the pausedUntil either.)
    mockGateDeps({
      fetchedAt: "2026-04-30T00:00:00Z",
      data: {
        weekly: { pct: 99, resetsAt: "not-a-date" },
      },
    });
    const { checkUsageThreshold } = await importGate();
    const tripped = checkUsageThreshold(95);
    expect(tripped).not.toBeNull();
    expect(tripped!.pausedUntil).toBe("not-a-date");
    expect(tripped!.reason).toContain("week");
  });
});

describe("autoContinueGateReason", () => {
  beforeEach(() => addAlertMock.mockReset());

  it("returns null when enabled and no meter trips", async () => {
    await initEmptyConfig();
    mockGateDeps({
      fetchedAt: "2026-05-02T00:00:00Z",
      data: {
        fiveHour: { pct: 10, resetsAt: "2026-05-02T05:00:00Z" },
        weekly: { pct: 20, resetsAt: "2026-05-09T00:00:00Z" },
      },
    });
    const { autoContinueGateReason } = await importGate();
    expect(autoContinueGateReason()).toBeNull();
  });

  it("returns globally-disabled when manually off", async () => {
    await initEmptyConfig();
    const { setAutoContinueConfig } = await importConfig();
    setAutoContinueConfig({ enabled: false });
    mockGateDeps(null);
    const { autoContinueGateReason } = await importGate();
    expect(autoContinueGateReason()).toBe("globally-disabled");
  });

  it("returns usage-paused when paused with pausedUntil set", async () => {
    await initEmptyConfig();
    const { setAutoContinueConfig } = await importConfig();
    setAutoContinueConfig({
      enabled: false,
      pausedUntil: "2099-01-01T00:00:00Z",
      pausedReason: "5h at 99%",
    });
    mockGateDeps(null);
    const { autoContinueGateReason } = await importGate();
    expect(autoContinueGateReason()).toBe("usage-paused");
  });

  it("auto-resumes after pausedUntil when resumeAfterReset is on", async () => {
    await initEmptyConfig();
    const { setAutoContinueConfig, getAutoContinueConfig } = await importConfig();
    setAutoContinueConfig({
      enabled: false,
      resumeAfterReset: true,
      pausedUntil: "2000-01-01T00:00:00Z",
      pausedReason: "5h at 99%",
    });
    mockGateDeps({
      fetchedAt: "2026-05-02T00:00:00Z",
      data: { fiveHour: { pct: 10, resetsAt: "2026-05-02T05:00:00Z" } },
    });
    const { autoContinueGateReason } = await importGate();
    expect(autoContinueGateReason()).toBeNull();
    const cfg = getAutoContinueConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.pausedUntil).toBeUndefined();
  });

  it("does NOT auto-resume when resumeAfterReset is off", async () => {
    await initEmptyConfig();
    const { setAutoContinueConfig, getAutoContinueConfig } = await importConfig();
    setAutoContinueConfig({
      enabled: false,
      resumeAfterReset: false,
      pausedUntil: "2000-01-01T00:00:00Z",
      pausedReason: "5h at 99%",
    });
    mockGateDeps(null);
    const { autoContinueGateReason } = await importGate();
    expect(autoContinueGateReason()).toBe("usage-paused");
    expect(getAutoContinueConfig().enabled).toBe(false);
  });

  it("auto-disables and fires an alert when threshold trips", async () => {
    await initEmptyConfig();
    mockGateDeps({
      fetchedAt: "2026-05-02T00:00:00Z",
      data: { weekly: { pct: 99, resetsAt: "2099-01-01T00:00:00Z" } },
    });
    const { autoContinueGateReason } = await importGate();
    expect(autoContinueGateReason()).toBe("usage-threshold");
    expect(addAlertMock).toHaveBeenCalledOnce();
    expect(addAlertMock.mock.calls[0][0].source).toBe("usage");
    const { getAutoContinueConfig } = await importConfig();
    const cfg = getAutoContinueConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.pausedUntil).toBe("2099-01-01T00:00:00Z");
  });

  it("does NOT trip on sonnet alone", async () => {
    await initEmptyConfig();
    mockGateDeps({
      fetchedAt: "2026-05-02T00:00:00Z",
      data: {
        fiveHour: { pct: 10, resetsAt: "2026-05-02T05:00:00Z" },
        weekly: { pct: 50, resetsAt: "2026-05-09T00:00:00Z" },
        sonnet: { pct: 99, resetsAt: "2026-05-09T00:00:00Z" },
      },
    });
    const { autoContinueGateReason } = await importGate();
    expect(autoContinueGateReason()).toBeNull();
    expect(addAlertMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Gate-reset wake — the usage poller's poke that lets an idle garden
// auto-resume after a token wall (no hooks or pushes to deliver the poke
// that would run the merged-state sweep).
// ---------------------------------------------------------------------------

describe("pokeOnGateReset", () => {
  const triggerProjectPollMock = vi.fn();

  beforeEach(() => triggerProjectPollMock.mockReset());

  async function importUsagePoller() {
    vi.doMock("../src/dashboard/poller-fifo.js", () => ({
      triggerProjectPoll: triggerProjectPollMock,
    }));
    vi.doMock("../src/dashboard/log.js", () => ({
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }));
    vi.doMock("../src/dashboard/header.js", () => ({ refreshDashboard: vi.fn() }));
    vi.doMock("../src/dashboard/usage.js", () => ({
      decideRefresh: vi.fn(), readUsageSnapshot: vi.fn(), refreshUsage: vi.fn(),
    }));
    vi.doMock("../src/dashboard/tmux.js", () => ({
      tmux: vi.fn(), windowExists: vi.fn(), killWindowSafe: vi.fn(),
    }));
    return await import("../src/dashboard/usage-poller.js");
  }

  async function initProjects() {
    const { saveConfig, GARDEN_DIR } = await importConfig();
    fs.mkdirSync(GARDEN_DIR, { recursive: true });
    saveConfig({ projects: { alpha: { path: "/tmp/a" }, beta: { path: "/tmp/b" } } });
  }

  it("pokes every project once the paused window passes with auto-resume armed", async () => {
    await initProjects();
    const { setAutoContinueConfig } = await importConfig();
    setAutoContinueConfig({
      enabled: false,
      resumeAfterReset: true,
      pausedUntil: "2000-01-01T00:00:00Z",
      pausedReason: "5h at 100%",
    });
    const { pokeOnGateReset } = await importUsagePoller();
    pokeOnGateReset();
    expect(triggerProjectPollMock).toHaveBeenCalledTimes(2);
    expect(triggerProjectPollMock).toHaveBeenCalledWith("alpha");
    expect(triggerProjectPollMock).toHaveBeenCalledWith("beta");
  });

  it("no-ops while still inside the paused window", async () => {
    await initProjects();
    const { setAutoContinueConfig } = await importConfig();
    setAutoContinueConfig({
      enabled: false,
      resumeAfterReset: true,
      pausedUntil: "2099-01-01T00:00:00Z",
      pausedReason: "5h at 100%",
    });
    const { pokeOnGateReset } = await importUsagePoller();
    pokeOnGateReset();
    expect(triggerProjectPollMock).not.toHaveBeenCalled();
  });

  it("no-ops when resumeAfterReset is off", async () => {
    await initProjects();
    const { setAutoContinueConfig } = await importConfig();
    setAutoContinueConfig({
      enabled: false,
      resumeAfterReset: false,
      pausedUntil: "2000-01-01T00:00:00Z",
      pausedReason: "5h at 100%",
    });
    const { pokeOnGateReset } = await importUsagePoller();
    pokeOnGateReset();
    expect(triggerProjectPollMock).not.toHaveBeenCalled();
  });

  it("no-ops when the gate is open", async () => {
    await initProjects();
    const { pokeOnGateReset } = await importUsagePoller();
    pokeOnGateReset();
    expect(triggerProjectPollMock).not.toHaveBeenCalled();
  });
});

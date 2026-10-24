// One pass of the real watchdog loop, with every duty it calls stubbed. The
// loop's wiring is the protection here: each duty is unit-tested elsewhere,
// and a duty the loop stops calling would pass all of those.
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  truncateLog: vi.fn(),
}));
vi.mock("../src/config.js", () => ({
  SESSIONS_DIR: "/tmp/garden-watchdog-loop-test/sessions",
  getBuildBranch: vi.fn(() => "main"),
  loadConfig: vi.fn(() => ({ projects: {} })),
}));
vi.mock("../src/version.js", () => ({ GARDEN_VERSION: "test", GARDEN_COMMIT: "" }));
vi.mock("../src/dashboard/tmux.js", () => ({
  newDashboardWindow: vi.fn(),
  windowExists: vi.fn(() => true),
  killWindowSafe: vi.fn(),
  listAllWindowNames: vi.fn(() => []),
}));
vi.mock("../src/dashboard/registry.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/dashboard/registry.js")>()),
  readRegistry: vi.fn(() => ({ workers: {} })),
  mutateRegistry: vi.fn(),
}));
vi.mock("../src/dashboard/state.js", () => ({
  readDashState: vi.fn(() => ({})),
  writeDashState: vi.fn(),
  withStateLock: vi.fn((fn: () => unknown) => fn()),
}));
vi.mock("../src/dashboard/alerts.js", () => ({ addAlert: vi.fn() }));
vi.mock("../src/dashboard/poller-fifo.js", () => ({ triggerProjectPoll: vi.fn() }));
vi.mock("../src/dashboard/git.js", () => ({
  commitsBehindOrigin: vi.fn(() => null),
  gardenInstallRepo: vi.fn(() => null),
  listWorktreeDirs: vi.fn(() => []),
  workerCleanupMarkerPath: vi.fn(() => "/nonexistent"),
}));
vi.mock("../src/dashboard/codex-input.js", () => ({ startCodexInputWatcher: vi.fn() }));
vi.mock("../src/dashboard/codex-usage.js", () => ({
  captureCodexUsageLatest: vi.fn(() => false),
  probeCodexUsageIfStale: vi.fn(() => false),
  CODEX_PROBE_INTERVAL_MS: 6 * 60 * 60_000,
}));
vi.mock("../src/dashboard/model-drift.js", () => ({ sweepWorkerModels: vi.fn(() => 0) }));
vi.mock("../src/dashboard/window-heal.js", () => ({ healWorkerWindows: vi.fn() }));
vi.mock("../src/dashboard/column-split.js", () => ({ reconcileColumnSplit: vi.fn(async () => {}) }));
vi.mock("../src/dashboard/awake.js", () => ({ enforceAwake: vi.fn() }));
vi.mock("../src/dashboard/pty-census.js", () => ({
  takePtyCensus: vi.fn(() => null),
  unexplainedHoldings: vi.fn(() => []),
  isPtyPressure: vi.fn(() => false),
  formatTopHolders: vi.fn(() => ""),
}));
vi.mock("../src/dashboard/spawn-draft.js", () => ({ sweepSpawnDrafts: vi.fn() }));
vi.mock("../src/dashboard/worker-cleanup.js", () => ({
  dueCleanupRequests: vi.fn(() => []),
  dispatchWorkerCleanup: vi.fn(),
}));
vi.mock("../src/dashboard/task-title.js", () => ({
  titleCandidates: vi.fn(() => []),
  dispatchWorkerTitle: vi.fn(),
}));
// The loop's dynamic imports.
vi.mock("../src/dashboard/runner.js", () => ({ resolveGardenRunner: vi.fn(() => "garden-runner") }));
vi.mock("../src/dashboard/poller.js", () => ({
  startProjectPoller: vi.fn(),
  restartDriftedPollers: vi.fn(),
}));
vi.mock("../src/dashboard/usage-poller.js", () => ({ ensureUsagePoller: vi.fn() }));
vi.mock("../src/dashboard/header.js", () => ({
  refreshStatusElapsed: vi.fn(),
  refreshDashboard: vi.fn(),
}));
vi.mock("../src/dashboard/validate.js", () => ({
  healActivePane: vi.fn(),
  cleanContextFiles: vi.fn(),
  cleanClaudeSettingsFiles: vi.fn(),
}));
vi.mock("../src/dashboard/permission-prompt.js", () => ({
  sweepAnsweredPermissionPrompts: vi.fn(() => false),
}));

import { runWatchdogLoop } from "../src/dashboard/watchdog.js";
import { ensureUsagePoller } from "../src/dashboard/usage-poller.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("runWatchdogLoop", () => {
  // A usage poller whose loop died used to stay dead until the next dashboard
  // attach: nothing in the fleet's one recurring tick revived it.
  it("runs the usage-poller heal on its pass, with its own runner", async () => {
    vi.useFakeTimers();
    void runWatchdogLoop(); // never resolves; the fake clock holds it at its first sleep

    await vi.waitFor(() => expect(ensureUsagePoller).toHaveBeenCalledWith("garden-runner"));
  });
});

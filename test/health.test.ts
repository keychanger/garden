import { describe, it, expect, vi, beforeEach } from "vitest";
import { captureConsoleLog } from "./helpers.js";

vi.mock("../src/session.js", () => ({
  dashboardExists: vi.fn(() => true),
  DASHBOARD_SESSION: "garden-dashboard",
}));

vi.mock("../src/dashboard/state.js", () => ({
  readDashState: vi.fn(() => ({
    activeProject: "garden",
    statusPaneId: "%0",
    gardenShellPaneId: "%1",
    activePaneId: "%2",
    activePaneType: "worker",
    activeWindowName: "_garden-worker-bold-ash",
  })),
  writeDashState: vi.fn(),
  withStateLock: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock("../src/dashboard/registry.js", () => ({
  readRegistry: vi.fn(() => ({ workers: {} })),
  updateWorkerFields: vi.fn(),
}));

vi.mock("../src/dashboard/validate.js", () => ({
  validateAndHeal: vi.fn(state => state),
}));

vi.mock("../src/dashboard/tmux.js", () => ({
  paneExists: vi.fn(() => true),
  windowExists: vi.fn(() => true),
  getFirstPaneId: vi.fn(() => "%5"),
  getPanePid: vi.fn(() => "12345"),
  listHiddenWorkerWindows: vi.fn(() => []),
}));

vi.mock("../src/config.js", () => ({
  loadConfig: vi.fn(() => ({
    projects: { garden: { path: "/tmp/garden" } },
  })),
  SESSIONS_DIR: "/tmp/fake-sessions",
}));

import { health } from "../src/commands/health.js";
import { readRegistry, updateWorkerFields } from "../src/dashboard/registry.js";
import { getPanePid } from "../src/dashboard/tmux.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("garden health — stale hook detection", () => {
  it("flags a worker stuck in 'working' with no recent hook", async () => {
    vi.mocked(readRegistry).mockReturnValue({
      workers: {
        garden: [{
          name: "bold-ash",
          sessionId: "abc",
          task: "fix the build",
          agentStatus: "working",
          lastEventAt: Date.now() - 30 * 60 * 1000, // 30 minutes ago
        }],
      },
    });

    const logged = await captureConsoleLog(() => health([]));

    const issueLine = logged.find(l => l.includes("last hook"));
    expect(issueLine).toBeDefined();
    expect(issueLine).toContain("bold-ash");
    expect(issueLine).toContain("min ago");
  });

  it("flags a worker stuck in 'working' with no hook ever", async () => {
    vi.mocked(readRegistry).mockReturnValue({
      workers: {
        garden: [{
          name: "bold-ash",
          sessionId: "abc",
          task: "fix the build",
          agentStatus: "working",
          // lastEventAt absent
        }],
      },
    });

    const logged = await captureConsoleLog(() => health([]));

    const issueLine = logged.find(l => l.includes("last hook ever ago"));
    expect(issueLine).toBeDefined();
  });

  it("does not flag a worker in 'working' with a fresh hook", async () => {
    vi.mocked(readRegistry).mockReturnValue({
      workers: {
        garden: [{
          name: "bold-ash",
          sessionId: "abc",
          task: "fix the build",
          agentStatus: "working",
          lastEventAt: Date.now() - 30_000, // 30s ago
        }],
      },
    });

    const logged = await captureConsoleLog(() => health([]));

    const issueLines = logged.filter(l => l.includes("last hook"));
    expect(issueLines).toHaveLength(0);
  });

  it("does not flag idle workers with stale hooks (legitimately quiet)", async () => {
    vi.mocked(readRegistry).mockReturnValue({
      workers: {
        garden: [{
          name: "bold-ash",
          sessionId: "abc",
          task: "fix the build",
          agentStatus: "idle",
          lastEventAt: Date.now() - 60 * 60 * 1000, // 1 hour ago
        }],
      },
    });

    const logged = await captureConsoleLog(() => health([]));

    const issueLines = logged.filter(l => l.includes("last hook"));
    expect(issueLines).toHaveLength(0);
  });
});

describe("garden health — dead pane PID detection", () => {
  it("flags a worker whose pane PID is dead but agentStatus != exited", async () => {
    vi.mocked(readRegistry).mockReturnValue({
      workers: {
        garden: [{
          name: "bold-ash",
          sessionId: "abc",
          task: "fix the build",
          agentStatus: "idle",
        }],
      },
    });
    vi.mocked(getPanePid).mockReturnValue("99999"); // some PID
    const realKill = process.kill;
    process.kill = ((pid: number, sig?: number | string) => {
      if (sig === 0 && pid === 99999) throw new Error("ESRCH");
      return realKill(pid, sig as number);
    }) as typeof process.kill;

    let logged: string[];
    try {
      logged = await captureConsoleLog(() => health([]));
    } finally {
      process.kill = realKill;
    }

    const issueLine = logged.find(l => l.includes("PID 99999 is dead"));
    expect(issueLine).toBeDefined();
  });

  it("does not flag a worker whose agentStatus is already 'exited'", async () => {
    vi.mocked(readRegistry).mockReturnValue({
      workers: {
        garden: [{
          name: "bold-ash",
          sessionId: "abc",
          task: "",
          agentStatus: "exited",
        }],
      },
    });
    vi.mocked(getPanePid).mockReturnValue("99999");
    const realKill = process.kill;
    process.kill = ((pid: number, sig?: number | string) => {
      if (sig === 0 && pid === 99999) throw new Error("ESRCH");
      return realKill(pid, sig as number);
    }) as typeof process.kill;

    let logged: string[];
    try {
      logged = await captureConsoleLog(() => health([]));
    } finally {
      process.kill = realKill;
    }

    const issueLines = logged.filter(l => l.includes("is dead"));
    expect(issueLines).toHaveLength(0);
  });

  it("with --fix, writes agentStatus=exited for dead pane workers", async () => {
    vi.mocked(readRegistry).mockReturnValue({
      workers: {
        garden: [{
          name: "bold-ash",
          sessionId: "abc",
          task: "",
          agentStatus: "idle",
        }],
      },
    });
    vi.mocked(getPanePid).mockReturnValue("99999");
    const realKill = process.kill;
    process.kill = ((pid: number, sig?: number | string) => {
      if (sig === 0 && pid === 99999) throw new Error("ESRCH");
      return realKill(pid, sig as number);
    }) as typeof process.kill;

    try {
      await captureConsoleLog(() => health(["--fix"]));
    } finally {
      process.kill = realKill;
    }

    expect(updateWorkerFields).toHaveBeenCalledWith("garden", "bold-ash", { agentStatus: "exited" });
  });

  it("does not auto-fix without --fix", async () => {
    vi.mocked(readRegistry).mockReturnValue({
      workers: {
        garden: [{
          name: "bold-ash",
          sessionId: "abc",
          task: "",
          agentStatus: "idle",
        }],
      },
    });
    vi.mocked(getPanePid).mockReturnValue("99999");
    const realKill = process.kill;
    process.kill = ((pid: number, sig?: number | string) => {
      if (sig === 0 && pid === 99999) throw new Error("ESRCH");
      return realKill(pid, sig as number);
    }) as typeof process.kill;

    try {
      await captureConsoleLog(() => health([]));
    } finally {
      process.kill = realKill;
    }

    expect(updateWorkerFields).not.toHaveBeenCalled();
  });
});

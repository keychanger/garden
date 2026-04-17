import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => "{}"),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn(),
  },
}));

vi.mock("../src/config.js", () => ({
  SESSIONS_DIR: "/tmp/fake-sessions",
}));

vi.mock("../src/session.js", () => ({
  DASHBOARD_SESSION: "garden-dashboard",
}));

vi.mock("../src/dashboard/tmux.js", () => ({
  tmux: vi.fn(),
}));

vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/version.js", () => ({
  GARDEN_VERSION: "test",
}));

vi.mock("node:crypto", () => ({
  default: { randomUUID: vi.fn(() => "test-uuid-1") },
}));

import fs from "node:fs";
import {
  readAlerts, addAlert, clearAlerts, alertCount,
  unreadAlertCount, acknowledgeAlerts, formatRightBar,
} from "../src/dashboard/alerts.js";
import { log } from "../src/dashboard/log.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("readAlerts", () => {
  it("returns empty store when file does not exist", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const store = readAlerts();
    expect(store).toEqual({ alerts: [] });
  });

  it("parses existing alerts file", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const data = { alerts: [{ id: "1", ts: "2026-01-01", level: "warn", source: "test", project: "p", message: "m" }] };
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(data));
    const store = readAlerts();
    expect(store.alerts).toHaveLength(1);
    expect(store.alerts[0].id).toBe("1");
  });

  it("returns empty store on corrupt file", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("not json{{{");
    const store = readAlerts();
    expect(store).toEqual({ alerts: [] });
  });
});

describe("addAlert", () => {
  it("appends alert and writes atomically", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    addAlert({
      level: "error",
      source: "review",
      project: "myproject",
      worker: "bold-ash",
      message: "Review failed",
    });

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining(".tmp"),
      expect.stringContaining("test-uuid-1"),
    );
    expect(fs.renameSync).toHaveBeenCalled();
  });

  it("routes warn alerts through log.warn, not log.error", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    addAlert({
      level: "warn",
      source: "worker",
      project: "myproject",
      worker: "bold-ash",
      message: "Worker bold-ash is asking for input — switch to it to respond",
    });

    expect(log.warn).toHaveBeenCalledWith(
      "alert",
      expect.stringContaining("asking for input"),
      expect.objectContaining({ worker: "bold-ash" }),
    );
    expect(log.error).not.toHaveBeenCalled();
  });

  it("routes error alerts through log.error", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    addAlert({
      level: "error",
      source: "review",
      project: "myproject",
      worker: "bold-ash",
      message: "Review failed",
    });

    expect(log.error).toHaveBeenCalledWith(
      "alert",
      "Review failed",
      expect.objectContaining({ worker: "bold-ash" }),
    );
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe("clearAlerts", () => {
  it("writes empty alerts array and stamps lastSeenAt", () => {
    clearAlerts();

    const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
    const parsed = JSON.parse(written);
    expect(parsed.alerts).toEqual([]);
    expect(parsed.lastSeenAt).toEqual(expect.any(String));
    expect(fs.renameSync).toHaveBeenCalled();
  });
});

describe("alertCount", () => {
  it("returns 0 when no alerts", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(alertCount()).toBe(0);
  });

  it("returns correct count", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const data = {
      alerts: [
        { id: "1", ts: "t", level: "warn", source: "s", project: "p", message: "m" },
        { id: "2", ts: "t", level: "error", source: "s", project: "p", message: "m" },
      ],
    };
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(data));
    expect(alertCount()).toBe(2);
  });
});

describe("unreadAlertCount", () => {
  it("returns 0 when no alerts", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(unreadAlertCount()).toBe(0);
  });

  it("counts all alerts when lastSeenAt is unset", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const data = {
      alerts: [
        { id: "1", ts: "2026-01-01T00:00:00Z", level: "error", source: "s", project: "p", message: "m" },
        { id: "2", ts: "2026-01-02T00:00:00Z", level: "error", source: "s", project: "p", message: "m" },
      ],
    };
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(data));
    expect(unreadAlertCount()).toBe(2);
  });

  it("only counts alerts after lastSeenAt", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const data = {
      alerts: [
        { id: "1", ts: "2026-01-01T00:00:00Z", level: "error", source: "s", project: "p", message: "m" },
        { id: "2", ts: "2026-01-03T00:00:00Z", level: "error", source: "s", project: "p", message: "m" },
      ],
      lastSeenAt: "2026-01-02T00:00:00Z",
    };
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(data));
    expect(unreadAlertCount()).toBe(1);
  });
});

describe("acknowledgeAlerts", () => {
  it("stamps lastSeenAt on existing store", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const data = {
      alerts: [
        { id: "1", ts: "2026-01-01T00:00:00Z", level: "error", source: "s", project: "p", message: "m" },
      ],
    };
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(data));

    acknowledgeAlerts();

    const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
    const parsed = JSON.parse(written);
    expect(parsed.alerts).toHaveLength(1);
    expect(parsed.lastSeenAt).toEqual(expect.any(String));
  });
});

describe("formatRightBar", () => {
  it("returns version-only when no unread", () => {
    expect(formatRightBar(0)).toBe("garden test ");
  });

  it("prefixes singular badge when unread is 1", () => {
    const out = formatRightBar(1);
    expect(out).toContain("⚠ 1 alert");
    expect(out).toContain("⌥l to clear");
    expect(out).toContain("garden test");
  });

  it("pluralizes when unread > 1", () => {
    expect(formatRightBar(3)).toContain("⚠ 3 alerts");
  });
});

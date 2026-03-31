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

vi.mock("node:crypto", () => ({
  default: { randomUUID: vi.fn(() => "test-uuid-1") },
}));

import fs from "node:fs";
import { readAlerts, addAlert, clearAlerts, alertCount } from "../src/dashboard/alerts.js";

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
      prNumber: 42,
      message: "Review failed",
    });

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining(".tmp"),
      expect.stringContaining("test-uuid-1"),
    );
    expect(fs.renameSync).toHaveBeenCalled();
  });
});

describe("clearAlerts", () => {
  it("writes empty alerts array", () => {
    clearAlerts();

    const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
    const parsed = JSON.parse(written);
    expect(parsed).toEqual({ alerts: [] });
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

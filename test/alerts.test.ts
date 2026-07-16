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

// These unit tests exercise alert logic against a fully-mocked fs, not real
// cross-process locking. Pass the lock through so addAlert/ack/clear run their
// read-modify-write without needing fs.constants / openSync on the mock. A
// vi.fn (not a bare arrow) so a test can override it with mockImplementationOnce
// to simulate a lock-acquisition failure.
vi.mock("../src/dashboard/file-lock.js", () => ({
  withFileLock: vi.fn((_lockPath: string, fn: () => unknown) => fn()),
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
  unreadAlertCount, unreadAlertCountsByProject, acknowledgeAlerts, formatRightBar,
} from "../src/dashboard/alerts.js";
import { log } from "../src/dashboard/log.js";
import { withFileLock } from "../src/dashboard/file-lock.js";

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

  it("returns empty store when alerts is missing", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ unrelated: 1 }));
    expect(readAlerts()).toEqual({ alerts: [] });
  });

  it("returns empty store when an alert is missing a required string field", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    // `level` is required; missing it would crash log[level](...) on the
    // next addAlert. Falling back to empty is safer than letting that fire.
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      alerts: [{ id: "1", ts: "t", source: "s", project: "p", message: "m" }],
    }));
    expect(readAlerts()).toEqual({ alerts: [] });
  });

  it("returns empty store when an alert's level is the wrong type", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      alerts: [{ id: "1", ts: "t", level: 42, source: "s", project: "p", message: "m" }],
    }));
    expect(readAlerts()).toEqual({ alerts: [] });
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
      source: "usage",
      project: "garden",
      message: "Auto-continue disabled: 5h meter at 96% (>=95%). Run 'garden auto on' to re-enable.",
    });

    expect(log.warn).toHaveBeenCalledWith(
      "alert",
      expect.stringContaining("Auto-continue disabled"),
      expect.objectContaining({ data: expect.objectContaining({ source: "usage" }) }),
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

describe("addAlert dedup", () => {
  function alertsFromLastWrite(): Array<Record<string, unknown>> {
    const calls = vi.mocked(fs.writeFileSync).mock.calls;
    if (calls.length === 0) return [];
    const last = calls[calls.length - 1][1] as string;
    return JSON.parse(last).alerts as Array<Record<string, unknown>>;
  }

  // Stage existing alerts into the readAlerts() mock by stuffing them into
  // the JSON.parse-able readFileSync mock. Subsequent writes will use the
  // capture above.
  function stage(alerts: Array<Record<string, unknown>>): void {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ alerts }));
  }

  it("suppresses identical-default-key alerts within the dedup window", () => {
    stage([]);
    addAlert({
      level: "error", source: "poller", project: "p", worker: "w", message: "Same body",
    });
    const after1 = alertsFromLastWrite();
    expect(after1).toHaveLength(1);

    // Stage that first alert as the now-current store, then fire an
    // identical alert and verify it does not persist.
    stage(after1);
    vi.mocked(log.error).mockClear();
    vi.mocked(fs.writeFileSync).mockClear();
    addAlert({
      level: "error", source: "poller", project: "p", worker: "w", message: "Same body",
    });
    // No new write to the alerts file: the writes we observe should only be
    // from refreshAlertBadge, which does not call atomicWriteFile (it sets
    // a tmux option). So writeFileSync should have zero calls.
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    // And the duplicate log emission is suppressed too.
    expect(log.error).not.toHaveBeenCalled();
  });

  it("persists alerts past the dedup window", () => {
    const oldTs = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago
    stage([{
      id: "old", ts: oldTs, level: "error", source: "poller",
      project: "p", worker: "w", message: "Same body",
      dedupKey: ["error", "poller", "p", "w", "Same body"].join("\x00"),
    }]);
    vi.mocked(fs.writeFileSync).mockClear();
    addAlert({
      level: "error", source: "poller", project: "p", worker: "w", message: "Same body",
    });
    // The window is 1h; the existing alert is 2h old, so the new alert persists.
    const after = alertsFromLastWrite();
    expect(after.length).toBeGreaterThan(0);
    const newest = after[after.length - 1] as { message?: string };
    expect(newest.message).toBe("Same body");
  });

  it("explicit dedupKey suppresses across volatile message text", () => {
    const sharedKey = "review-failed:proj:bold-ash";
    stage([{
      id: "old", ts: new Date().toISOString(),
      level: "error", source: "review", project: "proj", worker: "bold-ash",
      message: "Reviewer could not fix issues for worker bold-ash: typo in line 42",
      dedupKey: sharedKey,
    }]);
    vi.mocked(fs.writeFileSync).mockClear();
    addAlert({
      level: "error", source: "review", project: "proj", worker: "bold-ash",
      message: "Reviewer could not fix issues for worker bold-ash: undefined ref at line 99",
      dedupKey: sharedKey,
    });
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it("different explicit dedupKeys produce distinct alerts even with same message", () => {
    stage([{
      id: "old", ts: new Date().toISOString(),
      level: "error", source: "poller", project: "p", worker: "w1",
      message: "Same body", dedupKey: "tagA",
    }]);
    vi.mocked(fs.writeFileSync).mockClear();
    addAlert({
      level: "error", source: "poller", project: "p", worker: "w1",
      message: "Same body", dedupKey: "tagB",
    });
    const after = alertsFromLastWrite();
    expect(after).toHaveLength(2);
  });

  it("interoperates with pre-dedup alerts that have no stored dedupKey", () => {
    // Backward compat: alerts persisted before the dedup field landed have
    // no `dedupKey`. They should still suppress new alerts whose computed
    // default key matches the stored alert's effective default key.
    stage([{
      id: "legacy", ts: new Date().toISOString(),
      level: "error", source: "poller", project: "p", worker: "w",
      message: "Legacy body",
      // dedupKey omitted (legacy).
    }]);
    vi.mocked(fs.writeFileSync).mockClear();
    addAlert({
      level: "error", source: "poller", project: "p", worker: "w", message: "Legacy body",
    });
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });
});

describe("addAlert lock failure", () => {
  it("drops the alert without throwing when the lock cannot be acquired", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    // Simulate withFileLock's deadline throw. addAlert is best-effort: callers
    // (poller / validate — the latter fires it inside the registry lock) never
    // expect it to throw, so it must swallow the failure and persist nothing.
    vi.mocked(withFileLock).mockImplementationOnce(() => {
      throw new Error("Could not acquire alerts lock after 2000ms");
    });
    expect(() =>
      addAlert({ level: "error", source: "poller", project: "p", worker: "w", message: "boom" }),
    ).not.toThrow();
    // Nothing persisted and no log line emitted for a dropped alert.
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
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

describe("unreadAlertCountsByProject", () => {
  it("buckets unread alerts by project, respecting the global lastSeenAt", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const data = {
      alerts: [
        { id: "1", ts: "2026-01-01T00:00:00Z", level: "warn", source: "s", project: "lex", message: "m" },  // read
        { id: "2", ts: "2026-01-03T00:00:00Z", level: "warn", source: "s", project: "lex", message: "m" },   // unread
        { id: "3", ts: "2026-01-04T00:00:00Z", level: "error", source: "s", project: "lex", message: "m" },  // unread
        { id: "4", ts: "2026-01-03T00:00:00Z", level: "warn", source: "s", project: "web", message: "m" },   // unread
      ],
      lastSeenAt: "2026-01-02T00:00:00Z",
    };
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(data));
    const counts = unreadAlertCountsByProject();
    expect(counts.get("lex")).toBe(2);
    expect(counts.get("web")).toBe(1);
  });

  it("is empty when every alert predates lastSeenAt", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      alerts: [{ id: "1", ts: "2026-01-01T00:00:00Z", level: "warn", source: "s", project: "lex", message: "m" }],
      lastSeenAt: "2026-06-01T00:00:00Z",
    }));
    expect(unreadAlertCountsByProject().size).toBe(0);
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

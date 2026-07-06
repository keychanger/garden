import { describe, it, expect, vi, beforeEach } from "vitest";
import { captureConsoleLog } from "./helpers.js";
import type { Alert } from "../src/dashboard/alerts.js";

const h = vi.hoisted(() => ({
  isTTY: true,
  store: { alerts: [] as Alert[], lastSeenAt: undefined as string | undefined },
}));

vi.mock("../src/output.js", () => ({
  output: vi.fn(),
  get isTTY() { return h.isTTY; },
}));
vi.mock("../src/dashboard/alerts.js", () => ({
  readAlerts: () => h.store,
  clearAlerts: vi.fn(),
}));

import { alerts } from "../src/commands/alerts.js";
import { output } from "../src/output.js";
import { clearAlerts } from "../src/dashboard/alerts.js";

const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
function a(over: Partial<Alert>): Alert {
  return {
    id: "i", ts: new Date().toISOString(), level: "warn",
    source: "poller", project: "p", message: "m", ...over,
  };
}

beforeEach(() => {
  h.isTTY = true;
  h.store = { alerts: [], lastSeenAt: undefined };
  vi.clearAllMocks();
});

describe("garden alerts", () => {
  it("says so when there are no alerts", async () => {
    const lines = (await captureConsoleLog(() => alerts([]))).map(strip);
    expect(lines.join("\n")).toContain("No alerts.");
  });

  it("clears alerts on `clear`", async () => {
    const lines = (await captureConsoleLog(() => alerts(["clear"]))).map(strip);
    expect(clearAlerts).toHaveBeenCalled();
    expect(lines.join("\n")).toContain("Alerts cleared.");
  });

  it("splits unread from read by lastSeenAt", async () => {
    h.store = {
      lastSeenAt: "2026-01-01T12:00:00Z",
      alerts: [
        a({ message: "old-one", ts: "2026-01-01T11:00:00Z" }),   // read
        a({ message: "new-one", ts: "2026-01-01T13:00:00Z" }),   // unread
      ],
    };
    const text = (await captureConsoleLog(() => alerts([]))).map(strip).join("\n");
    expect(text).toMatch(/unread \(1\)/);
    expect(text).toMatch(/\bread \(1\)/); // \b so "unread (1)" doesn't satisfy the read-section check
    // both messages present
    expect(text).toContain("new-one");
    expect(text).toContain("old-one");
  });

  it("classifies an alert whose ts equals lastSeenAt as read (<= boundary)", async () => {
    h.store = {
      lastSeenAt: "2026-01-01T12:00:00Z",
      alerts: [
        a({ message: "boundary", ts: "2026-01-01T12:00:00Z" }), // == seen -> read
        a({ message: "later", ts: "2026-01-01T12:00:01Z" }),    // > seen  -> unread
      ],
    };
    const text = (await captureConsoleLog(() => alerts([]))).map(strip).join("\n");
    expect(text).toMatch(/unread \(1\)/);
    expect(text).toMatch(/\bread \(1\)/);
    // The read block prints after the unread block, so the boundary alert
    // (classified read) appears after the "read (1)" header.
    expect(text.indexOf("boundary")).toBeGreaterThan(text.search(/\bread \(1\)/));
  });

  it("treats every alert as unread when never acknowledged", async () => {
    h.store = { lastSeenAt: undefined, alerts: [a({ message: "x" }), a({ message: "y" })] };
    const text = (await captureConsoleLog(() => alerts([]))).map(strip).join("\n");
    expect(text).toMatch(/unread \(2\)/);
    expect(text).not.toMatch(/\bread \(/); // no read section (\b excludes the "unread" header)
  });

  it("uses honest level glyphs (✖ error, ⚠ warn)", async () => {
    h.store = { lastSeenAt: undefined, alerts: [
      a({ level: "error", message: "boom" }),
      a({ level: "warn", message: "hmm" }),
    ] };
    const raw = (await captureConsoleLog(() => alerts([]))).join("\n");
    expect(raw).toContain("✖");
    expect(raw).toContain("⚠");
    // error glyph is red, warn is yellow
    expect(raw).toMatch(/\x1b\[1;31m✖/);
    expect(raw).toMatch(/\x1b\[1;33m⚠/);
  });

  it("emits the full store as JSON when not a TTY", async () => {
    h.store = { lastSeenAt: "2026-01-01T12:00:00Z", alerts: [a({ message: "z" })] };
    h.isTTY = false;
    await alerts([]);
    expect(output).toHaveBeenCalledWith({
      alerts: h.store.alerts, lastSeenAt: "2026-01-01T12:00:00Z",
    });
  });
});

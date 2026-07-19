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

import { alerts, renderAlertsPane } from "../src/commands/alerts.js";
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
    // The read block prints before the unread block (chronological down the
    // screen), so the boundary alert (classified read) precedes the unread one.
    expect(text.indexOf("boundary")).toBeLessThan(text.indexOf("later"));
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

  it("keeps a multi-line message on a single row", async () => {
    h.store = { lastSeenAt: undefined, alerts: [
      a({ message: "ff-merge failed:\nAborting\nUpdating 9540d5a" }),
    ] };
    const lines = (await captureConsoleLog(() => alerts([]))).map(strip);
    const row = lines.find(l => l.includes("ff-merge failed"))!;
    expect(row).toContain("ff-merge failed: Aborting Updating 9540d5a");
    expect(row).not.toContain("\n");
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

// The ⌥a dashboard view. Rendered from the same store and split as the CLI, but
// laid out for the narrow lower-left pane and driven by an explicit seen-mark
// (the sticky pre-ack snapshot focusAlerts takes) rather than the live
// lastSeenAt.
describe("renderAlertsPane", () => {
  const NOW = Date.parse("2026-07-17T12:00:00Z");
  const at = (iso: string, over: Partial<Alert> = {}) => a({ ts: iso, ...over });

  it("says so when there are no alerts", () => {
    expect(strip(renderAlertsPane(60, null, NOW))).toContain("no alerts");
  });

  it("splits unread from read on the passed seen-mark, not the store's lastSeenAt", () => {
    // The store has been acked (lastSeenAt is NOW) but the caller passes the
    // pre-ack mark — the view must still show the newer alert as unread.
    h.store = {
      lastSeenAt: "2026-07-17T12:00:00Z",
      alerts: [
        at("2026-07-17T09:00:00Z", { message: "old one" }),
        at("2026-07-17T11:00:00Z", { message: "new one" }),
      ],
    };
    const out = strip(renderAlertsPane(60, "2026-07-17T10:00:00Z", NOW));
    // Leading space anchors the read header — "unread (1)" contains "read (1)".
    const readHeader = out.indexOf(" read (1)");
    const unreadHeader = out.indexOf("unread (1)");
    expect(readHeader).toBeGreaterThan(-1);
    expect(unreadHeader).toBeGreaterThan(readHeader);
    // Read (older) above unread (newer): time runs down the screen.
    expect(out.indexOf("old one")).toBeLessThan(unreadHeader);
    expect(out.indexOf("new one")).toBeGreaterThan(unreadHeader);
  });

  it("folds everything into read once the seen-mark catches up (the second ⌥a)", () => {
    h.store = {
      lastSeenAt: "2026-07-17T12:00:00Z",
      alerts: [at("2026-07-17T11:00:00Z", { message: "seen now" })],
    };
    const out = strip(renderAlertsPane(60, "2026-07-17T12:00:00Z", NOW));
    expect(out).toContain(" read (1)");
    expect(out).not.toContain("unread");
  });

  it("treats every alert as unread when never acknowledged", () => {
    h.store = { lastSeenAt: undefined, alerts: [at("2026-07-17T11:00:00Z")] };
    expect(strip(renderAlertsPane(60, null, NOW))).toContain("unread (1)");
  });

  it("lists oldest first within a section, so the newest is the last line", () => {
    h.store = {
      lastSeenAt: undefined,
      alerts: [
        at("2026-07-17T09:00:00Z", { message: "older" }),
        at("2026-07-17T11:00:00Z", { message: "newer" }),
      ],
    };
    const out = strip(renderAlertsPane(60, null, NOW));
    expect(out.indexOf("older")).toBeLessThan(out.indexOf("newer"));
  });

  it("heads each alert with its glyph, age and location, message wrapped under", () => {
    h.store = {
      lastSeenAt: undefined,
      alerts: [at("2026-07-17T11:00:00Z", {
        level: "error", project: "garden", worker: "bold-ash", message: "ci budget exhausted",
      })],
    };
    const lines = strip(renderAlertsPane(60, null, NOW)).split("\n");
    expect(lines[1]).toContain("✖");
    expect(lines[1]).toContain("1h");
    expect(lines[1]).toContain("garden/bold-ash");
    expect(lines[2]).toContain("ci budget exhausted");
  });

  it("omits the worker from the location when the alert is project-level", () => {
    h.store = {
      lastSeenAt: undefined,
      alerts: [at("2026-07-17T11:00:00Z", { project: "garden", worker: undefined })],
    };
    expect(strip(renderAlertsPane(60, null, NOW))).toContain("garden");
  });

  it("wraps a long message to the pane width instead of overflowing it", () => {
    h.store = {
      lastSeenAt: undefined,
      alerts: [at("2026-07-17T11:00:00Z", { message: "word ".repeat(40).trim() })],
    };
    const lines = strip(renderAlertsPane(40, null, NOW)).split("\n");
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(40);
  });

  // Alert messages carry raw git stderr and raw agent markdown. Their embedded
  // newlines used to render at column 0, escaping the gutter and visually
  // running one alert into the next.
  it("keeps a multi-line message inside the gutter", () => {
    h.store = {
      lastSeenAt: undefined,
      alerts: [at("2026-07-17T11:00:00Z", {
        message: "ff-merge failed:\npackage-lock.json\nAborting\nUpdating 9540d5a..65d6600",
      })],
    };
    const lines = strip(renderAlertsPane(78, null, NOW)).split("\n");
    // Line 0 is the section header, line 1 the alert header; the rest is body.
    for (const line of lines.slice(2)) {
      expect(line).toMatch(/^ {8}\S/); // indented into the message column
    }
    expect(lines.join("\n")).toContain("Aborting Updating");
  });

  it("strips markdown syntax out of an agent-authored message", () => {
    h.store = {
      lastSeenAt: undefined,
      alerts: [at("2026-07-17T11:00:00Z", {
        message: "Reviewer failed:\n\n## Review outcome\n\n**Step 1:** `git rebase` was clean.",
      })],
    };
    const out = strip(renderAlertsPane(78, null, NOW));
    expect(out).toContain("Review outcome Step 1: git rebase was clean.");
    expect(out).not.toMatch(/[#*`]/);
  });

  it("caps an overlong message so one alert cannot dominate the pane", () => {
    h.store = {
      lastSeenAt: undefined,
      alerts: [at("2026-07-17T11:00:00Z", { message: "word ".repeat(400).trim() })],
    };
    const lines = strip(renderAlertsPane(78, null, NOW)).split("\n");
    expect(lines.slice(2)).toHaveLength(3); // section header + alert header + 3 body lines
    expect(lines[lines.length - 1].endsWith("…")).toBe(true);
  });

  it("renders a read alert's message plainly, dimming only its gutter", () => {
    h.store = {
      lastSeenAt: "2026-07-17T12:00:00Z",
      alerts: [at("2026-07-17T11:00:00Z", { message: "the actual problem" })],
    };
    const lines = renderAlertsPane(78, "2026-07-17T12:00:00Z", NOW).split("\n");
    const body = lines[lines.length - 1];
    expect(body).toContain("the actual problem");
    expect(body).not.toMatch(/\x1b\[/); // no styling on the message itself
  });
});

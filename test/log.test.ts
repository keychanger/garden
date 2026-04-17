import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { useTmpHome } from "./helpers.js";

const env = useTmpHome();

async function importLog() {
  return await import("../src/dashboard/log.js");
}

describe("log", () => {
  it("writes JSON lines to log file", async () => {
    const { log } = await importLog();
    log.info("test", "hello world");
    const logFile = path.join(env.sessionsDir, "dashboard.log");
    const content = fs.readFileSync(logFile, "utf-8").trim();
    const entry = JSON.parse(content);
    expect(entry.level).toBe("info");
    expect(entry.src).toBe("test");
    expect(entry.msg).toBe("hello world");
    expect(entry.ts).toBeTruthy();
  });

  it("includes data when provided", async () => {
    const { log } = await importLog();
    log.info("test", "with data", { data: { key: "value" } });
    const logFile = path.join(env.sessionsDir, "dashboard.log");
    const entry = JSON.parse(fs.readFileSync(logFile, "utf-8").trim());
    expect(entry.data).toEqual({ key: "value" });
  });

  it("includes worker as top-level field when provided", async () => {
    const { log } = await importLog();
    log.info("test", "worker log", { worker: "bold-ash", data: { key: "val" } });
    const logFile = path.join(env.sessionsDir, "dashboard.log");
    const entry = JSON.parse(fs.readFileSync(logFile, "utf-8").trim());
    expect(entry.worker).toBe("bold-ash");
    expect(entry.data).toEqual({ key: "val" });
  });

  it("omits worker field when not provided", async () => {
    const { log } = await importLog();
    log.info("test", "no worker", { data: { x: 1 } });
    const logFile = path.join(env.sessionsDir, "dashboard.log");
    const entry = JSON.parse(fs.readFileSync(logFile, "utf-8").trim());
    expect(entry.worker).toBeUndefined();
  });

  it("respects log level filtering", async () => {
    process.env.GARDEN_LOG_LEVEL = "warn";
    try {
      const { log } = await importLog();
      log.debug("test", "should not appear");
      log.info("test", "should not appear");
      log.warn("test", "should appear");
      const logFile = path.join(env.sessionsDir, "dashboard.log");
      const lines = fs.readFileSync(logFile, "utf-8").trim().split("\n").filter(Boolean);
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]).level).toBe("warn");
    } finally {
      delete process.env.GARDEN_LOG_LEVEL;
    }
  });

  it("appends multiple entries", async () => {
    const { log } = await importLog();
    log.info("a", "first");
    log.info("b", "second");
    const logFile = path.join(env.sessionsDir, "dashboard.log");
    const lines = fs.readFileSync(logFile, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
  });
});

describe("log.transition", () => {
  it("writes at info level when from !== to", async () => {
    const { log } = await importLog();
    log.transition("poller", "prState", "new", "reviewing", { worker: "bold-ash" });
    const logFile = path.join(env.sessionsDir, "dashboard.log");
    const entry = JSON.parse(fs.readFileSync(logFile, "utf-8").trim());
    expect(entry.level).toBe("info");
    expect(entry.msg).toBe("prState");
    expect(entry.worker).toBe("bold-ash");
    expect(entry.data).toMatchObject({ from: "new", to: "reviewing" });
  });

  it("writes at debug level when from === to (heartbeat, suppressed by default)", async () => {
    const { log } = await importLog();
    log.transition("poller", "prState", "working", "working");
    const logFile = path.join(env.sessionsDir, "dashboard.log");
    // Default level is info, so the debug line is filtered out entirely.
    expect(fs.existsSync(logFile)).toBe(false);
  });

  it("merges extra data with from/to payload", async () => {
    const { log } = await importLog();
    log.transition("hook", "claudeStatus", "idle", "working", { data: { event: "prompt" } });
    const logFile = path.join(env.sessionsDir, "dashboard.log");
    const entry = JSON.parse(fs.readFileSync(logFile, "utf-8").trim());
    expect(entry.data).toEqual({ from: "idle", to: "working", event: "prompt" });
  });
});

describe("truncateLog", () => {
  it("clears log when over size limit", async () => {
    const { truncateLog } = await importLog();
    const logFile = path.join(env.sessionsDir, "dashboard.log");
    // Write > 512KB
    fs.writeFileSync(logFile, "x".repeat(600 * 1024));
    truncateLog();
    const stat = fs.statSync(logFile);
    expect(stat.size).toBe(0);
  });

  it("does nothing when log is under size limit", async () => {
    const { truncateLog } = await importLog();
    const logFile = path.join(env.sessionsDir, "dashboard.log");
    fs.writeFileSync(logFile, "small content");
    truncateLog();
    expect(fs.readFileSync(logFile, "utf-8")).toBe("small content");
  });
});

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

describe("truncateLog", () => {
  it("trims to a recent tail when over size limit, snapping to a newline", async () => {
    const { truncateLog } = await importLog();
    const logFile = path.join(env.sessionsDir, "dashboard.log");
    // Build > 10MB of newline-delimited entries. Each line is identifiable so
    // we can confirm the head was dropped and the tail kept intact.
    const line = "x".repeat(1023) + "\n"; // 1KB per line
    const lines = 11 * 1024; // 11MB
    fs.writeFileSync(logFile, line.repeat(lines));
    const beforeSize = fs.statSync(logFile).size;
    truncateLog();
    const after = fs.readFileSync(logFile, "utf-8");
    const afterSize = Buffer.byteLength(after);

    // Smaller than before, but a substantial recent tail kept (not zeroed).
    expect(afterSize).toBeLessThan(beforeSize);
    expect(afterSize).toBeGreaterThan(4 * 1024 * 1024);
    expect(afterSize).toBeLessThanOrEqual(9 * 1024 * 1024);
    // No partial line at the head — every retained line is a complete entry.
    expect(after.startsWith("x".repeat(1023) + "\n")).toBe(true);
    expect(after.endsWith("\n")).toBe(true);
  });

  it("does nothing when log is under size limit", async () => {
    const { truncateLog } = await importLog();
    const logFile = path.join(env.sessionsDir, "dashboard.log");
    fs.writeFileSync(logFile, "small content");
    truncateLog();
    expect(fs.readFileSync(logFile, "utf-8")).toBe("small content");
  });
});

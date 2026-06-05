import { describe, it, expect } from "vitest";
import {
  usagePollerWindowName,
  watchdogWindowName,
  workerWindowName,
  shellWindowName,
  parkingWindowName,
  pollerWindowName,
  reviewWindowName,
  gardenWindowName,
  workerWindowPrefix,
  parseWorkerWindow,
  parseWorkerSuffix,
  isGardenWindow,
  isWorkerWindow,
} from "../src/dashboard/window-names.js";

describe("window name construction", () => {
  it("workerWindowName", () => {
    expect(workerWindowName("garden", "bold-keen-ash")).toBe("_garden-worker-bold-keen-ash");
  });

  it("shellWindowName", () => {
    expect(shellWindowName("garden")).toBe("_garden-shell");
  });

  it("parkingWindowName", () => {
    expect(parkingWindowName("garden")).toBe("_garden-active");
  });

  it("pollerWindowName", () => {
    expect(pollerWindowName("garden")).toBe("_garden-poller");
  });

  it("reviewWindowName", () => {
    expect(reviewWindowName("garden", "bold-keen-ash")).toBe("_garden-review-bold-keen-ash");
  });

  it("gardenWindowName", () => {
    expect(gardenWindowName("growhouse")).toBe("_garden-growhouse");
    expect(gardenWindowName("root")).toBe("_garden-root");
    expect(gardenWindowName("logs")).toBe("_garden-logs");
    expect(gardenWindowName("history")).toBe("_garden-history");
    expect(gardenWindowName("pad")).toBe("_garden-pad");
  });

  it("usagePollerWindowName", () => {
    expect(usagePollerWindowName()).toBe("_garden-usage-poller");
  });

  it("watchdogWindowName", () => {
    expect(watchdogWindowName()).toBe("_garden-watchdog");
  });

  it("workerWindowPrefix", () => {
    expect(workerWindowPrefix("garden")).toBe("_garden-worker-");
  });
});

describe("parseWorkerWindow", () => {
  it("parses valid worker window name", () => {
    expect(parseWorkerWindow("_garden-worker-bold-keen-ash")).toEqual({
      project: "garden",
      worker: "bold-keen-ash",
    });
  });

  it("returns null for non-worker windows", () => {
    expect(parseWorkerWindow("_garden-shell")).toBeNull();
    expect(parseWorkerWindow("_garden-poller")).toBeNull();
    expect(parseWorkerWindow("main")).toBeNull();
    expect(parseWorkerWindow("")).toBeNull();
  });

  it("handles hyphenated project names", () => {
    const result = parseWorkerWindow("_my-app-worker-bold-keen-ash");
    expect(result).toEqual({ project: "my-app", worker: "bold-keen-ash" });
  });
});

describe("parseWorkerSuffix", () => {
  it("extracts worker name from window name", () => {
    expect(parseWorkerSuffix("_garden-worker-bold-keen-ash")).toBe("bold-keen-ash");
  });

  it("returns null for non-worker windows", () => {
    expect(parseWorkerSuffix("_garden-shell")).toBeNull();
    expect(parseWorkerSuffix("")).toBeNull();
  });
});

describe("roundtrip", () => {
  it("parseWorkerWindow inverts workerWindowName", () => {
    const result = parseWorkerWindow(workerWindowName("proj", "w1"));
    expect(result).toEqual({ project: "proj", worker: "w1" });
  });

  it("parseWorkerSuffix extracts worker from workerWindowName", () => {
    expect(parseWorkerSuffix(workerWindowName("proj", "w1"))).toBe("w1");
  });
});

describe("isGardenWindow", () => {
  it("returns true for growhouse/root/logs/history/pad windows", () => {
    expect(isGardenWindow("_garden-growhouse")).toBe(true);
    expect(isGardenWindow("_garden-root")).toBe(true);
    expect(isGardenWindow("_garden-logs")).toBe(true);
    expect(isGardenWindow("_garden-history")).toBe(true);
    expect(isGardenWindow("_garden-pad")).toBe(true);
  });

  it("returns false for non-garden windows", () => {
    expect(isGardenWindow("_garden-worker-x")).toBe(false);
    expect(isGardenWindow("_garden-shell")).toBe(false);
    expect(isGardenWindow("_proj-poller")).toBe(false);
    expect(isGardenWindow("main")).toBe(false);
  });
});

describe("isWorkerWindow", () => {
  it("returns true for worker windows", () => {
    expect(isWorkerWindow("_garden-worker-bold-keen-ash")).toBe(true);
    expect(isWorkerWindow("_my-app-worker-x")).toBe(true);
  });

  it("returns false for non-worker windows", () => {
    expect(isWorkerWindow("_garden-shell")).toBe(false);
    expect(isWorkerWindow("_garden-poller")).toBe(false);
    expect(isWorkerWindow("_garden-review-x")).toBe(false);
    expect(isWorkerWindow("main")).toBe(false);
  });
});

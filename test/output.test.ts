import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { captureConsoleLog } from "./helpers.js";

let origIsTTY: boolean | undefined;
let origGardenPretty: string | undefined;

beforeEach(() => {
  vi.resetModules();
  origIsTTY = process.stdout.isTTY;
  origGardenPretty = process.env.GARDEN_PRETTY;
});

afterEach(() => {
  process.stdout.isTTY = origIsTTY as boolean;
  if (origGardenPretty === undefined) delete process.env.GARDEN_PRETTY;
  else process.env.GARDEN_PRETTY = origGardenPretty;
});

describe("isTTY detection", () => {
  it("is false when stdout is not a TTY and GARDEN_PRETTY is unset", async () => {
    process.stdout.isTTY = undefined as unknown as boolean;
    delete process.env.GARDEN_PRETTY;
    const { isTTY } = await import("../src/output.js");
    expect(isTTY).toBe(false);
  });

  it("is true when GARDEN_PRETTY=1 even if stdout is not a TTY", async () => {
    process.stdout.isTTY = undefined as unknown as boolean;
    process.env.GARDEN_PRETTY = "1";
    const { isTTY } = await import("../src/output.js");
    expect(isTTY).toBe(true);
  });
});

describe("output()", () => {
  it("prints JSON when not TTY", async () => {
    process.stdout.isTTY = undefined as unknown as boolean;
    delete process.env.GARDEN_PRETTY;
    const { output } = await import("../src/output.js");

    const lines = await captureConsoleLog(() => {
      output({ key: "val" }, () => "pretty");
    });
    expect(lines[0]).toBe(JSON.stringify({ key: "val" }));
  });

  it("prints pretty output when TTY and formatter provided", async () => {
    process.env.GARDEN_PRETTY = "1";
    const { output } = await import("../src/output.js");

    const lines = await captureConsoleLog(() => {
      output({ key: "val" }, (d) => `pretty:${JSON.stringify(d)}`);
    });
    expect(lines[0]).toBe('pretty:{"key":"val"}');
  });

  it("prints JSON when TTY but no formatter", async () => {
    process.env.GARDEN_PRETTY = "1";
    const { output } = await import("../src/output.js");

    const lines = await captureConsoleLog(() => {
      output({ key: "val" });
    });
    expect(lines[0]).toBe(JSON.stringify({ key: "val" }));
  });
});

describe("outputLines()", () => {
  it("prints one JSON line per item when not TTY", async () => {
    process.stdout.isTTY = undefined as unknown as boolean;
    delete process.env.GARDEN_PRETTY;
    const { outputLines } = await import("../src/output.js");

    const lines = await captureConsoleLog(() => {
      outputLines([1, 2, 3]);
    });
    expect(lines).toEqual(["1", "2", "3"]);
  });

  it("prints formatted lines when TTY", async () => {
    process.env.GARDEN_PRETTY = "1";
    const { outputLines } = await import("../src/output.js");

    const lines = await captureConsoleLog(() => {
      outputLines(["a", "b"], (x) => `item:${x}`);
    });
    expect(lines).toEqual(["item:a", "item:b"]);
  });
});

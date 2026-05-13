// `garden reply` stages a freeform note on the calling worker's registry
// entry so the next handoff-callback dispatch can fold it into the prompt
// it sends to the parent pane.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { useTmpHome, captureConsoleLog } from "./helpers.js";

useTmpHome();

const origProject = process.env.GARDEN_PROJECT;
const origWorker = process.env.GARDEN_WORKER;

beforeEach(() => {
  process.env.GARDEN_PROJECT = "wolf";
  process.env.GARDEN_WORKER = "bold-ash";
});

afterEach(() => {
  process.env.GARDEN_PROJECT = origProject;
  process.env.GARDEN_WORKER = origWorker;
});

async function seedSelf(opts: {
  expectCallback?: boolean;
  parentProject?: string;
  parentWorker?: string;
  existingNote?: string;
} = {}): Promise<void> {
  const { addWorker } = await import("../src/dashboard/registry.js");
  addWorker("wolf", {
    name: "bold-ash",
    sessionId: "s",
    task: "",
    handoffCallbackExpected: opts.expectCallback,
    parentProject: opts.parentProject,
    parentWorker: opts.parentWorker,
    handoffReplyNote: opts.existingNote,
  });
}

describe("garden reply", () => {
  it("stages a note on the worker's own entry when called with -m", async () => {
    await seedSelf({
      expectCallback: true,
      parentProject: "fox",
      parentWorker: "calm-bay",
    });
    const { reply } = await import("../src/commands/reply.js");
    const { findWorkerByName } = await import("../src/dashboard/registry.js");

    await captureConsoleLog(() => reply(["-m", "all green, root cause filed"]));

    const after = findWorkerByName("wolf", "bold-ash");
    expect(after?.handoffReplyNote).toBe("all green, root cause filed");
  });

  it("appends to an existing note (multiple staged notes accumulate)", async () => {
    await seedSelf({
      expectCallback: true,
      parentProject: "fox",
      parentWorker: "calm-bay",
      existingNote: "first thought",
    });
    const { reply } = await import("../src/commands/reply.js");
    const { findWorkerByName } = await import("../src/dashboard/registry.js");

    await captureConsoleLog(() => reply(["-m", "second thought"]));

    const after = findWorkerByName("wolf", "bold-ash");
    expect(after?.handoffReplyNote).toBe("first thought\n\nsecond thought");
  });

  it("replaces the buffer when --replace is passed", async () => {
    await seedSelf({
      expectCallback: true,
      parentProject: "fox",
      parentWorker: "calm-bay",
      existingNote: "stale earlier draft",
    });
    const { reply } = await import("../src/commands/reply.js");
    const { findWorkerByName } = await import("../src/dashboard/registry.js");

    await captureConsoleLog(() => reply(["--replace", "-m", "fresh take"]));

    const after = findWorkerByName("wolf", "bold-ash");
    expect(after?.handoffReplyNote).toBe("fresh take");
  });

  it("refuses when GARDEN_PROJECT / GARDEN_WORKER are not set", async () => {
    delete process.env.GARDEN_PROJECT;
    delete process.env.GARDEN_WORKER;
    const { reply } = await import("../src/commands/reply.js");
    await expect(reply(["-m", "hi"])).rejects.toThrow(/inside a worker pane/);
  });

  it("refuses when the worker has no parent expecting a callback", async () => {
    // Worker exists but wasn't spawned with --expect-callback.
    await seedSelf({ parentProject: "fox", parentWorker: "calm-bay" });
    const { reply } = await import("../src/commands/reply.js");
    await expect(reply(["-m", "hi"])).rejects.toThrow(/no parent expecting a callback/);
  });

  it("refuses an empty body", async () => {
    await seedSelf({
      expectCallback: true,
      parentProject: "fox",
      parentWorker: "calm-bay",
    });
    const { reply } = await import("../src/commands/reply.js");
    await expect(reply(["-m", "   "])).rejects.toThrow(/Empty reply/);
  });
});

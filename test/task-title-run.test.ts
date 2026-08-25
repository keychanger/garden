import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { useTmpHome } from "./helpers.js";

const env = useTmpHome();

const PROJECT = "garden";
const WORKER = "lean-stout-quartz";
const OPENING = "Fix the Erica composer.\nMake the input grow with its content.";

function writeRollout(opening: string = OPENING): string {
  const transcript = path.join(env.home, `rollout-session-id.jsonl`);
  fs.writeFileSync(transcript, JSON.stringify({
    timestamp: "2026-08-25T12:00:00.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: opening }],
    },
  }) + "\n");
  return transcript;
}

async function addCandidate(task: string, transcriptPath?: string): Promise<void> {
  const { addWorker } = await import("../src/dashboard/registry.js");
  addWorker(PROJECT, {
    name: WORKER,
    sessionId: "session-id",
    harness: "codex",
    task,
    transcriptPath,
  });
}

describe("runWorkerTitle", () => {
  it("claims and applies one title from the landed opening prompt", async () => {
    const transcript = writeRollout();
    await addCandidate("Fix the Erica composer.", transcript);
    const { runWorkerTitle } = await import("../src/dashboard/task-title.js");
    const { getWorkers } = await import("../src/dashboard/registry.js");
    const generateTitle = vi.fn(() => "Erica composer autosize");

    runWorkerTitle(PROJECT, WORKER, { generateTitle, now: () => 123 });

    expect(generateTitle).toHaveBeenCalledWith(OPENING, expect.any(Object));
    expect(getWorkers(PROJECT)[0]).toMatchObject({
      task: "Erica composer autosize",
      titleGeneratedAt: 123,
    });
  });

  it("waits without claiming while the opening prompt has not landed", async () => {
    await addCandidate("Fix the Erica composer.");
    const { runWorkerTitle } = await import("../src/dashboard/task-title.js");
    const { getWorkers } = await import("../src/dashboard/registry.js");
    const generateTitle = vi.fn(() => "Erica composer autosize");

    runWorkerTitle(PROJECT, WORKER, { generateTitle, now: () => 123 });

    expect(generateTitle).not.toHaveBeenCalled();
    expect(getWorkers(PROJECT)[0].titleGeneratedAt).toBeUndefined();
  });

  it("does not replace live activity that already superseded the prompt fallback", async () => {
    const transcript = writeRollout();
    await addCandidate("Implement the current plan step", transcript);
    const { runWorkerTitle } = await import("../src/dashboard/task-title.js");
    const { getWorkers } = await import("../src/dashboard/registry.js");
    const generateTitle = vi.fn(() => "Erica composer autosize");

    runWorkerTitle(PROJECT, WORKER, { generateTitle, now: () => 123 });

    expect(generateTitle).not.toHaveBeenCalled();
    expect(getWorkers(PROJECT)[0]).toMatchObject({ task: "Implement the current plan step" });
    expect(getWorkers(PROJECT)[0].titleGeneratedAt).toBeUndefined();
  });

  it("keeps activity that changes while title generation is running", async () => {
    const transcript = writeRollout();
    await addCandidate("Fix the Erica composer.", transcript);
    const { runWorkerTitle } = await import("../src/dashboard/task-title.js");
    const { getWorkers, updateWorkerFields } = await import("../src/dashboard/registry.js");
    const generateTitle = vi.fn(() => {
      updateWorkerFields(PROJECT, WORKER, { task: "Run the integration suite" });
      return "Erica composer autosize";
    });

    runWorkerTitle(PROJECT, WORKER, { generateTitle, now: () => 123 });

    expect(getWorkers(PROJECT)[0]).toMatchObject({
      task: "Run the integration suite",
      titleGeneratedAt: 123,
    });
  });

  it("records a failed attempt once and does not retry it", async () => {
    const transcript = writeRollout();
    await addCandidate("Fix the Erica composer.", transcript);
    const { runWorkerTitle } = await import("../src/dashboard/task-title.js");
    const { getWorkers } = await import("../src/dashboard/registry.js");
    const generateTitle = vi.fn(() => null);

    runWorkerTitle(PROJECT, WORKER, { generateTitle, now: () => 123 });
    runWorkerTitle(PROJECT, WORKER, { generateTitle, now: () => 456 });

    expect(generateTitle).toHaveBeenCalledTimes(1);
    expect(getWorkers(PROJECT)[0]).toMatchObject({
      task: "Fix the Erica composer.",
      titleGeneratedAt: 123,
    });
  });
});

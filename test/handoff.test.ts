import { describe, it, expect, vi, beforeEach } from "vitest";
import { captureConsoleLog } from "./helpers.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("../src/config.js", () => ({
  tryGetProject: vi.fn(),
  loadConfig: vi.fn(),
  SESSIONS_DIR: "",
}));

vi.mock("../src/dashboard/handoff-dispatch.js", () => ({
  submitHandoffRequest: vi.fn(),
  waitForHandoffResponse: vi.fn(),
  withdrawPendingHandoffRequest: vi.fn(() => true),
}));

vi.mock("../src/dashboard/poller-fifo.js", () => ({
  triggerProjectPoll: vi.fn(),
}));

vi.mock("../src/dashboard/registry.js", () => ({
  findWorkerByName: vi.fn(),
}));

import { handoff } from "../src/commands/handoff.js";
import { tryGetProject, loadConfig } from "../src/config.js";
import {
  submitHandoffRequest, waitForHandoffResponse, withdrawPendingHandoffRequest,
} from "../src/dashboard/handoff-dispatch.js";
import { triggerProjectPoll } from "../src/dashboard/poller-fifo.js";
import { findWorkerByName } from "../src/dashboard/registry.js";

const cfg = await import("../src/config.js") as unknown as { SESSIONS_DIR: string };

let tmpDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-handoff-test-"));
  cfg.SESSIONS_DIR = tmpDir;
  vi.mocked(tryGetProject).mockReturnValue({ name: "other", path: "/repo/other" });
  vi.mocked(loadConfig).mockReturnValue({
    projects: { other: { name: "other", path: "/repo/other" } },
  } as ReturnType<typeof loadConfig>);
  vi.mocked(submitHandoffRequest).mockReturnValue("req-id-1");
  vi.mocked(waitForHandoffResponse).mockResolvedValue({
    workerName: "bold-ash",
    completedAt: Date.now(),
  });
  vi.mocked(withdrawPendingHandoffRequest).mockReturnValue(true);
  delete process.env.GARDEN_PROJECT;
  delete process.env.GARDEN_WORKER;
});

describe("garden handoff command", () => {
  it("rejects missing target project", async () => {
    await expect(handoff([])).rejects.toThrow(/Usage: garden handoff/);
  });

  it("rejects flag-shaped first arg as a missing project name", async () => {
    await expect(handoff(["-m", "msg"])).rejects.toThrow(/Usage: garden handoff/);
  });

  it("rejects unknown target project with a remediation hint", async () => {
    vi.mocked(tryGetProject).mockReturnValue(undefined);
    await expect(handoff(["ghost", "-m", "x"])).rejects.toThrow(/Unknown project 'ghost'/);
    expect(vi.mocked(submitHandoffRequest)).not.toHaveBeenCalled();
  });

  it("rejects -m without a value", async () => {
    await expect(handoff(["other", "-m"])).rejects.toThrow(/-m requires a message argument/);
  });

  it("rejects empty briefing from -m", async () => {
    await expect(handoff(["other", "-m", "   "])).rejects.toThrow(/Empty briefing/);
  });

  it("writes the seed file under SESSIONS_DIR/seeds and passes its path in the handoff request", async () => {
    await captureConsoleLog(() => handoff(["other", "-m", "Take this over"]));
    const seedsDir = path.join(tmpDir, "seeds");
    expect(fs.existsSync(seedsDir)).toBe(true);
    const files = fs.readdirSync(seedsDir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^seed-\d+-[a-z0-9]+\.txt$/);

    const reqCall = vi.mocked(submitHandoffRequest).mock.calls[0][0];
    expect(reqCall).toEqual({
      targetProject: "other",
      seedFile: path.join(seedsDir, files[0]),
      expectCallback: false,
      parentProject: undefined,
      parentWorker: undefined,
      ultracode: false,
    });
  });

  it("pokes the target project poller so an idle poller picks the request up", async () => {
    await captureConsoleLog(() => handoff(["other", "-m", "msg"]));
    expect(vi.mocked(triggerProjectPoll)).toHaveBeenCalledWith("other");
  });

  it("also pokes the source project poller when the caller is a worker", async () => {
    process.env.GARDEN_PROJECT = "src";
    process.env.GARDEN_WORKER = "blue-pine";
    vi.mocked(loadConfig).mockReturnValue({
      projects: {
        other: { name: "other", path: "/repo/other" },
        src: { name: "src", path: "/repo/src" },
      },
    } as ReturnType<typeof loadConfig>);
    await captureConsoleLog(() => handoff(["other", "-m", "msg"]));
    const pokes = vi.mocked(triggerProjectPoll).mock.calls.map(c => c[0]);
    expect(pokes).toContain("src");
    expect(pokes).toContain("other");
  });

  it("prefixes the seed with [handoff from <project>/<worker>] when env vars are set", async () => {
    process.env.GARDEN_PROJECT = "src";
    process.env.GARDEN_WORKER = "blue-pine";
    await captureConsoleLog(() => handoff(["other", "-m", "do the thing"]));
    const seedsDir = path.join(tmpDir, "seeds");
    const seedFile = path.join(seedsDir, fs.readdirSync(seedsDir)[0]);
    const body = fs.readFileSync(seedFile, "utf8");
    expect(body).toMatch(/^\[handoff from src\/blue-pine\]/);
    expect(body).toContain("do the thing");
  });

  it("falls back to the bare [handoff] prefix when env vars are missing", async () => {
    await captureConsoleLog(() => handoff(["other", "-m", "do the thing"]));
    const seedsDir = path.join(tmpDir, "seeds");
    const body = fs.readFileSync(path.join(seedsDir, fs.readdirSync(seedsDir)[0]), "utf8");
    expect(body).toMatch(/^\[handoff\]/);
  });

  it("unlinks the seed file and reports timeout when the dispatcher never answers", async () => {
    vi.mocked(waitForHandoffResponse).mockResolvedValue(null);
    await expect(handoff(["other", "-m", "msg"])).rejects.toThrow(/timed out/);
    const seedsDir = path.join(tmpDir, "seeds");
    expect(fs.readdirSync(seedsDir)).toEqual([]);
  });

  it("preserves the seed when a claimed request times out so recovery can finish", async () => {
    vi.mocked(waitForHandoffResponse).mockResolvedValue(null);
    vi.mocked(withdrawPendingHandoffRequest).mockReturnValue(false);
    await expect(handoff(["other", "-m", "msg"])).rejects.toThrow(/may still recover/);
    const seedsDir = path.join(tmpDir, "seeds");
    expect(fs.readdirSync(seedsDir)).toHaveLength(1);
  });

  it("unlinks the seed file and surfaces the dispatcher's error when newWorker rejects", async () => {
    vi.mocked(waitForHandoffResponse).mockResolvedValue({
      error: "Base branch 'main' has no local origin/main ref.",
      completedAt: Date.now(),
    });
    await expect(handoff(["other", "-m", "msg"]))
      .rejects.toThrow(/Base branch 'main'/);
    const seedsDir = path.join(tmpDir, "seeds");
    expect(fs.readdirSync(seedsDir)).toEqual([]);
  });

  it("prints the new worker name on success so the operator knows where it landed", async () => {
    const lines = await captureConsoleLog(() => handoff(["other", "-m", "msg"]));
    expect(lines.join("\n")).toContain("other/bold-ash");
  });

  it("allows longer worker creation only after the request is claimed", async () => {
    await captureConsoleLog(() => handoff(["other", "-m", "msg"]));
    expect(vi.mocked(waitForHandoffResponse)).toHaveBeenCalledWith(
      "req-id-1",
      15_000,
      75_000,
    );
  });

  it("passes expectCallback + parent env to the dispatch when --expect-callback is set", async () => {
    process.env.GARDEN_PROJECT = "src";
    process.env.GARDEN_WORKER = "blue-pine";
    await captureConsoleLog(() => handoff(["other", "--expect-callback", "-m", "see you on the other side"]));
    const call = vi.mocked(submitHandoffRequest).mock.calls[0][0];
    expect(call.expectCallback).toBe(true);
    expect(call.parentProject).toBe("src");
    expect(call.parentWorker).toBe("blue-pine");
  });

  it("rejects --expect-callback when invoked outside a worker pane (nothing to call back to)", async () => {
    await expect(handoff(["other", "--expect-callback", "-m", "hi"]))
      .rejects.toThrow(/inside a garden worker pane/);
  });

  it("notes the callback in the success line so the operator knows what to expect", async () => {
    process.env.GARDEN_PROJECT = "src";
    process.env.GARDEN_WORKER = "blue-pine";
    const lines = await captureConsoleLog(() => handoff(["other", "--expect-callback", "-m", "msg"]));
    expect(lines.join("\n")).toMatch(/callback requested/);
  });

  it("accepts --expect-callback after -m (flag-order tolerant)", async () => {
    process.env.GARDEN_PROJECT = "src";
    process.env.GARDEN_WORKER = "blue-pine";
    await captureConsoleLog(() => handoff(["other", "-m", "msg", "--expect-callback"]));
    const call = vi.mocked(submitHandoffRequest).mock.calls[0][0];
    expect(call.expectCallback).toBe(true);
  });

  it("passes ultracode:true to the dispatch when --ultracode is set", async () => {
    await captureConsoleLog(() => handoff(["other", "--ultracode", "-m", "make it strong"]));
    const call = vi.mocked(submitHandoffRequest).mock.calls[0][0];
    expect(call.ultracode).toBe(true);
  });

  it("does not treat --ultracode as part of the briefing (strips it before reading -m)", async () => {
    await captureConsoleLog(() => handoff(["other", "--ultracode", "-m", "the real briefing"]));
    const seedsDir = path.join(tmpDir, "seeds");
    const body = fs.readFileSync(path.join(seedsDir, fs.readdirSync(seedsDir)[0]), "utf8");
    expect(body).toContain("the real briefing");
    expect(body).not.toContain("--ultracode");
  });

  it("notes ultracode mode in the success line", async () => {
    const lines = await captureConsoleLog(() => handoff(["other", "--ultracode", "-m", "msg"]));
    expect(lines.join("\n")).toMatch(/ultracode mode/);
  });

  it("composes --ultracode with --expect-callback in the success line and dispatch", async () => {
    process.env.GARDEN_PROJECT = "src";
    process.env.GARDEN_WORKER = "blue-pine";
    const lines = await captureConsoleLog(
      () => handoff(["other", "--ultracode", "--expect-callback", "-m", "msg"]),
    );
    const call = vi.mocked(submitHandoffRequest).mock.calls[0][0];
    expect(call.ultracode).toBe(true);
    expect(call.expectCallback).toBe(true);
    expect(lines.join("\n")).toMatch(/ultracode mode; callback requested/);
  });

  it("threads --crew <name> into the dispatch request and notes it in the success line", async () => {
    const lines = await captureConsoleLog(() => handoff(["other", "--crew", "codex-claude", "-m", "build it"]));
    const call = vi.mocked(submitHandoffRequest).mock.calls[0][0];
    expect(call.crew).toBe("codex-claude");
    expect(lines.join("\n")).toMatch(/crew codex-claude/);
    expect(lines.join("\n")).not.toMatch(/inherited/);
  });

  it("does not treat --crew or its value as part of the briefing", async () => {
    await captureConsoleLog(() => handoff(["other", "--crew", "all-codex", "-m", "the real briefing"]));
    const seedsDir = path.join(tmpDir, "seeds");
    const body = fs.readFileSync(path.join(seedsDir, fs.readdirSync(seedsDir)[0]), "utf8");
    expect(body).toContain("the real briefing");
    expect(body).not.toContain("all-codex");
  });

  it("rejects --crew without a value, and an unknown crew, before dispatching", async () => {
    await expect(handoff(["other", "--crew"])).rejects.toThrow(/--crew requires a crew name/);
    await expect(handoff(["other", "--crew", "-m", "msg"])).rejects.toThrow(/--crew requires a crew name/);
    await expect(handoff(["other", "--crew", "no-such-crew", "-m", "msg"])).rejects.toThrow(/Unknown crew 'no-such-crew'.*all-claude/);
    expect(vi.mocked(submitHandoffRequest)).not.toHaveBeenCalled();
  });

  it("inherits the calling worker's own crew when --crew is not passed", async () => {
    // A designer's design seat came from its crew; its builder lands on the
    // same crew's build + review halves with nothing in the brief to say so.
    process.env.GARDEN_PROJECT = "src";
    process.env.GARDEN_WORKER = "blue-pine";
    vi.mocked(findWorkerByName).mockReturnValue({ name: "blue-pine", crew: "codex-claude" } as ReturnType<typeof findWorkerByName>);
    const lines = await captureConsoleLog(() => handoff(["other", "-m", "msg"]));
    expect(vi.mocked(findWorkerByName)).toHaveBeenCalledWith("src", "blue-pine");
    const call = vi.mocked(submitHandoffRequest).mock.calls[0][0];
    expect(call.crew).toBe("codex-claude");
    expect(lines.join("\n")).toMatch(/crew codex-claude \(inherited\)/);
  });

  it("an explicit --crew outranks the inherited one", async () => {
    process.env.GARDEN_PROJECT = "src";
    process.env.GARDEN_WORKER = "blue-pine";
    vi.mocked(findWorkerByName).mockReturnValue({ name: "blue-pine", crew: "codex-claude" } as ReturnType<typeof findWorkerByName>);
    await captureConsoleLog(() => handoff(["other", "--crew", "all-claude", "-m", "msg"]));
    expect(vi.mocked(submitHandoffRequest).mock.calls[0][0].crew).toBe("all-claude");
  });

  it("forwards no crew when the calling worker carries none, or when run outside a worker pane", async () => {
    process.env.GARDEN_PROJECT = "src";
    process.env.GARDEN_WORKER = "blue-pine";
    vi.mocked(findWorkerByName).mockReturnValue({ name: "blue-pine" } as ReturnType<typeof findWorkerByName>);
    await captureConsoleLog(() => handoff(["other", "-m", "msg"]));
    expect(vi.mocked(submitHandoffRequest).mock.calls[0][0].crew).toBeUndefined();

    delete process.env.GARDEN_PROJECT;
    delete process.env.GARDEN_WORKER;
    vi.mocked(findWorkerByName).mockClear();
    await captureConsoleLog(() => handoff(["other", "-m", "msg"]));
    expect(vi.mocked(findWorkerByName)).not.toHaveBeenCalled();
    expect(vi.mocked(submitHandoffRequest).mock.calls[1][0].crew).toBeUndefined();
  });

  it("threads --bead <id> into the dispatch request", async () => {
    await captureConsoleLog(() => handoff(["other", "--bead", "bd-7", "-m", "build bead 7"]));
    const call = vi.mocked(submitHandoffRequest).mock.calls[0][0];
    expect(call.bead).toBe("bd-7");
  });

  it("rejects --bead without a value", async () => {
    await expect(handoff(["other", "--bead"])).rejects.toThrow(/--bead requires a bead id/);
    expect(vi.mocked(submitHandoffRequest)).not.toHaveBeenCalled();
  });

  it("rejects --bead immediately followed by another flag (no id swallowing)", async () => {
    await expect(handoff(["other", "--bead", "-m", "msg"])).rejects.toThrow(/--bead requires a bead id/);
    expect(vi.mocked(submitHandoffRequest)).not.toHaveBeenCalled();
  });

  it("rejects a bead id that exceeds the dispatch request bound", async () => {
    await expect(handoff(["other", "--bead", "b".repeat(129), "-m", "msg"]))
      .rejects.toThrow(/128 characters or fewer/);
    expect(vi.mocked(submitHandoffRequest)).not.toHaveBeenCalled();
  });

  it("does not treat --bead or its value as part of the briefing", async () => {
    await captureConsoleLog(() => handoff(["other", "--bead", "bd-7", "-m", "the real briefing"]));
    const seedsDir = path.join(tmpDir, "seeds");
    const body = fs.readFileSync(path.join(seedsDir, fs.readdirSync(seedsDir)[0]), "utf8");
    expect(body).toContain("the real briefing");
    expect(body).not.toContain("--bead");
    expect(body).not.toContain("bd-7");
  });

  it("leaves bead undefined on the dispatch when --bead is not passed", async () => {
    await captureConsoleLog(() => handoff(["other", "-m", "msg"]));
    const call = vi.mocked(submitHandoffRequest).mock.calls[0][0];
    expect(call.bead).toBeUndefined();
  });

  it("notes the bead in the success line", async () => {
    const lines = await captureConsoleLog(() => handoff(["other", "--bead", "bd-7", "-m", "msg"]));
    expect(lines.join("\n")).toMatch(/bead bd-7/);
  });
});

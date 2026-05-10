import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("../src/config.js", () => ({
  SESSIONS_DIR: "",
}));

// log.ts captures `LOG_FILE = path.join(SESSIONS_DIR, "dashboard.log")` at
// module init, so the SESSIONS_DIR="" mock above resolves it to the relative
// path "dashboard.log" — every log call would then append to CWD. Mock the
// logger directly so dispatcher writes never touch disk.
vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/dashboard/workers.js", () => ({
  newWorker: vi.fn(),
}));

import {
  submitHandoffRequest, waitForHandoffResponse, processPendingHandoffs,
} from "../src/dashboard/handoff-dispatch.js";
import { newWorker } from "../src/dashboard/workers.js";

const cfg = await import("../src/config.js") as unknown as { SESSIONS_DIR: string };

let tmpDir: string;
let reqDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-handoff-dispatch-test-"));
  cfg.SESSIONS_DIR = tmpDir;
  reqDir = path.join(tmpDir, "handoff-requests");
});

describe("submitHandoffRequest", () => {
  it("writes a .req.json file under handoff-requests/", () => {
    const id = submitHandoffRequest({ targetProject: "wolf", seedFile: "/tmp/seed.txt" });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const reqFile = path.join(reqDir, `${id}.req.json`);
    expect(fs.existsSync(reqFile)).toBe(true);
    const body = JSON.parse(fs.readFileSync(reqFile, "utf8"));
    expect(body).toMatchObject({
      id,
      targetProject: "wolf",
      seedFile: "/tmp/seed.txt",
    });
    expect(typeof body.createdAt).toBe("number");
  });
});

describe("waitForHandoffResponse", () => {
  it("returns the parsed response and deletes the response file", async () => {
    fs.mkdirSync(reqDir, { recursive: true });
    const id = "abc";
    const respFile = path.join(reqDir, `${id}.resp.json`);
    fs.writeFileSync(respFile, JSON.stringify({ workerName: "bold-ash", completedAt: 1 }));
    const resp = await waitForHandoffResponse(id, 1000);
    expect(resp).toEqual({ workerName: "bold-ash", completedAt: 1 });
    expect(fs.existsSync(respFile)).toBe(false);
  });

  it("returns null when the timeout elapses without a response", async () => {
    const resp = await waitForHandoffResponse("never", 200);
    expect(resp).toBeNull();
  });
});

describe("processPendingHandoffs", () => {
  it("no-ops when the requests directory does not exist", () => {
    expect(() => processPendingHandoffs()).not.toThrow();
    expect(vi.mocked(newWorker)).not.toHaveBeenCalled();
  });

  it("processes a pending request, writes a response, deletes the claim file", () => {
    vi.mocked(newWorker).mockReturnValue("bold-ash");
    const id = submitHandoffRequest({ targetProject: "wolf", seedFile: "/tmp/seed.txt" });
    processPendingHandoffs();
    expect(vi.mocked(newWorker)).toHaveBeenCalledWith({
      projectName: "wolf",
      seedMessageFile: "/tmp/seed.txt",
      background: true,
    });
    const respFile = path.join(reqDir, `${id}.resp.json`);
    expect(fs.existsSync(respFile)).toBe(true);
    const resp = JSON.parse(fs.readFileSync(respFile, "utf8"));
    expect(resp.workerName).toBe("bold-ash");
    // Request and claim files are gone after processing.
    expect(fs.existsSync(path.join(reqDir, `${id}.req.json`))).toBe(false);
    expect(fs.existsSync(path.join(reqDir, `${id}.req.json.processing`))).toBe(false);
  });

  it("writes an error response when newWorker throws", () => {
    vi.mocked(newWorker).mockImplementationOnce(() => {
      throw new Error("Base branch 'main' missing on origin.");
    });
    const id = submitHandoffRequest({ targetProject: "wolf", seedFile: "/tmp/seed.txt" });
    processPendingHandoffs();
    const respFile = path.join(reqDir, `${id}.resp.json`);
    const resp = JSON.parse(fs.readFileSync(respFile, "utf8"));
    expect(resp.error).toContain("Base branch 'main' missing");
    expect(resp.workerName).toBeUndefined();
  });

  it("writes an error response when newWorker returns null", () => {
    vi.mocked(newWorker).mockReturnValue(null);
    const id = submitHandoffRequest({ targetProject: "wolf", seedFile: "/tmp/seed.txt" });
    processPendingHandoffs();
    const respFile = path.join(reqDir, `${id}.resp.json`);
    const resp = JSON.parse(fs.readFileSync(respFile, "utf8"));
    expect(resp.error).toContain("newWorker returned null");
  });

  it("skips a file already claimed by another poller (atomic rename loses)", () => {
    vi.mocked(newWorker).mockReturnValue("bold-ash");
    const id = submitHandoffRequest({ targetProject: "wolf", seedFile: "/tmp/seed.txt" });
    // Simulate another poller claiming the file first.
    const reqFile = path.join(reqDir, `${id}.req.json`);
    const otherClaim = reqFile + ".processing";
    fs.renameSync(reqFile, otherClaim);

    processPendingHandoffs();
    expect(vi.mocked(newWorker)).not.toHaveBeenCalled();
    // The other claim file remains untouched.
    expect(fs.existsSync(otherClaim)).toBe(true);
  });

  it("processes multiple pending requests in one pass", () => {
    vi.mocked(newWorker)
      .mockReturnValueOnce("a-one")
      .mockReturnValueOnce("b-two");
    const id1 = submitHandoffRequest({ targetProject: "wolf", seedFile: "/tmp/s1.txt" });
    const id2 = submitHandoffRequest({ targetProject: "fox", seedFile: "/tmp/s2.txt" });
    processPendingHandoffs();
    expect(vi.mocked(newWorker)).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(path.join(reqDir, `${id1}.resp.json`))).toBe(true);
    expect(fs.existsSync(path.join(reqDir, `${id2}.resp.json`))).toBe(true);
  });
});

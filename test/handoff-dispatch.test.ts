import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("../src/config.js", () => ({
  SESSIONS_DIR: "",
}));

vi.mock("../src/paths.js", () => ({
  CONTROL_DIR: "",
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

vi.mock("../src/dashboard/registry.js", () => ({
  getWorkers: vi.fn(() => []),
}));

import {
  submitHandoffRequest, waitForHandoffResponse, withdrawPendingHandoffRequest,
  processPendingHandoffs,
} from "../src/dashboard/handoff-dispatch.js";
import { newWorker } from "../src/dashboard/workers.js";
import { getWorkers } from "../src/dashboard/registry.js";

const cfg = await import("../src/config.js") as unknown as { SESSIONS_DIR: string };
const gardenPaths = await import("../src/paths.js") as unknown as { CONTROL_DIR: string };

let tmpDir: string;
let reqDir: string;
let controlDir: string;
let claimsDir: string;
let validSeed: string;

const CLAIM_TOKEN = "00000000-0000-4000-8000-000000000000";
const RESPONSE_ID = "11111111-1111-4111-8111-111111111111";

function moveToClaim(id: string, ownerPid: number): string {
  fs.mkdirSync(claimsDir, { recursive: true });
  const claim = path.join(
    claimsDir,
    `${id}.req.json.processing.${ownerPid}.${CLAIM_TOKEN}`,
  );
  fs.renameSync(path.join(reqDir, `${id}.req.json`), claim);
  return claim;
}

function resultPath(id: string): string {
  return path.join(controlDir, "handoff", "receipts", `${id}.result.json`);
}

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-handoff-dispatch-test-"));
  cfg.SESSIONS_DIR = tmpDir;
  controlDir = path.join(tmpDir, "control");
  gardenPaths.CONTROL_DIR = controlDir;
  reqDir = path.join(tmpDir, "handoff-requests");
  claimsDir = path.join(controlDir, "handoff", "claims");
  // A seed file inside the seeds dir — the only location processPendingHandoffs
  // accepts (its realpath must stay within SESSIONS_DIR/seeds).
  const seedsDir = path.join(tmpDir, "seeds");
  fs.mkdirSync(seedsDir, { recursive: true });
  validSeed = path.join(seedsDir, "seed.txt");
  fs.writeFileSync(validSeed, "seed content");
});

describe("submitHandoffRequest", () => {
  it("writes a .req.json file under handoff-requests/", () => {
    const id = submitHandoffRequest({ targetProject: "wolf", seedFile: validSeed });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const reqFile = path.join(reqDir, `${id}.req.json`);
    expect(fs.existsSync(reqFile)).toBe(true);
    const body = JSON.parse(fs.readFileSync(reqFile, "utf8"));
    expect(body).toMatchObject({
      id,
      targetProject: "wolf",
      seedFile: validSeed,
    });
    expect(typeof body.createdAt).toBe("number");
  });

  it("withdraws only while the request is still pending", () => {
    const pending = submitHandoffRequest({ targetProject: "wolf", seedFile: validSeed });
    expect(withdrawPendingHandoffRequest(pending)).toBe(true);
    expect(fs.existsSync(path.join(reqDir, `${pending}.req.json`))).toBe(false);

    const claimed = submitHandoffRequest({ targetProject: "wolf", seedFile: validSeed });
    moveToClaim(claimed, process.pid);
    expect(withdrawPendingHandoffRequest(claimed)).toBe(false);
  });
});

describe("waitForHandoffResponse", () => {
  it("returns the parsed durable response", async () => {
    const id = RESPONSE_ID;
    const respFile = resultPath(id);
    fs.mkdirSync(path.dirname(respFile), { recursive: true });
    fs.writeFileSync(respFile, JSON.stringify({ workerName: "bold-ash", completedAt: 1 }));
    const resp = await waitForHandoffResponse(id, 1000);
    expect(resp).toEqual({ workerName: "bold-ash", completedAt: 1 });
    expect(fs.existsSync(respFile)).toBe(true);
  });

  it("returns null when the timeout elapses without a response", async () => {
    const resp = await waitForHandoffResponse(RESPONSE_ID, 200);
    expect(resp).toBeNull();
  });

  it("rejects an unsafe response id instead of resolving a path outside the inbox", async () => {
    await expect(waitForHandoffResponse("../../escape", 10)).rejects.toThrow(/request id/i);
  });

  it("extends the deadline after the dispatcher claims a slow request", async () => {
    const id = submitHandoffRequest({ targetProject: "wolf", seedFile: validSeed });
    const reqFile = path.join(reqDir, `${id}.req.json`);
    const respFile = resultPath(id);
    setTimeout(() => { fs.unlinkSync(reqFile); }, 50);
    setTimeout(() => {
      fs.mkdirSync(path.dirname(respFile), { recursive: true });
      fs.writeFileSync(respFile, JSON.stringify({ workerName: "slow-oak", completedAt: 1 }));
    }, 400);

    const resp = await waitForHandoffResponse(id, 200, 1_000);
    expect(resp?.workerName).toBe("slow-oak");
  });
});

describe("processPendingHandoffs", () => {
  it("no-ops when the requests directory does not exist", () => {
    expect(() => processPendingHandoffs()).not.toThrow();
    expect(vi.mocked(newWorker)).not.toHaveBeenCalled();
  });

  it("processes a pending request, writes a response, deletes the claim file", () => {
    vi.mocked(newWorker).mockReturnValue("bold-ash");
    const id = submitHandoffRequest({ targetProject: "wolf", seedFile: validSeed });
    processPendingHandoffs();
    expect(vi.mocked(newWorker)).toHaveBeenCalledWith({
      projectName: "wolf",
      seedMessageFile: path.join(controlDir, "handoff", "seeds", `${id}.txt`),
      background: true,
      handoffRequestId: id,
    });
    const respFile = resultPath(id);
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
    const id = submitHandoffRequest({ targetProject: "wolf", seedFile: validSeed });
    processPendingHandoffs();
    const respFile = resultPath(id);
    const resp = JSON.parse(fs.readFileSync(respFile, "utf8"));
    expect(resp.error).toContain("Base branch 'main' missing");
    expect(resp.workerName).toBeUndefined();
  });

  it("writes an error response when newWorker returns null", () => {
    vi.mocked(newWorker).mockReturnValue(null);
    const id = submitHandoffRequest({ targetProject: "wolf", seedFile: validSeed });
    processPendingHandoffs();
    const respFile = resultPath(id);
    const resp = JSON.parse(fs.readFileSync(respFile, "utf8"));
    expect(resp.error).toContain("newWorker returned null");
  });

  it("leaves a claim owned by a live dispatcher untouched", () => {
    vi.mocked(newWorker).mockReturnValue("bold-ash");
    const id = submitHandoffRequest({ targetProject: "wolf", seedFile: validSeed });
    const otherClaim = moveToClaim(id, process.pid);

    processPendingHandoffs();
    expect(vi.mocked(newWorker)).not.toHaveBeenCalled();
    expect(fs.existsSync(otherClaim)).toBe(true);
  });

  it("recovers a claim abandoned by a dead dispatcher", () => {
    vi.mocked(newWorker).mockReturnValue("bold-ash");
    const id = submitHandoffRequest({ targetProject: "wolf", seedFile: validSeed });
    const abandoned = moveToClaim(id, 999_999_999);

    processPendingHandoffs();

    expect(vi.mocked(newWorker)).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(abandoned)).toBe(false);
    expect(JSON.parse(fs.readFileSync(resultPath(id), "utf8")))
      .toMatchObject({ workerName: "bold-ash" });
  });

  it("reconciles an abandoned claim to its existing worker without spawning twice", () => {
    const id = submitHandoffRequest({ targetProject: "wolf", seedFile: validSeed });
    moveToClaim(id, 999_999_999);
    vi.mocked(getWorkers).mockReturnValueOnce([{
      name: "already-spawned",
      sessionId: "session",
      task: "",
      handoffRequestId: id,
    }]);

    processPendingHandoffs();

    expect(vi.mocked(newWorker)).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(resultPath(id), "utf8")))
      .toMatchObject({ workerName: "already-spawned" });
  });

  it("replays a durable receipt instead of repeating a completed dispatch", () => {
    const id = submitHandoffRequest({ targetProject: "wolf", seedFile: validSeed });
    moveToClaim(id, 999_999_999);
    const receiptsDir = path.join(controlDir, "handoff", "receipts");
    fs.mkdirSync(receiptsDir, { recursive: true });
    fs.writeFileSync(
      path.join(receiptsDir, `${id}.result.json`),
      JSON.stringify({ workerName: "receipt-oak", completedAt: 1 }),
    );

    processPendingHandoffs();

    expect(vi.mocked(newWorker)).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(resultPath(id), "utf8")))
      .toMatchObject({ workerName: "receipt-oak" });
  });

  it("fails an abandoned legacy claim rather than risking a duplicate spawn", () => {
    const id = submitHandoffRequest({ targetProject: "wolf", seedFile: validSeed });
    const request = path.join(reqDir, `${id}.req.json`);
    const legacyClaim = `${request}.processing`;
    fs.renameSync(request, legacyClaim);
    const stale = new Date(Date.now() - 180_000);
    fs.utimesSync(legacyClaim, stale, stale);

    processPendingHandoffs();

    expect(vi.mocked(newWorker)).not.toHaveBeenCalled();
    expect(fs.existsSync(legacyClaim)).toBe(false);
    expect(JSON.parse(fs.readFileSync(resultPath(id), "utf8")).error)
      .toMatch(/cannot be replayed safely/i);
  });

  it("propagates handoffCallback when expectCallback + parent fields set", () => {
    vi.mocked(newWorker).mockReturnValue("bold-ash");
    submitHandoffRequest({
      targetProject: "wolf",
      seedFile: validSeed,
      expectCallback: true,
      parentProject: "fox",
      parentWorker: "calm-bay",
    });
    processPendingHandoffs();
    expect(vi.mocked(newWorker)).toHaveBeenCalledWith(expect.objectContaining({
      projectName: "wolf",
      handoffCallback: {
        parentProject: "fox",
        parentWorker: "calm-bay",
        expectCallback: true,
      },
    }));
  });

  it("drops handoffCallback when expectCallback is set but parent env was missing", () => {
    vi.mocked(newWorker).mockReturnValue("bold-ash");
    // expectCallback without parentProject/parentWorker — should not propagate.
    submitHandoffRequest({
      targetProject: "wolf",
      seedFile: validSeed,
      expectCallback: true,
    });
    processPendingHandoffs();
    const call = vi.mocked(newWorker).mock.calls[0][0];
    expect(call?.handoffCallback).toBeUndefined();
  });

  it("does not propagate handoffCallback when expectCallback is false", () => {
    vi.mocked(newWorker).mockReturnValue("bold-ash");
    submitHandoffRequest({
      targetProject: "wolf",
      seedFile: validSeed,
      parentProject: "fox",
      parentWorker: "calm-bay",
    });
    processPendingHandoffs();
    const call = vi.mocked(newWorker).mock.calls[0][0];
    expect(call?.handoffCallback).toBeUndefined();
  });

  it("passes ultracode:true to newWorker when the request carries it", () => {
    vi.mocked(newWorker).mockReturnValue("bold-ash");
    submitHandoffRequest({ targetProject: "wolf", seedFile: validSeed, ultracode: true });
    processPendingHandoffs();
    expect(vi.mocked(newWorker)).toHaveBeenCalledWith(expect.objectContaining({
      projectName: "wolf",
      ultracode: true,
    }));
  });

  it("binds the result path to the request filename rather than a forged body id", () => {
    vi.mocked(newWorker).mockReturnValue("bold-ash");
    const id = submitHandoffRequest({ targetProject: "wolf", seedFile: validSeed });
    const reqFile = path.join(reqDir, `${id}.req.json`);
    const request = JSON.parse(fs.readFileSync(reqFile, "utf8"));
    request.id = "../../escaped";
    fs.writeFileSync(reqFile, JSON.stringify(request));

    processPendingHandoffs();

    expect(vi.mocked(newWorker)).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(resultPath(id), "utf8")).error)
      .toMatch(/does not match/i);
  });

  it("does not pass ultracode to newWorker for a plain request", () => {
    vi.mocked(newWorker).mockReturnValue("bold-ash");
    submitHandoffRequest({ targetProject: "wolf", seedFile: validSeed });
    processPendingHandoffs();
    const call = vi.mocked(newWorker).mock.calls[0][0];
    expect(call?.ultracode).toBeUndefined();
  });

  it("processes multiple pending requests in one pass", () => {
    vi.mocked(newWorker)
      .mockReturnValueOnce("a-one")
      .mockReturnValueOnce("b-two");
    const s1 = path.join(tmpDir, "seeds", "s1.txt");
    const s2 = path.join(tmpDir, "seeds", "s2.txt");
    fs.writeFileSync(s1, "a");
    fs.writeFileSync(s2, "b");
    const id1 = submitHandoffRequest({ targetProject: "wolf", seedFile: s1 });
    const id2 = submitHandoffRequest({ targetProject: "fox", seedFile: s2 });
    processPendingHandoffs();
    expect(vi.mocked(newWorker)).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(resultPath(id1))).toBe(true);
    expect(fs.existsSync(resultPath(id2))).toBe(true);
  });

  it("rejects a request whose seedFile escapes the seeds directory", () => {
    // A worker-authored request pointing seedFile outside SESSIONS_DIR/seeds
    // must be dropped, not read into the child's first prompt.
    const outsideSeed = path.join(tmpDir, "outside-seed.txt");
    fs.writeFileSync(outsideSeed, "secret");
    const id = submitHandoffRequest({ targetProject: "wolf", seedFile: outsideSeed });
    processPendingHandoffs();
    expect(vi.mocked(newWorker)).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(reqDir, `${id}.req.json.processing`))).toBe(false);
    expect(fs.existsSync(path.join(reqDir, `${id}.req.json`))).toBe(false);
  });

  it("rejects a seedFile symlink that escapes the seeds directory", () => {
    // A symlink living inside seeds/ but resolving outside must be rejected
    // (realpath, not the raw path, is what is checked).
    const secret = path.join(tmpDir, "secret.txt");
    fs.writeFileSync(secret, "secret");
    const link = path.join(tmpDir, "seeds", "link.txt");
    fs.symlinkSync(secret, link);
    const id = submitHandoffRequest({ targetProject: "wolf", seedFile: link });
    processPendingHandoffs();
    expect(vi.mocked(newWorker)).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(reqDir, `${id}.req.json.processing`))).toBe(false);
  });

  it("hands newWorker a protected seed copy that cannot be swapped after validation", () => {
    const secret = path.join(tmpDir, "secret.txt");
    fs.writeFileSync(secret, "secret content");
    let dispatchedSeedPath = "";
    let dispatchedSeedContent = "";
    vi.mocked(newWorker).mockImplementationOnce(opts => {
      try { fs.unlinkSync(validSeed); } catch { /* dispatcher already removed it */ }
      fs.symlinkSync(secret, validSeed);
      dispatchedSeedPath = opts.seedMessageFile!;
      dispatchedSeedContent = fs.readFileSync(opts.seedMessageFile!, "utf8");
      return "bold-ash";
    });
    submitHandoffRequest({ targetProject: "wolf", seedFile: validSeed });

    processPendingHandoffs();

    expect(vi.mocked(newWorker)).toHaveBeenCalledTimes(1);
    expect(dispatchedSeedPath).not.toBe(validSeed);
    expect(dispatchedSeedContent).toBe("seed content");
  });

  it("rejects a malformed request that fails the shape guard", () => {
    fs.mkdirSync(reqDir, { recursive: true });
    // Missing targetProject / seedFile — not a valid HandoffRequest.
    fs.writeFileSync(path.join(reqDir, "bad.req.json"), JSON.stringify({ id: "x", createdAt: 1 }));
    processPendingHandoffs();
    expect(vi.mocked(newWorker)).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(reqDir, "bad.req.json.processing"))).toBe(false);
  });

  it("drops a request body that parses to null / a primitive / an array without throwing", () => {
    // isHandoffRequest runs on JSON.parse's output OUTSIDE any try/catch, so its
    // non-object guard (null / primitive / array) must reject cleanly rather than
    // throw — a throw would abort the whole poll pass and strand sibling requests.
    fs.mkdirSync(reqDir, { recursive: true });
    for (const [name, body] of [
      ["null.req.json", "null"],
      ["number.req.json", "42"],
      ["array.req.json", "[]"],
    ]) {
      fs.writeFileSync(path.join(reqDir, name), body);
    }
    expect(() => processPendingHandoffs()).not.toThrow();
    expect(vi.mocked(newWorker)).not.toHaveBeenCalled();
    for (const name of ["null.req.json", "number.req.json", "array.req.json"]) {
      expect(fs.existsSync(path.join(reqDir, name + ".processing"))).toBe(false);
    }
  });

  it("rejects a seedFile that does not exist on disk (realpath throws)", () => {
    // Drives seedFileWithinSeedsDir's realpathSync catch branch: a seedFile named
    // inside seeds/ but never written resolves to nothing, so the request is
    // dropped rather than handed to newWorker.
    const missingSeed = path.join(tmpDir, "seeds", "gone.txt");
    const id = submitHandoffRequest({ targetProject: "wolf", seedFile: missingSeed });
    processPendingHandoffs();
    expect(vi.mocked(newWorker)).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(reqDir, `${id}.req.json.processing`))).toBe(false);
    expect(fs.existsSync(path.join(reqDir, `${id}.req.json`))).toBe(false);
  });

  it("rejects a seedFile that is a dangling symlink inside seeds/", () => {
    // A symlink living inside seeds/ whose target was deleted: realpathSync throws,
    // the catch returns false, and the request is dropped.
    const target = path.join(tmpDir, "vanished.txt");
    const link = path.join(tmpDir, "seeds", "dangling.txt");
    fs.symlinkSync(target, link); // target intentionally never created
    const id = submitHandoffRequest({ targetProject: "wolf", seedFile: link });
    processPendingHandoffs();
    expect(vi.mocked(newWorker)).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(reqDir, `${id}.req.json.processing`))).toBe(false);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { spawnSync } from "node:child_process";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  listOpenEpics, swarmStatus, showBeads, claimBead, runBd, bdChildEnv,
  incrementFailedLabel,
} from "../src/dashboard/beads.js";

// The default store context: cwd-discovered .beads, no BEADS_DIR override.
const STORE = { path: "/repo" };

function bdOk(stdout: string) {
  return { status: 0, stdout, stderr: "", error: undefined } as ReturnType<typeof spawnSync>;
}

function bdFail(stderr: string) {
  return { status: 1, stdout: "", stderr, error: undefined } as ReturnType<typeof spawnSync>;
}

beforeEach(() => {
  vi.mocked(spawnSync).mockReset();
});

describe("listOpenEpics", () => {
  it("parses epics and tolerates stderr noise", () => {
    vi.mocked(spawnSync).mockReturnValueOnce(bdOk(JSON.stringify([
      { id: "e1", title: "Epic", status: "open", priority: 1, labels: ["dispatch:auto"], design: "D" },
      { id: "junk" }, // missing title -> dropped
    ])));
    const epics = listOpenEpics(STORE);
    expect(epics).toHaveLength(1);
    expect(epics[0]).toMatchObject({ id: "e1", labels: ["dispatch:auto"], design: "D" });
    const call = vi.mocked(spawnSync).mock.calls[0];
    expect(call[0]).toBe("bd");
    expect(call[1]).toEqual(["query", "type=epic AND NOT status=closed", "--json"]);
    expect(call[2]).toMatchObject({ cwd: "/repo" });
  });

  it("throws on a failed or unparseable run so intake records the failure", () => {
    vi.mocked(spawnSync).mockReturnValueOnce(bdFail("boom"));
    expect(() => listOpenEpics(STORE)).toThrow("bd query type=epic AND NOT status=closed failed: boom");
    vi.mocked(spawnSync).mockReturnValueOnce(bdOk("not json"));
    expect(() => listOpenEpics(STORE)).toThrow("returned unparseable JSON");
  });
});

describe("swarmStatus", () => {
  it("parses the grouped frontier, keeping assignees and dropping empty ones", () => {
    vi.mocked(spawnSync).mockReturnValueOnce(bdOk(JSON.stringify({
      ready: [{ id: "b1", title: "one", assignee: "w1" }, { id: "b2", title: "two", assignee: "" }],
      active: [{ id: "b3", title: "three", assignee: "w2" }],
      blocked: [],
      completed: [{ id: "b0", title: "zero" }],
    })));
    const st = swarmStatus(STORE, "e1");
    expect(st?.ready).toEqual([{ id: "b1", title: "one", assignee: "w1" }, { id: "b2", title: "two" }]);
    expect(st?.active).toEqual([{ id: "b3", title: "three", assignee: "w2" }]);
    expect(st?.completed.map(c => c.id)).toEqual(["b0"]);
  });

  it("throws when bd fails so intake records the failure", () => {
    vi.mocked(spawnSync).mockReturnValueOnce(bdFail("no epic"));
    expect(() => swarmStatus(STORE, "e1")).toThrow("bd swarm status e1 failed: no epic");
  });
});

describe("showBeads", () => {
  it("returns [] without shelling out for an empty id list", () => {
    expect(showBeads(STORE, [])).toEqual([]);
    expect(vi.mocked(spawnSync)).not.toHaveBeenCalled();
  });

  it("passes all ids and parses the list shape", () => {
    vi.mocked(spawnSync).mockReturnValueOnce(bdOk(JSON.stringify([
      { id: "b1", title: "one", status: "open", priority: 0, labels: [] },
      { id: "b2", title: "two", status: "open", priority: 2, labels: [], description: "d" },
    ])));
    const beads = showBeads(STORE, ["b1", "b2"]);
    expect(beads.map(b => b.id)).toEqual(["b1", "b2"]);
    expect(beads[1].description).toBe("d");
    expect(vi.mocked(spawnSync).mock.calls[0][1]).toEqual(["show", "b1", "b2", "--json"]);
  });
});

describe("claimBead", () => {
  it("claims with BEADS_ACTOR set to the worker name", () => {
    vi.mocked(spawnSync).mockReturnValueOnce(bdOk("ok"));
    expect(claimBead(STORE, "b1", "swift-oak")).toBe(true);
    const call = vi.mocked(spawnSync).mock.calls[0];
    expect(call[1]).toEqual(["update", "b1", "--claim"]);
    expect((call[2] as { env: Record<string, string> }).env.BEADS_ACTOR).toBe("swift-oak");
  });

  it("reports a foreign claim as failure", () => {
    vi.mocked(spawnSync).mockReturnValueOnce(bdFail("issue already claimed by other"));
    expect(claimBead(STORE, "b1", "swift-oak")).toBe(false);
  });
});

describe("incrementFailedLabel", () => {
  it("adds the max-wins increment before attempting to remove every straggler", () => {
    const ops: string[] = [];
    const result = incrementFailedLabel({
      addLabel: (_id, label) => { ops.push(`add:${label}`); return true; },
      // A failed cleanup is best-effort: the newly added maximum still makes
      // the durable count correct, and the remaining duplicate is harmless.
      removeLabel: (_id, label) => { ops.push(`remove:${label}`); return label !== "dispatch:failed:1"; },
    }, "b1", ["dispatch:failed:1", "other", "dispatch:failed:3"]);

    expect(result).toEqual({ ok: true, count: 4 });
    expect(ops).toEqual([
      "add:dispatch:failed:4",
      "remove:dispatch:failed:1",
      "remove:dispatch:failed:3",
    ]);
  });
});

// The store-resolution rule (board DELEGATION.md Decision 15): every bd child
// gets the resolved BEADS_DIR, overriding any store inherited from the shell
// that invoked garden.
describe("shared-store resolution (beadsDir)", () => {
  it("bdChildEnv injects the configured store or the checkout default", () => {
    const shared = bdChildEnv({ path: "/repo", beadsDir: "/board/.beads" });
    expect(shared.BEADS_DIR).toBe("/board/.beads");
    const plain = bdChildEnv(STORE);
    expect(plain.BEADS_DIR).toBe("/repo/.beads");
  });

  it("bdChildEnv replaces an inherited store from another worker", () => {
    const inherited = process.env.BEADS_DIR;
    process.env.BEADS_DIR = "/other/.beads";
    try {
      expect(bdChildEnv(STORE).BEADS_DIR).toBe("/repo/.beads");
    } finally {
      if (inherited === undefined) delete process.env.BEADS_DIR;
      else process.env.BEADS_DIR = inherited;
    }
  });

  it("bdChildEnv layers BEADS_ACTOR on top of the store env", () => {
    const env = bdChildEnv({ path: "/repo", beadsDir: "/board/.beads" }, "swift-oak");
    expect(env.BEADS_DIR).toBe("/board/.beads");
    expect(env.BEADS_ACTOR).toBe("swift-oak");
  });

  it("runBd keeps cwd at the project path and passes BEADS_DIR when set", () => {
    vi.mocked(spawnSync).mockReturnValueOnce(bdOk("fine"));
    runBd({ path: "/repo", beadsDir: "/board/.beads" }, ["list"]);
    const call = vi.mocked(spawnSync).mock.calls[0];
    expect(call[2]).toMatchObject({ cwd: "/repo" });
    expect((call[2] as { env: Record<string, string> }).env.BEADS_DIR).toBe("/board/.beads");
  });

  it("runBd without beadsDir pins the checkout's own store", () => {
    vi.mocked(spawnSync).mockReturnValueOnce(bdOk("fine"));
    runBd(STORE, ["list"]);
    const call = vi.mocked(spawnSync).mock.calls[0];
    expect((call[2] as { env: Record<string, string> }).env.BEADS_DIR).toBe("/repo/.beads");
  });
});

describe("runBd lock retry", () => {
  it("retries once on a transient lock error, then succeeds", () => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce(bdFail("opening lock file: resource busy"))
      .mockReturnValueOnce(bdOk("fine"));
    const res = runBd(STORE, ["list"]);
    expect(res.ok).toBe(true);
    expect(vi.mocked(spawnSync)).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-lock failures", () => {
    vi.mocked(spawnSync).mockReturnValueOnce(bdFail("unknown issue"));
    expect(runBd(STORE, ["list"]).ok).toBe(false);
    expect(vi.mocked(spawnSync)).toHaveBeenCalledTimes(1);
  });
});

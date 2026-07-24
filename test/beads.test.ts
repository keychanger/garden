import { describe, it, expect, vi, beforeEach } from "vitest";
import { spawnSync } from "node:child_process";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

vi.mock("../src/dashboard/log.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  listOpenEpics, swarmStatus, showBeads, claimBead, runBd,
} from "../src/dashboard/beads.js";

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
    const epics = listOpenEpics("/repo");
    expect(epics).toHaveLength(1);
    expect(epics[0]).toMatchObject({ id: "e1", labels: ["dispatch:auto"], design: "D" });
    const call = vi.mocked(spawnSync).mock.calls[0];
    expect(call[0]).toBe("bd");
    expect(call[1]).toEqual(["query", "type=epic AND NOT status=closed", "--json"]);
    expect(call[2]).toMatchObject({ cwd: "/repo" });
  });

  it("returns empty on a failed or unparseable run", () => {
    vi.mocked(spawnSync).mockReturnValueOnce(bdFail("boom"));
    expect(listOpenEpics("/repo")).toEqual([]);
    vi.mocked(spawnSync).mockReturnValueOnce(bdOk("not json"));
    expect(listOpenEpics("/repo")).toEqual([]);
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
    const st = swarmStatus("/repo", "e1");
    expect(st?.ready).toEqual([{ id: "b1", title: "one", assignee: "w1" }, { id: "b2", title: "two" }]);
    expect(st?.active).toEqual([{ id: "b3", title: "three", assignee: "w2" }]);
    expect(st?.completed.map(c => c.id)).toEqual(["b0"]);
  });

  it("returns null when bd fails", () => {
    vi.mocked(spawnSync).mockReturnValueOnce(bdFail("no epic"));
    expect(swarmStatus("/repo", "e1")).toBeNull();
  });
});

describe("showBeads", () => {
  it("returns [] without shelling out for an empty id list", () => {
    expect(showBeads("/repo", [])).toEqual([]);
    expect(vi.mocked(spawnSync)).not.toHaveBeenCalled();
  });

  it("passes all ids and parses the list shape", () => {
    vi.mocked(spawnSync).mockReturnValueOnce(bdOk(JSON.stringify([
      { id: "b1", title: "one", status: "open", priority: 0, labels: [] },
      { id: "b2", title: "two", status: "open", priority: 2, labels: [], description: "d" },
    ])));
    const beads = showBeads("/repo", ["b1", "b2"]);
    expect(beads.map(b => b.id)).toEqual(["b1", "b2"]);
    expect(beads[1].description).toBe("d");
    expect(vi.mocked(spawnSync).mock.calls[0][1]).toEqual(["show", "b1", "b2", "--json"]);
  });
});

describe("claimBead", () => {
  it("claims with BEADS_ACTOR set to the worker name", () => {
    vi.mocked(spawnSync).mockReturnValueOnce(bdOk("ok"));
    expect(claimBead("/repo", "b1", "swift-oak")).toBe(true);
    const call = vi.mocked(spawnSync).mock.calls[0];
    expect(call[1]).toEqual(["update", "b1", "--claim"]);
    expect((call[2] as { env: Record<string, string> }).env.BEADS_ACTOR).toBe("swift-oak");
  });

  it("reports a foreign claim as failure", () => {
    vi.mocked(spawnSync).mockReturnValueOnce(bdFail("issue already claimed by other"));
    expect(claimBead("/repo", "b1", "swift-oak")).toBe(false);
  });
});

describe("runBd lock retry", () => {
  it("retries once on a transient lock error, then succeeds", () => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce(bdFail("opening lock file: resource busy"))
      .mockReturnValueOnce(bdOk("fine"));
    const res = runBd("/repo", ["list"]);
    expect(res.ok).toBe(true);
    expect(vi.mocked(spawnSync)).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-lock failures", () => {
    vi.mocked(spawnSync).mockReturnValueOnce(bdFail("unknown issue"));
    expect(runBd("/repo", ["list"]).ok).toBe(false);
    expect(vi.mocked(spawnSync)).toHaveBeenCalledTimes(1);
  });
});

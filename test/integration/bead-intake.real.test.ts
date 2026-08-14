// The bead-intake loop against a REAL bd database: verifies the 1.0.3
// behaviors the loop is built on (claim atomicity + same-actor idempotency,
// swarm-status frontier shape, label add/remove, reopen from in_progress)
// and the loop's writes end-to-end — dispatch claims the bead as the worker,
// manual authorization is consumed, budget exhaustion labels the epic, and
// the reaper recovers a dead worker's bead. Skipped when bd is not installed
// (CI runners); the unit suite in test/poller-intake.test.ts covers the
// logic with fakes.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  listOpenEpics, swarmStatus, showBeads, claimBead, reopenBead, unassignBead,
  addLabel, removeLabel,
} from "../../src/dashboard/beads.js";
import {
  runIntakeOnce, REAPER_GRACE_MS, type IntakeDeps,
} from "../../src/dashboard/poller-intake.js";
import type { WorkerEntry } from "../../src/dashboard/registry.js";

const bdInstalled = (() => {
  const res = spawnSync("bd", ["--version"], { encoding: "utf8", timeout: 5000 });
  return !res.error && res.status === 0;
})();

const TEST_TIMEOUT = 120_000;

describe.skipIf(!bdInstalled)("bead intake against real bd", () => {
  let repo: string;
  let epicId: string;
  const childIds: string[] = [];

  function bd(...args: string[]): string {
    return execFileSync("bd", args, { cwd: repo, encoding: "utf8", timeout: 30_000 });
  }

  function createBead(title: string, extra: string[] = []): string {
    const out = bd("create", title, ...extra, "--json");
    const parsed = JSON.parse(out) as { id: string };
    return parsed.id;
  }

  beforeAll(() => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bead-intake-")));
    bd("init");
    epicId = createBead("intake epic", ["-t", "epic"]);
    bd("update", epicId, "--design", "The epic design doc.");
    for (const title of ["slice one", "slice two", "slice three"]) {
      childIds.push(createBead(title));
    }
    for (const id of childIds) {
      bd("link", id, epicId, "--type", "parent-child");
    }
    // slice three blocked by slice one -> initial ready frontier is one+two.
    bd("dep", childIds[0], "--blocks", childIds[2]);
  }, TEST_TIMEOUT);

  afterAll(() => {
    if (repo) fs.rmSync(repo, { recursive: true, force: true });
  });

  function makeDeps(opts: { workers?: WorkerEntry[]; cap?: number } = {}):
    IntakeDeps & { spawns: Array<{ seed: string; task: string }>; alerts: string[] } {
    const spawns: Array<{ seed: string; task: string }> = [];
    const alerts: string[] = [];
    let n = 0;
    return {
      projectName: "intake-it",
      cap: opts.cap ?? 10,
      listOpenEpics: () => listOpenEpics(repo),
      swarmStatus: (id) => swarmStatus(repo, id),
      showBeads: (ids) => showBeads(repo, ids),
      claim: (id, actor) => claimBead(repo, id, actor),
      reopen: (id, reason) => reopenBead(repo, id, reason),
      unassign: (id) => unassignBead(repo, id),
      addLabel: (id, label) => addLabel(repo, id, label),
      removeLabel: (id, label) => removeLabel(repo, id, label),
      spawn: (seed, task) => { spawns.push({ seed, task }); n++; return `it-worker-${n}`; },
      workers: () => opts.workers ?? [],
      alert: (input) => { alerts.push(`${input.level}:${input.message}`); },
      nowMs: () => Date.now(),
      spawns,
      alerts,
    };
  }

  it("dispatches the ready frontier of a manual epic, claims as the workers, and consumes the gate", () => {
    bd("label", "add", epicId, "dispatch:manual");
    const deps = makeDeps();
    expect(runIntakeOnce(deps)).toBe(true);

    // Both unblocked children dispatched; the blocked third untouched.
    expect(deps.spawns).toHaveLength(2);
    expect(deps.spawns[0].seed).toContain("The epic design doc.");
    expect(deps.spawns[0].seed).toContain("--claim");

    // Claims landed in bd: assignee is the worker name, status in_progress.
    const details = showBeads(repo, [childIds[0], childIds[1]]);
    for (const d of details) {
      expect(d.status).toBe("in_progress");
      expect(d.assignee).toMatch(/^it-worker-/);
    }
    const st = swarmStatus(repo, epicId);
    expect(st?.active).toHaveLength(2);
    expect(st?.ready).toHaveLength(0);

    // Manual authorization consumed; session counter written.
    const epic = listOpenEpics(repo).find(e => e.id === epicId);
    expect(epic?.labels).toContain("dispatch:dispatched");
    expect(epic?.labels).not.toContain("dispatch:manual");
    expect(epic?.labels).toContain("dispatch:spent:2");

    // A second pass is a no-op: gate consumed, frontier empty.
    const deps2 = makeDeps();
    expect(runIntakeOnce(deps2)).toBe(false);
    expect(deps2.spawns).toHaveLength(0);
  }, TEST_TIMEOUT);

  it("the worker's own seeded claim is an idempotent no-op after intake's claim", () => {
    // Which it-worker-N claimed which bead depends on the priority tiebreak
    // over random bd id suffixes — read the actual assignee rather than
    // assuming the dispatch order.
    const owner = showBeads(repo, [childIds[0]])[0].assignee;
    expect(owner).toMatch(/^it-worker-/);
    // Verified 1.0.3 quirk the seed relies on: same-actor re-claim succeeds.
    const res = spawnSync("bd", ["update", childIds[0], "--claim"], {
      cwd: repo, encoding: "utf8", timeout: 30_000,
      env: { ...process.env, BEADS_ACTOR: owner },
    });
    expect(res.status).toBe(0);
    // And a FOREIGN claim still fails — the idempotency guarantee.
    const foreign = spawnSync("bd", ["update", childIds[0], "--claim"], {
      cwd: repo, encoding: "utf8", timeout: 30_000,
      env: { ...process.env, BEADS_ACTOR: "someone-else" },
    });
    expect(foreign.status).not.toBe(0);
  }, TEST_TIMEOUT);

  it("reaps a dead worker's bead and advances the wavefront on the next auto pass", () => {
    // Re-arm as auto; childIds[0]'s claiming worker "dies" mid-build while
    // the sibling's worker stays live. Assignees are read from bd, not
    // assumed from dispatch order (random id suffixes decide the tiebreak).
    bd("label", "remove", epicId, "dispatch:dispatched");
    bd("label", "add", epicId, "dispatch:auto");
    const deadName = showBeads(repo, [childIds[0]])[0].assignee!;
    const liveName = showBeads(repo, [childIds[1]])[0].assignee!;
    const deadEntry: WorkerEntry = {
      name: deadName, sessionId: "s", task: "",
      agentStatus: "exited", lastEventAt: Date.now() - REAPER_GRACE_MS - 1000,
    };
    const liveEntry: WorkerEntry = {
      name: liveName, sessionId: "s", task: "", agentStatus: "working",
    };
    const deps = makeDeps({ workers: [deadEntry, liveEntry] });
    expect(runIntakeOnce(deps)).toBe(true);

    // Reaped: reopened, unassigned, retry-labeled...
    const reaped = showBeads(repo, [childIds[0]])[0];
    expect(reaped.status).toBe("open");
    expect(reaped.assignee).toBeUndefined();
    expect(reaped.labels).toContain("dispatch:retry:1");

    // ...and immediately re-dispatched by the same pass's frontier read?
    // No — the frontier was computed before the reap, so the re-dispatch
    // happens on the NEXT pass. Run it.
    const deps2 = makeDeps({ workers: [liveEntry] });
    expect(runIntakeOnce(deps2)).toBe(true);
    expect(deps2.spawns.length).toBeGreaterThanOrEqual(1);
    const reclaimed = showBeads(repo, [childIds[0]])[0];
    expect(reclaimed.status).toBe("in_progress");
    expect(reclaimed.assignee).toMatch(/^it-worker-/);
  }, TEST_TIMEOUT);

  it("halts intake and labels the epic when the budget is exhausted", () => {
    // Budget equal to sessions already spent (2 dispatches in test 1 + 1
    // re-dispatch above = spent:3).
    bd("label", "add", epicId, "budget:3");
    const deps = makeDeps({ workers: [] });
    runIntakeOnce(deps);
    const epic = listOpenEpics(repo).find(e => e.id === epicId);
    expect(epic?.labels).toContain("dispatch:budget-exhausted");
    expect(deps.alerts.some(a => a.startsWith("error:"))).toBe(true);

    // With the exhaustion label present, nothing dispatches even after a
    // bead closes and frees the frontier.
    const deps2 = makeDeps({ workers: [] });
    expect(runIntakeOnce(deps2)).toBe(false);
    expect(deps2.spawns).toHaveLength(0);
  }, TEST_TIMEOUT);

  it("dispatches a manual wave larger than the cap across passes, consuming only at exhaustion", () => {
    // Fresh epic: a 2-bead wave under cap 1 (true-wave semantics, Decision 9).
    const waveEpic = createBead("wave epic", ["-t", "epic"]);
    const waveKids = [createBead("wave one"), createBead("wave two")];
    for (const id of waveKids) {
      bd("link", id, waveEpic, "--type", "parent-child");
    }
    bd("label", "add", waveEpic, "dispatch:manual");

    // Pass 1: one slot, one spawn — the arm stays, the mid-wave marker lands.
    const deps = makeDeps({ cap: 1 });
    expect(runIntakeOnce(deps)).toBe(true);
    expect(deps.spawns).toHaveLength(1);
    let labels = listOpenEpics(repo).find(e => e.id === waveEpic)!.labels;
    expect(labels).toContain("dispatch:manual");
    expect(labels).toContain("dispatch:dispatching");
    expect(labels).not.toContain("dispatch:dispatched");

    // Pass 2: the remaining bead dispatches, the observed frontier drains,
    // and only now is the authorization consumed.
    const deps2 = makeDeps({ cap: 1 });
    expect(runIntakeOnce(deps2)).toBe(true);
    expect(deps2.spawns).toHaveLength(1);
    labels = listOpenEpics(repo).find(e => e.id === waveEpic)!.labels;
    expect(labels).toContain("dispatch:dispatched");
    expect(labels).not.toContain("dispatch:manual");
    expect(labels).not.toContain("dispatch:dispatching");
    expect(labels).toContain("dispatch:spent:2");

    // Both beads claimed as their workers.
    const kids = showBeads(repo, waveKids);
    for (const k of kids) {
      expect(k.status).toBe("in_progress");
      expect(k.assignee).toMatch(/^it-worker-/);
    }
  }, TEST_TIMEOUT);
});

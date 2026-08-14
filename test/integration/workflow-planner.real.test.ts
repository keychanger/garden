// The planner contract against a REAL bd database: every command spelling the
// planner seed (buildPlannerSeed) instructs a worker to run must be executable
// on the installed bd 1.0.3, because the planner follows the seed verbatim.
// Pins: per-child `bd create --ephemeral --parent` produces children that are
// linked into the epic's swarm frontier AND ephemeral (board's draft-review
// gate reads `ephemeral:true` from bd export), `bd dep <blocker> --blocks
// <blocked>` wires the integration gate, `bd dep cycles` exits clean, and the
// plan:* label rewrites round-trip. Also pins the reason the seed DEVIATES
// from DELEGATION.md's `bd create --graph --ephemeral` sketch: --graph
// silently drops ephemerality (the canary test below) — if a future bd honors
// it, that test fails and the single-call graph contract can be reconsidered.
// Skipped when bd is not installed (CI runners); test/poller-intake.test.ts
// covers the loop logic with fakes.
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
  runIntakeOnce, type IntakeDeps, type IntakeSpawnRequest,
} from "../../src/dashboard/poller-intake.js";

const bdInstalled = (() => {
  const res = spawnSync("bd", ["--version"], { encoding: "utf8", timeout: 5000 });
  return !res.error && res.status === 0;
})();

const TEST_TIMEOUT = 120_000;

describe.skipIf(!bdInstalled)("planner contract against real bd", () => {
  let repo: string;
  let epicId: string;

  function bd(...args: string[]): string {
    return execFileSync("bd", args, { cwd: repo, encoding: "utf8", timeout: 30_000 });
  }

  function createBead(title: string, extra: string[] = []): string {
    return bd("create", title, ...extra, "--silent").trim();
  }

  // bd export emits JSONL; the `ephemeral` field is what board's draft
  // rendering (and the promote/discard gate) keys on.
  function exportedEphemeral(): Map<string, boolean> {
    const out = bd("export");
    const map = new Map<string, boolean>();
    for (const line of out.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parsed = JSON.parse(trimmed) as { id: string; ephemeral?: boolean };
      map.set(parsed.id, parsed.ephemeral === true);
    }
    return map;
  }

  beforeAll(() => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "planner-real-")));
    bd("init");
    epicId = createBead("planner epic", ["-t", "epic"]);
    bd("update", epicId, "--design", "The epic design doc.");
  }, TEST_TIMEOUT);

  afterAll(() => {
    if (repo) fs.rmSync(repo, { recursive: true, force: true });
  });

  it("the seed's wisp-create spelling produces ephemeral children linked into the swarm frontier", () => {
    // The exact spellings buildPlannerSeed instructs: per-child create with
    // --ephemeral --parent, then explicit `bd dep <blocker> --blocks
    // <blocked>` edges, integration child labeled and blocked by every leaf.
    const leaf1 = createBead("leaf one", ["--ephemeral", "--parent", epicId, "-d", "first slice"]);
    const leaf2 = createBead("leaf two", ["--ephemeral", "--parent", epicId, "-d", "second slice"]);
    const integration = createBead("integration", [
      "--ephemeral", "--parent", epicId, "-l", "integration",
      "-d", "Verify the assembled feature.",
    ]);
    bd("dep", leaf1, "--blocks", integration);
    bd("dep", leaf2, "--blocks", integration);

    // Linked: the epic's swarm frontier sees all three, leaves ready and the
    // integration gate blocked behind them.
    const st = swarmStatus(repo, epicId);
    expect(st?.ready.map(r => r.id).sort()).toEqual([leaf1, leaf2].sort());
    expect(st?.blocked.map(r => r.id)).toEqual([integration]);

    // Ephemeral: board renders these as dimmed draft wisps.
    const eph = exportedEphemeral();
    expect(eph.get(leaf1)).toBe(true);
    expect(eph.get(leaf2)).toBe(true);
    expect(eph.get(integration)).toBe(true);
    expect(eph.get(epicId)).toBe(false);

    // The integration label survives the create (buildBeadSeed's dispatch
    // branch keys on it).
    const detail = showBeads(repo, [integration])[0];
    expect(detail.labels).toContain("integration");
  }, TEST_TIMEOUT);

  it("bd dep cycles exits 0 on the planner-shaped DAG", () => {
    const res = spawnSync("bd", ["dep", "cycles"], { cwd: repo, encoding: "utf8", timeout: 30_000 });
    expect(res.status).toBe(0);
  }, TEST_TIMEOUT);

  it("the plan:* label rewrites round-trip through the bd client", () => {
    // The planner's completion contract: remove plan:planning, add plan:ready
    // (or plan:failed). Exercise every rewrite through the same beads.ts
    // client the intake loop uses.
    expect(addLabel(repo, epicId, "plan:pending")).toBe(true);
    let epic = listOpenEpics(repo).find(e => e.id === epicId);
    expect(epic?.labels).toContain("plan:pending");

    expect(removeLabel(repo, epicId, "plan:pending")).toBe(true);
    expect(addLabel(repo, epicId, "plan:planning")).toBe(true);
    epic = listOpenEpics(repo).find(e => e.id === epicId);
    expect(epic?.labels).toContain("plan:planning");
    expect(epic?.labels).not.toContain("plan:pending");

    expect(removeLabel(repo, epicId, "plan:planning")).toBe(true);
    expect(addLabel(repo, epicId, "plan:ready")).toBe(true);
    epic = listOpenEpics(repo).find(e => e.id === epicId);
    expect(epic?.labels).toContain("plan:ready");
    expect(epic?.labels).not.toContain("plan:planning");

    expect(removeLabel(repo, epicId, "plan:ready")).toBe(true);
  }, TEST_TIMEOUT);

  it("canary: bd create --graph silently drops --ephemeral (why the seed forbids it)", () => {
    // DELEGATION.md's phase-4d sketch wanted ONE `bd create --graph
    // --ephemeral` call. On the installed 1.0.3 the flag is silently ignored
    // — the children come out permanent, which would bypass board's
    // draft-review gate entirely — so buildPlannerSeed pins the per-child
    // spelling instead. If this canary fails, --graph started honoring
    // ephemerality and the single-call contract can be reconsidered.
    const plan = path.join(repo, "graph-plan.json");
    fs.writeFileSync(plan, JSON.stringify({
      nodes: [{ key: "g1", title: "graph canary", type: "task" }],
      edges: [],
    }));
    const out = bd("create", "--graph", plan, "--ephemeral", "--json");
    const ids = (JSON.parse(out) as { ids: Record<string, string> }).ids;
    expect(ids.g1).toBeTruthy();
    expect(exportedEphemeral().get(ids.g1)).toBe(false);
  }, TEST_TIMEOUT);

  it("the plan-consume loop moves a real epic pending -> planning and spawns one planner", () => {
    const planEpic = createBead("consume epic", ["-t", "epic"]);
    bd("update", planEpic, "--design", "Consume-loop design doc.");
    bd("label", "add", planEpic, "plan:pending");

    const spawns: IntakeSpawnRequest[] = [];
    const deps: IntakeDeps = {
      projectName: "planner-it",
      cap: 10,
      listOpenEpics: () => listOpenEpics(repo),
      swarmStatus: (id) => swarmStatus(repo, id),
      showBeads: (ids) => showBeads(repo, ids),
      claim: (id, actor) => claimBead(repo, id, actor),
      reopen: (id, reason) => reopenBead(repo, id, reason),
      unassign: (id) => unassignBead(repo, id),
      addLabel: (id, label) => addLabel(repo, id, label),
      removeLabel: (id, label) => removeLabel(repo, id, label),
      spawn: (req) => { spawns.push(req); return `it-planner-${spawns.length}`; },
      workers: () => [],
      alert: () => { /* not exercised */ },
      nowMs: () => Date.now(),
    };

    expect(runIntakeOnce(deps)).toBe(true);
    expect(spawns).toHaveLength(1);
    expect(spawns[0].workflow).toBe("planner");
    expect(spawns[0].bead).toBeUndefined();
    expect(spawns[0].seed).toContain("Consume-loop design doc.");
    expect(spawns[0].seed).toContain(`--ephemeral --parent ${planEpic}`);
    expect(spawns[0].seed).toContain("plan:ready");

    // Durably at plan:planning before any further wake could act.
    const epic = listOpenEpics(repo).find(e => e.id === planEpic);
    expect(epic?.labels).toContain("plan:planning");
    expect(epic?.labels).not.toContain("plan:pending");

    // Idempotency: a repeated poke spawns nothing further.
    const spawnsBefore = spawns.length;
    expect(runIntakeOnce(deps)).toBe(false);
    expect(spawns).toHaveLength(spawnsBefore);
  }, TEST_TIMEOUT);

  it("an integration-labeled bead dispatches with the assembly seed", () => {
    // Promote-equivalent state: a permanent integration bead ready for
    // dispatch under an armed epic (its leaves already closed). Simplest
    // real construction: a fresh epic whose only child carries the label.
    const gateEpic = createBead("gate epic", ["-t", "epic"]);
    bd("update", gateEpic, "--design", "Gate design doc.");
    const gate = createBead("integration", ["--parent", gateEpic, "-l", "integration"]);
    bd("label", "add", gateEpic, "dispatch:manual");

    const spawns: IntakeSpawnRequest[] = [];
    const deps: IntakeDeps = {
      projectName: "planner-it",
      cap: 10,
      listOpenEpics: () => listOpenEpics(repo),
      swarmStatus: (id) => swarmStatus(repo, id),
      showBeads: (ids) => showBeads(repo, ids),
      claim: (id, actor) => claimBead(repo, id, actor),
      reopen: (id, reason) => reopenBead(repo, id, reason),
      unassign: (id) => unassignBead(repo, id),
      addLabel: (id, label) => addLabel(repo, id, label),
      removeLabel: (id, label) => removeLabel(repo, id, label),
      spawn: (req) => { spawns.push(req); return `it-gate-${spawns.length}`; },
      workers: () => [],
      alert: () => { /* not exercised */ },
      nowMs: () => Date.now(),
    };

    expect(runIntakeOnce(deps)).toBe(true);
    const gateSpawn = spawns.find(s => s.bead === gate);
    expect(gateSpawn).toBeDefined();
    expect(gateSpawn!.seed).toContain("integration gate");
    expect(gateSpawn!.seed).toContain("ASSEMBLED feature");
    // Claim stays identical; a clean verification can close without inventing
    // a commit, while real glue changes still wait for their merge.
    expect(gateSpawn!.seed).toContain(`bd update ${gate} --claim`);
    expect(gateSpawn!.seed).toContain(`bd close ${gate}\` directly`);
    expect(gateSpawn!.seed).toContain("If you make glue changes");
  }, TEST_TIMEOUT);
});

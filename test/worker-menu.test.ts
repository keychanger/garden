// The ⌥i worker menu's pure plan builders. Assert structure + dispatch strings
// without driving tmux. The heavy side-effecting deps worker-menu imports for
// its run*/apply* helpers (header/workers/git) are stubbed so importing the
// module is cheap; the builders themselves use only shellEscape + crewNameFor.
import { describe, it, expect, vi } from "vitest";

vi.mock("../src/dashboard/header.js", () => ({ refreshDashboard: vi.fn() }));
vi.mock("../src/dashboard/workers.js", () => ({ bounceWorker: vi.fn() }));

const {
  buildWorkerMenuPlan, buildWorkerBranchSubmenuPlan, buildWorkerCrewSubmenuPlan,
  buildWorkerModelSubmenuPlan, buildWorkerKillConfirmPlan,
} = await import("../src/dashboard/worker-menu.js");

const view = {
  project: "lex", worker: "bold-ash", runner: "garden",
  state: "reviewing", base: "v2-api", model: "sonnet", reviewer: "codex",
};

describe("buildWorkerMenuPlan", () => {
  it("puts the identity in the title", () => {
    const t = buildWorkerMenuPlan(view).title;
    expect(t).toContain("bold-ash");
    expect(t).toContain("base v2-api");
    expect(t).toContain("model sonnet");
    expect(t).toContain("reviewer codex");
  });

  it("surfaces the worker verbs and the three live config rows", () => {
    const rows = buildWorkerMenuPlan(view).rows;
    const labels = rows.filter(r => !r.sep).map(r => r.label).join(" | ");
    expect(labels).toMatch(/hold \/ resume/);
    expect(labels).toMatch(/bounce/);
    expect(labels).toMatch(/kick review/);
    expect(labels).toMatch(/base branch: v2-api/);
    expect(labels).toMatch(/reviewer: codex/);
    expect(labels).toMatch(/model: sonnet/);
    expect(labels).toMatch(/kill/);
  });

  it("routes the config rows to per-worker submenus with explicit project+worker", () => {
    const rows = buildWorkerMenuPlan(view).rows;
    const base = rows.find(r => r.label.startsWith("(1)"))!;
    const rev = rows.find(r => r.label.startsWith("(2)"))!;
    const model = rows.find(r => r.label.startsWith("(3)"))!;
    expect(base.run).toBe("garden dashboard _worker-branch-submenu lex bold-ash");
    expect(rev.run).toBe("garden dashboard _worker-crew-submenu lex bold-ash");
    expect(model.run).toBe("garden dashboard _worker-model-submenu lex bold-ash");
  });

  it("shows the last review in a display-popup", () => {
    const row = buildWorkerMenuPlan(view).rows.find(r => r.label.includes("show last review"))!;
    expect(row.tmux).toContain("display-popup -E");
    expect(row.tmux).toContain("garden review bold-ash");
  });

  it("has two separators (verbs | config | kill)", () => {
    expect(buildWorkerMenuPlan(view).rows.filter(r => r.sep)).toHaveLength(2);
  });
});

describe("buildWorkerBranchSubmenuPlan", () => {
  it("lists branches (current marked) + an unset row, dispatching _worker-set baseBranch", () => {
    const plan = buildWorkerBranchSubmenuPlan("lex", "bold-ash", ["v2-api", "main"], "v2-api", "garden");
    expect(plan.rows[0].label).toBe("v2-api  ✓");           // current base marked
    expect(plan.rows[0].run).toBe("garden dashboard _worker-set lex bold-ash baseBranch v2-api");
    expect(plan.rows[1].run).toBe("garden dashboard _worker-set lex bold-ash baseBranch main");
    const unset = plan.rows.at(-1)!;
    expect(unset.label).toMatch(/unset/);
    expect(unset.run).toBe("garden dashboard _worker-set lex bold-ash baseBranch ''");  // empty value clears
  });
});

describe("buildWorkerCrewSubmenuPlan", () => {
  it("maps each reviewer member to the crew pairing the worker's build member (crewNameFor)", () => {
    const members = [{ name: "claude", harness: "claude-code" }, { name: "codex", harness: "codex" }];
    // Worker builds with claude (harness undefined), so picking codex => claude-codex.
    const plan = buildWorkerCrewSubmenuPlan("lex", "bold-ash", members, undefined, undefined, "claude-code", "garden");
    const codexRow = plan.rows.find(r => r.label.startsWith("codex"))!;
    expect(codexRow.run).toBe("garden dashboard _worker-set lex bold-ash crew claude-codex");
    const claudeRow = plan.rows.find(r => r.label.startsWith("claude"))!;
    expect(claudeRow.run).toBe("garden dashboard _worker-set lex bold-ash crew all-claude");
    // Current reviewer (claude-code) is marked.
    expect(claudeRow.label).toContain("✓");
    expect(plan.rows.at(-1)!.run).toBe("garden dashboard _worker-set lex bold-ash crew ''");  // unset
  });

  it("a codex-building worker picking codex => all-codex", () => {
    const members = [{ name: "codex", harness: "codex" }];
    const plan = buildWorkerCrewSubmenuPlan("lex", "bold-ash", members, "codex", undefined, "codex", "garden");
    expect(plan.rows[0].run).toBe("garden dashboard _worker-set lex bold-ash crew all-codex");
  });
});

describe("buildWorkerModelSubmenuPlan", () => {
  it("offers common models + custom prompt + clear, each set+bounce", () => {
    const plan = buildWorkerModelSubmenuPlan("lex", "bold-ash", "sonnet", "garden");
    const opus = plan.rows.find(r => r.label.startsWith("opus"))!;
    expect(opus.run).toBe("garden dashboard _worker-set-bounce lex bold-ash model opus");
    expect(plan.rows.find(r => r.label.includes("sonnet"))!.label).toContain("✓");  // current marked
    expect(plan.rows.find(r => r.label.includes("custom"))!.tmux).toContain("command-prompt");
    expect(plan.rows.at(-1)!.run).toBe("garden dashboard _worker-set-bounce lex bold-ash model ''");  // clear
  });
});

describe("buildWorkerKillConfirmPlan", () => {
  it("confirms yes (focused kill) / cancel (re-open menu)", () => {
    const plan = buildWorkerKillConfirmPlan("lex", "bold-ash", "garden");
    expect(plan.rows[0].run).toBe("garden dashboard _kill-pane");
    expect(plan.rows[1].run).toBe("garden dashboard _worker-menu lex bold-ash");
  });
});

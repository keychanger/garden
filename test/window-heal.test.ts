import { describe, it, expect } from "vitest";
import { planWindowHeals } from "../src/dashboard/window-heal.js";
import type { SessionPane } from "../src/dashboard/tmux.js";
import type { WorkerRegistry, WorkerEntry } from "../src/dashboard/registry.js";

function entry(name: string, worktreePath: string): WorkerEntry {
  return { name, sessionId: "s", task: "", worktreePath };
}

const WT = (project: string, worker: string) =>
  `/home/u/.garden/worktrees/${project}/${worker}`;

function registry(): WorkerRegistry {
  return {
    workers: {
      garden: [entry("firm-hale-ledge", WT("garden", "firm-hale-ledge"))],
      wolf: [entry("east-rough-snow", WT("wolf", "east-rough-snow"))],
      "leadingtone-io": [entry("cool-drawn-glow", WT("leadingtone-io", "cool-drawn-glow"))],
    },
  } as WorkerRegistry;
}

function pane(windowId: string, windowName: string, panePath: string): SessionPane {
  return { windowId, windowName, paneId: `%${windowId.slice(1)}`, width: 100, height: 50, panePath };
}

describe("planWindowHeals", () => {
  it("re-files a duplicated worker name onto the worker its pane holds", () => {
    // The 2026-08-22 incident shape: several windows named for one live worker,
    // each actually holding a different worker's pane.
    const plan = planWindowHeals([
      pane("@1", "_leadingtone-io-worker-cool-drawn-glow", WT("leadingtone-io", "cool-drawn-glow")),
      pane("@2", "_leadingtone-io-worker-cool-drawn-glow", WT("garden", "firm-hale-ledge")),
      pane("@3", "_leadingtone-io-worker-cool-drawn-glow", WT("wolf", "east-rough-snow")),
    ], registry());

    expect(plan.renames).toEqual(expect.arrayContaining([
      { windowId: "@2", from: "_leadingtone-io-worker-cool-drawn-glow", to: "_garden-worker-firm-hale-ledge" },
      { windowId: "@3", from: "_leadingtone-io-worker-cool-drawn-glow", to: "_wolf-worker-east-rough-snow" },
    ]));
    expect(plan.renames).toHaveLength(2);
    expect(plan.conflicts).toEqual([]);
  });

  it("leaves a unique correctly-named live-worker window alone even when its cwd wanders", () => {
    // A worker's Bash foreground can transiently sit in a sibling worktree;
    // a unique name claiming a live worker is not evidence of misfiling.
    const plan = planWindowHeals([
      pane("@1", "_wolf-worker-east-rough-snow", WT("garden", "firm-hale-ledge")),
    ], registry());
    expect(plan.renames).toEqual([]);
    expect(plan.conflicts).toEqual([]);
  });

  it("re-files a window named for a worker that no longer exists", () => {
    const plan = planWindowHeals([
      pane("@1", "_wolf-worker-long-dead-vole", WT("garden", "firm-hale-ledge")),
    ], registry());
    expect(plan.renames).toEqual([
      { windowId: "@1", from: "_wolf-worker-long-dead-vole", to: "_garden-worker-firm-hale-ledge" },
    ]);
  });

  it("re-files quarantined _stray- windows", () => {
    const plan = planWindowHeals([
      pane("@4", "_stray-4", WT("wolf", "east-rough-snow")),
    ], registry());
    expect(plan.renames).toEqual([
      { windowId: "@4", from: "_stray-4", to: "_wolf-worker-east-rough-snow" },
    ]);
  });

  it("reports a conflict instead of renaming when the true name is already taken", () => {
    const plan = planWindowHeals([
      pane("@1", "_wolf-worker-east-rough-snow", WT("wolf", "east-rough-snow")),
      pane("@2", "_stray-2", WT("wolf", "east-rough-snow")),
    ], registry());
    expect(plan.renames).toEqual([]);
    expect(plan.conflicts).toEqual([
      { windowId: "@2", name: "_stray-2", expected: "_wolf-worker-east-rough-snow" },
    ]);
  });

  it("never touches shell, poller, review, or garden windows in worker worktrees", () => {
    const plan = planWindowHeals([
      pane("@1", "_wolf-shell", WT("wolf", "east-rough-snow")),
      pane("@2", "_wolf-poller", WT("wolf", "east-rough-snow")),
      pane("@3", "_wolf-review-east-rough-snow", WT("wolf", "east-rough-snow")),
      pane("@4", "main", WT("wolf", "east-rough-snow")),
      pane("@5", "_garden-growhouse", WT("wolf", "east-rough-snow")),
    ], registry());
    expect(plan.renames).toEqual([]);
    expect(plan.conflicts).toEqual([]);
  });

  it("matches pane paths inside a worktree, not only at its root", () => {
    const plan = planWindowHeals([
      pane("@1", "_stray-1", WT("garden", "firm-hale-ledge") + "/src/dashboard"),
    ], registry());
    expect(plan.renames).toEqual([
      { windowId: "@1", from: "_stray-1", to: "_garden-worker-firm-hale-ledge" },
    ]);
  });

  it("does not match a sibling worktree by prefix", () => {
    const reg = {
      workers: {
        garden: [entry("firm", WT("garden", "firm"))],
      },
    } as WorkerRegistry;
    const plan = planWindowHeals([
      pane("@1", "_stray-1", WT("garden", "firm-hale-ledge")),
    ], reg);
    expect(plan.renames).toEqual([]);
  });

  it("ignores panes outside any registered worktree", () => {
    const plan = planWindowHeals([
      pane("@1", "_stray-1", "/home/u/code/somewhere-else"),
    ], registry());
    expect(plan.renames).toEqual([]);
    expect(plan.conflicts).toEqual([]);
  });

  it("plans one rename per target worker; extra claimants become conflicts", () => {
    const plan = planWindowHeals([
      pane("@1", "_stray-1", WT("garden", "firm-hale-ledge")),
      pane("@2", "_stray-2", WT("garden", "firm-hale-ledge")),
    ], registry());
    expect(plan.renames).toEqual([
      { windowId: "@1", from: "_stray-1", to: "_garden-worker-firm-hale-ledge" },
    ]);
    expect(plan.conflicts).toEqual([
      { windowId: "@2", name: "_stray-2", expected: "_garden-worker-firm-hale-ledge" },
    ]);
  });
});

// Window-name heal: re-file worker windows whose NAME disagrees with the
// worker their pane actually contains.
//
// Hidden worker windows are the status pane's source of truth for which
// workers exist, so a misnamed window makes a live worker invisible and its
// name-holder show a phantom row. Names go wrong two ways: a rename that
// silently failed mid-swap (fixed at the source in layout.ts, but any window
// misfiled before that fix persists indefinitely), and a respawn race that
// leaves two windows claiming one worker. The pane itself carries ground
// truth — a worker pane's processes live in that worker's worktree — so the
// heal joins pane cwd against the registry's worktree paths and renames each
// misfiled window (by window id, the only unambiguous handle) back to the
// worker it really holds. `_stray-` windows quarantined by layout.ts re-enter
// the fleet the same way.
//
// Conservative by design: only windows already claiming to be worker windows
// (or quarantined strays) are considered — reviewer / ci-fix / shell / poller
// windows legitimately run in worker worktrees and are never touched — and a
// window whose true name is already taken is reported, never killed (two live
// panes claiming one worker is an operator decision; see
// feedback: never auto-cleanup workers).
import { isWorkerWindow, parseWorkerWindow, workerWindowName } from "./window-names.js";
import { listSessionPanes, renameWindowById, type SessionPane } from "./tmux.js";
import { readRegistry, type WorkerRegistry } from "./registry.js";
import { addAlert } from "./alerts.js";
import { log } from "./log.js";

export interface WindowHealPlan {
  renames: Array<{ windowId: string; from: string; to: string }>;
  // A window whose pane belongs to a worker whose correctly-named window
  // already exists (that one counted, this one is surplus) — two live panes
  // claiming one worker. Surfaced, never resolved automatically.
  conflicts: Array<{ windowId: string; name: string; expected: string }>;
}

const STRAY_PREFIX = "_stray-";

function healEligible(name: string): boolean {
  return name.startsWith(STRAY_PREFIX) || isWorkerWindow(name);
}

// Pure planner: one pane snapshot + one registry snapshot in, the rename set
// out. A window is misfiled when its pane's cwd sits inside a registered
// worker's worktree but its name says otherwise. First pane per window decides
// (worker windows are single-pane).
export function planWindowHeals(panes: SessionPane[], registry: WorkerRegistry): WindowHealPlan {
  const byWorktree = new Map<string, { project: string; worker: string }>();
  for (const [project, entries] of Object.entries(registry.workers)) {
    for (const e of entries) {
      if (e.worktreePath) byWorktree.set(e.worktreePath, { project, worker: e.name });
    }
  }

  const seenWindows = new Set<string>();
  const nameCounts = new Map<string, number>();
  for (const pane of panes) {
    if (seenWindows.has(pane.windowId)) continue;
    seenWindows.add(pane.windowId);
    nameCounts.set(pane.windowName, (nameCounts.get(pane.windowName) ?? 0) + 1);
  }

  seenWindows.clear();
  const claimed = new Set<string>();
  const plan: WindowHealPlan = { renames: [], conflicts: [] };

  for (const pane of panes) {
    if (seenWindows.has(pane.windowId)) continue;
    seenWindows.add(pane.windowId);
    if (!healEligible(pane.windowName)) continue;

    const owner = worktreeOwner(pane.panePath, byWorktree);
    if (!owner) continue;
    const expected = workerWindowName(owner.project, owner.worker);
    if (pane.windowName === expected) {
      claimed.add(expected);
      continue;
    }
    // A window whose name is a live worker's is renamed on cwd evidence ONLY
    // when that name is duplicated: worker names are unique, so duplicates
    // prove at most one holder is right, and the pane's worktree says which
    // worker this one really holds. A unique, correctly-parsing name is left
    // alone — its own agent may just be running a command in a sibling
    // worktree, and pane cwd tracks the foreground process.
    const parsed = parseWorkerWindow(pane.windowName);
    const namesLiveWorker = parsed !== null
      && (registry.workers[parsed.project] ?? []).some(e => e.name === parsed.worker);
    if (namesLiveWorker && (nameCounts.get(pane.windowName) ?? 0) < 2) continue;

    if ((nameCounts.get(expected) ?? 0) > 0 || claimed.has(expected)) {
      plan.conflicts.push({ windowId: pane.windowId, name: pane.windowName, expected });
      continue;
    }
    claimed.add(expected);
    plan.renames.push({ windowId: pane.windowId, from: pane.windowName, to: expected });
  }
  return plan;
}

function worktreeOwner(
  panePath: string,
  byWorktree: Map<string, { project: string; worker: string }>,
): { project: string; worker: string } | null {
  for (const [worktree, owner] of byWorktree) {
    if (panePath === worktree || panePath.startsWith(worktree + "/")) return owner;
  }
  return null;
}

// Apply the plan against live tmux. Returns the number of windows renamed.
// Callers serialize against navigation via the state lock so the heal cannot
// observe a swap between its swap-pane and rename steps.
export function healWorkerWindows(): number {
  const plan = planWindowHeals(listSessionPanes(), readRegistry());
  let healed = 0;
  for (const r of plan.renames) {
    if (renameWindowById(r.windowId, r.to)) {
      healed++;
      log.info("watchdog", "healed misfiled worker window", {
        data: { windowId: r.windowId, from: r.from, to: r.to },
      });
    }
  }
  for (const c of plan.conflicts) {
    // expected comes from workerWindowName(), so it always parses back.
    const parsed = parseWorkerWindow(c.expected);
    if (!parsed) continue;
    addAlert({
      level: "warn",
      source: "watchdog",
      project: parsed.project,
      worker: parsed.worker,
      message:
        `Two tmux windows hold panes for worker '${parsed.worker}' ` +
        `('${c.expected}' plus '${c.name}' at ${c.windowId}). One is surplus — ` +
        `likely a duplicate agent launch. Inspect both and kill the stale one ` +
        `(tmux kill-window -t ${c.windowId} if that is the surplus). [window-dup]`,
      dedupKey: `window-heal-conflict:${c.expected}:${c.windowId}`,
    });
  }
  return healed;
}

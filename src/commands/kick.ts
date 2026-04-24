import { readRegistry, updateWorkerFields } from "../dashboard/registry.js";
import { triggerProjectPoll } from "../dashboard/poller.js";
import { getCommitSummary, getWorkerBaseBranch } from "../dashboard/git.js";
import { tryGetProject } from "../config.js";

export async function kick(args: string[]): Promise<void> {
  const workerName = args[0];
  if (!workerName) throw new Error("Usage: garden kick <worker>");

  const registry = readRegistry();
  const matches: Array<{
    project: string;
    worker: string;
    state?: string;
    claudeStatus?: string;
  }> = [];
  for (const [project, entries] of Object.entries(registry.workers)) {
    for (const entry of entries) {
      if (entry.name === workerName) {
        matches.push({
          project,
          worker: entry.name,
          state: entry.prState,
          claudeStatus: entry.claudeStatus,
        });
      }
    }
  }

  if (matches.length === 0) {
    throw new Error(`No worker found with name '${workerName}'`);
  }
  if (matches.length > 1) {
    const list = matches.map(m => `  ${m.project}/${m.worker} (${m.state ?? "working"})`).join("\n");
    throw new Error(`Multiple workers match '${workerName}':\n${list}\nKill or rename one first.`);
  }

  const { project, state, claudeStatus } = matches[0];
  if (state && state !== "working") {
    throw new Error(
      `Worker ${project}/${workerName} is in state '${state}', not 'working'. ` +
      `Kick only re-arms workers stranded in working — for other states, investigate the ` +
      `poller log or the alerts panel.`,
    );
  }
  // A reviewer racing a live worker can force-push over unfinished commits.
  if (claudeStatus === "working" || claudeStatus === "asking") {
    throw new Error(
      `Worker ${project}/${workerName} is currently ${claudeStatus} — Claude is ` +
      `still mid-turn. Kick only re-arms workers whose turn has ended ` +
      `(claudeStatus=idle). Wait for the Stop hook, or if you believe the ` +
      `status is truly stuck, edit the registry directly.`,
    );
  }

  const projectInfo = tryGetProject(project);
  if (projectInfo) {
    const entry = registry.workers[project].find(e => e.name === workerName);
    const wtPath = entry?.worktreePath ?? projectInfo.path;
    const baseBranch = getWorkerBaseBranch(entry ?? {}, projectInfo.path);
    const commits = getCommitSummary(wtPath, baseBranch);
    if (!commits) {
      throw new Error(
        `Worker ${project}/${workerName} has no commits ahead of ${baseBranch} — nothing to review.`,
      );
    }
  }

  updateWorkerFields(project, workerName, { pendingReviewAt: Date.now() });
  triggerProjectPoll(project);
  console.log(`Kicked ${project}/${workerName} — review queued.`);
}

// Re-arm a worker for review and poke its project poller. Used to recover
// workers that are stranded in `working` with no active Claude session to
// fire a Stop hook — e.g. after a reviewer-push race reset them, or after
// a crashed poller dropped the pendingReviewAt flag. Mirrors what the Stop
// hook would do if fresh commits had just landed.
import { readRegistry, updateWorkerFields } from "../dashboard/registry.js";
import { triggerProjectPoll } from "../dashboard/poller.js";
import { getCommitSummary, resolveBaseBranch } from "../dashboard/git.js";
import { tryGetProject } from "../config.js";

export async function kick(args: string[]): Promise<void> {
  const workerName = args[0];
  if (!workerName) throw new Error("Usage: garden kick <worker>");

  const registry = readRegistry();
  const matches: Array<{ project: string; worker: string; state?: string }> = [];
  for (const [project, entries] of Object.entries(registry.workers)) {
    for (const entry of entries) {
      if (entry.name === workerName) {
        matches.push({ project, worker: entry.name, state: entry.prState });
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

  const { project, state } = matches[0];
  if (state && state !== "working") {
    throw new Error(
      `Worker ${project}/${workerName} is in state '${state}', not 'working'. ` +
      `Kick only re-arms workers stranded in working — for other states, investigate the ` +
      `poller log or the alerts panel.`,
    );
  }

  const projectInfo = tryGetProject(project);
  if (projectInfo) {
    const wtPath = registry.workers[project].find(e => e.name === workerName)?.worktreePath
      ?? projectInfo.path;
    const baseBranch = resolveBaseBranch(projectInfo.path, projectInfo);
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

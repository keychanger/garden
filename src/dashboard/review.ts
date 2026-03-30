// Review worker spawning: creates a reviewer Claude session for a PR.
import { DASHBOARD_SESSION } from "../session.js";
import {
  tmux, setPaneLabel, getFirstPaneId,
} from "./tmux.js";
import { generateWorkerName } from "./names.js";
import { addWorker, getAllWorkerNames } from "./registry.js";
import { refreshDashboard } from "./header.js";
import { log } from "./log.js";
import { buildReviewWorkerCommand, resolveGardenRunner } from "./create.js";

export function spawnReviewWorker(
  projectName: string,
  projectPath: string,
  parent: { name: string; worktreePath?: string; branchName?: string; prNumber?: number },
  prNumber: number,
): string {
  const existingNames = getAllWorkerNames();
  const reviewerName = generateWorkerName(existingNames);
  const branchName = parent.branchName ?? parent.name;
  const wtPath = parent.worktreePath ?? projectPath;
  const gardenRunner = resolveGardenRunner();

  const cmd = buildReviewWorkerCommand(
    projectName, projectPath, branchName, prNumber, gardenRunner, reviewerName,
  );

  const windowName = `_${projectName}-worker-${reviewerName}`;
  tmux("new-window", "-d", "-t", DASHBOARD_SESSION, "-n", windowName, "-c", wtPath,
    "sh", "-c", cmd);

  const paneId = getFirstPaneId(`${DASHBOARD_SESSION}:${windowName}`);
  if (paneId) setPaneLabel(paneId, reviewerName);

  addWorker(projectName, {
    name: reviewerName,
    sessionId: "",
    task: `reviewing PR #${prNumber}`,
    worktreePath: parent.worktreePath,
    branchName,
    prNumber,
    role: "reviewer",
    parentWorker: parent.name,
  });

  refreshDashboard();
  log.info("review", "review worker spawned", { reviewerName, prNumber });
  return reviewerName;
}

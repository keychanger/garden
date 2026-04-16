// Clears the worker registry, removing all saved worker sessions.
import fs from "node:fs";
import readline from "node:readline";
import { REGISTRY_FILE, readRegistry } from "../dashboard/registry.js";
import { tryGetProject } from "../config.js";
import { deleteRemoteBranch } from "../dashboard/git.js";

export async function reset(_args: string[]): Promise<void> {
  const registry = readRegistry();
  const totalWorkers = Object.values(registry.workers).flat().length;

  if (totalWorkers === 0) {
    console.log("Registry is already empty.");
    return;
  }

  const projectCount = Object.keys(registry.workers).length;
  console.log(`This will clear ${totalWorkers} worker(s) across ${projectCount} project(s).`);
  console.log("Resumed sessions will no longer be available.");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>(resolve => {
    rl.question("Are you sure? [y/N] ", resolve);
  });
  rl.close();

  if (answer.toLowerCase() !== "y") {
    console.log("Cancelled.");
    return;
  }

  for (const [projectName, workers] of Object.entries(registry.workers)) {
    const project = tryGetProject(projectName);
    if (!project) continue;
    for (const worker of workers) {
      if (worker.branchName) {
        deleteRemoteBranch(project.path, worker.branchName);
      }
    }
  }

  try { fs.unlinkSync(REGISTRY_FILE); } catch { /* already gone */ }
  console.log("Registry cleared.");
}

// Worker registry: persistent record of living workers across dashboard restarts.
import fs from "node:fs";
import path from "node:path";
import { SESSIONS_DIR } from "../config.js";
import { log } from "./log.js";

export interface WorkerEntry {
  name: string;       // adjective-noun name, e.g. "swift-oak"
  sessionId: string;  // claude session UUID for direct resume
  task: string;       // last known task summary from pane title
  worktreePath?: string;
  branchName?: string;
  prNumber?: number;
  prState?: string;
  lastSeenSha?: string;
  lastShaChangeAt?: string;
}

export interface WorkerRegistry {
  workers: Record<string, WorkerEntry[]>;
}

export const REGISTRY_FILE = path.join(SESSIONS_DIR, "dashboard.registry.json");

export function readRegistry(): WorkerRegistry {
  try {
    if (fs.existsSync(REGISTRY_FILE)) {
      return JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf-8"));
    }
  } catch (err) {
    log.warn("registry", "failed to read registry, using empty", {
      file: REGISTRY_FILE,
      error: String(err),
    });
  }
  return { workers: {} };
}

export function writeRegistry(registry: WorkerRegistry): void {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const tmpFile = REGISTRY_FILE + ".tmp";
  fs.writeFileSync(tmpFile, JSON.stringify(registry, null, 2));
  fs.renameSync(tmpFile, REGISTRY_FILE);
}

export function addWorker(project: string, entry: WorkerEntry): void {
  const registry = readRegistry();
  if (!registry.workers[project]) registry.workers[project] = [];
  registry.workers[project].push(entry);
  writeRegistry(registry);
}

export function removeWorker(project: string, workerName: string): void {
  const registry = readRegistry();
  const entries = registry.workers[project];
  if (!entries) return;
  registry.workers[project] = entries.filter(e => e.name !== workerName);
  if (registry.workers[project].length === 0) delete registry.workers[project];
  writeRegistry(registry);
}

export function updateWorkerTask(project: string, workerName: string, task: string): void {
  const registry = readRegistry();
  const entries = registry.workers[project];
  if (!entries) return;
  const entry = entries.find(e => e.name === workerName);
  if (!entry) return;
  entry.task = task;
  writeRegistry(registry);
}

export function updateWorkerFields(
  project: string,
  workerName: string,
  fields: Partial<Omit<WorkerEntry, "name">>,
): void {
  const registry = readRegistry();
  const entries = registry.workers[project];
  if (!entries) return;
  const entry = entries.find(e => e.name === workerName);
  if (!entry) return;
  Object.assign(entry, fields);
  writeRegistry(registry);
}

export function findWorkerByName(
  project: string,
  workerName: string,
): WorkerEntry | undefined {
  return getWorkers(project).find(e => e.name === workerName);
}

export function getWorkers(project: string): WorkerEntry[] {
  return readRegistry().workers[project] ?? [];
}

export function getAllWorkerNames(): string[] {
  const registry = readRegistry();
  const names: string[] = [];
  for (const entries of Object.values(registry.workers)) {
    for (const entry of entries) {
      names.push(entry.name);
    }
  }
  return names;
}

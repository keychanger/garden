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
  prState?: string;
  mergeCount?: number;
  lastSeenSha?: string;
  lastShaChangeAt?: string;
  mergedAt?: string;
  failCount?: number;
  failingSha?: string;
  claudeStatus?: string;  // cached process status from last pgrep detection
  reviewWindowName?: string;
  mergePendingAt?: string;
  lastReviewBody?: string;
  role?: string;
  parentWorker?: string;
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
      data: { error: String(err) },
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

  // Log state transitions when prState changes
  if (fields.prState && fields.prState !== entry.prState) {
    log.info("poller", `${entry.prState ?? "new"} -> ${fields.prState}`, {
      worker: workerName,
    });
  }

  Object.assign(entry, fields);
  writeRegistry(registry);
}

export function batchUpdateWorkerFields(
  updates: Array<{ project: string; workerName: string; fields: Partial<Omit<WorkerEntry, "name">> }>,
): void {
  if (updates.length === 0) return;
  const registry = readRegistry();
  for (const { project, workerName, fields } of updates) {
    const entries = registry.workers[project];
    if (!entries) continue;
    const entry = entries.find(e => e.name === workerName);
    if (!entry) continue;
    if (fields.prState && fields.prState !== entry.prState) {
      log.info("poller", `${entry.prState ?? "new"} -> ${fields.prState}`, {
        worker: workerName,
      });
    }
    Object.assign(entry, fields);
  }
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

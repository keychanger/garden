// Centralized window naming conventions for the dashboard.
// All tmux window name construction, parsing, and classification lives here.
// Consumer files import from this module instead of hardcoding patterns.

export type GardenView = "growhouse" | "root" | "logs" | "history" | "diary";

// --- Construction ---

export function workerWindowName(project: string, worker: string): string {
  return `_${project}-worker-${worker}`;
}

export function shellWindowName(project: string): string {
  return `_${project}-shell`;
}

export function parkingWindowName(project: string): string {
  return `_${project}-active`;
}

export function pollerWindowName(project: string): string {
  return `_${project}-poller`;
}

export function reviewWindowName(project: string, worker: string): string {
  return `_${project}-review-${worker}`;
}

export function ciFixWindowName(project: string, worker: string): string {
  return `_${project}-ci-fix-${worker}`;
}

export function gardenWindowName(view: GardenView): string {
  return `_garden-${view}`;
}

export function usagePollerWindowName(): string {
  return "_garden-usage-poller";
}

export function watchdogWindowName(): string {
  return "_garden-watchdog";
}

export function workerWindowPrefix(project: string): string {
  return `_${project}-worker-`;
}

// --- Parsing ---

const WORKER_WINDOW_RE = /^_(.+)-worker-(.+)$/;

export function parseWorkerWindow(name: string): { project: string; worker: string } | null {
  const match = name.match(WORKER_WINDOW_RE);
  if (!match) return null;
  return { project: match[1], worker: match[2] };
}

export function parseWorkerSuffix(name: string): string | null {
  const match = name.match(/-worker-(.+)$/);
  if (!match) return null;
  return match[1];
}

// --- Classification ---

const GARDEN_VIEWS = new Set<string>(["growhouse", "root", "logs", "history", "diary"]);

export function isGardenWindow(name: string): boolean {
  return name === "_garden-growhouse" || name === "_garden-root"
    || name === "_garden-logs" || name === "_garden-history"
    || name === "_garden-diary";
}

export function isWorkerWindow(name: string): boolean {
  return WORKER_WINDOW_RE.test(name);
}

export { GARDEN_VIEWS };

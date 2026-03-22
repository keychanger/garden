import fs from "node:fs";
import path from "node:path";
import { GARDEN_DIR } from "./config.js";

const EVENTS_PATH = path.join(GARDEN_DIR, "events.jsonl");

export interface GardenEvent {
  time: string;
  project: string;
  event: string;
  [key: string]: unknown;
}

export function emit(project: string, event: string, data?: Record<string, unknown>): void {
  const entry: GardenEvent = {
    time: new Date().toISOString(),
    project,
    event,
    ...data,
  };
  fs.mkdirSync(GARDEN_DIR, { recursive: true });
  fs.appendFileSync(EVENTS_PATH, JSON.stringify(entry) + "\n");
}

export function readEvents(since?: Date): GardenEvent[] {
  if (!fs.existsSync(EVENTS_PATH)) return [];

  const lines = fs.readFileSync(EVENTS_PATH, "utf-8").trim().split("\n");
  const events: GardenEvent[] = [];

  for (const line of lines) {
    if (!line) continue;
    try {
      const event = JSON.parse(line) as GardenEvent;
      if (since && new Date(event.time) < since) continue;
      events.push(event);
    } catch {
      // skip malformed lines
    }
  }
  return events;
}

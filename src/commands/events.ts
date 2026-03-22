// Displays the event log, optionally filtered by a --since time range.
import { readEvents, type GardenEvent } from "../events.js";
import { outputLines } from "../output.js";

export async function events(args: string[]): Promise<void> {
  let since: Date | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--since" && args[i + 1]) {
      since = parseSince(args[++i]);
    }
  }

  const entries = readEvents(since);

  if (entries.length === 0) {
    console.log("No events.");
    return;
  }

  outputLines(entries, (item) => {
    const e = item as GardenEvent;
    const time = new Date(e.time).toLocaleTimeString("en-US", { hour12: false });
    const parts = [time, e.project.padEnd(14), e.event];

    if ("description" in e) parts.push(String(e.description));
    if ("reason" in e) parts.push(`— ${String(e.reason)}`);
    if ("mode" in e) parts.push(`(${String(e.mode)})`);
    if ("taskId" in e) parts.push(`[${String(e.taskId)}]`);

    return parts.join("  ");
  });
}

function parseSince(value: string): Date {
  // Support "1h", "30m", "2d" relative formats
  const match = value.match(/^(\d+)([mhd])$/);
  if (match) {
    const amount = parseInt(match[1], 10);
    const unit = match[2];
    const ms = { m: 60_000, h: 3_600_000, d: 86_400_000 }[unit]!;
    return new Date(Date.now() - amount * ms);
  }
  // Otherwise try ISO date
  const d = new Date(value);
  if (isNaN(d.getTime())) throw new Error(`Invalid time: ${value}`);
  return d;
}

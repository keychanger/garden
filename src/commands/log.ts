import { readLog } from "../session.js";
import { getProject } from "../config.js";
import { output } from "../output.js";

export async function log(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) throw new Error("Usage: garden log <name>");

  getProject(name);
  const content = readLog(name);
  output({ project: name, log: content }, () => content);
}

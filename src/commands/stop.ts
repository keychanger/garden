import { tmuxSessionExists, killTmuxSession, clearState, clearLog } from "../session.js";
import { emit } from "../events.js";

export async function stop(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) throw new Error("Usage: garden stop <name>");

  if (!tmuxSessionExists(name)) {
    throw new Error(`No running session for '${name}'.`);
  }

  killTmuxSession(name);
  clearState(name);
  clearLog(name);
  emit(name, "session_stop");
  console.log(`Stopped session '${name}'.`);
}

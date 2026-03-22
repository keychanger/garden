// Signals a paused session to advance to the next task.
// With --auto, also switches the session to auto mode.
import { tmuxSessionExists, readState, writeState, sendSignal } from "../session.js";
import { resolveProjectFromArgs } from "../config.js";

export async function next(args: string[]): Promise<void> {
  const auto = args.includes("--auto");
  const filtered = args.filter((a) => a !== "--auto");
  const { project } = resolveProjectFromArgs(filtered);
  const name = project.name;

  if (!tmuxSessionExists(name)) {
    throw new Error(`No running session for '${name}'.`);
  }

  if (auto) {
    const state = readState(name);
    if (!state) {
      throw new Error(`No state found for '${name}'.`);
    }
    writeState(name, { ...state, mode: "auto" });
  }

  sendSignal(name);

  if (auto) {
    console.log(`Switched '${name}' to auto mode and signaled to continue.`);
  } else {
    console.log(`Signaled '${name}' to continue.`);
  }
}

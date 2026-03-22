// Switches a session from auto mode to paused so it stops after the current task.
import { tmuxSessionExists, readState, writeState } from "../session.js";
import { resolveProjectFromArgs } from "../config.js";

export async function pause(args: string[]): Promise<void> {
  const { project } = resolveProjectFromArgs(args);
  const name = project.name;

  if (!tmuxSessionExists(name)) {
    throw new Error(`No running session for '${name}'.`);
  }

  const state = readState(name);
  if (!state) {
    throw new Error(`No state found for '${name}'.`);
  }

  if (state.mode === "paused") {
    console.log(`'${name}' is already in paused mode.`);
    return;
  }

  writeState(name, { ...state, mode: "paused" });
  console.log(`'${name}' will pause after the current task finishes.`);
}

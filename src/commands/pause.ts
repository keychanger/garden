import { tmuxSessionExists, readState, writeState } from "../session.js";

export async function pause(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) throw new Error("Usage: garden pause <name>");

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

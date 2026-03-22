import { tmuxSessionExists, sendSignal } from "../session.js";

export async function next(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) throw new Error("Usage: garden next <name>");

  if (!tmuxSessionExists(name)) {
    throw new Error(`No running session for '${name}'.`);
  }

  sendSignal(name);
  console.log(`Signaled '${name}' to continue.`);
}

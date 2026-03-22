import { tmuxSessionExists, attachTmuxSession, checkTmux } from "../session.js";

export async function attach(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) throw new Error("Usage: garden attach <name>");

  checkTmux();

  if (!tmuxSessionExists(name)) {
    throw new Error(`No running session for '${name}'. Start one with 'garden start ${name}'.`);
  }

  attachTmuxSession(name);
}

// Attaches the terminal to a running project's tmux session.
import { tmuxSessionExists, attachTmuxSession, checkTmux } from "../session.js";
import { resolveProjectFromArgs } from "../config.js";

export async function attach(args: string[]): Promise<void> {
  checkTmux();
  const { project } = resolveProjectFromArgs(args);
  const name = project.name;

  if (!tmuxSessionExists(name)) {
    throw new Error(`No running session for '${name}'. Start one with 'garden start ${name}'.`);
  }

  console.log(`Attaching to ${name}... (detach with ctrl-b d)`);
  attachTmuxSession(name);
}

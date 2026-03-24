// Stops a running session by killing its tmux session and clearing state.
import { tmuxSessionExists, killTmuxSession, clearState, listTmuxSessions } from "../session.js";
import { resolveProjectFromArgs, getProject, loadConfig } from "../config.js";
import { resetInProgress } from "../tasks.js";
import { emit } from "../events.js";

function stopOne(name: string, projectPath: string): void {
  killTmuxSession(name);
  clearState(name);
  resetInProgress(projectPath);
  emit(name, "session_stop");
  console.log(`Stopped ${name}.`);
}

export async function stop(args: string[]): Promise<void> {
  if (args[0] === "--all" || args[0] === "-a") {
    const sessions = listTmuxSessions();
    if (sessions.length === 0) {
      console.log("No running sessions.");
      return;
    }
    const config = loadConfig();
    for (const name of sessions) {
      const projectPath = config.projects[name]?.path;
      if (projectPath) {
        stopOne(name, projectPath);
      } else {
        // Skip non-project sessions (e.g., dashboard)
        continue;
      }
    }
    return;
  }

  const { project } = resolveProjectFromArgs(args);

  if (!tmuxSessionExists(project.name)) {
    throw new Error(`No running session for '${project.name}'.`);
  }

  stopOne(project.name, project.path);
}

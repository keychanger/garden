// Kills tmux server and rebuilds garden. Useful for dev iteration.
// Works from inside the dashboard — spawns a detached process that survives the tmux kill.
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { shellEscape } from "../dashboard/tmux.js";

export async function rebuild(_args: string[]): Promise<void> {
  // This command drives iTerm and tmux via osascript to quit, rebuild, and
  // relaunch the dashboard. It is macOS + iTerm specific; on any other platform
  // it would kill the tmux session and never bring the dashboard back. Fail
  // loudly with the manual steps instead.
  if (process.platform !== "darwin") {
    throw new Error(
      "garden rebuild automates iTerm and tmux on macOS. On this platform, rebuild " +
      "manually: run `git pull && npm run build`, then relaunch the dashboard.",
    );
  }

  const gardenRoot = findGardenRoot();
  if (!gardenRoot) {
    throw new Error("Could not find garden project root (no package.json found).");
  }

  // Build the script that will run detached from this process/tmux
  const script = `
    # Kill iTerm and tmux
    osascript -e 'tell application "iTerm" to quit' 2>/dev/null
    sleep 0.3
    tmux kill-session -t garden-dashboard 2>/dev/null
    sleep 0.3

    # Pull latest and build
    cd ${shellEscape(gardenRoot)} && git pull && npm run build

    # Relaunch iTerm with dashboard
    osascript -e '
      tell application "iTerm"
        activate
        repeat 20 times
          try
            if (count of windows) > 0 then
              tell current session of current window
                write text "garden dashboard"
              end tell
              exit repeat
            end if
          end try
          delay 0.5
        end repeat
      end tell
    '
  `;

  // Spawn detached — survives tmux/iTerm dying
  const child = spawn("sh", ["-c", script], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  console.log("Rebuilding... dashboard will relaunch shortly.");
}

function findGardenRoot(): string | null {
  const realBin = fs.realpathSync(process.argv[1]);
  let dir = path.dirname(realBin);
  for (let i = 0; i < 5; i++) {
    const pkgPath = path.join(dir, "package.json");
    if (fs.existsSync(pkgPath)) {
      // A malformed package.json (mid-edit, partial download, etc.) crashed
      // `garden rebuild` with a generic JSON parse error before the fix.
      // Surface the path so the operator knows which file to fix.
      let pkg: { name?: unknown };
      try {
        pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      } catch (err) {
        throw new Error(`failed to parse ${pkgPath}: ${String(err)}`);
      }
      if (pkg.name === "garden") return dir;
    }
    dir = path.dirname(dir);
  }
  return null;
}


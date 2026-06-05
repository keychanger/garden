// Opens the project's diary in $EDITOR.
import { spawnSync } from "node:child_process";
import { resolveProjectFromArgs } from "../config.js";
import { shellEscape } from "../dashboard/tmux.js";
import { diaryFilePath } from "../diary.js";

export async function diary(args: string[]): Promise<void> {
  const { project, remainingArgs } = resolveProjectFromArgs(args);
  const file = diaryFilePath(project.name);

  if (remainingArgs.includes("--path")) {
    console.log(file);
    return;
  }

  // $EDITOR may carry arguments ("code -w"), so run it through a shell and
  // escape only the file path.
  const editor = process.env.EDITOR || "vi";
  const result = spawnSync("sh", ["-c", `${editor} ${shellEscape(file)}`], { stdio: "inherit" });
  if (result.error) {
    throw new Error(`Failed to launch editor '${editor}' for ${file}: ${result.error.message}`);
  }
}

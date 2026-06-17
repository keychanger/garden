// Opens the project's diary in $EDITOR.
import { spawnSync } from "node:child_process";
import { resolveProjectFromArgs } from "../config.js";
import { shellEscape } from "../dashboard/tmux.js";
import { diaryFilePath, editorIsNano } from "../diary.js";

export async function diary(args: string[]): Promise<void> {
  const { project, remainingArgs } = resolveProjectFromArgs(args);
  const file = diaryFilePath(project.name);

  if (remainingArgs.includes("--path")) {
    console.log(file);
    return;
  }

  // $EDITOR may carry arguments ("code -w"), so run it through a shell and
  // escape only the file path. Fallback is nano (modeless, self-documenting)
  // rather than vi so an unset $EDITOR is friendly out of the box. nano/pico
  // get -b to enable word wrap, so long diary lines wrap to the terminal width
  // instead of scrolling off the right edge.
  const editor = process.env.EDITOR || "nano";
  const wrapFlag = editorIsNano(editor) ? " -b" : "";
  const result = spawnSync("sh", ["-c", `${editor}${wrapFlag} ${shellEscape(file)}`], { stdio: "inherit" });
  if (result.error) {
    throw new Error(`Failed to launch editor '${editor}' for ${file}: ${result.error.message}`);
  }
}

import { execFileSync } from "node:child_process";
import { resolveProjectFromArgs } from "../config.js";

export async function test(args: string[]): Promise<void> {
  const { project, remainingArgs } = resolveProjectFromArgs(args);
  execFileSync("npm", ["test", "--", ...remainingArgs], {
    cwd: project.path,
    stdio: "inherit",
  });
}

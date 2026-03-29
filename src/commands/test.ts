import { execSync } from "node:child_process";
import { resolveProjectFromArgs } from "../config.js";

export async function test(args: string[]): Promise<void> {
  const { project, remainingArgs } = resolveProjectFromArgs(args);
  const cmd = ["npm", "test", "--", ...remainingArgs].join(" ");
  execSync(cmd, { cwd: project.path, stdio: "inherit" });
}

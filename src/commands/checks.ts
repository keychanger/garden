// `garden checks [project]` — run the project's configured checks command
// under the machine-wide checks semaphore. Workers and reviewers route their
// pre-push suite through this so overlapping runs queue instead of stampeding
// the operator's workstation; CI keeps running the raw command on its own
// isolated runner. The child runs in the caller's cwd (the worker's worktree),
// inherits stdio, and its exit code is the command's exit code.
import { spawn } from "node:child_process";
import { resolveProjectFromArgs, getChecksSlotsOverride } from "../config.js";
import {
  acquireChecksSlot,
  defaultChecksSlots,
  releaseChecksSlot,
} from "../checks-semaphore.js";

export async function checks(args: string[]): Promise<void> {
  const { project } = resolveProjectFromArgs(args);
  const command = project.checks;
  if (!command) {
    throw new Error(
      `Project ${project.name} has no checks command configured. `
      + `Set one with: garden config ${project.name} checks "<command>"`,
    );
  }

  // Garden-level override (garden limits checks-slots N) wins over the
  // hardware-derived default.
  const slots = getChecksSlotsOverride() ?? defaultChecksSlots();
  let announced = 0;
  const slot = await acquireChecksSlot(slots, {
    onWait: (elapsedMs) => {
      // One line immediately, then every ~30s, so a queued run is visibly
      // queued rather than hung.
      if (elapsedMs >= announced) {
        console.error(
          `[garden checks] waiting for a free checks slot `
          + `(${slots} on this machine, all busy; waited ${Math.round(elapsedMs / 1000)}s)`,
        );
        announced += 30_000;
      }
    },
  });
  if (slot === null) {
    console.error(
      "[garden checks] no slot freed up within the maximum wait; running ungated",
    );
  } else {
    console.error(`[garden checks] slot ${slot}/${slots} acquired; running: ${command}`);
  }

  const release = () => {
    if (slot !== null) releaseChecksSlot(slot);
  };
  process.on("exit", release);

  const exitCode = await new Promise<number>((resolve) => {
    const child = spawn(command, { shell: true, stdio: "inherit" });
    const forward = (signal: NodeJS.Signals) => {
      child.kill(signal);
    };
    process.on("SIGINT", forward);
    process.on("SIGTERM", forward);
    child.on("close", (code, signal) => {
      process.off("SIGINT", forward);
      process.off("SIGTERM", forward);
      resolve(code ?? (signal ? 1 : 0));
    });
    child.on("error", () => resolve(127));
  });

  release();
  process.exitCode = exitCode;
}

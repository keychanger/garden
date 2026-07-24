import { resolveProjectFromArgs } from "../config.js";
import { ensureProjectPoller } from "../dashboard/poller.js";
import { triggerProjectPoll } from "../dashboard/poller-fifo.js";
import { intakePokePath } from "../dashboard/poller-intake.js";
import { atomicWriteFile } from "../dashboard/atomic-write.js";
import { resolveGardenRunner } from "../dashboard/runner.js";
import { output } from "../output.js";

// Fire-and-forget wake of a project's poller, bypassing the bead-intake
// throttle. This is the FIFO poke path board's dispatch gate keys use
// (DELEGATION.md: a wake-up, not an RPC): the marker file makes the very next
// poll cycle run intake, and the FIFO byte causes that cycle now. Safe from
// inside a worker pane (both paths live in ~/.garden/sessions, which the
// sandbox allows) and a no-op when no poller is listening — the marker then
// rides the next natural wake.
export async function poke(args: string[]): Promise<void> {
  const { project } = resolveProjectFromArgs(args);
  atomicWriteFile(intakePokePath(project.name), String(Date.now()));
  ensureProjectPoller(project.name, resolveGardenRunner());
  triggerProjectPoll(project.name);
  output(
    { project: project.name, poked: true },
    () => `Poked ${project.name}'s poller (bead intake runs on this wake).`,
  );
}

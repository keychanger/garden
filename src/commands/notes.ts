// `garden notes [project] [--clear]` — read the non-blocking notes reviewers
// left on this project's branches (see dashboard/review-notes.ts). The review
// body itself is gone after merge, so this file is the only place they live.
import { resolveProjectFromArgs } from "../config.js";
import { output, isTTY } from "../output.js";
import { readReviewNotes, clearReviewNotes } from "../dashboard/review-notes.js";

export async function notes(args: string[]): Promise<void> {
  const { project, remainingArgs } = resolveProjectFromArgs(args);

  if (remainingArgs.includes("--clear")) {
    clearReviewNotes(project.name);
    console.log(`Review notes for ${project.name} cleared.`);
    return;
  }

  const all = readReviewNotes(project.name);
  if (!isTTY) {
    output({ project: project.name, notes: all });
    return;
  }
  if (all.length === 0) {
    console.log(`No review notes for ${project.name}.`);
    return;
  }

  console.log("");
  for (const note of all) {
    const when = new Date(note.at).toLocaleString();
    console.log(`  \x1b[1m${note.worker}\x1b[0m \x1b[2m(${note.branch}) ${note.verdict} · ${when}\x1b[0m`);
    for (const line of note.notes.split("\n")) console.log(`    ${line}`);
    console.log("");
  }
  console.log(`  \x1b[2m'garden notes ${project.name} --clear' removes them\x1b[0m`);
  console.log("");
}

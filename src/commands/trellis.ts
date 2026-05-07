// `garden trellis <subcommand>` — trellis document management. v1 ships
// list / show / new / status / amend / resume / retire / revive. The
// `--override` flag on resume is deferred to v1.5; phase 4 ships resume
// without it.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { tryGetProject } from "../config.js";
import { output, isTTY } from "../output.js";
import { triggerProjectPoll } from "../dashboard/poller-fifo.js";
import {
  findTrellisByName, findTrellisFiles, trellisDirFor,
  TRELLIS_RETIREMENT_REGEX,
} from "../dashboard/trellis-tag.js";
import {
  readRegistry, updateWorkerFields, type WorkerEntry,
} from "../dashboard/registry.js";

export async function trellis(args: string[]): Promise<void> {
  const sub = args[0];
  switch (sub) {
    case "list":    return listCommand(args.slice(1));
    case "show":    return showCommand(args.slice(1));
    case "new":     return newCommand(args.slice(1));
    case "status":  return statusCommand(args.slice(1));
    case "amend":   return amendCommand(args.slice(1));
    case "resume":  return resumeCommand(args.slice(1));
    case "retire":  return retireCommand(args.slice(1));
    case "revive":  return reviveCommand(args.slice(1));
    default: throw new Error(USAGE);
  }
}

const USAGE = [
  "Usage:",
  "  garden trellis list <project> [--active]",
  "  garden trellis show <project> <name>",
  "  garden trellis new <project> <name>",
  "  garden trellis status <worker>",
  "  garden trellis amend <worker>",
  "  garden trellis resume <worker>",
  "  garden trellis retire <project> <name>",
  "  garden trellis revive <project> <name>",
].join("\n");

// --- list ----------------------------------------------------------------

async function listCommand(args: string[]): Promise<void> {
  const projectName = args[0];
  if (!projectName) throw new Error("Usage: garden trellis list <project> [--active]");
  if (!tryGetProject(projectName)) {
    throw new Error(`Unknown project '${projectName}'. Run 'garden list' to see registered projects.`);
  }
  const activeOnly = args.includes("--active");
  const all = findTrellisFiles(projectName);
  const visible = activeOnly ? all.filter(t => !t.retired) : all;

  if (!isTTY) {
    output(visible.map(t => ({
      name: t.name,
      path: t.path,
      retired: t.retired,
      hasSentinel: t.hasSentinel,
      summary: t.summary,
    })));
    return;
  }

  if (visible.length === 0) {
    const dir = trellisDirFor(projectName);
    console.log(`No trellises in ${dir}.`);
    console.log(`Create one with 'garden trellis new ${projectName} <name>'.`);
    return;
  }

  const active = visible.filter(t => !t.retired);
  const archived = visible.filter(t => t.retired);
  const nameWidth = Math.max(...visible.map(t => t.name.length), 8);

  if (active.length > 0) {
    for (const t of active) {
      const sentinel = t.hasSentinel ? "" : "  (no sentinel)";
      console.log(`  ${t.name.padEnd(nameWidth)}  ${t.summary}${sentinel}`);
    }
  }
  if (archived.length > 0) {
    if (active.length > 0) console.log("");
    console.log("Archived:");
    for (const t of archived) {
      console.log(`  ${t.name.padEnd(nameWidth)}  ${t.summary}`);
    }
  }
}

// --- show ----------------------------------------------------------------

async function showCommand(args: string[]): Promise<void> {
  const projectName = args[0];
  const name = args[1];
  if (!projectName || !name) throw new Error("Usage: garden trellis show <project> <name>");
  const info = findTrellisByName(projectName, name);
  if (!info) {
    throw new Error(`Trellis '${name}' not found in project '${projectName}'.`);
  }
  // Stream the file content. JSON wrapping isn't useful here — show is
  // meant for paged TTY consumption.
  const content = fs.readFileSync(info.path, "utf-8");
  process.stdout.write(content);
}

// --- new -----------------------------------------------------------------

async function newCommand(args: string[]): Promise<void> {
  const projectName = args[0];
  const trellisName = args[1];
  if (!projectName || !trellisName) {
    throw new Error("Usage: garden trellis new <project> <name>");
  }
  if (!tryGetProject(projectName)) {
    throw new Error(`Unknown project '${projectName}'. Run 'garden list' to see registered projects.`);
  }
  const dir = trellisDirFor(projectName);
  if (!dir) {
    throw new Error(`Could not resolve trellisDir for project '${projectName}'.`);
  }

  // Strip .md if the operator typed it; we always add it.
  const stem = trellisName.endsWith(".md") ? trellisName.slice(0, -3) : trellisName;
  const filePath = path.join(dir, `${stem}.md`);

  if (fs.existsSync(filePath)) {
    throw new Error(
      `Trellis already exists at ${filePath}. Use 'garden trellis amend' to edit it.`,
    );
  }

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, scaffoldContent(stem));
  console.log(`Created trellis at ${filePath}`);
  console.log(
    "Edit the scaffold to fill in the recommended sections, then plant a vine with:",
  );
  console.log(
    `  garden workers new ${projectName} --workflow trellis --trellis ${stem}`,
  );
}

// --- status --------------------------------------------------------------

async function statusCommand(args: string[]): Promise<void> {
  const workerName = args[0];
  if (!workerName) throw new Error("Usage: garden trellis status <worker>");

  const found = findWorkerAcrossProjects(workerName);
  if (!found) {
    throw new Error(`Worker '${workerName}' not found in any project.`);
  }
  const { project, entry } = found;
  if (entry.workflow !== "trellis") {
    throw new Error(
      `Worker '${workerName}' is on workflow '${entry.workflow ?? "default"}', not trellis. ` +
      `'garden trellis status' is for trellis vines only.`,
    );
  }

  const lessons = readLessonsTail(entry);
  const data = {
    worker: entry.name,
    project,
    trellis: entry.trellisName,
    trellisPath: entry.trellisPath,
    iterations: `${entry.trellisIteration ?? 0} / ${entry.trellisMaxIterations ?? 30}`,
    lastVerdict: entry.trellisLastVerdict,
    drift: entry.trellisLastDrift ?? [],
    alignedCount: entry.trellisAlignedCount,
    failingReason: entry.failingReason,
    lessons: lessons ?? "(none)",
  };

  output(data, () => {
    const lines: string[] = [];
    const pad = (s: string) => s.padEnd(15);
    lines.push(`${pad("worker:")} ${entry.name}`);
    lines.push(`${pad("project:")} ${project}`);
    lines.push(`${pad("trellis:")} ${entry.trellisName ?? "?"}`);
    if (entry.trellisPath) lines.push(`${pad("path:")} ${entry.trellisPath}`);
    lines.push(`${pad("iterations:")} ${entry.trellisIteration ?? 0} / ${entry.trellisMaxIterations ?? 30}`);
    if (entry.trellisLastVerdict) lines.push(`${pad("last verdict:")} ${entry.trellisLastVerdict}`);
    if (entry.failingReason) lines.push(`${pad("failingReason:")} ${entry.failingReason}`);
    if ((entry.trellisLastDrift ?? []).length > 0) {
      lines.push(`${pad("drift items:")}`);
      for (const item of entry.trellisLastDrift!) lines.push(`  ${item}`);
    }
    if (entry.trellisAlignedCount !== undefined) {
      lines.push(`${pad("aligned items:")} ${entry.trellisAlignedCount}`);
    }
    lines.push(`${pad("lessons:")} ${lessons ?? "(none)"}`);
    return lines.join("\n");
  });
}

// --- amend ---------------------------------------------------------------

async function amendCommand(args: string[]): Promise<void> {
  const workerName = args[0];
  if (!workerName) throw new Error("Usage: garden trellis amend <worker>");

  const found = findWorkerAcrossProjects(workerName);
  if (!found) {
    throw new Error(`Worker '${workerName}' not found in any project.`);
  }
  const { project: projectName, entry } = found;
  if (entry.workflow !== "trellis") {
    throw new Error(
      `Worker '${workerName}' is on workflow '${entry.workflow ?? "default"}', not trellis. ` +
      `'garden trellis amend' edits the worker's bound trellis.`,
    );
  }
  if (!entry.trellisPath || !entry.trellisName) {
    throw new Error(
      `Worker '${workerName}' has no bound trellis (missing trellisPath/trellisName on the registry entry).`,
    );
  }
  const project = tryGetProject(projectName);
  if (!project) {
    throw new Error(`Unknown project '${projectName}'. Run 'garden list' to see registered projects.`);
  }
  const trellisPath = entry.trellisPath;
  const trellisName = entry.trellisName;
  if (!fs.existsSync(trellisPath)) {
    throw new Error(`Trellis file at ${trellisPath} no longer exists.`);
  }

  // Refuse on a dirty main checkout (Q4). The trellis lives on main, and
  // committing on a dirty tree mixes operator's pending edits with the
  // amend — same footgun the bootstrap already alerts on.
  if (isMainCheckoutDirty(project.path)) {
    throw new Error(
      `Project '${projectName}' main checkout has uncommitted changes — refusing to amend trellis. ` +
      `Commit or stash those changes first, then re-run 'garden trellis amend ${workerName}'.`,
    );
  }

  const editor = process.env.EDITOR || process.env.VISUAL || "vi";
  const before = fs.readFileSync(trellisPath, "utf-8");
  const result = spawnSync(editor, [trellisPath], { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`Editor exited with status ${result.status}; not committing changes.`);
  }
  const after = fs.readFileSync(trellisPath, "utf-8");
  if (before === after) {
    console.log("No changes; nothing to commit.");
    return;
  }

  // Auto-revive a retired trellis on save — you don't edit a tombstone;
  // if you're touching it, it's alive again.
  const wasRetired = TRELLIS_RETIREMENT_REGEX.test(after);
  let finalContent = after;
  if (wasRetired) {
    finalContent = after.replace(TRELLIS_RETIREMENT_REGEX, "").replace(/\n{3,}/g, "\n\n");
    if (finalContent !== after) {
      fs.writeFileSync(trellisPath, finalContent);
    }
  }

  // Commit to main. The trellis lives on the project's main branch.
  const relPath = path.relative(project.path, trellisPath);
  const summary = wasRetired
    ? `trellis: amend ${trellisName} (revives retirement)`
    : `trellis: amend ${trellisName}`;
  try {
    execFileSync("git", ["add", relPath], { cwd: project.path, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", summary], { cwd: project.path, stdio: "ignore" });
  } catch (err) {
    throw new Error(`git commit failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  console.log(`Committed ${summary} on ${project.path}.`);
  if (wasRetired) {
    console.log(
      `Trellis was retired; the amend auto-revived it. ` +
      `It's back in the picker and CLI vine spawn will accept it.`,
    );
  }
}

// --- resume --------------------------------------------------------------

async function resumeCommand(args: string[]): Promise<void> {
  const workerName = args[0];
  if (!workerName) throw new Error("Usage: garden trellis resume <worker>");

  const found = findWorkerAcrossProjects(workerName);
  if (!found) {
    throw new Error(`Worker '${workerName}' not found in any project.`);
  }
  const { project, entry } = found;
  if (entry.workflow !== "trellis") {
    throw new Error(
      `Worker '${workerName}' is on workflow '${entry.workflow ?? "default"}', not trellis. ` +
      `'garden trellis resume' is for trellis vines only.`,
    );
  }
  if (entry.failingReason !== "trellis-flagged") {
    throw new Error(
      `Worker '${workerName}' is not in a flagged state ` +
      `(prState=${entry.prState ?? "?"}, failingReason=${entry.failingReason ?? "none"}). ` +
      `'garden trellis resume' clears trellis-flagged. For other failures, push commits and let the debounce cycle.`,
    );
  }

  // Clear the flagged state and arm a fresh review on the next poller
  // wake. The reviewer reads the trellis at HEAD post-rebase, so any
  // operator amend takes effect on this iteration.
  updateWorkerFields(project, workerName, {
    failingReason: undefined,
    failingSha: undefined,
    trellisFlaggedClauses: undefined,
    pendingReviewAt: Date.now(),
    prState: "working",
  });
  triggerProjectPoll(project);
  console.log(
    `Resumed vine ${project}/${workerName}. The next review fires on the poller's next wake; ` +
    `if you amended the trellis, the new content takes effect.`,
  );
}

// --- retire / revive -----------------------------------------------------

async function retireCommand(args: string[]): Promise<void> {
  const projectName = args[0];
  const name = args[1];
  if (!projectName || !name) throw new Error("Usage: garden trellis retire <project> <name>");
  const project = tryGetProject(projectName);
  if (!project) {
    throw new Error(`Unknown project '${projectName}'. Run 'garden list' to see registered projects.`);
  }
  const info = findTrellisByName(projectName, name);
  if (!info) {
    throw new Error(`Trellis '${name}' not found in project '${projectName}'.`);
  }
  if (info.retired) {
    console.log(`Trellis '${name}' is already retired.`);
    return;
  }

  // Refuse on a dirty main checkout BEFORE writing — the dirty check
  // would otherwise trip on our own write. Same Q4 rule as `amend`.
  if (isMainCheckoutDirty(project.path)) {
    throw new Error(
      `Project '${projectName}' main checkout has uncommitted changes — refusing to retire trellis. ` +
      `Commit or stash those changes first, then re-run 'garden trellis retire ${projectName} ${name}'.`,
    );
  }

  // The retirement comment lands with just the date. The plan calls for
  // auto-filling a commit range from the most-recently-aligned vine, but
  // garden does not currently persist the merge-commit SHA (the worker's
  // branch is deleted on merge), so any computed range would be a guess.
  // Operator can hand-edit the comment to add a range when relevant.
  const today = new Date().toISOString().slice(0, 10);
  const comment = `<!-- retired: ${today} -->`;
  const tagMatch = info.path; // file path
  const content = fs.readFileSync(tagMatch, "utf-8");
  // Append the comment immediately after the existing trellis tag.
  const updated = content.replace(
    /(<!--\s*trellis:\s*v\d+\s*-->)/,
    `$1\n${comment}`,
  );
  if (updated === content) {
    throw new Error(
      `Could not locate the trellis tag in ${tagMatch} — refusing to write retirement.`,
    );
  }
  fs.writeFileSync(tagMatch, updated);

  const relPath = path.relative(project.path, info.path);
  try {
    execFileSync("git", ["add", relPath], { cwd: project.path, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", `trellis: retire ${name}`], {
      cwd: project.path, stdio: "ignore",
    });
  } catch (err) {
    throw new Error(`git commit failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  console.log(`Retired trellis '${name}'.`);
  console.log(
    `It's filtered from the picker; CLI vine spawn refuses to bind to it. ` +
    `Revive with 'garden trellis revive ${projectName} ${name}'.`,
  );
}

async function reviveCommand(args: string[]): Promise<void> {
  const projectName = args[0];
  const name = args[1];
  if (!projectName || !name) throw new Error("Usage: garden trellis revive <project> <name>");
  const project = tryGetProject(projectName);
  if (!project) {
    throw new Error(`Unknown project '${projectName}'. Run 'garden list' to see registered projects.`);
  }
  const info = findTrellisByName(projectName, name);
  if (!info) {
    throw new Error(`Trellis '${name}' not found in project '${projectName}'.`);
  }
  if (!info.retired) {
    console.log(`Trellis '${name}' is not retired; nothing to do.`);
    return;
  }
  // Refuse on a dirty main checkout BEFORE writing.
  if (isMainCheckoutDirty(project.path)) {
    throw new Error(
      `Project '${projectName}' main checkout has uncommitted changes — refusing to revive trellis. ` +
      `Commit or stash those changes first, then re-run 'garden trellis revive ${projectName} ${name}'.`,
    );
  }
  const content = fs.readFileSync(info.path, "utf-8");
  const updated = content.replace(TRELLIS_RETIREMENT_REGEX, "").replace(/\n{3,}/g, "\n\n");
  fs.writeFileSync(info.path, updated);

  const relPath = path.relative(project.path, info.path);
  try {
    execFileSync("git", ["add", relPath], { cwd: project.path, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", `trellis: revive ${name}`], {
      cwd: project.path, stdio: "ignore",
    });
  } catch (err) {
    throw new Error(`git commit failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  console.log(`Revived trellis '${name}'.`);
}

// --- helpers -------------------------------------------------------------

function findWorkerAcrossProjects(
  workerName: string,
): { project: string; entry: WorkerEntry } | null {
  const registry = readRegistry();
  for (const [project, entries] of Object.entries(registry.workers)) {
    const entry = entries.find(e => e.name === workerName);
    if (entry) return { project, entry };
  }
  return null;
}

function isMainCheckoutDirty(repoPath: string): boolean {
  try {
    const out = execFileSync("git", ["status", "--porcelain"], {
      cwd: repoPath, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim().length > 0;
  } catch {
    // If we can't even run git status, assume something's broken; refuse
    // by reporting dirty so the operator investigates.
    return true;
  }
}

function readLessonsTail(entry: WorkerEntry, lines = 3): string | null {
  if (!entry.worktreePath) return null;
  const lessonsPath = path.join(entry.worktreePath, ".garden", "trellis-lessons.md");
  try {
    const content = fs.readFileSync(lessonsPath, "utf-8").trim();
    if (!content) return null;
    const all = content.split("\n").filter(l => l.trim());
    return all.slice(-lines).join("\n");
  } catch {
    return null;
  }
}

// Scaffold content per TRELLIS.md "The trellis document". Includes the
// required spine (title, sentinel within the first paragraph, trellis tag
// within the first 200 bytes), and the recommended section headings as
// a starting structure. Operators fill in the prose.
function scaffoldContent(name: string): string {
  return `# ${name}

Spec for the **${name}** feature: a one-paragraph summary of what this feature does and why it exists. **If the code disagrees with this document, the code is wrong.**

<!-- trellis: v1 -->

## Intent

One paragraph: what this feature does, why it exists, what user-visible behavior changes when it lands.

## Surface

The concrete API/CLI/UI surface this feature must expose. Be specific:
function signatures, command flags, file paths, exported symbols. The
reviewer verifies these via grep + signature checks.

- (replace with concrete bullets)

## Behavior

Invariants the feature must satisfy. Mix of objective ("error path
returns \`{ok: false, reason}\`") and judgment-graded ("errors should be
specific and structured"). Number them so drift items can cite them.

1. (replace with concrete bullets)

## Tests

Test cases that should exist. Concrete: file paths or test names. The
reviewer verifies via grep on test files.

- (replace with concrete bullets)

## Docs

Documentation surface that should exist or update. Concrete: file
paths and section titles, or DESIGN.md/CLAUDE.md updates expected.

- (replace with concrete bullets)

## Out of scope

Explicit non-goals. Prevents the loop from chasing adjacent improvements.
Each bullet is a thing the reviewer should bounce back as drift if the
worker tries to include it.

- (replace with concrete bullets)
`;
}

// Botanist publish: move an approved design artifact from the worker's uncommitted
// working directory to a tracked docs/ path, commit it locally, and write the
// .garden-done sentinel. The commit is NOT pushed here — the poller's skip-review
// merge (handleWorking → merge-pending → mergeToBase) force-pushes the branch and
// fast-forwards base, exactly as it does for any worker, so publish needs no
// network and works inside the worker sandbox.
//
// The publish mutation path is CLI-only. Poller scope enforcement imports the
// node:path-only botanist-paths.ts leaf so this module never enters hook.js.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { setDoneSentinel } from "./continue.js";
import { log } from "./log.js";
import { BOTANIST_PUBLISH_ROOT, isPublishablePath } from "./botanist-paths.js";
import { shellEscape } from "./tmux.js";

export { BOTANIST_PUBLISH_ROOT, isPublishablePath } from "./botanist-paths.js";

// The artifact a botanist drafts during the converge phase (see the botanist skill).
export const BOTANIST_ARTIFACT_REL = path.join(".garden", "botanist", "artifact.md");

export interface PublishResult {
  ok: boolean;
  message: string;
}

// Move the artifact to `toRelPath` (worktree-relative, must be under docs/ and
// end in .md), stage + commit it, and write .garden-done. With dryRun, report
// what would happen and change nothing.
export function publishBotanistArtifact(
  worktreePath: string,
  toRelPath: string,
  opts: { dryRun?: boolean; project?: string; trellisDir?: string } = {},
): PublishResult {
  if (!isPublishablePath(toRelPath)) {
    return {
      ok: false,
      message: `Publish target must be a path under '${BOTANIST_PUBLISH_ROOT}' (got '${toRelPath}'). A botanist publishes design docs, not code.`,
    };
  }
  if (!toRelPath.endsWith(".md")) {
    return { ok: false, message: `Publish target must be a Markdown file (.md), got '${toRelPath}'.` };
  }

  const artifactAbs = path.join(worktreePath, BOTANIST_ARTIFACT_REL);
  if (!fs.existsSync(artifactAbs)) {
    return {
      ok: false,
      message: `No artifact to publish at '${BOTANIST_ARTIFACT_REL}'. Draft it during the converge phase before publishing.`,
    };
  }

  const targetAbs = path.join(worktreePath, toRelPath);

  if (opts.dryRun) {
    return {
      ok: true,
      message: `[dry-run] Would move '${BOTANIST_ARTIFACT_REL}' → '${toRelPath}', commit it, and mark the botanist done. Nothing was changed.`,
    };
  }

  try {
    fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
    fs.renameSync(artifactAbs, targetAbs);
  } catch (err) {
    return { ok: false, message: `Failed to move the artifact into place: ${String(err)}` };
  }

  const name = path.basename(toRelPath, ".md");
  try {
    execFileSync("git", ["add", "--", toRelPath], { cwd: worktreePath, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", `docs: publish ${name} (botanist)`], {
      cwd: worktreePath, stdio: "pipe",
    });
  } catch (err) {
    return {
      ok: false,
      message: `Staged the artifact but the commit failed: ${String(err)}. The file is at '${toRelPath}'; commit it by hand or retry.`,
    };
  }

  // Mark done so the skip-review merge finalizes to `done` (not auto-continue).
  setDoneSentinel(worktreePath);
  log.info("botanist", "published artifact", {
    data: { worktree: worktreePath, target: toRelPath },
  });

  const proj = opts.project ?? "<project>";
  const trellisTarget = path.join(
    opts.trellisDir ?? ".garden/trellises",
    `${name}.md`,
  );
  return {
    ok: true,
    message: `Published '${toRelPath}' (committed, marked done). The poller will merge it — no reviewer runs.\n`
      + `Now execute the handoff plan the operator approved (see the botanist skill):\n`
      + `  default builder — spawn it yourself: garden handoff ${shellEscape(proj)} < .garden/botanist/handoff-brief.md\n`
      + `    (inline the design in the brief: the doc has not merged when the new worker branches)\n`
      + `  trellis builder — needs the trellis spine in the doc; the operator runs, in the checkout after merge:\n`
      + `    cp ${shellEscape(toRelPath)} ${shellEscape(trellisTarget)} && garden workers new ${shellEscape(proj)} --workflow trellis --trellis ${shellEscape(name)}`,
  };
}

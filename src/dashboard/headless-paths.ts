import { createHash } from "node:crypto";
import path from "node:path";
import { CONTROL_DIR, CONTROL_REPORTS_DIR, HEADLESS_RUNS_DIR } from "../paths.js";

const SAFE_ARTIFACT_PART = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function artifactPart(value: string): string {
  if (SAFE_ARTIFACT_PART.test(value)) return value;
  const digest = createHash("sha256").update(value, "utf16le").digest("hex");
  return `sha256-${digest}`;
}

function artifactStem(project: string, worker: string): string {
  return `${artifactPart(project)}-${artifactPart(worker)}`;
}

export function reviewResultPath(project: string, worker: string): string {
  return path.join(HEADLESS_RUNS_DIR, `${artifactStem(project, worker)}-review-result.txt`);
}

export function reviewPromptPath(project: string, worker: string): string {
  return path.join(HEADLESS_RUNS_DIR, `${artifactStem(project, worker)}-review-prompt.txt`);
}

export function ciFixPromptPath(project: string, worker: string): string {
  return path.join(HEADLESS_RUNS_DIR, `${artifactStem(project, worker)}-ci-fix-prompt.txt`);
}

export function ciFixResultPath(project: string, worker: string): string {
  return path.join(HEADLESS_RUNS_DIR, `${artifactStem(project, worker)}-ci-fix-result.txt`);
}

export function holisticFindingsPath(project: string, worker: string): string {
  return path.join(CONTROL_REPORTS_DIR, `holistic-findings-${artifactStem(project, worker)}.md`);
}

export function reviewNotesPath(project: string): string {
  return path.join(CONTROL_REPORTS_DIR, `review-notes-${artifactPart(project)}.jsonl`);
}

// Garden's Claude Code settings (hooks, sandbox, status line), passed to every
// interactive Claude launch with `--settings` (a headless launch generates its
// own `<promptFile>.settings.json` sidecar). Kept outside the worktree so a repo that
// commits its own .claude/settings.json is never overwritten, and outside every
// worker sandbox so a worker cannot edit its own sandbox.
export const CLAUDE_SETTINGS_DIR = path.join(CONTROL_DIR, "claude-settings");

// One settings file per directory Claude runs in (a worktree, or a project
// checkout on the legacy path). The installer and every launch command derive
// the path from the same directory, so they cannot disagree about it.
export function claudeSettingsPath(runtimeDir: string): string {
  const digest = createHash("sha256").update(path.resolve(runtimeDir)).digest("hex");
  return path.join(CLAUDE_SETTINGS_DIR, `${digest}.json`);
}

export function headlessArtifactNames(project: string, worker: string): string[] {
  const paths = [
    reviewResultPath(project, worker),
    reviewPromptPath(project, worker),
    ciFixResultPath(project, worker),
    ciFixPromptPath(project, worker),
  ];
  return paths.flatMap(file => {
    const name = path.basename(file);
    return name.endsWith("-prompt.txt")
      ? [name, `${name}.stderr`, `${name}.settings.json`]
      : [name, `${name}.stderr`];
  });
}

export function isHeadlessArtifactName(name: string): boolean {
  return name.endsWith("-review-prompt.txt.settings.json")
    || name.endsWith("-ci-fix-prompt.txt.settings.json")
    || name.endsWith("-review-result.txt")
    || name.endsWith("-review-result.txt.stderr")
    || name.endsWith("-review-prompt.txt")
    || name.endsWith("-ci-fix-result.txt")
    || name.endsWith("-ci-fix-result.txt.stderr")
    || name.endsWith("-ci-fix-prompt.txt");
}

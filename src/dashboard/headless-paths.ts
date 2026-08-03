import { createHash } from "node:crypto";
import path from "node:path";
import { CONTROL_REPORTS_DIR, HEADLESS_RUNS_DIR } from "../paths.js";

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

export function headlessArtifactNames(project: string, worker: string): string[] {
  const paths = [
    reviewResultPath(project, worker),
    reviewPromptPath(project, worker),
    ciFixResultPath(project, worker),
    ciFixPromptPath(project, worker),
  ];
  return paths.flatMap(file => {
    const name = path.basename(file);
    return [name, `${name}.stderr`];
  });
}

export function isHeadlessArtifactName(name: string): boolean {
  return name.endsWith("-review-result.txt")
    || name.endsWith("-review-result.txt.stderr")
    || name.endsWith("-review-prompt.txt")
    || name.endsWith("-ci-fix-result.txt")
    || name.endsWith("-ci-fix-result.txt.stderr")
    || name.endsWith("-ci-fix-prompt.txt");
}

// The publishable-path boundary for a designer artifact. Kept in its own leaf
// module (node:path only) because it is imported by poller-review.ts, which is
// reachable from the lean dist/hook.js closure — the git/fs-write publish logic
// lives in designer-publish.ts and must never be pulled into the hook bundle.
import path from "node:path";

// The only place a designer may publish. `.garden/` is git-excluded (never in a
// diff), so a designer's sole committable output is a tracked doc under docs/.
// Enforced at publish time (the --to target) AND at merge time (handleWorking's
// skip-review scope check), so the two can never drift.
export const DESIGNER_PUBLISH_ROOT = "docs/";

export function isPublishablePath(relPath: string): boolean {
  // Reject absolute paths and any traversal segment before the prefix check —
  // "docs/../src/x" starts with "docs/" but escapes the boundary.
  if (path.isAbsolute(relPath)) return false;
  const normalized = path.normalize(relPath);
  if (normalized.startsWith("..") || normalized.split(path.sep).includes("..")) return false;
  return normalized.startsWith(DESIGNER_PUBLISH_ROOT);
}

// GitHub Actions gate at the poller's merge step.
//
// Background: workers run `mergeToBase` without consulting CI. If GitHub
// Actions on the worker's branch is red (e.g., a stale dependency lockfile),
// the bad commits land on the base branch and stay red there. Branch
// protection on the GitHub side blocks UI merges, but garden's merge path
// is a force-push from the poller — it bypasses the UI entirely. This
// module provides the defense-in-depth gate.
//
// Contract for handleMergePending (poller-merge.ts):
//   - "success" / "unavailable" → proceed with merge
//   - "no-ci" → proceed, UNLESS the project has CI (workflow files on disk, or
//     a check-run observed earlier this poller's life), in which case zero
//     check-runs is treated as "not yet materialized" and the merge defers
//     within a bounded grace window before passing through (the disambiguation
//     lives in gateCiStatus, poller-merge.ts)
//   - "missing-commit" → defer until GitHub knows the commit; never pass on timeout
//   - "pending" → defer (caller stays in merge-pending, schedules a re-poke)
//   - "failed" → caller transitions worker to `failing` with reason "ci"
//
// "unavailable" (gh missing, not a github remote, or API error) always passes
// through — failing closed there would block legitimate non-GitHub projects.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { log } from "./log.js";
import { readStableRegularFile } from "./safe-read.js";

export type CiStatus =
  | { kind: "success" }
  | { kind: "pending"; pending: string[] }
  | { kind: "failed"; failed: Array<{ name: string; conclusion: string; htmlUrl?: string }> }
  | { kind: "no-ci" }
  | { kind: "missing-commit" }
  | { kind: "unavailable"; reason: string };

// Parse a GitHub repo slug ("owner/repo") from the origin remote URL.
// Returns null when the remote isn't github (e.g., gitlab, self-hosted,
// no remote at all). The poller treats null as "no CI gate applies".
export function getGitHubRepoSlug(projectPath: string): string | null {
  let url: string;
  try {
    url = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: projectPath,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    }).trim();
  } catch {
    return null;
  }
  // Accept both SSH (git@github.com:owner/repo[.git]) and HTTPS
  // (https://github.com/owner/repo[.git]) forms. Strip the .git suffix
  // — `gh api` accepts the slug without it.
  const sshMatch = url.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1];
  const httpsMatch = url.match(/^https?:\/\/(?:[^@]+@)?github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  if (httpsMatch) return httpsMatch[1];
  return null;
}

// Does this project define GitHub Actions workflows on disk?
//
// This answers the question zero check-runs is ambiguous about: "not created
// YET" (defer) vs "this project has no CI" (pass through). The poller used to
// answer it only from a learned in-memory flag, set the first time a query
// observed any check-run — but the poller queries within seconds of the
// reviewer's force-push, while GitHub takes ~5-12s to create the runs. So the
// query returned zero runs, the flag stayed unset, and the flag's only setter
// was the very observation the race prevented: after a poller restart the gate
// passed everything through silently. A red main merged that way on 2026-07-20.
//
// The checkout on disk is the durable answer — it survives a restart and needs
// no network. Kept as an OR with the learned flag, which still covers CI that
// has no workflow file in the repo (CodeQL default setup, third-party apps).
//
// Only a workflow that a push to `branch` would start counts. A deploy-only
// (push to main) or PR-only workflow never puts check-runs on a worker SHA, so
// counting it cost every merge in that project the full grace window for
// nothing.
export function projectDefinesCi(projectPath: string, branch: string): boolean {
  const dir = path.join(projectPath, ".github", "workflows");
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
      .some((f) => {
        // The files are merged worker commits; a symlinked one is not followed.
        const file = readStableRegularFile(path.join(dir, f), dir, MAX_WORKFLOW_BYTES);
        return file === null || workflowRunsOnPush(file.data.toString("utf-8"), branch);
      });
  } catch {
    // No .github/workflows directory (or unreadable) — not a CI project as far
    // as the repo is concerned.
    return false;
  }
}

const MAX_WORKFLOW_BYTES = 256 * 1024;

// Would a push to `branch` start this workflow? Of GitHub's triggers only
// `push` runs for a worker branch: garden opens no pull requests, and the rest
// fire on the default branch or by hand. Anything unreadable answers yes,
// since a wrong yes costs one grace window and a wrong no lets the gate pass
// a SHA whose check-runs have not appeared yet.
export function workflowRunsOnPush(source: string, branch: string): boolean {
  try {
    const on = (yaml.load(source) as { on?: unknown } | null)?.on;
    if (typeof on === "string") return on === "push";
    if (Array.isArray(on)) return on.includes("push");
    if (!on || typeof on !== "object") return true;
    if (!("push" in on)) return false;
    const push = (on as { push?: unknown }).push;
    if (push === null || typeof push !== "object") return true;
    const filters = push as Record<string, unknown>;
    if (filters.branches !== undefined) return branchFilterMatches(filters.branches, branch);
    if (filters["branches-ignore"] !== undefined) {
      return !branchFilterMatches(filters["branches-ignore"], branch);
    }
    // Tag filters alone keep the workflow off branch pushes.
    return filters.tags === undefined && filters["tags-ignore"] === undefined;
  } catch {
    return true;
  }
}

// GitHub reads a branch filter list in order: the last pattern a branch
// matches decides, and a leading `!` excludes. Throws on anything else.
function branchFilterMatches(patterns: unknown, branch: string): boolean {
  const list = typeof patterns === "string" ? [patterns] : patterns;
  if (!Array.isArray(list)) throw new Error("unreadable branch filter");
  let matched = false;
  for (const pattern of list) {
    if (typeof pattern !== "string") throw new Error("unreadable branch filter");
    const negated = pattern.startsWith("!");
    if (branchGlob(negated ? pattern.slice(1) : pattern).test(branch)) matched = !negated;
  }
  return matched;
}

// GitHub's filter glob: `*` stops at `/`, `**` does not, `?` and `+` repeat
// the preceding character, `[...]` is a class, and `\` escapes. A malformed
// pattern throws from the RegExp constructor.
function branchGlob(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\" && i + 1 < pattern.length) {
      source += pattern[++i].replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    } else if (c === "*") {
      const deep = pattern[i + 1] === "*";
      if (deep) i++;
      source += deep ? ".*" : "[^/]*";
    } else if (c === "?" || c === "+") {
      source += c;
    } else if (c === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end < 0) throw new Error("unclosed character class");
      source += pattern.slice(i, end + 1);
      i = end;
    } else {
      source += c.replace(/[.^${}()|\\/]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

// Query GitHub Actions check-runs for a commit and reduce to a single
// gate verdict. Uses the `gh` CLI (already authenticated for the operator)
// rather than raw HTTPS — keeps credentials out of garden's surface area
// and avoids adding @octokit as a dependency.
//
// The check-runs endpoint returns every check that ran on the commit
// (Actions workflows, third-party checks like CodeQL, etc.). The gate
// is binary: any non-success conclusion fails the gate; any non-completed
// status defers. This is intentionally strict — a "neutral" conclusion
// from a flaky linter is still a signal worth pausing on. Operators who
// want to skip the gate set requireCiSuccess: false at the project level.
export function checkCiStatus(repoSlug: string, sha: string): CiStatus {
  const result = spawnSync(
    "gh",
    [
      "api",
      "--paginate",
      `repos/${repoSlug}/commits/${sha}/check-runs`,
      "--jq",
      ".check_runs",
    ],
    { encoding: "utf-8", timeout: 30_000 },
  );

  if (result.error) {
    // ENOENT — gh isn't installed. Operators on a fresh box hit this.
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "unavailable", reason: "gh-not-installed" };
    return { kind: "unavailable", reason: `gh-spawn-error: ${String(result.error)}` };
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    if (/No commit found for SHA:/i.test(stderr)) return { kind: "missing-commit" };
    // 404 on the commit, auth failure, rate limit — all surface here. Pass
    // through rather than block. The alert path is the operator's signal
    // that the gate isn't doing its job; we log enough to debug.
    return { kind: "unavailable", reason: `gh-exit-${result.status}: ${stderr.slice(0, 200)}` };
  }

  // --paginate concatenates JSON arrays as separate lines, NOT as one big
  // array. Parse each non-empty line and flatten.
  const lines = (result.stdout ?? "").split("\n").filter(l => l.trim().length > 0);
  type CheckRun = {
    name?: string;
    status?: string;
    conclusion?: string | null;
    html_url?: string;
  };
  const runs: CheckRun[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (Array.isArray(parsed)) runs.push(...parsed as CheckRun[]);
    } catch (err) {
      log.warn("ci-gate", "failed to parse gh api line", {
        data: { error: String(err), line: line.slice(0, 200) },
      });
    }
  }

  if (runs.length === 0) return { kind: "no-ci" };

  const pending: string[] = [];
  const failed: Array<{ name: string; conclusion: string; htmlUrl?: string }> = [];
  for (const run of runs) {
    const name = run.name ?? "(unnamed)";
    if (run.status !== "completed") {
      pending.push(name);
      continue;
    }
    // Conclusions per GitHub docs: success, failure, neutral, cancelled,
    // skipped, timed_out, action_required, stale, startup_failure.
    // success/skipped/neutral pass; everything else fails.
    const conclusion = run.conclusion ?? "missing";
    if (conclusion === "success" || conclusion === "skipped" || conclusion === "neutral") {
      continue;
    }
    failed.push({ name, conclusion, htmlUrl: run.html_url });
  }

  if (failed.length > 0) return { kind: "failed", failed };
  if (pending.length > 0) return { kind: "pending", pending };
  return { kind: "success" };
}

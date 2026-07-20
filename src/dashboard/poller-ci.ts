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
//   - "pending" → defer (caller stays in merge-pending, schedules a re-poke)
//   - "failed" → caller transitions worker to `failing` with reason "ci"
//
// "unavailable" (gh missing, not a github remote, or API error) always passes
// through — failing closed there would block legitimate non-GitHub projects.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { log } from "./log.js";

export type CiStatus =
  | { kind: "success" }
  | { kind: "pending"; pending: string[] }
  | { kind: "failed"; failed: Array<{ name: string; conclusion: string; htmlUrl?: string }> }
  | { kind: "no-ci" }
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
export function projectDefinesCi(projectPath: string): boolean {
  try {
    return fs
      .readdirSync(path.join(projectPath, ".github", "workflows"))
      .some((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
  } catch {
    // No .github/workflows directory (or unreadable) — not a CI project as far
    // as the repo is concerned.
    return false;
  }
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
    const stderr = (result.stderr ?? "").trim().slice(0, 200);
    // 404 on the commit, auth failure, rate limit — all surface here. Pass
    // through rather than block. The alert path is the operator's signal
    // that the gate isn't doing its job; we log enough to debug.
    return { kind: "unavailable", reason: `gh-exit-${result.status}: ${stderr}` };
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

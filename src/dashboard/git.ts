// Git operations for worktree-based workers.
import { execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { SESSIONS_DIR } from "../config.js";
import type { ProjectConfig } from "../config.js";
import type { WorkerEntry } from "./registry.js";
import { atomicWriteFile } from "./atomic-write.js";
import { isGeneratedWorkerName } from "./names.js";
import { log } from "./log.js";
import { runGit, runGitBytes } from "./git-exec.js";
import { assertBranchName, assertRevision, branchRef, isValidBranchName, remoteBranchRef } from "./git-refs.js";

const WORKTREE_BASE = path.join(
  process.env.HOME ?? "",
  ".garden",
  "worktrees",
);

export function resolveBaseBranch(repoPath: string): string {
  // Use whatever branch is checked out in the main project directory —
  // that's the branch workers should merge into.
  const current = currentBranch(repoPath);
  if (current && current !== "HEAD") return current;
  try {
    const ref = git(repoPath, "symbolic-ref", "refs/remotes/origin/HEAD");
    const match = ref.match(/^refs\/remotes\/origin\/(.+)$/);
    // The shared refs store is worker-writable, so origin/HEAD is not trusted
    // to name a branch git can be handed.
    if (match && isValidBranchName(match[1])) return match[1];
  } catch {
    // origin/HEAD not set — common for --single-branch clones
  }
  return "main";
}

// Resolve the base branch for a NEW worker, in precedence order:
//   1. an explicit per-worker override (`workers new --base`)
//   2. the project's configured baseBranch (the authoritative pin)
//   3. resolveBaseBranch — the legacy checkout-follows behavior (current
//      branch → origin/HEAD → "main")
// The result still flows through the branchExistsOnOrigin / tryPublishBranch /
// getRemoteTrackingSha chain in newWorker, so a resolved base is validated and
// (if needed) published regardless of which source it came from.
export function resolveSpawnBase(
  project: Pick<ProjectConfig, "path" | "baseBranch">,
  override?: string,
): string {
  const chosen = override?.trim() || project.baseBranch || resolveBaseBranch(project.path);
  return assertBranchName(chosen);
}

// Local + origin branch names for a repo, most-recently-committed first, capped.
// Feeds the base-branch submenus (worker + project config menus). Origin refs
// are stripped of the "origin/" prefix and de-duped against local names (a
// branch both checked out and on origin appears once); HEAD / origin/HEAD are
// dropped, as are worker branches (generated adjective-adjective-noun names —
// never sensible base/build targets, and an active fleet would otherwise fill
// the cap with them). Best-effort — an empty list on any git error.
export function listBranches(repoPath: string, limit = 12): string[] {
  try {
    // Full refnames, prefix stripped here: %(refname:short) shortens the way
    // git disambiguates, so a same-named tag yields "heads/main".
    const out = git(
      repoPath, "for-each-ref", "--sort=-committerdate",
      "--format=%(refname)", "refs/heads", "refs/remotes/origin",
    );
    const seen = new Set<string>();
    const names: string[] = [];
    for (const raw of out.split("\n")) {
      const ref = raw.trim();
      const name = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length)
        : ref.startsWith("refs/remotes/origin/") ? ref.slice("refs/remotes/origin/".length)
        : "";
      // isValidBranchName also drops "" and origin/HEAD's "HEAD".
      if (!isValidBranchName(name) || seen.has(name) || isGeneratedWorkerName(name)) continue;
      seen.add(name);
      names.push(name);
      if (names.length >= limit) break;
    }
    return names;
  } catch {
    return [];
  }
}

// Returns true if the named branch is known on origin per local refs. Used
// to validate a candidate base branch at worker creation — a worker targeting
// a local-only branch breaks silently. Local-only (no `ls-remote`) so the ⌥n
// hotkey doesn't block on the network; the bootstrap's fresh `git fetch`
// raises a `bootstrap` alert if the branch has since vanished from origin.
export function branchExistsOnOrigin(repoPath: string, branchName: string): boolean {
  try {
    git(repoPath, "show-ref", "--verify", "--quiet", "--end-of-options", remoteBranchRef(branchName));
    return true;
  } catch {
    return false;
  }
}

export type PublishResult = { ok: true } | { ok: false; error: string };

// Push <branchName> from the main checkout to origin so it gains an
// origin/<branchName> ref. Called when the operator triggers ⌥n while the
// main checkout is parked on a local-only branch — treat that as an explicit
// "publish this branch as the base for workers" gesture rather than refusing.
// The push creates the local remotes/origin/<branchName> ref as a side
// effect, which is exactly what branchExistsOnOrigin and the merge path
// need. Returns { ok: false, error } with the captured git stderr on
// failure (no remote, branch protection, non-fast-forward, network) so the
// caller can surface the real reason instead of a generic remediation hint.
export function tryPublishBranch(repoPath: string, branchName: string): PublishResult {
  try {
    const ref = branchRef(assertBranchName(branchName));
    operatorGit(repoPath, "push", "-u", "--end-of-options", "origin", `${ref}:${ref}`);
    log.info("git", "published branch to origin", { data: { branchName } });
    return { ok: true };
  } catch (err) {
    const stderr = (err as { stderr?: string | Buffer }).stderr;
    const errText = (stderr ? String(stderr) : String(err)).trim();
    log.warn("git", "failed to publish branch", {
      data: { branchName, error: errText },
    });
    return { ok: false, error: errText };
  }
}

// True when the project's current HEAD has `.garden-done` tracked. A reviewer
// running `git add -A` while the sentinel sat in its CWD is how this happens
// (wolf, 2026-05-06). New workers then inherit the file via `git worktree
// add`, the first Stop hook trips terminal `done` from the file's mere
// presence, and post-merge auto-continue stays silent across every cycle on
// that project. The bootstrap defangs each new worktree, but the root fix
// is `git rm` on main — surface this to the operator via addAlert so the
// cleanup doesn't sit in a stderr line nobody reads.
export function gardenDoneTrackedInHead(repoPath: string): boolean {
  try {
    const out = git(repoPath, "ls-tree", "HEAD", ".garden-done");
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

// Return the worker's pinned base branch, falling back to current-checkout
// resolution for legacy workers that predate the pinning. New workers always
// carry entry.baseBranch; the fallback is only reached for entries written
// before the field existed.
export function getWorkerBaseBranch(
  entry: Pick<WorkerEntry, "baseBranch">,
  projectPath: string,
): string {
  if (entry.baseBranch) return entry.baseBranch;
  return resolveBaseBranch(projectPath);
}

export function worktreePath(project: string, workerName: string): string {
  return path.join(WORKTREE_BASE, project, workerName);
}

// Every worker worktree directory on disk, as the (project, name) pair the
// registry keys by. This is the inverse of worktreePath(): the layout is exactly
// two levels deep under WORKTREE_BASE, so a project dir's children are worker
// names. Lives here rather than in the caller so WORKTREE_BASE stays private.
//
// Deliberately reports what is on DISK without consulting the registry or git —
// its one consumer (the watchdog's orphan sweep) exists to find directories the
// registry does not know about, so filtering here would hide them. A worktree
// whose git metadata is already broken still shows up, which is the point: those
// are the ones nothing else can see.
export function listWorktreeDirs(): { project: string; name: string; path: string }[] {
  const found: { project: string; name: string; path: string }[] = [];
  let projects: fs.Dirent[];
  try {
    projects = fs.readdirSync(WORKTREE_BASE, { withFileTypes: true });
  } catch {
    return found; // no worktrees yet, or HOME unset
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectDir = path.join(WORKTREE_BASE, project.name);
    let workers: fs.Dirent[];
    try {
      workers = fs.readdirSync(projectDir, { withFileTypes: true });
    } catch {
      continue; // raced with a removal
    }
    for (const worker of workers) {
      if (!worker.isDirectory()) continue;
      found.push({
        project: project.name,
        name: worker.name,
        path: path.join(projectDir, worker.name),
      });
    }
  }
  return found;
}


export function createWorktree(
  repoPath: string,
  wtPath: string,
  branchName: string,
  opts: { startPoint?: string; useExistingBranch?: boolean } = {},
): void {
  fs.mkdirSync(path.dirname(wtPath), { recursive: true });
  assertBranchName(branchName);
  if (opts.useExistingBranch) {
    operatorGit(repoPath, "worktree", "add", "--end-of-options", wtPath, branchName);
  } else if (opts.startPoint) {
    operatorGit(repoPath, "worktree", "add", "-b", branchName, "--end-of-options", wtPath, assertRevision(opts.startPoint));
  } else {
    operatorGit(repoPath, "worktree", "add", "-b", branchName, "--end-of-options", wtPath);
  }
  log.info("git", "created worktree", { data: { branchName } });
  installDeps(wtPath);
}

export function localBranchExists(repoPath: string, branchName: string): boolean {
  try {
    git(repoPath, "show-ref", "--verify", "--quiet", "--end-of-options", branchRef(branchName));
    return true;
  } catch {
    return false;
  }
}

// A deleted branch's commits survive in the object store until gc, so a
// killed worker's unmerged tip is often still reachable by SHA even though
// no ref names it anymore. `garden resurrect` uses this to decide whether it
// can restore the branch at its final position instead of restarting from
// the base.
export function commitExists(repoPath: string, sha: string): boolean {
  try {
    git(repoPath, "cat-file", "-e", "--end-of-options", `${assertRevision(sha)}^{commit}`);
    return true;
  } catch {
    return false;
  }
}

// Best-effort full fetch; returns whether it succeeded so callers can note
// (not fail on) an offline origin.
export function fetchOrigin(repoPath: string): boolean {
  try {
    operatorGit(repoPath, "fetch", "origin");
    return true;
  } catch {
    return false;
  }
}

export function workerCleanupMarkerPath(project: string, worker: string): string {
  return path.join(SESSIONS_DIR, `worker-cleanup-${project}-${worker}`);
}

// Run one worker-cleanup git step, returning null on success or git's own
// stderr on failure. The cleanup path needs the error TEXT, not a boolean and
// not a log line: it reports the reason to the operator and decides whether to
// retry. removeWorktree/deleteBranch above log-and-swallow instead, which is
// right for their callers and wrong for this one.
export function gitCleanupStep(repoPath: string, args: string[]): string | null {
  try {
    operatorGit(repoPath, ...args);
    return null;
  } catch (err) {
    return gitErrText(err) || `git ${args[0]} failed`;
  }
}

// gitCleanupStep for a step whose output determines what cleanup remains.
// Preserve the error text: treating every failure as empty output would turn
// an inaccessible repo or offline origin into a false "already absent".
export function gitCleanupOutput(
  repoPath: string,
  args: string[],
): { ok: true; output: string } | { ok: false; error: string } {
  try {
    return { ok: true, output: operatorGit(repoPath, ...args) };
  } catch (err) {
    return { ok: false, error: gitErrText(err) || `git ${args[0]} failed` };
  }
}

export function removeWorktree(repoPath: string, wtPath: string): void {
  try {
    operatorGit(repoPath, "worktree", "remove", wtPath, "--force");
    log.info("git", "removed worktree");
  } catch (err) {
    log.warn("git", "failed to remove worktree", {
      data: { error: String(err) },
    });
  }
}

export function worktreeExists(wtPath: string): boolean {
  try {
    return fs.existsSync(path.join(wtPath, ".git"));
  } catch {
    return false;
  }
}

export function deleteBranch(repoPath: string, branchName: string): void {
  try {
    operatorGit(repoPath, "branch", "-D", "--end-of-options", assertBranchName(branchName));
    log.info("git", "deleted branch", { data: { branchName } });
  } catch (err) {
    log.warn("git", "failed to delete branch", {
      data: { branchName, error: String(err) },
    });
  }
}

// The commit an operator-supplied revision names ("origin/main", "HEAD~3", a
// short SHA), or null when it names none. The helpers that build ranges accept
// only commit SHAs and full refs, so a revision the operator typed is resolved
// through this first.
export function resolveCommitSha(repoPath: string, rev: string): string | null {
  try {
    return git(repoPath, "rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`);
  } catch {
    return null;
  }
}

export function getBranchHeadSha(wtPath: string): string | null {
  try {
    return git(wtPath, "rev-parse", "HEAD");
  } catch {
    return null;
  }
}

// Read the remote tracking ref for a branch. Unlike getBranchHeadSha (which
// reads the local HEAD), this reflects the last-pushed state. It is NOT
// affected by a local rebase, so the poller can use it to detect genuine
// worker pushes without false positives from the reviewer rebasing.
export function getRemoteTrackingSha(wtPath: string, branchName: string): string | null {
  try {
    return git(wtPath, "rev-parse", "--verify", "--end-of-options", remoteBranchRef(branchName));
  } catch {
    return null;
  }
}

export function getDiffAgainstBase(wtPath: string, baseBranch: string): string {
  return git(wtPath, "diff", ...DIFF_SAFETY_ARGS, "--end-of-options", `${remoteBranchRef(baseBranch)}...HEAD`);
}

// Refresh origin/<base> in a worker's worktree before a review or a merge reads
// it. A failure is the caller's to log: neither path treats it as fatal.
export function fetchBaseBranch(wtPath: string, baseBranch: string): void {
  git(wtPath, "fetch", "--end-of-options", "origin", branchRef(baseBranch));
}

// Regular files as committed at `rev`, read from the object store rather than
// the worktree. The prompt builders read these from the unsandboxed poller, and
// the worktree is the worker's: a committed symlink makes a plain read follow it
// to a credential file, or to the poller's own FIFO, which never reaches EOF. A
// symlink or submodule entry is skipped, so a symlinked CLAUDE.md -> AGENTS.md
// pair is read once. The result keeps the input order and omits paths with no
// regular file at `rev`; it is empty when git fails.
export function readCommittedFiles(
  wtPath: string,
  paths: readonly string[],
  rev = "HEAD",
): Map<string, string> {
  const files = new Map<string, string>();
  const wanted = [...new Set(paths)].filter(Boolean);
  if (wanted.length === 0) return files;
  try {
    const blobs = new Map<string, string>();
    // Names come from the worker's branch; a leading ":(" must not read as pathspec magic.
    const listing = runGit(wtPath, ["--literal-pathspecs", "ls-tree", "-z", rev, "--", ...wanted]);
    for (const record of listing.split("\0")) {
      const entry = record.match(/^(100644|100755) blob ([0-9a-f]+)\t(.+)$/s);
      if (entry) blobs.set(entry[3], entry[2]);
    }
    const oids = [...new Set(blobs.values())];
    if (oids.length === 0) return files;
    // One record per object, in input order: "<oid> blob <size>\n<bytes>\n".
    const out = runGitBytes(wtPath, ["cat-file", "--batch"], oids.map(oid => `${oid}\n`).join(""));
    const contents = new Map<string, string>();
    let pos = 0;
    for (const oid of oids) {
      const eol = out.indexOf(0x0a, pos);
      const size = Number(out.toString("utf-8", pos, eol).split(" ")[2]);
      contents.set(oid, out.toString("utf-8", eol + 1, eol + 1 + size));
      pos = eol + 1 + size + 1;
    }
    for (const file of wanted) {
      const oid = blobs.get(file);
      if (oid !== undefined) files.set(file, contents.get(oid) ?? "");
    }
  } catch (err) {
    log.warn("git", "readCommittedFiles failed", { data: { rev, error: String(err) } });
    files.clear();
  }
  return files;
}

export function cleanWorktree(
  worktreePath: string,
  ctx?: { project?: string; worker?: string },
): void {
  try {
    git(worktreePath, "checkout", "--", ".");
    log.info("git", "cleaned unstaged changes before rebase", {
      worker: ctx?.worker,
      data: ctx?.project ? { project: ctx.project } : undefined,
    });
  } catch {
    // nothing to clean
  }
}

export type RebaseResult =
  | { kind: "ok" }
  // The branch already contains the base tip, so there was nothing to replay
  // and no rebase ran. Callers treat it exactly like `ok` — it exists so the
  // skip is visible in logs and tests rather than indistinguishable from a
  // rebase that did work.
  | { kind: "up-to-date" }
  | { kind: "conflict" }
  | { kind: "error"; error: string };

// Merge commits in `origin/<base>..HEAD`. A plain `git rebase` drops these and
// linearizes their commits; when the merged side came from the base, that can
// also replay commits onto a tree that already contains their content. Used to
// pick the rebase mode below.
export function branchMergeCommits(worktreePath: string, baseBranch: string): string[] {
  try {
    const out = git(worktreePath, "rev-list", "--merges", "--end-of-options", `${remoteBranchRef(baseBranch)}..HEAD`);
    return out.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

export function rebaseBranch(worktreePath: string, baseBranch: string): RebaseResult {
  // Fast-forward short-circuit. When the base tip is already an ancestor of
  // HEAD the branch sits strictly on top of the base and merging it is a pure
  // fast-forward — but `git rebase` does NOT no-op here if the branch carries a
  // merge commit (its fast-forward check requires linear history). It flattens
  // the merge and replays the merged side's commits, which then conflict
  // against content the tree already has. That is unwinnable for the resolver,
  // so skip the rebase entirely: there is nothing to replay.
  const base = remoteBranchRef(baseBranch);
  if (isAncestor(worktreePath, base, "HEAD")) {
    log.info("git", "branch already contains the base tip; skipping rebase", {
      data: { worktreePath, baseBranch },
    });
    return { kind: "up-to-date" };
  }
  // The base advanced, so the branch really must be replayed. Preserve merge
  // topology when it has any — `--rebase-merges` recreates the merge commits
  // instead of flattening them.
  const merges = branchMergeCommits(worktreePath, baseBranch);
  const args = merges.length > 0
    ? ["rebase", "--rebase-merges", "--end-of-options", base]
    : ["rebase", "--end-of-options", base];
  if (merges.length > 0) {
    log.info("git", "rebasing with --rebase-merges to preserve merge topology", {
      data: { worktreePath, baseBranch, mergeCommits: merges },
    });
  }
  try {
    git(worktreePath, ...args);
    return { kind: "ok" };
  } catch (err) {
    const msg = String(err);
    if (msg.includes("CONFLICT") || msg.includes("could not apply")) {
      return { kind: "conflict" };
    }
    return { kind: "error", error: msg };
  }
}

export function abortRebase(worktreePath: string): void {
  try {
    git(worktreePath, "rebase", "--abort");
  } catch {
    // may not be in a rebase state
  }
}

// True when a rebase is in progress (either interactive/merge-style or am-style).
// Used to detect leftover rebase state from a crashed or aborted resolver.
// Uses `git rev-parse --git-path` so it works in worktrees where `.git` is a
// file pointing at the shared repo, not a directory.
export function hasRebaseInProgress(worktreePath: string): boolean {
  try {
    const rebaseMerge = git(worktreePath, "rev-parse", "--git-path", "rebase-merge");
    if (fs.existsSync(path.resolve(worktreePath, rebaseMerge))) return true;
  } catch { /* ignore */ }
  try {
    const rebaseApply = git(worktreePath, "rev-parse", "--git-path", "rebase-apply");
    if (fs.existsSync(path.resolve(worktreePath, rebaseApply))) return true;
  } catch { /* ignore */ }
  return false;
}

// True when `ancestor` is an ancestor of `descendant` in the worktree's repo.
// Used by the resolver verification to confirm the branch is rebased onto base.
export function isAncestor(worktreePath: string, ancestor: string, descendant: string): boolean {
  try {
    git(worktreePath, "merge-base", "--is-ancestor", "--end-of-options", assertRevision(ancestor), assertRevision(descendant));
    return true;
  } catch {
    return false;
  }
}

// Ensure no rebase is in progress. If one is found, abort it. Belt-and-suspenders
// cleanup before the poller attempts a fresh rebase — recovers from a prior
// resolver that crashed or was killed mid-rebase.
export function ensureNoRebaseInProgress(worktreePath: string): void {
  if (hasRebaseInProgress(worktreePath)) {
    log.warn("git", "aborting leftover rebase before fresh attempt", {
      data: { worktreePath },
    });
    abortRebase(worktreePath);
  }
}

// Paths (relative to worktree root) currently in a merge-conflict state — i.e.
// files with unresolved conflict markers during a rebase/merge. Used in
// escalation alerts so the operator knows exactly where the resolver got stuck.
export function getUnmergedFiles(worktreePath: string): string[] {
  try {
    return nameList(worktreePath, ["diff", "--name-only", "-z", "--diff-filter=U"]);
  } catch {
    return [];
  }
}

export function forcePushBranch(worktreePath: string, branch: string): void {
  // Push the worktree's actual HEAD to the named branch on origin, regardless
  // of which local branch is currently checked out. Without HEAD: in the
  // refspec, git pushes refs/heads/<branch> from the local repo, which can
  // be stale (or unmoved) if the worker has done its work on a different
  // local branch in the same worktree. The previous behavior caused the
  // poller to force-push a stale ref and loop forever in handleMerged when
  // a worker created a side branch — see worktree workflow rules in
  // src/rules.ts for the directive that prevents the same trap.
  git(worktreePath, "push", "--force-with-lease", "--end-of-options", "origin", `HEAD:${branchRef(branch)}`);
}

export function mergeToBase(
  repoPath: string,
  branchName: string,
  baseBranch: string,
  ctx?: { project?: string; worker?: string },
): void {
  operatorGit(repoPath, "fetch", "origin");
  // Resolve to concrete SHAs so we can verify fast-forward and push without
  // needing a clean working tree or switching branches in the project checkout.
  const branchSha = git(repoPath, "rev-parse", "--verify", "--end-of-options", remoteBranchRef(branchName));
  const baseSha = git(repoPath, "rev-parse", "--verify", "--end-of-options", remoteBranchRef(baseBranch));
  // Verify fast-forward: branch must be a descendant of current base
  try {
    git(repoPath, "merge-base", "--is-ancestor", "--end-of-options", baseSha, branchSha);
  } catch {
    throw new Error(
      `Cannot fast-forward: origin/${branchName} (${branchSha}) is not a descendant of origin/${baseBranch} (${baseSha})`,
    );
  }
  // Push directly to remote base branch — no local checkout or merge needed.
  // --no-verify: this runs in the operator's checkout, whose .git/hooks may
  // carry a block-direct-pushes-to-main guard aimed at humans. The merge queue
  // is the authorized base-branch pusher (the branch is already reviewed and
  // fast-forward-verified above), so the checkout's pre-push guard must not
  // veto it. Such a guard was shadowed by the core.hooksPath leak until
  // scopeHooksPathToWorktree fixed the leak, which silently re-armed it and
  // blocked every merge with a bare "failed to push some refs".
  operatorGit(repoPath, "push", "--no-verify", "--end-of-options", "origin", `${branchSha}:${branchRef(baseBranch)}`);
  log.info("git", "merged to base branch", {
    worker: ctx?.worker,
    data: { branchName, baseBranch, ...(ctx?.project ? { project: ctx.project } : {}) },
  });
}

export type FastForwardResult =
  // `worktree`: the base branch was checked out, so `merge --ff-only` advanced
  // the working tree too — a configured postMerge can build it. `ref`: the
  // base was parked off to the side, so only its branch ref was advanced; the
  // working tree is on another branch and postMerge must be skipped.
  | { ok: true; advanced: "worktree" | "ref" }
  | { ok: false; reason: "diverged"; currentBranch: string | null; ahead: number; behind: number }
  | { ok: false; reason: "checked-out-elsewhere"; currentBranch: string | null; checkedOutAt: string | null }
  // `behind`: how far the stalled checkout has fallen behind origin. A dirty
  // checkout stays dirty, so this is the number that says whether it is a
  // moment's inconvenience or months of drift (and, when a postMerge builds
  // from it, how stale the built binary is).
  | { ok: false; reason: "dirty"; currentBranch: string | null; error: string; behind: number }
  | { ok: false; reason: "stuck"; error: string };

// Advance the project's local base branch to the freshly-merged origin tip.
// Two shapes, because `git merge --ff-only` only ever moves HEAD:
//   - base IS the checked-out branch -> `merge --ff-only` updates the working
//     tree as well (advanced: "worktree").
//   - base is NOT checked out (the operator parked the project checkout on
//     another branch — the deliberate many-base workflow) -> advance the ref
//     alone with `git fetch origin <base>:<base>` (advanced: "ref"). That
//     refspec is both fast-forward-enforced (it rejects a non-ff update — real
//     divergence) and worktree-aware (it refuses to move a branch checked out
//     in another worktree), so we never clobber local-only commits or desync a
//     sibling worktree. The common "ref simply trailed origin" case advances
//     silently; only genuine divergence or contention surfaces to the operator.
export function fastForwardBase(
  repoPath: string,
  baseBranch: string,
  ctx?: { project?: string; worker?: string },
): FastForwardResult {
  const worker = ctx?.worker;
  const baseData = { baseBranch, ...(ctx?.project ? { project: ctx.project } : {}) };
  const current = currentBranch(repoPath);
  if (current === baseBranch) {
    try {
      operatorGit(repoPath, "fetch", "--end-of-options", "origin", branchRef(baseBranch));
    } catch (err) {
      return { ok: false, reason: "stuck", error: gitErrText(err) };
    }
    try {
      operatorGit(repoPath, "merge", "--ff-only", "--end-of-options", remoteBranchRef(baseBranch));
      log.info("git", "fast-forwarded local base checkout", { worker, data: baseData });
      return { ok: true, advanced: "worktree" };
    } catch (err) {
      const error = gitErrText(err);
      // ff-only refused. The base checkout is the operator's shared working
      // directory, not a pristine mirror, so this is expected — and benign for
      // merge correctness (the work already landed on origin; only the local
      // rebuild lags). Classify into three sub-cases instead of one `stuck`.
      const dirty = isWorktreeDirty(repoPath);
      if (dirty === false && treeMatchesOrigin(repoPath, baseBranch)) {
        // Clean tree whose committed content already equals origin/<base>: the
        // local-only commit(s) carry no unique content (e.g. an operator heal
        // commit whose change also merged the normal way). Reset onto origin —
        // the reflog preserves the dropped commits and the working tree doesn't
        // move, since its content already matches. Never reset a dirty tree:
        // that would destroy uncommitted operator work.
        try {
          // No --end-of-options, as in syncWorktreeToRemote: reset rejects it
          // before git 2.44.
          operatorGit(repoPath, "reset", "--hard", remoteBranchRef(baseBranch), "--");
          log.info("git", "auto-healed redundant local base divergence onto origin", {
            worker,
            data: baseData,
          });
          return { ok: true, advanced: "worktree" };
        } catch (resetErr) {
          return { ok: false, reason: "stuck", error: gitErrText(resetErr) };
        }
      }
      if (dirty === false) {
        // Clean tree carrying real local-only content: genuine divergence.
        // origin holds the merged work; the operator reconciles by hand.
        const { ahead, behind } = aheadBehind(repoPath, branchRef(baseBranch), remoteBranchRef(baseBranch));
        log.debug("git", "base diverged from origin; postMerge skipped", {
          worker,
          data: { ...baseData, ahead, behind },
        });
        return { ok: false, reason: "diverged", currentBranch: current, ahead, behind };
      }
      // Dirty (or status unknowable): uncommitted local changes collide with the
      // merge. Leave the checkout untouched rather than clobber operator edits.
      const { behind } = aheadBehind(repoPath, branchRef(baseBranch), remoteBranchRef(baseBranch));
      log.debug("git", "base checkout dirty; no fast-forward or postMerge", {
        worker,
        data: { ...baseData, error, behind },
      });
      return { ok: false, reason: "dirty", currentBranch: current, error, behind };
    }
  }
  // Off-base: refresh the tracking ref (so divergence math below is accurate),
  // then advance the local branch ref without touching the working tree.
  try {
    operatorGit(repoPath, "fetch", "--end-of-options", "origin", branchRef(baseBranch));
  } catch (err) {
    return { ok: false, reason: "stuck", error: gitErrText(err) };
  }
  try {
    operatorGit(repoPath, "fetch", "--end-of-options", "origin", `${branchRef(baseBranch)}:${branchRef(baseBranch)}`);
    log.info("git", "advanced off-base local base ref to origin", {
      worker,
      data: { ...baseData, currentBranch: current },
    });
    return { ok: true, advanced: "ref" };
  } catch (err) {
    const text = gitErrText(err);
    if (/refusing to fetch into branch|checked out at/.test(text)) {
      const checkedOutAt = text.match(/checked out at '([^']+)'/)?.[1] ?? null;
      log.info("git", "off-base base ref not advanced: checked out elsewhere", {
        worker,
        data: { ...baseData, currentBranch: current, checkedOutAt },
      });
      return { ok: false, reason: "checked-out-elsewhere", currentBranch: current, checkedOutAt };
    }
    if (/non-fast-forward|\[rejected\]/.test(text)) {
      const { ahead, behind } = aheadBehind(repoPath, branchRef(baseBranch), remoteBranchRef(baseBranch));
      log.info("git", "off-base base ref not advanced: diverged from origin", {
        worker,
        data: { ...baseData, currentBranch: current, ahead, behind },
      });
      return { ok: false, reason: "diverged", currentBranch: current, ahead, behind };
    }
    return { ok: false, reason: "stuck", error: text };
  }
}

// Captured-stderr-first error text — execFileSync's own message omits the git
// stderr we need to classify the failure (non-fast-forward vs checked-out).
function gitErrText(err: unknown): string {
  const stderr = (err as { stderr?: string | Buffer }).stderr;
  return (stderr ? String(stderr) : String(err)).trim();
}

// True when the checkout's committed tree (HEAD) is byte-identical to
// origin/<base> — i.e. its local-only commits introduce no content origin
// lacks. `git diff --quiet` exits 0 on an identical tree (no throw) and
// non-zero otherwise (throw); any error is treated as "not identical" so the
// caller never resets onto origin under uncertainty.
function treeMatchesOrigin(repoPath: string, baseBranch: string): boolean {
  try {
    git(repoPath, "diff", "--quiet", ...DIFF_SAFETY_ARGS, "--end-of-options", "HEAD", remoteBranchRef(baseBranch));
    return true;
  } catch {
    return false;
  }
}

// Commit counts on either side of a divergence: `<local>...<remote>` left/right
// is (local-only, remote-only). Reported in the divergence alert so the
// operator sees how much local-only history they'd drop before reconciling.
function aheadBehind(
  repoPath: string,
  local: string,
  remote: string,
): { ahead: number; behind: number } {
  try {
    const out = git(repoPath, "rev-list", "--left-right", "--count", "--end-of-options", `${local}...${remote}`);
    const [a, b] = out.split(/\s+/);
    return { ahead: Number(a) || 0, behind: Number(b) || 0 };
  } catch {
    return { ahead: 0, behind: 0 };
  }
}

export function deleteRemoteBranch(
  repoPath: string,
  branchName: string,
  ctx?: { project?: string; worker?: string },
): void {
  const projectData = ctx?.project ? { project: ctx.project } : {};
  try {
    const refs = operatorGit(repoPath, "ls-remote", "--heads", "--end-of-options", "origin", branchRef(branchName));
    if (!refs.trim()) return;
    operatorGit(repoPath, "push", "--delete", "--end-of-options", "origin", branchRef(branchName));
    log.info("git", "deleted remote branch", {
      worker: ctx?.worker,
      data: { branchName, ...projectData },
    });
  } catch (err) {
    log.warn("git", "failed to delete remote branch", {
      worker: ctx?.worker,
      data: { branchName, error: String(err), ...projectData },
    });
  }
}

export function getChangedFiles(wtPath: string, baseBranch: string): string[] {
  try {
    return nameList(wtPath, ["diff", "--name-only", "-z", "--end-of-options", `${remoteBranchRef(baseBranch)}...HEAD`]);
  } catch (err) {
    log.warn("git", "getChangedFiles failed", { data: { baseBranch, error: String(err) } });
    return [];
  }
}

export function getChangedFilesBetween(
  wtPath: string,
  fromSha: string,
  toSha: string,
): string[] {
  try {
    return nameList(wtPath, ["diff", "--name-only", "-z", "--end-of-options", `${assertRevision(fromSha)}..${assertRevision(toSha)}`]);
  } catch (err) {
    log.warn("git", "getChangedFilesBetween failed", {
      data: { fromSha, toSha, error: String(err) },
    });
    return [];
  }
}

// `git diff --stat <range>` as a human-readable block (files + insertion/
// deletion counts). Two callers: `garden review` renders the review-window
// delta, and a reviewer prompt whose diff is too large to inline carries this
// summary instead so the reviewer can page the delta itself. Optional
// `files` scopes the range the same way the holistic diff is scoped. Empty
// string on a no-op range (a CLEAN review, where the reviewer pushed nothing)
// or any git failure — both callers render a fallback rather than throwing.
export function getDiffStat(
  wtPath: string,
  range: string,
  files: string[] = [],
): string {
  try {
    const args = ["diff", "--stat", ...DIFF_SAFETY_ARGS, "--end-of-options", assertRange(range)];
    if (files.length > 0) args.push("--", ...files);
    return git(wtPath, ...args).trim();
  } catch (err) {
    log.warn("git", "getDiffStat failed", {
      data: { range, error: String(err) },
    });
    return "";
  }
}

export interface DiffNumstat {
  files: number;
  insertions: number;
  deletions: number;
}

// `git diff --numstat from..to` parsed to totals, for the telemetry ledger's
// fix-magnitude signal (how much a reviewer/resolver actually changed). Each
// line is "<added>\t<deleted>\t<path>"; a binary file renders "-\t-\t<path>" and
// is counted as a touched file with zero line deltas. All-zero on a no-op range
// (a CLEAN review, where the reviewer pushed nothing) or any git failure — the
// same empty-on-failure contract as getDiffStat.
export function getDiffNumstat(
  wtPath: string,
  fromSha: string,
  toSha: string,
): DiffNumstat {
  const total: DiffNumstat = { files: 0, insertions: 0, deletions: 0 };
  try {
    const out = git(wtPath, "diff", "--numstat", ...DIFF_SAFETY_ARGS, "--end-of-options", `${assertRevision(fromSha)}..${assertRevision(toSha)}`).trim();
    if (!out) return total;
    for (const line of out.split("\n")) {
      const parts = line.split("\t");
      if (parts.length < 3) continue;
      total.files += 1;
      const added = parseInt(parts[0], 10);
      const deleted = parseInt(parts[1], 10);
      if (!Number.isNaN(added)) total.insertions += added;
      if (!Number.isNaN(deleted)) total.deletions += deleted;
    }
    return total;
  } catch (err) {
    log.warn("git", "getDiffNumstat failed", {
      data: { fromSha, toSha, error: String(err) },
    });
    return total;
  }
}

// Commit log across an arbitrary SHA range, optionally scoped to a file set.
// The whole-task rationale source for holistic review: unlike getCommitSummary
// (origin/<base>..HEAD, which is empty once the worktree is synced to the
// merged tip), this takes explicit endpoints so it stays populated at `done`.
export function getCommitLogRange(
  wtPath: string,
  fromSha: string,
  toSha: string,
  files?: string[],
): string {
  try {
    const args = ["log", "--oneline", "--end-of-options", `${assertRevision(fromSha)}..${assertRevision(toSha)}`];
    if (files && files.length > 0) args.push("--", ...files);
    return git(wtPath, ...args);
  } catch (err) {
    log.warn("git", "getCommitLogRange failed", {
      data: { fromSha, toSha, error: String(err) },
    });
    return "";
  }
}

// The production whole-task diff-scoping function, shared by the live holistic
// dispatcher and the offline backtest harness so both exercise one code path.
// Computes the cumulative diff from a worker's creation-time base SHA to the
// assembled tip, scoped to the union of files the worker touched. The scoping
// suppresses sibling-merge noise that advanced the base in between; its known
// limitation (blind to ripple into untouched files) is documented in the
// holistic worker's brief.
export function resolveHolisticDiff(
  wtPath: string,
  fromSha: string,
  toRef: string,
  touchedFiles: string[],
): string {
  try {
    const args = ["diff", ...DIFF_SAFETY_ARGS, "--end-of-options", `${assertRevision(fromSha)}..${assertRevision(toRef)}`];
    if (touchedFiles.length > 0) args.push("--", ...touchedFiles);
    return git(wtPath, ...args);
  } catch (err) {
    log.warn("git", "resolveHolisticDiff failed", {
      data: { fromSha, toRef, error: String(err) },
    });
    return "";
  }
}

export type SyncWorktreeResult =
  | { ok: true }
  | { ok: false; reason: "dirty" | "fetch-failed" | "reset-failed"; error?: string };

// Sync a worker's worktree to the latest remote tip of its branch. Used after
// a merge to discard the worker's pre-review HEAD and adopt the reviewer's
// force-pushed (and now-merged) version. Refuses to clobber uncommitted local
// changes — those are rare (the worker just finished its turn) but we don't
// want to silently nuke operator-typed edits.
export function syncWorktreeToRemote(
  wtPath: string,
  branchName: string,
): SyncWorktreeResult {
  try {
    const dirty = git(wtPath, "status", "--porcelain");
    if (dirty) return { ok: false, reason: "dirty" };
  } catch (err) {
    return { ok: false, reason: "fetch-failed", error: String(err) };
  }
  try {
    git(wtPath, "fetch", "--end-of-options", "origin", branchRef(branchName));
  } catch (err) {
    return { ok: false, reason: "fetch-failed", error: String(err) };
  }
  try {
    // No --end-of-options: reset rejects it before git 2.44, and a full ref
    // cannot be read as an option anyway.
    git(wtPath, "reset", "--hard", remoteBranchRef(branchName), "--");
  } catch (err) {
    return { ok: false, reason: "reset-failed", error: String(err) };
  }
  return { ok: true };
}

// Fast-forward a worker's worktree to the latest remote tip of the base
// branch. Used by `garden workers grow` when the worker's branch was already
// fully merged before the convert: the local branch tip equals its old
// merged commit, but `origin/<base>` may have advanced from sibling merges
// since. `merge --ff-only` enforces "strict ancestor" — if siblings have
// pushed commits that touched the same files in a way that would require a
// real merge, we surface that rather than clobbering with `reset --hard`.
export function syncWorktreeToBase(
  wtPath: string,
  baseBranch: string,
): SyncWorktreeResult {
  try {
    const dirty = git(wtPath, "status", "--porcelain");
    if (dirty) return { ok: false, reason: "dirty" };
  } catch (err) {
    return { ok: false, reason: "fetch-failed", error: String(err) };
  }
  try {
    git(wtPath, "fetch", "--end-of-options", "origin", branchRef(baseBranch));
  } catch (err) {
    return { ok: false, reason: "fetch-failed", error: String(err) };
  }
  try {
    git(wtPath, "merge", "--ff-only", "--end-of-options", remoteBranchRef(baseBranch));
  } catch (err) {
    return { ok: false, reason: "reset-failed", error: String(err) };
  }
  return { ok: true };
}

// Returns true if the worktree has uncommitted changes (tracked or
// untracked-not-gitignored). Thin wrapper over `git status --porcelain` —
// non-empty output means dirty. Returns null if the git invocation fails
// (path isn't a worktree, git unavailable, etc.) so callers can distinguish
// "definitely clean" from "couldn't determine".
export function isWorktreeDirty(wtPath: string): boolean | null {
  try {
    return git(wtPath, "status", "--porcelain").length > 0;
  } catch {
    return null;
  }
}

// The git repo the RUNNING garden build was compiled from, or null when the
// binary is not running out of a checkout. Resolved from argv[1] rather than
// the registered "garden" project: the install is what went stale, and it is
// reachable whether or not the operator registered it as a project.
// realpathSync resolves the npm-link symlink (bin/garden -> <repo>/dist/cli.js)
// to the real file, so dirname twice lands on the repo root.
export function gardenInstallRepo(): string | null {
  try {
    const bin = fs.realpathSync(process.argv[1] ?? "");
    const root = path.dirname(path.dirname(bin));
    return fs.existsSync(path.join(root, ".git")) ? root : null;
  } catch {
    return null;
  }
}

// How many commits `ref` is behind `origin/<branch>`, or null when it cannot be
// determined (unknown ref, no such branch, not a repo). Reads the LOCAL
// origin/<branch> ref — deliberately no fetch, since this feeds the status bar
// and must never touch the network; the ref is advanced by fastForwardBase's
// fetch on every merge, which is the same cadence the answer changes on.
export function commitsBehindOrigin(
  repoPath: string,
  ref: string,
  branch: string,
): number | null {
  try {
    const out = git(repoPath, "rev-list", "--count", "--end-of-options", `${assertRevision(ref)}..${remoteBranchRef(branch)}`);
    const n = Number(out.trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// Tracked files with UNSTAGED modifications. Deliberately narrower than
// isWorktreeDirty: it excludes untracked files (nothing here should ever delete
// an operator's new file) and staged changes (a deliberate act). This is the
// exact class a build/install hook churns — see revertPostMergeChurn.
export function listModifiedTrackedFiles(repoPath: string): string[] {
  try {
    return nameList(repoPath, ["diff", "--name-only", "-z"]);
  } catch {
    return [];
  }
}

// Restore tracked files that a command dirtied, leaving anything the operator
// had already modified alone. `before` is the listModifiedTrackedFiles snapshot
// taken immediately prior; only paths absent from it are reverted, so an
// operator edit in flight is never discarded. Returns the reverted paths.
export function revertChurn(repoPath: string, before: ReadonlySet<string>): string[] {
  const churn = listModifiedTrackedFiles(repoPath).filter(p => !before.has(p));
  if (churn.length === 0) return [];
  try {
    operatorGit(repoPath, "checkout", "--", ...churn);
    return churn;
  } catch (err) {
    // A failed revert leaves the churn in place, which is exactly the state
    // that wedges the next merge — so it must not be silent, or the trap
    // re-arms with nothing in the log to explain it.
    log.warn("git", "could not revert working-tree churn", {
      data: { files: churn.length, paths: churn.slice(0, 5).join(", "), error: gitErrText(err) },
    });
    return [];
  }
}

// Returns the number of commits the worker's HEAD is ahead of
// `origin/<baseBranch>`. Used by `garden workers grow` to decide whether
// the worker still has unmerged work to push (in which case the next merge
// fires the grow auto-continue) or is fully merged (in which case the
// convert command must dispatch iter-1 itself). Returns null if the count
// can't be determined — typically because the path isn't a git worktree
// or `origin/<baseBranch>` doesn't exist locally.
export function countCommitsAheadOfBase(
  wtPath: string,
  baseBranch: string,
): number | null {
  try {
    const out = git(wtPath, "rev-list", "--count", "--end-of-options", `${remoteBranchRef(baseBranch)}..HEAD`);
    const n = Number.parseInt(out, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// The newest commit as `<short sha> <subject>`, or "" when git cannot say.
export function getHeadSubject(wtPath: string): string {
  try {
    return runGit(wtPath, ["log", "-1", "--oneline", "HEAD"], { timeout: 10_000 }).trim();
  } catch {
    return "";
  }
}

export function getCommitSummary(wtPath: string, baseBranch: string): string {
  try {
    return runGit(wtPath, ["log", "--oneline", "--end-of-options", `${remoteBranchRef(baseBranch)}..HEAD`], { timeout: 10_000 }).trim();
  } catch (err) {
    log.warn("git", "getCommitSummary failed", { data: { baseBranch, error: String(err) } });
    return "";
  }
}

// Does the worktree HEAD have commits ahead of origin/<base>? Returns a
// boolean on success, or null when the git call itself failed (error/timeout).
// Callers that gate a review launch on "are there commits" MUST distinguish
// null from false: getCommitSummary returns "" for both, so treating its empty
// result as "no commits" lets a transient git failure permanently cancel a
// pending review. rev-list --count is cheaper than log --oneline and all the
// caller needs is the yes/no.
export function hasCommitsAhead(wtPath: string, baseBranch: string): boolean | null {
  try {
    const out = runGit(wtPath, ["rev-list", "--count", "--end-of-options", `${remoteBranchRef(baseBranch)}..HEAD`], { timeout: 10_000 }).trim();
    return parseInt(out, 10) > 0;
  } catch (err) {
    log.warn("git", "hasCommitsAhead failed", { data: { baseBranch, error: String(err) } });
    return null;
  }
}

export function getNewCommitSummary(wtPath: string, sinceSha: string | undefined): string {
  if (!sinceSha) return "";
  try {
    return runGit(wtPath, ["log", "--oneline", "--end-of-options", `${assertRevision(sinceSha)}..HEAD`], { timeout: 10_000 }).trim();
  } catch (err) {
    log.warn("git", "getNewCommitSummary failed", { data: { sinceSha, error: String(err) } });
    return "";
  }
}

export function pruneWorktrees(repoPath: string): void {
  try {
    operatorGit(repoPath, "worktree", "prune");
  } catch {
    // best effort
  }
}

export function installPollTriggerHook(wtPath: string, _gardenRunner: string, projectName: string): void {
  const hooksDir = path.join(wtPath, ".garden-hooks");
  const hookPath = path.join(hooksDir, "pre-push");
  const signalFifo = path.join(SESSIONS_DIR, `${projectName}-poll-signal`);

  const hookScript = [
    "#!/bin/sh",
    `# Signal the poller immediately`,
    `FIFO="${signalFifo}"`,
    `if [ -p "$FIFO" ]; then`,
    `  (echo > "$FIFO") </dev/null >/dev/null 2>&1 &`,
    `fi`,
    `exit 0`,
    "",
  ].join("\n");

  // Atomic write: git reads pre-push on every push, and a worker mid-push
  // could otherwise see a half-written script and silently skip the FIFO
  // signal. Practical risk is near-zero (install runs once at worker
  // creation, before the worker has anything to push) but the cost is
  // a single function swap.
  atomicWriteFile(hookPath, hookScript, { mode: 0o755 });
  scopeHooksPathToWorktree(wtPath, hooksDir);
  log.info("git", "installed poll trigger hook");
}

// Point core.hooksPath at this worktree's .garden-hooks WITHOUT leaking to the
// shared repo config. Plain `git config --local core.hooksPath` writes to the
// shared `.git/config`, so the MAIN checkout and every sibling worktree inherit
// it: the operator's next commit in the main checkout would then run whichever
// worker installed last — a sandbox-writable hook executing UNSANDBOXED in the
// operator's tree — and the operator's own `.git/hooks/*` (e.g. a block-push
// guard) go dormant. Enable worktree-scoped config, clear any garden-owned
// value that already leaked into the shared config (an operator's own value is
// left alone), then write this worktree's hooksPath in worktree scope so it
// applies here only and the main checkout falls back to its default .git/hooks.
// Idempotent: safe to re-run on every worker create / refresh / bounce.
export function scopeHooksPathToWorktree(wtPath: string, hooksDir: string): void {
  git(wtPath, "config", "extensions.worktreeConfig", "true");
  let sharedHooksPath: string | null = null;
  try {
    sharedHooksPath = git(wtPath, "config", "--local", "--get", "core.hooksPath");
  } catch { /* unset in shared config — nothing leaked */ }
  if (sharedHooksPath && sharedHooksPath.endsWith(".garden-hooks")) {
    try { git(wtPath, "config", "--local", "--unset", "core.hooksPath"); } catch { /* already clear */ }
  }
  git(wtPath, "config", "--worktree", "core.hooksPath", hooksDir);
}

function installDeps(wtPath: string): void {
  if (fs.existsSync(path.join(wtPath, "package.json"))) {
    try {
      execFileSync("npm", ["install"], {
        cwd: wtPath,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120_000,
      });
      log.info("git", "installed npm dependencies");
    } catch (err) {
      log.warn("git", "failed to install npm dependencies", {
        data: { error: String(err) },
      });
    }
  }
  if (fs.existsSync(path.join(wtPath, "pyproject.toml"))) {
    try {
      const contents = fs.readFileSync(
        path.join(wtPath, "pyproject.toml"),
        "utf-8",
      );
      if (!contents.includes("[tool.poetry]")) return;
      execFileSync("poetry", ["install", "--no-interaction"], {
        cwd: wtPath,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 300_000,
      });
      log.info("git", "installed poetry dependencies");
    } catch (err) {
      log.warn("git", "failed to install poetry dependencies", {
        data: { error: String(err) },
      });
    }
  }
}

// The checked-out branch, or "HEAD" when detached. Read from HEAD's full ref:
// `rev-parse --abbrev-ref` shortens a name the way git disambiguates it, so a
// tag named like the branch, which any worker can create in the shared refs
// store, turns "main" into "heads/main".
export function currentBranch(repoPath: string): string | null {
  try {
    const ref = git(repoPath, "symbolic-ref", "--quiet", "HEAD");
    return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : "HEAD";
  } catch (err) {
    // symbolic-ref --quiet exits 1, printing nothing, when HEAD is detached.
    return (err as { status?: number }).status === 1 ? "HEAD" : null;
  }
}

// Fast, DISPLAY-ONLY branch resolution: read the branch name straight from
// .git/HEAD instead of forking `git rev-parse`. The status render resolves the
// checked-out branch of every project in the active plot plus the header's
// active project on every repaint (hook firehose + every nav) — that was ~6 git
// forks (~8ms each) per repaint; a .git/HEAD read is ~0.05ms. Falls back to the
// git fork on a detached HEAD (raw SHA, no `ref:`) or any read/parse failure,
// so the displayed value matches `git rev-parse` in every case the fast path
// can't resolve. NOT for merge decisions — those call currentBranch directly
// for ground truth (a partial/racing HEAD read must never gate a force-push).
export function currentBranchFast(repoPath: string): string | null {
  try {
    const dotGit = path.join(repoPath, ".git");
    let gitDir = dotGit;
    if (!fs.statSync(dotGit).isDirectory()) {
      // Linked worktree: .git is a file "gitdir: <path>".
      const m = fs.readFileSync(dotGit, "utf-8").trim().match(/^gitdir:\s*(.+)$/);
      if (!m) return currentBranch(repoPath);
      gitDir = m[1];
    }
    const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf-8").trim();
    const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    return ref ? ref[1] : currentBranch(repoPath);
  } catch {
    return currentBranch(repoPath);
  }
}

// Extract the host from the origin remote URL. Handles both ssh-style
// (git@host:owner/repo.git) and https-style (https://host/owner/repo.git)
// forms. Returns null if there is no origin or the URL can't be parsed.
export function getRemoteHost(repoPath: string): string | null {
  let url: string;
  try {
    url = git(repoPath, "config", "--get", "remote.origin.url");
  } catch {
    return null;
  }
  if (!url) return null;
  const sshMatch = url.match(/^[^@]+@([^:]+):/);
  if (sshMatch) return sshMatch[1];
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

// Hooks and fsmonitor off (see git-exec.ts): every helper here may be handed a
// worker's worktree. operatorGit keeps them, for the commands garden runs in
// the operator's own checkout.
function git(cwd: string, ...args: string[]): string {
  return runGit(cwd, args).trim();
}

function operatorGit(cwd: string, ...args: string[]): string {
  return runGit(cwd, args, { operatorHooks: true }).trim();
}

// A -z path list. Unlike newline output, git does not quote these, so a path
// with non-ASCII bytes or a quote comes back as itself.
function nameList(cwd: string, args: string[]): string[] {
  return runGit(cwd, args).split("\0").filter(Boolean);
}

// "<a>..<b>" or "<a>...<b>", each end a revision assertRevision accepts.
function assertRange(range: string): string {
  const ends = range.split(/\.{2,3}/);
  if (ends.length !== 2) throw new Error(`not a revision range: ${JSON.stringify(range)}`);
  ends.forEach(assertRevision);
  return range;
}

// Diff drivers and textconv filters are programs named in git config, which a
// Codex worker's sandbox can write, so content diffs garden builds run neither.
const DIFF_SAFETY_ARGS = ["--no-ext-diff", "--no-textconv"] as const;

// Absolute path to the repo's shared git common dir (`<main>/.git`) — the
// object store and refs every linked worktree writes through. A worktree's own
// git dir (HEAD/index/logs) lives under it at `worktrees/<name>/` — see
// getWorktreeAdminDir for why a sandbox grants that one separately. Resolved from the main checkout so
// it works before a worktree exists; returns null if git can't resolve it.
// Used to grant a Codex worker's workspace-write sandbox access to its git
// storage, which sits OUTSIDE the worktree cwd (claude-code's sandbox
// auto-grants the git dir; Codex's does not).
export function getGitCommonDir(repoPath: string): string | null {
  try {
    const dir = git(repoPath, "rev-parse", "--git-common-dir");
    return path.isAbsolute(dir) ? dir : path.resolve(repoPath, dir);
  } catch {
    return null;
  }
}

// A linked worktree's own admin dir under the common dir (HEAD, index), read
// from its `.git` pointer file exactly as Codex resolves it, so a sandbox grant
// names the same path Codex protects. Before the worktree exists (a fresh
// spawn builds its launch command first), this is where `git worktree add`
// puts it: `<common>/worktrees/<basename>`.
export function getWorktreeAdminDir(wtPath: string, commonDir: string): string {
  try {
    const pointer = fs.readFileSync(path.join(wtPath, ".git"), "utf-8").trim();
    if (pointer.startsWith("gitdir:")) return path.resolve(wtPath, pointer.slice("gitdir:".length).trim());
  } catch {
    // Not created yet: fall through to git's default name.
  }
  return path.join(commonDir, "worktrees", path.basename(wtPath));
}

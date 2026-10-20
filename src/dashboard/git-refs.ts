// The names garden hands to git. Most come from places a worker can write: the
// registry in ~/.garden/sessions, and ref names in the shared refs store. Git
// reads any argument that starts with "-" as an option, so a forged base of
// "--upload-pack=<cmd>" or a SHA of "--output=<path>" would turn a fetch or a
// diff garden runs as the operator into something else. Every such value is
// validated here before it reaches git.
//
// A leaf module: the hook bundle (hooks/default.ts) and the bootstrap script
// builder both use it.

// An object name as garden stores one: rev-parse output, full or abbreviated.
export function isCommitSha(value: string): boolean {
  return /^[0-9a-f]{7,64}$/.test(value);
}

// git check-ref-format's rules for a branch name, without forking git. Rejects
// a leading "-" as `git branch` does.
export function isValidBranchName(name: string): boolean {
  if (!name || name.startsWith("-") || name === "@" || name === "HEAD") return false;
  // Control characters, space, and ~ ^ : ? * [ \ are never allowed.
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return false;
  if (name.includes("..") || name.includes("@{") || name.includes("//")) return false;
  if (name.startsWith("/") || name.endsWith("/") || name.endsWith(".")) return false;
  return name.split("/").every(part => !part.startsWith(".") && !part.endsWith(".lock"));
}

// A revision garden passes as one: an object name, HEAD, or a fully qualified ref.
export function isSafeRevision(rev: string): boolean {
  if (isCommitSha(rev) || rev === "HEAD") return true;
  return rev.startsWith("refs/") && isValidBranchName(rev);
}

export function assertBranchName(name: string): string {
  if (!isValidBranchName(name)) throw new Error(`not a valid git branch name: ${JSON.stringify(name)}`);
  return name;
}

export function assertRevision(rev: string): string {
  if (!isSafeRevision(rev)) throw new Error(`not a commit SHA, HEAD or full ref: ${JSON.stringify(rev)}`);
  return rev;
}

// origin's copy of a branch by its full name. The abbreviated "origin/<base>"
// resolves through git's lookup order, which checks tags and local branches
// first, so a tag or branch named "origin/<base>" would stand in for it. Never
// throws: these run inside poll passes, where a throw would stop every worker
// in the project, and a full ref cannot be read as an option whatever the
// branch says (git rejects a malformed one as an unknown revision).
export function remoteBranchRef(branch: string): string {
  return `refs/remotes/origin/${branch}`;
}

// A branch by its full name, for fetch and push refspecs and ls-remote: the
// bare name would also match a tag of the same name on the remote.
export function branchRef(branch: string): string {
  return `refs/heads/${branch}`;
}

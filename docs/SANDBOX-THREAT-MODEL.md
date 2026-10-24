# Sandbox threat model

**Status: reference.** This describes garden's worker-sandbox security posture as
currently implemented, the boundaries it enforces, and the residual risks an operator
must account for. It is not a spec — if the code and this doc disagree, treat it as a
bug in whichever is wrong and reconcile them.

Garden began as a single-operator tool, where "a rogue worker" meant "your own agent on
your own machine." Running workers over less-trusted repository content — the external-
client case — turns several former conveniences into real security boundaries. This doc
is the map of which boundaries hold, which are opt-in, and which are still open.

## Threat model

The adversary is a **worker agent that has gone rogue** — prompt-injected by the repo or
task content it processes, or a misbehaving model — attempting to (a) escape its sandbox
to run code in the operator's context, or (b) read and exfiltrate operator credentials.
Garden is not defending against a malicious operator, nor against a compromised host.

Two trust levels matter:

- **Sandboxed** — worker agents, and the headless reviewer/resolver/ci-fix agents on the
  claude-code path, run inside the OS sandbox Claude Code configures from garden's
  settings file under `~/.garden/control/claude-settings/`, passed with `--settings`
  (Seatbelt on macOS, bubblewrap on Linux) — the headless `claude -p` gets the
  worker's file. The repo's own `.claude/settings.json` merges in and can widen the
  sandbox; that is the repo owner's committed config, at the trust level of its hooks. A Codex worker runs inside
  Codex's own `workspace-write` sandbox. The Codex *review family* is the exception and
  is not in this tier — see residuals.
- **Unsandboxed** — the poller, watchdog, garden's Claude Code hook handlers, and the
  operator's own shell run with the operator's full privileges. They read the worker
  registry and files in workers' worktrees, and they run git both in the operator's
  checkout and inside workers' worktrees.

The danger is any path by which sandboxed code influences what unsandboxed code later
reads or runs.

## What the sandbox enforces

- **Write confinement.** `buildSandboxConfig` (`src/dashboard/sandbox.ts`) grants a
  worker write access only to its worktree, standard subprocess caches (`~/.npm`,
  `~/.cache`, `/tmp`), and `~/.garden/sessions`, plus any directories the operator lists
  in the project's `sandboxWriteRoots` (none by default; `/`, top-level directories, the
  home directory, and garden's control plane are refused). Existing targets must be
  directories, and symlinked paths are stored as their canonical targets. A bead-intake
  project's workers may also write its beads store; a configured `beadsDir` is held to
  the same refusals (`resolveBeadsWriteRoot`). Claude Code adds a grant of its own: the
  repository's shared git common dir (`<main>/.git`), which a linked worktree's commits
  write through, so its refs, objects and every other worktree's admin entry are writable
  too; a Codex worker gets the same directory through its `writable_roots`. The files
  carved back out of it, and what the rest exposes, are under "Git admin-file isolation"
  below and in the residuals. Everything else is read-only or denied at the kernel.
- **Egress allowlist.** Network is restricted to Anthropic, GitHub, npm, the project's
  git remote host, and any per-project `sandboxDomains`. A worker cannot POST to an
  arbitrary host. (Codex is the exception — see residuals.)
- **Git-hook isolation.** Worker hooks are installed with `core.hooksPath` in
  `--worktree` scope under `extensions.worktreeConfig` (`scopeHooksPathToWorktree` in
  `src/dashboard/git.ts`). Before this, a worker's hooksPath leaked into the shared
  `.git/config` and the operator's **main checkout** ran whichever worker's
  `.garden-hooks/` was installed last — so any worker could plant a `pre-commit` that the
  operator's next commit executed unsandboxed. The scoped install closes that: the main
  checkout runs its own default `.git/hooks`, and the operator's own hooks (e.g. a
  block-push-to-main guard) stay armed. The scoping still left garden's own git exposed:
  the poller pushes, fetches, rebases and checks out inside the worktree, where
  `.garden-hooks/` is worker-writable and git-excluded, so a planted `pre-push` ran
  unsandboxed on the next verdict push. Every git command garden runs now goes through
  `runGit` (`src/dashboard/git-exec.ts`) with `core.hooksPath=/dev/null` and
  `core.fsmonitor=false`; only garden's operations on the operator's own checkout
  (fast-forward, base push, `worktree add`, branch cleanup) keep that checkout's hooks,
  which belong to the operator (board's beads hooks import on post-merge).
- **Git admin-file isolation.** Claude Code write-protects the session's own repository
  config: probed from inside a worker sandbox on Claude Code 2.1.304, `.git/config`,
  `.git/config.worktree`, `.git/hooks`, the worktree's `.git` pointer, and its admin
  entry's `config.worktree` and `commondir` are all denied. The shared git dir is
  otherwise writable (commits need it), and with it every *other* worktree's admin entry
  under `<main>/.git/worktrees/<name>/`. A worker could point a sibling's `commondir` at
  a repository it controls, or put an fsmonitor, ssh command or filter driver in the
  sibling's `config.worktree`, and garden's unsandboxed git in that worktree would run
  it. `buildSandboxConfig` adds `filesystem.denyWrite` globs for
  `<main>/.git/worktrees/*/{config.worktree,commondir,gitdir}`, which cover worktrees
  created after the session started. Claude Code applies the globs fully on macOS and
  warns that Linux support for them is partial.
- **Reads of worker-controlled files.** Garden never follows a path the worker controls
  from an unsandboxed process. The review prompt's documentation, test-file and spec
  inputs are read as committed regular-file blobs at HEAD (`readCommittedFiles` in
  `src/dashboard/git.ts`), never from the worktree; a committed symlink is skipped rather
  than followed, which kept a symlinked `DESIGN.md` from inlining a credential file the
  worker's own sandbox cannot read, or the poller's signal FIFO, which never reaches EOF.
  The grow goal and log files, which are git-excluded and edited mid-loop, are read with
  `readStableRegularFile` (`src/dashboard/safe-read.ts`): no-follow, non-blocking (a FIFO
  is refused at fstat instead of blocking the open), contained within the worktree,
  single-link, and size-capped. The same reader serves the Codex installer's reads of the
  worktree `AGENTS.md` and `AGENTS.override.md`, which it composes back into the worker's
  own instructions (a symlink there would otherwise deliver a file the worker's sandbox
  cannot read), the handoff dispatcher's seed copies, and both installers' `info/exclude`
  heal, whose append goes only to the file that was read (`appendToStableFile`), as does
  the one-time rewrite of it that drops an older Codex build's unanchored lines (run by both
  installers and a Claude worker's spawn), which also requires the file to still hold the
  bytes it read (`rewriteStableFile`).
- **Launch inputs.** What an unsandboxed process runs, or hands an agent as
  instructions, lives under `~/.garden/control` rather than `~/.garden/sessions`: the
  worker bootstrap script and the dashboard pane scripts (`control/scripts`), the
  system-prompt context files Claude reads with `--append-system-prompt-file` and the
  Codex installer composes into `AGENTS.override.md` (`control/contexts`), the status-line script
  Claude Code runs outside the sandbox (`control/claude-settings`), and the seed prompts
  the unsandboxed seeder pastes as a worker's first prompt (`control/seeds`). In the
  sessions dir a worker could rewrite a bootstrap script while its shell was still
  reading it, give a sibling different rules, or swap a sibling's briefing, or a symlink
  to a file it cannot read, in before delivery. The seeder reads only regular files,
  without following links, from the control tree, and from the sessions dir only for a
  seed an older build left there. `garden handoff` runs inside the sandbox, so its seed
  starts in the sessions dir and is copied into the control tree before use (below).
  The V8 compile cache Node loads for the per-tool-call hook lives there too
  (`control/node-compile`). The hook runs unsandboxed, and Node checks a cache entry only
  against a keyless CRC32, so a worker able to write the cache, as it could under
  `~/.cache`, fed that process bytecode of its choosing: a substituted entry with a
  recomputed checksum passed Node's check and aborted the process inside V8.
  **This one needs a rollout step.** The cache path is baked into each worker's hook
  commands when its settings file is written — at spawn, bounce, loop respawn, or a
  dashboard attach — and a merge-driven deploy rewrites none of those. Every
  claude-code worker alive at deploy time therefore keeps pointing its unsandboxed hook
  at the old `~/.cache` directory until it is bounced or the dashboard is re-attached.
  Nothing breaks either way (Node creates the new directory on first use), but the
  protection does not apply to those workers until then.
- **Dependency installs from unreviewed content.** Resurrect rebuilds a worker's
  worktree and installs its dependencies as the operator, outside any sandbox. It does
  that only for a tree started from the project's own base on origin. A tree restored
  from the worker's own branch or tip, from a local-only branch under the base's name,
  or from any other branch the tombstone names — `baseBranch` is copied from the
  worker-writable registry — installs nothing at all: neither npm nor poetry runs
  (`installDeps` in `src/dashboard/git.ts`), and the operator is told so in the
  resurrect output, because those dependencies are the worker's own sandboxed session's
  to install.
  `npm install --ignore-scripts` was tried first and is not sufficient: it suppresses
  lifecycle scripts, but npm also reads the tree's own `.npmrc`, and keys there name
  programs npm executes itself. With `git` set, a measured `npm install
  --ignore-scripts` ran a script from the tree three times as the operator while
  correctly skipping the package's `preinstall`. Pinning that key on the command line
  would close only the keys we thought of, so the install is skipped outright.
  Content from the project's base on origin is only as trustworthy as that ref
  (see residuals).
- **Review-channel integrity.** Reviewer, resolver, and CI-fix prompts, results, and
  harness sidecars live under `~/.garden/control/headless`, outside the worker's
  `~/.garden/sessions` write grant. Durable holistic shadow reports live under
  `~/.garden/control/reports`. The outer poller-owned launch shell opens these files
  before the headless agent runs, so sandboxed agents can still consume the prompt and
  emit a verdict without granting the worker write access to the verdict channel.
  Unsafe, malformed, or oversized project and worker names are mapped to bounded SHA-256
  filename components, preventing a forged registry name from traversing out of the
  control tree or exceeding filesystem filename limits.
- **Handoff-channel integrity.** A worker writes only the UUID-named request and seed
  into `~/.garden/sessions`. Before acting, an unsandboxed poller moves the request into
  `~/.garden/control/handoff`, binds the body ID to the filename, and copies the seed
  from a no-follow, containment-checked stable file descriptor. Claims, delayed seed
  copies, and durable results remain outside the worker write grant. Dead-owner claims
  are replayed from the protected tree, while a request ID on the registry entry and a
  durable receipt prevent replay from spawning the same handoff twice. Until a poller
  claims it, a request and its seed are as writable by a sibling as by their author (see
  residuals).
- **Registry forgery guard (partial).** The worker registry lives in the
  sandbox-writable `~/.garden/sessions`. Its read guard (`invalidEntryField`, applied to each
  entry by `readRegistry` in `src/dashboard/registry.ts`) type-checks the trusted fields (`prState`, `agentStatus`,
  `baseBranch`, `branchName`, `worktreePath`, `sessionId`, `handoffRequestId`, `bead`) and drops an entry that
  fails, so a forged wrong-typed value cannot flow into a path/git/dispatch consumer. This stops malformed forgery; it does
  not stop a well-formed malicious entry (see residuals). Values that reach git are also
  checked where git is called (`git-refs.ts`): a SHA must be an object name, a branch is
  passed as a full ref, and `--end-of-options` precedes them, so a forged `lastSeenSha` of
  `--output=<path>` no longer makes `git log` write a file as the operator.
- **Credential read-deny (opt-in).** With `sandboxDenyCredentials` set on a project,
  the sandbox additionally denies read of the operator's credential paths (`~/.claude`,
  `~/.ssh`, cloud creds — `DENIED_CREDENTIAL_PATHS`) via Claude Code's
  `sandbox.credentials` (mode `deny`) plus `filesystem.denyRead`. OS-enforced and,
  per Claude Code's docs, scoped to sandboxed Bash subprocesses only — the parent
  `claude`/reviewer authenticate before the boundary. **Default off** (see residuals).

## Residual risks and operator responsibilities

- **Credential read-deny must be verified before it protects anything.** It ships off
  because the parent-auth timing is documented but not guaranteed for every Claude Code
  release, and enabling it while wrong would break reviewer auth fleet-wide. Requires
  Claude Code >= 2.1.187. To enable safely, per project:
  1. `garden config <project> sandboxDenyCredentials true`
  2. Spawn a worker and confirm a review still completes (the reviewer authenticates).
  3. In the sandboxed worktree, confirm `cat ~/.claude/.credentials.json` is blocked.
  If step 2 fails, disable it and fall back to per-worker credential-dir isolation.
  Until this is done and (optionally) the default flipped on, clients are **not**
  protected against credential exfiltration by a prompt-injected worker.
- **Codex workers are less confined than Claude workers.** A Codex worker
  (`--harness codex`, opt-in) uses Codex's `workspace-write` sandbox, which has:
  - **No per-domain egress** — `network_access` is a boolean; the `sandboxDomains`
    allowlist is not enforced. A compromised Codex worker can reach any host.
  - **A broad git-dir write grant** — the worker gets the shared git common dir
    (`<main>/.git`) writable so it can commit/push from a linked worktree, plus the
    worktree's own `<main>/.git/worktrees/<name>` by exact path (Codex 0.160+ protects
    that resolved gitdir from broader grants; it sits inside the common dir, so naming it
    widens nothing). That grant
    still includes `hooks/` and `config`, so a Codex worker can write `<main>/.git/hooks/*`
    (which the main checkout now runs, post git-hook isolation) or repoint `core.hooksPath`
    via `config`. Writing `config` also **repoints `remote.origin.url`**, which defeats
    every protection that asks origin for a commit rather than trusting a local ref: the
    bootstrap's `ls-remote`, its fetch, and the merge queue's tip reads all consult
    whatever remote that file names. Demonstrated end to end against a scratch project
    on 2026-10-21: with origin repointed at a attacker-controlled bare repo, the real
    generated bootstrap installed that repo's `main`, ran its `preinstall` as the
    operator, created the worktree on its commit, and fast-forwarded the operator's main
    checkout to it. This is strictly stronger than the ref rewrite above — it survives
    the healing fetch, and no amount of asking origin helps when origin is the
    attacker's. It is the reason the ref-resolution work above is scoped to claude-code. It can also write every worktree's `config.worktree` and `commondir`,
    which the claude-code sandbox denies. Garden's own git still runs with hooks,
    fsmonitor, external diff drivers and textconv off, but other command-running keys
    cannot be neutralized from the command line — an ssh command on fetch and push,
    filter drivers on checkout and status, a signing program on rebase — so only removing
    the write grant closes them. Narrowing the grant to exclude these files is pending
    validation that Codex's `writable_roots` supports the required granularity and that
    commit/push still work — until then, treat Codex workers as **do not run on untrusted
    repo content**.
- **A Codex reviewer runs with no sandbox at all.** `buildHeadlessCommand`
  (`src/dashboard/harness/codex-core.ts`) invokes `codex exec
  --dangerously-bypass-approvals-and-sandbox`, so a Codex reviewer/resolver/ci-fix agent
  runs with the operator's full privileges — unlike the claude-code review family, whose
  headless `claude -p` uses freshly generated project sandbox settings in a protected prompt sidecar. This is the sharpest residual in
  the model: the reviewer's whole job is to read a diff and repo content a possibly
  prompt-injected worker just wrote, and it does so unconfined. Selecting a Codex
  reviewer (`role reviewer harness codex`, or a `*-codex` crew) is therefore a
  trust decision about the repo content under review, not only about review quality.
  Confining it is pending the same `writable_roots` validation as the worker case, plus
  confirming `codex exec` can complete a review under a non-bypass sandbox.
- **The registry is writable by workers, and it gates review.** Moving review exchange
  files closes verdict replacement, but it does not make `~/.garden/sessions` a trusted
  control store. The registry type guard is defense-in-depth; a worker with a
  valid-looking forged entry can still direct the unsandboxed poller:
  - **Skip review.** The merge queue acts on `prState` and `mergeReadySha` as recorded,
    so an entry set to `merge-pending`, with `mergeReadySha` absent or naming the current
    HEAD, merges that HEAD without a reviewer having seen it. Unreviewed commits on the
    base then reach the operator's context: the next worker's bootstrap installs the
    base's dependencies with package scripts, and `postMerge` runs in the operator's
    checkout. Registry forgery is therefore a route to running code as the operator, not
    only to manipulating fleet state.
  - **Push to another branch.** Garden force-pushes the worker's HEAD to the entry's
    `branchName` and deletes that branch after merge. A worker's branch always carries
    its name, but nothing yet enforces that on a forged entry.
  - **Retarget its merge base** through `baseBranch`.
  - **Type into a sibling's agent.** Any entry's `pendingHandoffCallbacks` is pasted
    verbatim into that worker's pane at its next turn end (`deliverHandoffCallbacks` in
    `src/dashboard/continue.ts`).
  - **Have a stopped sibling's work removed** with a forged cleanup request (below).

  The handoff inbox and `sessions/seeds` are shared the same way: any worker can rewrite
  or delete a sibling's pending request or seed before a poller claims it, so
  handoff-channel integrity holds only against the requesting worker. The principled
  fix — moving the registry out of the worker-writable set and routing the mutations
  sandboxed commands make (`garden workers grow`, `garden blocked`, `garden reply`)
  through validated request files the poller applies — remains required.
- **Resurrecting unreviewed content still resumes an agent in that tree.** Skipping the
  dependency install keeps the operator from running the tree's build scripts, but
  `resurrectWorker` then resumes the session in the rebuilt worktree, and a repo's own
  committed `.claude/settings.json` merges with garden's `--settings` file, with its
  hooks still applying and running unsandboxed. The trust assumption stated above — that
  this file is the repo owner's committed config — does not hold for a tree restored from
  a worker's own branch or tip, which no review saw. Not yet verified: whether a worker
  can get a modified settings file committed despite the sandbox's write-deny on that
  path (the shared git dir and indexes are writable, which is why this is open rather
  than dismissed). Until it is, resurrecting an unreviewed start point is an operator
  decision about that branch's content, not a confined operation.
- **Workers can still move the git state garden acts on.** The shared refs (including
  `refs/remotes/origin/*` and `packed-refs`), a sibling's `HEAD` and index, and new
  `info/attributes`, `shallow` and `objects/info/alternates` files in the shared git dir
  are all writable. None of them makes git itself run a program (attributes can only
  select drivers, and the files that define drivers are denied), but they can point garden
  at a different commit or a truncated history. Garden names origin's branch in full and
  reads branch names back from full refs, so a tag or branch merely named `origin/<base>`
  no longer stands in for it and a tag named `main` no longer renames the checked-out
  branch. A worker can still rewrite `refs/remotes/origin/<base>` itself in the window
  between a fetch and the read that follows, and that read decides more than which diff
  review sees.
  The merge queue asks origin for both tips (`remoteTipSha`, over `git ls-remote`) rather
  than reading the refs its own fetch just wrote, so the commit pushed to the base branch
  is the one origin carries for the worker's branch, and the fast-forward that advances the
  operator's checkout — what a configured `postMerge` then builds and installs — advances
  to origin's reading of the base. Both functions already contact origin for their own
  fetch, so this costs a round-trip rather than a new dependency, and the remote URL comes
  from the shared `.git/config`, which no sandbox grants. Those reads alone do not keep
  unreviewed commits off the base: `mergeToBase` checks only that the branch tip descends
  from origin's base tip, and a forged base committed on top of that tip passes. The
  queue's own rebase (`rebaseBranch`) took its target from the tracking ref after its
  fetch, so a forged base written in that window was replayed beneath the reviewed
  commits, force-pushed with them, and pushed to the base (reproduced with real git,
  2026-10-24). The queue now asks origin for the base tip before that fetch and rebases
  onto it, and when origin does not answer or the fetch did not bring that commit in, it
  skips the rebase rather than falling back to the ref (`handleMergePending`,
  `poller-merge.ts`).
  The two install paths ask origin the same way **for a claude-code worker**. The
  new-worker bootstrap resolves the base commit from origin (`baseShaStep`, `create.ts`)
  and uses that SHA for both the main-checkout fast-forward and the `worktree add` whose
  dependencies it then installs with package scripts, aborting the spawn rather than
  guessing when origin cannot be read or when the commit origin named is not in the
  object store; resurrect's origin-base start point — its only one that installs with
  scripts on — resolves the same way. All of it rests on `remote.origin.url` being
  fixed, which holds only where `.git/config` is write-denied: a **Codex** worker's git
  grant includes that file (see the Codex residual below), so there the whole mechanism
  is bypassable by repointing origin, and asking origin is asking whoever the worker
  chose. Both restore the branch's upstream explicitly, since a SHA
  start point carries none and garden's own worker rules have every worker check
  `git log @{u}..HEAD`.
  Still open, and not lower-stakes: what review *sees* comes from the same ref. The review
  prompt's diff and the reviewer's own rebase (`git rebase refs/remotes/origin/<base>`, per
  its prompt) read it after the review launch's fetch, and the resolver's rebase and the
  poller's check of it read it too. A base forged in either window puts its commits inside
  the branch that is then pushed, under a diff that does not show them, and the queue lands
  them with the reviewed work: it skips the rebase when the branch already contains
  origin's tip, and replays them with the reviewed commits when origin has moved on (both
  reproduced). Closing that needs the poller to pin each review's base from origin, hand
  that SHA to the reviewer and resolver, and refuse at merge any commit between origin's
  tip and HEAD outside the reviewed range, a record that cannot live in the worker-writable
  registry. Registry forgery ("Skip review", above) reaches the same end more simply.
  Replace refs no longer stand in for those SHAs. git reads the object
  `refs/replace/<sha>` points at in place of the commit that SHA names unless told not
  to, and a replacement for origin's tip written from a worktree did exactly that
  (reproduced against a scratch repository on 2026-10-24): `fastForwardBase` left the
  operator checkout's `HEAD` at origin's SHA with the replacement's files in its working
  tree and a clean status, `createWorktree` at that SHA checked out the replacement's
  files, and a rebase onto it built commits whose trees carried them, which the queue's
  fast-forward check let onto the base. Garden's git now runs with
  `GIT_NO_REPLACE_OBJECTS=1`: `runGit` sets it for every command (`git-exec.ts`), the
  bootstrap script exports it before its first git command, and every headless agent gets
  it inline. That closes replace refs only. The rest of the shared git common dir is still
  in the worker's write grant (see the write-confinement bullet above), so a SHA garden
  takes from origin is no more trustworthy than that directory. Closing the class for good
  means workers stop sharing the operator's git directory, which is an operator decision.
- **Other state in the sessions dir is still trusted.** Besides the registry, garden
  keeps files there that sandboxed `garden` commands write: the dashboard state file,
  alerts, the pre-rendered pane files the status, usage, history and alerts panes replay,
  handoff and worker-cleanup requests, lock files, and each project's poll FIFO. A worker
  can repaint the operator's left column with them, or point the state file's active pane
  at a pane garden will paste into. A cleanup request is checked against the registry,
  which a worker can also forge, so a worker that deletes a sibling's entry and forges a
  request can still have the watchdog remove that sibling's worktree and branches once its
  pane has exited. A sibling is spared while a pane's cwd is inside the target, which is
  what a running worker looks like: the executor defers on that, and tmux, not the
  registry, reports it. The check is the foreground process's cwd, so a sibling whose
  shell has moved out of its worktree, or whose cwd tmux will not report, is not
  detected; garden's own infrastructure windows are excluded, since they never hold a
  worker. A session that cannot be enumerated defers rather than proceeding. A link the
  removed worker plants at its own worktree path is unlinked instead of followed: neither
  the reap nor `git worktree remove`, which resolves the path once the worker's admin
  entry is gone, runs on it (`unlinkNonDirectory`, `worker-cleanup.ts`), and the reap
  resolves only the path's parent, so a link to `/` no longer aims it at every process the
  operator owns. Both checks look at the path before git does, so a process that keeps
  swapping a link and a directory there can race the window between the executor's last
  check and git's own resolution, and have git remove the worktree the link points at;
  closing it needs the executor to move the entry out of the worker's grant first.
  Garden refuses what it can recognize without trusting a file's contents. The pokers
  never block on the poll FIFO and write it only after confirming the descriptor they
  opened is a FIFO, so a link or file planted there takes no write (a shell cannot open
  without following a link, so a link swapped in after a shell poke's path checks can still
  make that open create an empty file where it points);
  a directory planted at that path is removed rather than stalling the project's poller;
  a lock is reclaimed unless its pid actually answers — only `EPERM` proves a holder
  exists, so pid 1 or below, a pid past the OS range (which answers with a type error,
  the way a forged body stepped around the pid-1 rule by writing a longer number), and
  any other unnameable pid all read as dead; a cleanup
  request or handoff claim whose processing throws is retired rather than blocking every
  one behind it; and a project or plot name such as `constructor` or `__proto__` resolves
  to nothing rather than to an inherited property — a forged active plot threw inside the
  status-pane bake, freezing the pane and silently disabling the plot hotkeys. A FIFO planted where an unsandboxed reader
  expects a regular file, such as the registry, the state file or a lock, still blocks that
  reader. The Claude and Codex usage snapshots, through which a forged 100% reading paused
  auto-continue fleet-wide, now live in the control tree. So do the files there that only
  unsandboxed garden wrote: the poller and watchdog spawn locks, which every poller respawn
  and every poll take (a lock is never reclaimed while its pid answers and names a process
  older than the lock, so a planted one made each respawn of that poller throw, or stalled
  every poll for the lock's 2s deadline), and the bead-intake throttle and error stamps (a
  future-dated throttle stamp held background intake off, and a forged error reached
  board's dispatch chip). The locks that stay are taken by sandboxed `garden` commands
  beside what they guard: the registry, state and alerts locks, the checks-semaphore slots
  `garden checks` claims inside a worker, and each worker-cleanup request's lock. One planted
  there naming a live process older than itself holds what it guards until the operator
  removes it.
- **`postMerge`/`checks` commands are trusted.** They come from `~/.garden/config.yml`,
  which is not in any sandbox write grant, so a worker cannot set them. Do not move
  `config.yml` into a writable location.

## Enforcement caveat

Garden configures the sandbox; Claude Code and Codex enforce it (Seatbelt/bubblewrap).
The guarantees above hold only if the agent CLI's own sandbox is functioning and enabled
(`sandbox.enabled: true`, which garden always sets for workers). `garden doctor` reports
the CLI versions; the credential read-deny in particular depends on a Claude Code version
that honors `sandbox.credentials`.

Project test permissions remain explicit: `sandboxAllowLocalBinding` defaults to false.
On macOS, opting in permits local listeners and direct access to host localhost services;
it does not disable the domain allowlist or filesystem/credential restrictions. Test data
outside the worktree requires an exact `sandboxWriteRoots` grant. Temporary writes include
the launcher's canonical OS temporary directory and canonical `/tmp`. Headless settings
are regenerated under `control/headless` on every launch, so a retry observes repaired
permissions without rewriting the live worker's settings or granting control-plane writes.

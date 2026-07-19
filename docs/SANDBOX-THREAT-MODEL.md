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
  claude-code path, run inside the OS sandbox Claude Code configures from the worktree's
  `.claude/settings.json` (Seatbelt on macOS, bubblewrap on Linux) — the headless
  `claude -p` runs in the worktree and inherits that config. A Codex worker runs inside
  Codex's own `workspace-write` sandbox. The Codex *review family* is the exception and
  is not in this tier — see residuals.
- **Unsandboxed** — the poller, watchdog, and the operator's own shell run with the
  operator's full privileges. They read the worker registry and the operator's git
  checkout, and they execute git operations that fire git hooks.

The danger is any path by which sandboxed code influences what unsandboxed code later
reads or runs.

## What the sandbox enforces

- **Write confinement.** `buildSandboxConfig` (`src/dashboard/sandbox.ts`) grants a
  worker write access only to its worktree, standard subprocess caches (`~/.npm`,
  `~/.cache`, `/tmp`), and `~/.garden/sessions`. Everything else is read-only or denied
  at the kernel.
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
  block-push-to-main guard) stay armed.
- **Registry forgery guard (partial).** The worker registry lives in the
  sandbox-writable `~/.garden/sessions`. Its read guard (`isWorkerRegistry` in
  `src/dashboard/registry.ts`) type-checks the trusted fields (`prState`, `agentStatus`,
  `baseBranch`, `branchName`, `worktreePath`, `sessionId`) so a forged wrong-typed value
  cannot flow into a path/git/dispatch consumer. This stops malformed forgery; it does
  not stop a well-formed malicious entry (see residuals).
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
    (`<main>/.git`) writable so it can commit/push from a linked worktree. That grant
    still includes `hooks/` and `config`, so a Codex worker can write `<main>/.git/hooks/*`
    (which the main checkout now runs, post git-hook isolation) or repoint `core.hooksPath`
    via `config`. Narrowing the grant to exclude `hooks/`/`config` is pending validation
    that Codex's `writable_roots` supports the required granularity and that commit/push
    still work — until then, treat Codex workers as **do not run on untrusted repo
    content**.
- **A Codex reviewer runs with no sandbox at all.** `buildHeadlessCommand`
  (`src/dashboard/harness/codex-core.ts`) invokes `codex exec
  --dangerously-bypass-approvals-and-sandbox`, so a Codex reviewer/resolver/ci-fix agent
  runs with the operator's full privileges — unlike the claude-code review family, whose
  headless `claude -p` inherits the worktree sandbox. This is the sharpest residual in
  the model: the reviewer's whole job is to read a diff and repo content a possibly
  prompt-injected worker just wrote, and it does so unconfined. Selecting a Codex
  reviewer (`role reviewer harness codex`, or a `*-codex` crew) is therefore a
  trust decision about the repo content under review, not only about review quality.
  Confining it is pending the same `writable_roots` validation as the worker case, plus
  confirming `codex exec` can complete a review under a non-bypass sandbox.
- **The registry is writable by workers.** The type guard is defense-in-depth; a worker
  with a valid-looking forged entry can still manipulate fleet state (e.g. retarget its
  own merge base). The principled fix — moving the registry out of the worker-writable
  set and routing worker-initiated mutations (`garden workers grow`) through a validated
  request-file the poller applies — is planned.
- **`postMerge`/`checks` commands are trusted.** They come from `~/.garden/config.yml`,
  which is not in any sandbox write grant, so a worker cannot set them. Do not move
  `config.yml` into a writable location.

## Enforcement caveat

Garden configures the sandbox; Claude Code and Codex enforce it (Seatbelt/bubblewrap).
The guarantees above hold only if the agent CLI's own sandbox is functioning and enabled
(`sandbox.enabled: true`, which garden always sets for workers). `garden doctor` reports
the CLI versions; the credential read-deny in particular depends on a Claude Code version
that honors `sandbox.credentials`.

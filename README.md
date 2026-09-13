# Garden

A CLI orchestrator for running interactive Claude Code sessions across multiple
projects from a single tmux dashboard. Each unit of work runs as a "worker" in
its own git worktree; a per-project poller reviews and merges worker branches
using local git.

Depth lives in [`DESIGN.md`](DESIGN.md) (architecture), [`AGENTS.md`](AGENTS.md)
(quick reference), and [`docs/`](docs/README.md). This file is just how to get it
running.

## Requirements

- **macOS 13+**, on Apple Silicon or Intel. Garden's supported platform is
  macOS; credential capture uses the macOS Keychain.
- **Node 24 LTS recommended**, or Node 22.12+ within the 22.x line. The locked
  build/test dependencies do not support Node 22.1–22.11 or Node 23.
  See [Node releases](https://nodejs.org/en/about/previous-releases).
- **Git** and **tmux** on your PATH. Apple's Command Line Tools supply Git
  (`xcode-select --install`), or install it through Homebrew.
- **Claude Code**, installed and logged in with your own account. The default
  workers and reviewers use the `claude` CLI. Follow the
  [Claude Code setup guide](https://code.claude.com/docs/en/setup), run `claude`,
  complete login/onboarding, and verify you can send a prompt before using Garden.
  Garden does not supply model access or credentials.
- **A terminal that sends Left Option as Meta/Esc+.** Every dashboard hotkey is
  `⌥`-based; without this they silently do nothing. In iTerm2:
  Settings → Profiles → Keys → Left Option key → **Esc+**. In Terminal.app:
  Settings → Profiles → Keyboard → **Use Option as Meta key**.
  Run `garden keys` for the reference.
- **gh** (optional) — needed for `garden create` (scaffolds a new GitHub
  repo) and the CI merge gate. `brew install gh && gh auth login`.

With [Homebrew](https://brew.sh) already installed, a fresh-machine toolchain is:

```bash
brew install node@24 git tmux
export PATH="$(brew --prefix node@24)/bin:$PATH"
node --version
git --version
tmux -V
```

Add that Node PATH export to `~/.zshrc` as well so new terminals can find it.
If you already manage Node with a version manager, use a supported version there.

## Install

Clone into a permanent directory: the linked command and bundled worker resources
continue to use this checkout. Read access to the Garden repo is sufficient.
Use the clone URL available to your GitHub account (SSH or authenticated HTTPS).

```bash
git clone <this-repo> garden
cd garden
npm ci --include=dev
npm run build      # esbuild → dist/cli.js + dist/hook.js
npm link           # puts `garden` on your PATH (targets dist/cli.js)
garden doctor      # works before init; reports missing tools
garden init        # creates ~/.garden and an empty config.yml
garden doctor
```

Build from a git clone, not a source tarball: the build stamps its version from
`git rev-parse --short HEAD`. Development dependencies are needed to build from
source, even when you only intend to use Garden.

If `npm link` fails with a global-directory permission error, use a user-owned
prefix:

```bash
npm_config_prefix="$HOME/.local" npm link
export PATH="$HOME/.local/bin:$PATH"
```

Persist that PATH export in `~/.zshrc`. If `garden` is still not found, check
`command -v garden` in a new terminal. `node dist/cli.js doctor` can diagnose
Garden before the global link is working.

`garden init` is required before registering projects or opening the dashboard;
`help`, `keys`, and `doctor` also work before initialization. Configuration and
runtime state live under `~/.garden` and are created separately on each machine.
Garden also manages git worktrees, hooks, and agent settings for registered
projects; do not copy someone else's `~/.garden` or authentication files.

## First project and worker

Start with a small repository you own. Read access to Garden lets you install
it, but **managed projects need push access**: Garden pushes worker branches and
fast-forwards the remote base branch after automated review. A repository that
requires pull requests for every base-branch change needs a separate writable
base branch or a fork for this workflow.

Before registering your project:

```bash
cd ~/code/my-project
git config user.name             # must print your commit author name
git config user.email            # must print your commit author email
git remote -v                   # must include origin
git fetch origin                # verify your own remote authentication
```

If your identity is missing, set `git config --global user.name "Your Name"`
and `git config --global user.email "you@example.com"`, or omit `--global`
to configure just this repository. Fetch verifies read access; you also need
permission to push branches and the chosen base. Publish an initial commit and
base branch if this is a new repository. Install its own development toolchain
and make its checks pass locally.

```bash
garden add ~/code/my-project
garden config my-project baseBranch main    # use your intended merge target
garden config my-project checks "npm test"  # replace with this project's checks
garden dashboard
```

`garden add` uses the directory basename as the project name. It accepts an
existing directory without validating its Git remote; the worker needs
`origin/<base>` when it starts. Pinning `baseBranch` prevents your current
checkout branch from changing the default merge target.

In the dashboard, select the project with `⌥1` (or its numbered shortcut),
press `⌥n` to create a worker, and give it a small task. The worker gets an
isolated worktree; after it commits and pushes, Garden reviews and merges the
change. Use `⌥a` for alerts and `garden logs` from another terminal if setup
fails. Detach with tmux's default `Ctrl-b`, then `d`; `garden dashboard`
reattaches. `garden dashboard exit` stops the dashboard and agent processes,
keeping their worktrees and saved state for restart.

`garden create <path> [--org <org>]` is an alternative to `add`: it requires
GitHub CLI authentication and creates a new **private** GitHub repo under the
signed-in account or specified organization.

Run `garden help` for the command surface and `garden keys` for dashboard
shortcuts. `garden doctor` checks installed tools, Node, and configuration; it
does not verify Claude login, remote push permissions, or terminal key delivery.

## Staying updated

When workers are idle, run this from a separate terminal:

```bash
garden dashboard exit
cd /path/to/garden
git pull --ff-only       # on main
npm ci --include=dev
npm run build
garden doctor
garden dashboard
```

`npm link` persists, so the rebuilt `dist/cli.js` is picked up automatically.
Restarting loads the new build into dashboard processes. The convenience
`garden rebuild` command specifically automates iTerm2 and quits that app;
use the manual sequence above with other terminals.

`rules.md` (the global rules loaded into every worker) is opinionated and shipped
in this repo. Override per-project via `<project>/.garden/rules.md` to keep
local preferences separate from updates.

## Development

`main` is the stable branch consumers track. Continuous development happens on a
personal branch (`dev`), promoted to `main` at good stopping points:

```bash
git push origin dev:main    # fast-forward main from dev; no checkout switch
```

This stays a clean fast-forward as long as nothing commits directly to `main`.

Garden develops itself: workers run on the garden repo like any other project.
Pin the garden project's base to your dev branch so self-development merges land
there, not on `main`:

```bash
garden config garden baseBranch dev
```

Before pushing, run the checks the reviewer and CI also run:

```bash
npm run lint && npm run build && npm run test:coverage && npm run test:integration
```

## License

Proprietary and confidential. Copyright (c) 2026 Keychange. All rights reserved.
Use is permitted only under a separate written agreement with Keychange; see
[`LICENSE`](LICENSE).

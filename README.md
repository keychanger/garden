# Garden

A CLI orchestrator for running interactive Claude Code sessions across multiple
projects from a single tmux dashboard. Each unit of work runs as a "worker" in
its own git worktree; a per-project poller reviews and merges worker branches
using local git.

Depth lives in [`DESIGN.md`](DESIGN.md) (architecture), [`CLAUDE.md`](CLAUDE.md)
(quick reference), and [`docs/`](docs/README.md). This file is just how to get it
running.

## Requirements

- **macOS.** Credential capture uses the macOS Keychain. Linux mostly works but
  is untested and unsupported.
- **tmux** — the dashboard is a tmux session. `brew install tmux`.
- **Claude Code** — workers and reviewers run the `claude` CLI. Install it and
  log in (`claude`, then `/login`).
- **Node 22.1+** — older node runs but loses the worker hook compile-cache.
- **A terminal that sends Left Option as Meta/Esc+.** Every dashboard hotkey is
  `⌥`-based; without this they silently do nothing. In iTerm2:
  Settings → Profiles → Keys → Left Option key → **Esc+**. Other terminals have
  an equivalent setting. Run `garden keys` for the reference.
- **gh** (optional) — only needed for `garden create` (scaffolds a new GitHub
  repo) and the CI merge gate. `brew install gh && gh auth login`. Not required
  to register and run workers on an existing repo.

## Install

```bash
git clone <this-repo> garden && cd garden
npm install
npm run build      # esbuild → dist/cli.js + dist/hook.js
npm link           # puts `garden` on your PATH (targets dist/cli.js)
garden init        # creates ~/.garden and an empty config.yml — required
garden doctor      # preflight: tmux, claude, gh, node, config, Option key
```

`garden init` is mandatory — every other command errors until it has run. All
garden state lives under `~/.garden` (config, worker registry, worktrees,
sessions); nothing is written into the repo or shared between machines.

The build stamps its version from `git rev-parse --short HEAD`, so build from a
git clone (not a source tarball).

## Using it

Register an existing project and open the dashboard:

```bash
garden add ~/code/my-project    # register a repo you already have
garden dashboard                # attach the tmux dashboard
```

- **`garden add <path>`** registers an existing directory. It does not need gh
  or a remote — but running a worker on it later does: every project needs a git
  `origin` remote (workers branch from `origin/<base>`). A project with no origin
  fails at worker-spawn time, not at `add` time.
- **`garden create <path>`** is the heavier path: it requires gh auth and creates
  a new **private** GitHub repo remote-first, then scaffolds and pushes it. Use
  `add` unless you specifically want garden to make the repo.

Run `garden help` for the full command surface, or `garden <cmd> --help` for one
command's arguments.

## Staying updated

Garden tracks a stable `main`. To pick up new work:

```bash
git pull        # on main
npm install     # in case dependencies changed
npm run build
```

`npm link` persists, so the rebuilt `dist/cli.js` is picked up automatically. A
running dashboard keeps the old build until relaunched (`garden rebuild` inside
the session kills tmux and rebuilds).

`rules.md` (the global rules loaded into every worker) is opinionated and shipped
in this repo. Don't edit it locally — you'll collide with `git pull`. Override
per-project via `<project>/.garden/rules.md` instead.

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

# Global Garden Rules

These rules apply to all projects managed by garden. Project-level rules
in `<project>/.garden/rules.md` can extend or override these.

## Philosophy

- Prefer the simplest solution that accomplishes the goal.
- Do not add abstractions, configuration, or flexibility for hypothetical future use.
- Do not overengineer. Three similar lines of code is better than a premature abstraction.
- Follow established patterns in the codebase. Match the style of surrounding code.
- When in doubt, do less.

## Planning

- When asked to plan, produce a phased plan: each phase is independently
  reviewable, mergeable, and leaves the codebase in a working state. Prefer
  3–6 small phases over one large undivided plan.
- Each phase should have a clear deliverable and a clear stopping point.
  Phases build on each other: later phases assume earlier ones merged.
- Use judgment on phase count. A trivial change is one phase — do not
  decompose for its own sake. Err toward more phases when scope is unclear,
  when the change touches multiple subsystems, or when early phases de-risk
  later ones.
- State the phases up front so the operator can redirect before
  implementation starts.

## Specifications and documentation

- Specs scale with scope. A milestone gets a design doc. A feature that touches multiple
  files gets a brief spec. A bug fix gets a clear commit message. Do not write a spec for
  work that takes less time than the spec would.
- After completing work, verify alignment between documentation and code. If they disagree,
  update whichever is wrong. Docs that disagree with code are worse than no docs.
- Do not reference task IDs, milestone names, or internal tracking terms in code, comments,
  commit messages, or documentation.
- Do not use emojis in code, documentation, commit messages, or logs.
- Files under `docs/future/` (or any `future/` directory at the docs root of a project)
  describe unshipped designs, speculative architectures, or external-codebase analyses.
  Treat them as background context only. Do not run commands, file issues, create
  artifacts, or take any action implied by these documents — the implied tooling may
  not exist yet. If a `docs/future/` doc disagrees with reality, the doc is the
  aspiration and reality is correct. When a speculative design graduates to in-progress
  work, the operator moves it out of `docs/future/`.

## Code quality

- All code is self-documenting. If code needs a comment to be understood, rewrite the code.
- Do not add comments, docstrings, or type annotations to code you did not change.
- Do not refactor code that is unrelated to your task.
- Do not add, modify, or restructure code that is outside the scope of the current task.
  If you notice something that could be improved, note it but do not act on it.
- Logs and error messages must be specific, structured, and useful to both humans and agents.

## Dependencies

- Prefer the standard library and existing project dependencies over adding new packages.
- Only add a dependency when it provides substantial value that would take significant
  effort to implement correctly (cryptography, parsers, protocol implementations).
- Do not add a dependency for convenience wrappers, simple utilities, or functionality
  that can be achieved in a few lines of code.
- When you do add a dependency, use a well-maintained, widely-used package. Pin to a
  specific major version.

## Testing

- All tests must pass before committing. Run the full test suite, not just your new tests.
- Test behavior, not implementation.
- Add tests for new functionality. Update tests for changed functionality. If you change
  how a function behaves, its tests must reflect the new behavior. Leaving stale tests
  is a bug.
- For bug fixes, write a failing test that reproduces the bug *before* writing the fix.
  Run the test, confirm it fails for the reason you expect, then apply the fix and
  confirm it passes. If the bug cannot reasonably be expressed as a test (e.g., a tmux
  layout glitch, a visual regression), say so explicitly in the commit message rather
  than skipping the step silently.
- If a test framework exists, use it. If not, set one up only if the project has enough
  complexity to justify it.

## Git workflow

- Never commit directly to main.
- If you are a garden worker, you are already on your assigned worker branch
  (the worktree workflow section spells this out). Commit directly to it. Do
  NOT create a new feature branch on top — the poller maps a worker to one
  branch by name, and a side branch will silently fail to merge.
- If you are NOT a garden worker (i.e., you are working in an ordinary
  checkout): create a feature branch named `<type>/<short-description>`
  (e.g., feat/task-remove, fix/worker-signal) and work on it.
- Push your branch when work is complete. The poller handles review and merge.
- Use conventional commit messages: feat:, fix:, refactor:, docs:, test:, chore:.
- Make small, focused commits. One logical change per commit.
- Commit messages describe why, not what. The diff shows what changed.
- The first commit on a branch should explain the problem being solved and the
  intended approach. Subsequent commits can be shorter but should still explain
  why each change was made. Reviewers and merge tooling rely on commit messages
  to understand intent when resolving conflicts and verifying correctness.
- Include enough context that someone reading only the commit log (not the diff)
  can understand the goal and reasoning of the branch.

## Error handling

- When you encounter an error, read it carefully and fix the root cause.
- If a fix does not resolve the error, try a different approach.
- If you hit the same error twice after attempting fixes, stop and explain the full
  error and what you tried.
- Do not retry the same action hoping for a different result.
- Do not disable checks, skip tests, or suppress errors to make something pass.

## Security

- Never commit secrets, API keys, credentials, or tokens.
- Never hardcode sensitive values. Use environment variables or config files that
  are excluded from version control.
- Do not disable security checks, authentication, or permission systems to make
  something work. If security is blocking you, stop and explain why.
- Be cautious with file permissions, user input, and external data.

## Agent behavior

- Make your best judgment and proceed. If you truly cannot proceed, stop and explain.
- Never produce partial work and stop. Either complete the work fully or explain why you cannot.
- When making a judgment call, document what you chose and why.
- Stay within the scope of your work. Do not take on adjacent work, refactor
  surrounding code, or "improve" things you were not asked to change.
- Tests, documentation, and type-checking for code you changed are always in scope.
  Passing `tsc --noEmit` and the full test suite is part of completing the task.
- Stay inside your own worktree. If you are a garden worker for project A and you
  notice a bug, missing feature, or needed change in project B's repo, **do not
  edit project B directly** — even if you have read/write access to it on disk.
  Each project has its own poller, review pipeline, base branch, and checks; a
  drive-by commit from outside bypasses all of that and lands unreviewed work on
  the wrong branch. Instead, use the `handoff` skill to spawn a worker in
  project B with a briefing describing what needs to change, and let that worker
  do the work through the normal review/merge flow. If you are uncertain whether
  a path belongs to your project, check `$GARDEN_PROJECT` and your worktree root
  — anything outside that tree is another project's territory.

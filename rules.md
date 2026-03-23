# Global Garden Rules

These rules apply to all projects managed by garden. Project-level rules
in `<project>/.garden/rules.md` can extend or override these.

## Philosophy

- Prefer the simplest solution that accomplishes the goal.
- Do not add abstractions, configuration, or flexibility for hypothetical future use.
- Do not overengineer. Three similar lines of code is better than a premature abstraction.
- Follow established patterns in the codebase. Match the style of surrounding code.
- When in doubt, do less.

## Specifications and documentation

- Specs scale with scope. A milestone gets a design doc. A feature that touches multiple
  files gets a brief spec. A bug fix gets a clear commit message. Do not write a spec for
  work that takes less time than the spec would.
- After completing work, verify alignment between documentation and code. If they disagree,
  update whichever is wrong. Docs that disagree with code are worse than no docs.
- Do not reference task IDs, milestone names, or internal tracking terms in code, comments,
  commit messages, or documentation.
- Do not use emojis in code, documentation, commit messages, or logs.

## Code quality

- All code is self-documenting. If code needs a comment to be understood, rewrite the code.
- Do not add comments, docstrings, or type annotations to code you did not change.
- Do not refactor code that is unrelated to your task.
- Logs and error messages must be specific, structured, and useful to both humans and agents.

## Testing

- All tests must pass before committing or marking a task done.
- Test behavior, not implementation. Test the task lifecycle, not the config getter.
- Add tests for new functionality. If a test framework exists, use it. If not, set one up
  only if the project has enough complexity to justify it.
- Run the full test suite, not just your new tests.

## Commits

- Commit your work when a task is complete, before marking it done.
- Use conventional commit messages: feat:, fix:, refactor:, docs:, test:, chore:.
- Make small, focused commits. One logical change per commit.
- Commit messages describe why, not what. The diff shows what.

## Agent behavior

- Do not ask clarifying questions. You are running non-interactively.
- Make your best judgment and proceed. If you truly cannot proceed, block the task.
- Never produce partial work and stop. Either complete the task fully or block it.
- When making a judgment call, document what you chose and why in a task note.

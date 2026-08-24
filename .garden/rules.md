# Garden Project Rules

These extend the global rules in `<garden-repo>/rules.md`.

## Language and tooling

- TypeScript, strict mode, ES modules.
- Build with esbuild. No webpack, rollup, or other bundlers.
- No CLI framework. Commands are plain async functions dispatched from cli.ts.
- Only dependency beyond Node stdlib: js-yaml. Do not add others without strong justification.

## Code patterns

- One file per command in src/commands/. Export a single async function.
- Register new commands in src/commands/index.ts and update help text in src/cli.ts.
- Use resolveProject() or resolveProjectFromArgs() for project resolution. Never parse project names manually.
- Use output() and outputLines() from src/output.ts for all data output. Respect TTY detection.
- Shell-escape all user-provided strings passed to tmux or child processes.

## Dashboard architecture invariants

- The right pane is permanent. Never destroy or recreate it in normal operation — move
  content via swap-pane only. The single exception is repair: when its pane has already
  died, `healActivePaneInState` (validate.ts) splits the slot back in and refills it,
  because `activePaneId` is learned only from swaps that succeeded, so a dead one blocks
  every later swap from ever replacing it. Repair belongs there and nowhere else.
- Hidden tmux windows use underscore-prefixed names (`_<project>-worker-N`, `_<project>-shell`).
  Do not create, rename, or destroy underscore-prefixed windows outside of dashboard code.
- All state file writes must be atomic: write to a temp file, then rename. Never write
  directly to `dashboard.state.json` or `dashboard.registry.json`.
- State files are the source of truth for dashboard logic. Tmux is the source of truth for
  pane existence. When they disagree, the validator heals state to match tmux reality.

## Testing

- Test framework: vitest (when set up).
- Test the CLI commands and dashboard behavior.
- Do not test trivial getters or internal helpers unless they have complex logic.
- When you change a function's behavior, update its tests to match. Changing code without
  updating its tests is a bug, not a scope decision.
- Run `npx vitest run` and `npx tsc --noEmit` before committing. Both must pass clean.

## Documentation maintenance

- Updating tests and documentation for code you changed is part of the task, not adjacent
  work. Do not skip it for scope reasons.
- If your changes affect commands, flags, file layout, or architecture, update both DESIGN.md and CLAUDE.md.
- If your changes affect agent behavior or workflow, update rules.md.
- DESIGN.md is the spec. CLAUDE.md is the quick-start for Claude sessions. Keep them in sync but not redundant.

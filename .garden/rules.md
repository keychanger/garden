# Garden Project Rules

These extend the global rules in ~/.garden/rules.md.

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
- Use emit() from src/events.ts for any state changes. Events are the record of what happened.
- Shell-escape all user-provided strings passed to tmux or child processes.

## Testing

- Test framework: vitest (when set up).
- Test the CLI commands, task lifecycle, and worker behavior.
- Do not test trivial getters or internal helpers unless they have complex logic.

## Documentation maintenance

- If your changes affect commands, flags, file layout, or architecture, update both DESIGN.md and CLAUDE.md.
- If your changes affect agent behavior or workflow, update rules.md.
- DESIGN.md is the spec. CLAUDE.md is the quick-start for Claude sessions. Keep them in sync but not redundant.

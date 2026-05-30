// Minimal entrypoint for the per-tool-call Claude hook.
//
// The hook fires on every tool completion by every agent, so its cost is paid
// at N x tool-rate. Routing it through cli.ts would parse the entire command +
// dashboard bundle on every fire; bundling just the hook dispatcher's import
// closure (dist/hook.js) parses ~60% less and cold-starts faster. Worker
// settings.json hook commands invoke this via resolveHookRunner(); cli.js
// keeps its own `_claude-hook` route for workers whose settings predate it.
import { handleClaudeHook } from "./dashboard/hook-dispatcher.js";

handleClaudeHook(process.argv[2] ?? "");

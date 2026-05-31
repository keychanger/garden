// Minimal entrypoint for the per-tool-call Claude hook.
//
// The hook fires on every tool completion by every agent, so its cost is paid
// at N x tool-rate. Routing it through cli.ts would parse the entire command +
// dashboard bundle on every fire; bundling just the hook dispatcher's import
// closure (dist/hook.js) parses ~60% less and cold-starts faster. Worker
// settings.json hook commands invoke this via resolveHookRunner(); cli.js
// keeps its own `_claude-hook` route for workers whose settings predate it.
import { handleClaudeHook } from "./dashboard/hook-dispatcher.js";

// Normally the event is argv[2] (`node hook.js posttooluse`). But a worker
// Claude session caches its hook command at SessionStart and never reloads it,
// so a session that started mid-migration can still fire the old cli-style
// command shape against this new entrypoint: `node hook.js dashboard
// _claude-hook posttooluse`. There argv[2] is the literal "dashboard" and the
// real event sits after the "_claude-hook" token. Recover it so stale sessions
// dispatch correctly for the rest of their life instead of warning on every
// fire — symmetric with cli.js keeping its `_claude-hook` route for the inverse.
const argv = process.argv.slice(2);
const hookIdx = argv.indexOf("_claude-hook");
const event = hookIdx >= 0 ? argv[hookIdx + 1] : argv[0];

handleClaudeHook(event ?? "");

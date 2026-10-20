// Sticky logs filter — dashboard wiring for the ⌥/ command-prompt + apply.
// The filter file itself (read/write/parse) lives in src/commands/logs.ts so
// `garden logs` and `garden logs --follow` can honor it without depending on
// the dashboard. This module owns the tmux UX: pop a command-prompt, write
// the file on submit, update the pane title, and respawn the logs pane so
// the live tail picks up the new filter.
import { execFileSync } from "node:child_process";
import { DASHBOARD_SESSION } from "../session.js";
import { readStickyFilterExpr, writeStickyFilterExpr, formatLogsPaneLabel } from "../commands/logs.js";
import { focusLogs } from "./navigate.js";
import { resolveGardenRunner } from "./runner.js";
import { readDashState } from "./state.js";
import { respawnLogsPane } from "./create.js";
import { promptArgv, setPaneLabel, getFirstPaneId } from "./tmux.js";
import { log } from "./log.js";

// Triggered by ⌥/. Switches to the logs view (so the operator sees the
// filtered tail land in real time), then opens tmux's command-prompt
// pre-filled with the current sticky expr so backspace-Enter clears it
// and edit-Enter tweaks it.
export function openLogsFilterPrompt(): void {
  focusLogs();
  const runner = resolveGardenRunner();
  // The pre-fill comes from logs.filter.json, which any worker sandbox can
  // write, so it and the reply both travel the promptArgv way: as text, never
  // as a format or shell syntax.
  const current = readStickyFilterExpr() ?? "";
  try {
    execFileSync("tmux", promptArgv("logs filter:", runner, ["_logs-filter-apply"], current), { stdio: "ignore" });
  } catch (err) {
    log.warn("logs-filter", "command-prompt failed", { data: { error: String(err) } });
  }
}

// Triggered by the command-prompt's run-shell on Enter. Empty input clears.
export function applyLogsFilter(expr: string): void {
  const trimmed = expr.trim();
  writeStickyFilterExpr(trimmed);

  const state = readDashState();
  const target = (state.gardenPaneType === "logs" && state.gardenShellPaneId)
    ? state.gardenShellPaneId
    : getFirstPaneId(`${DASHBOARD_SESSION}:_garden-logs`);
  if (target) {
    setPaneLabel(target, formatLogsPaneLabel(trimmed));
  }
  try { respawnLogsPane(state); } catch { /* pane gone */ }
  if (trimmed) {
    log.info("logs-filter", "filter set", { data: { expr: trimmed } });
  } else {
    log.info("logs-filter", "filter cleared");
  }
}

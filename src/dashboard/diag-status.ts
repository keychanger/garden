// Diagnostic snapshot for the status pane. Captures the pre-baked file, the
// live $cur from the bash loop (via SIGUSR2 dump), the visible pane content,
// the registry, and the tmux window list — into one timestamped bundle.
// Used to debug status-pane rendering anomalies (e.g. duplicate worker rows
// after a refresh). Not wired into any UI; invoked manually.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { SESSIONS_DIR } from "../config.js";
import { readDashState } from "./state.js";
import { readRegistry } from "./registry.js";
import { listAllWindowNames, getPanePid } from "./tmux.js";
import { STATUS_RENDERED_FILE, STATUS_CUR_DUMP_FILE } from "./header.js";

export async function runDiagStatus(): Promise<void> {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const out = path.join(SESSIONS_DIR, `diag-status-${ts}.txt`);
  const sections: string[] = [];

  const state = readDashState();
  const statusPaneId = state.statusPaneId ?? null;

  sections.push(`# garden status-pane diagnostic`);
  sections.push(`timestamp: ${new Date().toISOString()}`);
  sections.push(`statusPaneId: ${statusPaneId ?? "(none)"}`);
  sections.push(`usagePaneId: ${state.usagePaneId ?? "(none)"}`);
  sections.push(`activeProject: ${state.activeProject ?? "(none)"}`);
  sections.push(`activePaneType: ${state.activePaneType ?? "(none)"}`);
  sections.push(`activeWindowName: ${state.activeWindowName ?? "(none)"}`);
  sections.push(`gardenPaneType: ${state.gardenPaneType ?? "(none)"}`);
  sections.push(`gardenWindowName: ${state.gardenWindowName ?? "(none)"}`);
  sections.push(`activePlot: ${state.activePlot ?? "(none)"}`);
  sections.push("");

  sections.push(`## pane geometry (window of statusPaneId)`);
  if (statusPaneId) {
    try {
      const winId = execFileSync("tmux", [
        "display-message", "-p", "-t", statusPaneId, "#{window_id}",
      ], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      const panes = execFileSync("tmux", [
        "list-panes", "-t", winId,
        "-F", "#{pane_id} #{pane_index} w=#{pane_width} h=#{pane_height} top=#{pane_top} left=#{pane_left} title=#{pane_title}",
      ], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
      sections.push(`window: ${winId}`);
      sections.push(panes.trimEnd());
    } catch (err) {
      sections.push(`(geometry probe failed: ${String(err)})`);
    }
  } else {
    sections.push("(no statusPaneId)");
  }
  sections.push("");

  // Trigger USR2 BEFORE reading the dump file so we capture the current $cur.
  if (statusPaneId) {
    try {
      const pid = getPanePid(statusPaneId);
      if (pid) {
        // Clear any stale dump first so we know if the trap actually wrote.
        try { fs.unlinkSync(STATUS_CUR_DUMP_FILE); } catch { /* not present */ }
        process.kill(parseInt(pid, 10), "SIGUSR2");
        // Bash's signal trap runs at the next "safe point". Inside the spinner
        // loop that's after the current sleep tick (≤120ms); inside the long
        // 24h sleep it's near-instant. 250ms covers both.
        await new Promise(r => setTimeout(r, 250));
      } else {
        sections.push("WARN: could not resolve status pane pid; $cur dump skipped");
      }
    } catch (err) {
      sections.push(`WARN: SIGUSR2 dispatch failed: ${String(err)}`);
    }
  }

  sections.push(`## pre-baked file (${STATUS_RENDERED_FILE})`);
  sections.push(readFileSafe(STATUS_RENDERED_FILE));
  sections.push("");

  sections.push(`## $cur dump (${STATUS_CUR_DUMP_FILE})`);
  sections.push(readFileSafe(STATUS_CUR_DUMP_FILE));
  sections.push("");

  sections.push(`## visible pane (capture-pane -p ${statusPaneId ?? "?"})`);
  if (statusPaneId) {
    try {
      const captured = execFileSync("tmux", ["capture-pane", "-p", "-t", statusPaneId, "-J"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      sections.push(captured);
    } catch (err) {
      sections.push(`(capture-pane failed: ${String(err)})`);
    }
  } else {
    sections.push("(no statusPaneId)");
  }
  sections.push("");

  sections.push(`## tmux windows (full list)`);
  try {
    sections.push(listAllWindowNames().join("\n"));
  } catch (err) {
    sections.push(`(list-windows failed: ${String(err)})`);
  }
  sections.push("");

  sections.push(`## registry (workers per project)`);
  try {
    const reg = readRegistry();
    for (const [project, entries] of Object.entries(reg.workers)) {
      sections.push(`${project}: ${entries.length} entries`);
      for (const e of entries) {
        sections.push(`  - ${e.name}  claudeStatus=${e.claudeStatus ?? "?"}  prState=${e.prState ?? "?"}  task=${JSON.stringify(e.task ?? "")}`);
      }
    }
  } catch (err) {
    sections.push(`(readRegistry failed: ${String(err)})`);
  }
  sections.push("");

  const body = sections.join("\n");
  fs.writeFileSync(out, body);
  console.log(`wrote ${out}`);
  console.log("");
  console.log(body);
}

function readFileSafe(p: string): string {
  try {
    if (!fs.existsSync(p)) return "(file not present)";
    return fs.readFileSync(p, "utf8");
  } catch (err) {
    return `(read failed: ${String(err)})`;
  }
}

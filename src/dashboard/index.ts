// Dashboard entry point: subcommand dispatch and help.
import {
  checkTmux,
  dashboardExists,
  attachDashboardSession,
  killDashboardSession,
} from "../session.js";
import { readDashState } from "./state.js";
import { printHeader, handlePaneDied, handleTitleChanged } from "./header.js";
import { handleClaudeHook } from "./hook-dispatcher.js";
import { log } from "./log.js";
import { ensureDashboard, resizeTerminal, cleanupContextFiles } from "./create.js";
import { newWorker, killPane, bounceActiveWorker, holdActiveWorker } from "./workers.js";
import {
  continueWorker, continueWorkerAfterMerge, continueWorkerAfterMergeIfStuck,
  continueWorkerIfStuck, rearmContinueIfDrafting, seedWorker,
} from "./continue.js";
import { growAutoContinueAfterMerge } from "./grow-continue.js";
import { trellisAutoContinueAfterMerge } from "./trellis-continue.js";
import {
  runTrellisPicker, plantVineFromPicker, spawnTrellisAuthor, runReviveSubmenu,
  runWorkflowPicker, plantGrowFromPicker, plantBotanistFromPicker,
  runComposeBaseSubmenu, runComposeCrewSubmenu, runComposeMemberSubmenu,
  runComposeModelSubmenu, runComposeEffortSubmenu,
  stageSpawnDraft, composeDefaultFromPicker,
} from "./trellis-picker.js";
import {
  runCrewPicker, applyCrewFromPicker, runCrewComposer, runStoredCrewPicker,
  runCrewDimSubmenu, setCrewDimFromPicker, saveCrewFromPicker, runCrewEdit,
  deleteCrewFromPicker, cancelCrewComposer,
} from "./crew-picker.js";
import {
  runWorkerMenu, runWorkerBranchSubmenu, runWorkerCrewSubmenu, runWorkerModelSubmenu,
  runWorkerKillConfirm, applyWorkerSet, applyWorkerSetBounce,
} from "./worker-menu.js";
import {
  runProjectMenu, runProjectBranchSubmenu, runHolisticSubmenu, runColorSubmenu,
  runProjectModelSubmenu, runProjectEffortSubmenu,
  applyConfigSetFromMenu,
} from "./project-menu.js";
import {
  runGardenMenu, runChecksSlotsSubmenu, runMaxReviewsSubmenu, applyGardenLimitFromMenu,
  runBuildBranchSubmenu, applyBuildBranch,
} from "./garden-menu.js";
import { switchProject, focusWorker, focusShell, focusGrowhouse, focusRoot, focusLogs, focusHistory, focusDiary, focusAlerts, cyclePane, cyclePlot } from "./navigate.js";
import { diaryFilePath } from "../diary.js";
import { openLogsFilterPrompt, applyLogsFilter } from "./logs-filter.js";
import { poll, triggerProjectPoll, postPush, stopAllPollers } from "./poller.js";
import { runUsagePollerLoop, stopUsagePoller } from "./usage-poller.js";
import { runWatchdogLoop, stopWatchdog } from "./watchdog.js";
import { loadConfig } from "../config.js";
import { addAlert } from "./alerts.js";

// Strip `--delay-ms N` from args (if present) and return the delay in ms plus
// the cleaned args. Lets internal subcommands defer their work without a shell
// `sleep` wrapper — `dispatchDelayed*` callers spawn `garden dashboard <sub>
// --delay-ms N <args>` and the Node child holds the timer. See the leak
// post-mortem in poller-fifo.ts: `sleep && echo > FIFO` blocked forever on
// readerless FIFOs and accumulated 200+ orphan bash processes.
function takeDelayMs(args: string[]): { delayMs: number; rest: string[] } {
  const idx = args.indexOf("--delay-ms");
  if (idx === -1) return { delayMs: 0, rest: args };
  const delayMs = parseInt(args[idx + 1] ?? "0", 10);
  return { delayMs: Number.isFinite(delayMs) ? Math.max(0, delayMs) : 0,
           rest: [...args.slice(0, idx), ...args.slice(idx + 2)] };
}

// Read the backoff attempt counter the draft-deferral re-arm threads through
// `_continue-worker* --attempt N`. Positional, so it sits after project/worker
// and leaves args[1]/args[2] untouched. Absent on the first (dispatch) fire.
function getAttempt(args: string[]): number {
  const idx = args.indexOf("--attempt");
  if (idx === -1) return 0;
  const n = parseInt(args[idx + 1] ?? "0", 10);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

export async function dashboard(rawArgs: string[]): Promise<void> {
  checkTmux();

  const { delayMs, rest: args } = takeDelayMs(rawArgs);
  if (delayMs > 0) {
    await new Promise<void>(resolve => { setTimeout(resolve, delayMs); });
  }

  const sub = args[0];

  if (sub === "exit" || sub === "close") {
    if (!dashboardExists()) {
      console.log("No dashboard running.");
      return;
    }
    log.info("dashboard", "closing dashboard");
    stopAllPollers();
    stopUsagePoller();
    stopWatchdog();
    killDashboardSession();
    // Preserve the persisted state files across a clean exit. The registry is
    // the only record of each worker's sessionId / branch / worktree, and the
    // resume-on-restart path (create.ts) rebuilds the whole fleet from it —
    // deleting it here turned the validator's own recovery advice ("exit &&
    // dashboard") into fleet-wide worker loss. State and alerts are equally
    // reusable across a restart. Deliberate full teardown (including remote
    // branch deletion) is `garden reset`, which confirms first. Only the
    // transient per-worker context files are swept here.
    cleanupContextFiles();
    console.log("Dashboard closed.");
    return;
  }

  // Internal subcommands called by hotkeys
  if (sub === "_switch") return switchProject(args[1]);
  if (sub === "_new-worker") { newWorker(); return; }
  if (sub === "_focus-worker") return focusWorker();
  if (sub === "_focus-shell") return focusShell();
  if (sub === "_focus-growhouse") return focusGrowhouse();
  if (sub === "_focus-root") return focusRoot();
  if (sub === "_focus-logs") return focusLogs();
  if (sub === "_focus-history") return focusHistory();
  if (sub === "_focus-diary") return focusDiary();
  if (sub === "_focus-alerts") return focusAlerts();
  if (sub === "_diary-path") {
    // Consumed by the diary view's editor loop (diary-view.sh): prints the
    // focused project's diary file path, or nothing when no project is focused.
    const project = readDashState().activeProject;
    if (project) console.log(diaryFilePath(project));
    return;
  }
  if (sub === "_logs-filter") return openLogsFilterPrompt();
  if (sub === "_logs-filter-apply") {
    applyLogsFilter(args.slice(1).join(" "));
    return;
  }
  if (sub === "_cycle-pane") return cyclePane(args[1] === "prev" ? -1 : 1);
  if (sub === "_cycle-plot") return cyclePlot(args[1] === "prev" ? -1 : 1);
  if (sub === "_kill-pane") return killPane();
  if (sub === "_bounce") return bounceActiveWorker();
  if (sub === "_hold-worker") return holdActiveWorker();
  if (sub === "_continue-worker") {
    if (args[1] && args[2]) {
      const delivered = continueWorker(args[1], args[2]);
      if (!delivered) rearmContinueIfDrafting("_continue-worker", args[1], args[2], getAttempt(args));
    }
    return;
  }
  if (sub === "_continue-worker-if-stuck") {
    if (args[1] && args[2]) continueWorkerIfStuck(args[1], args[2]);
    return;
  }
  if (sub === "_continue-worker-after-merge") {
    if (args[1] && args[2]) {
      const delivered = continueWorkerAfterMerge(args[1], args[2]);
      if (!delivered) {
        rearmContinueIfDrafting("_continue-worker-after-merge", args[1], args[2], getAttempt(args));
      }
    }
    return;
  }
  if (sub === "_continue-worker-after-merge-if-stuck") {
    if (args[1] && args[2]) continueWorkerAfterMergeIfStuck(args[1], args[2]);
    return;
  }
  if (sub === "_trellis-continue-after-merge") {
    if (args[1] && args[2]) trellisAutoContinueAfterMerge(args[1], args[2]);
    return;
  }
  if (sub === "_grow-continue-after-merge") {
    if (args[1] && args[2]) growAutoContinueAfterMerge(args[1], args[2]);
    return;
  }
  if (sub === "_trellis-picker") {
    runTrellisPicker(args[1]);
    return;
  }
  if (sub === "_workflow-picker") {
    runWorkflowPicker(args[1]);
    return;
  }
  if (sub === "_compose-default") {
    if (args[1]) composeDefaultFromPicker(args[1]);
    return;
  }
  if (sub === "_compose-base-submenu") {
    if (args[1]) runComposeBaseSubmenu(args[1]);
    return;
  }
  if (sub === "_compose-crew-submenu") {
    if (args[1]) runComposeCrewSubmenu(args[1]);
    return;
  }
  if (sub === "_compose-member-submenu") {
    if (args[1]) runComposeMemberSubmenu(args[1]);
    return;
  }
  if (sub === "_compose-model-submenu") {
    if (args[1]) runComposeModelSubmenu(args[1]);
    return;
  }
  if (sub === "_compose-effort-submenu") {
    if (args[1]) runComposeEffortSubmenu(args[1]);
    return;
  }
  if (sub === "_spawn-draft") {
    // _spawn-draft <project> <field> <value>; value may be empty (clear).
    const [, projectName, field] = args;
    if (projectName && field) stageSpawnDraft(projectName, field, args.slice(3).join(" "));
    return;
  }
  if (sub === "_crew-picker") {
    runCrewPicker(args[1]);
    return;
  }
  if (sub === "_crew-set") {
    const [, projectName, crewName] = args;
    if (projectName && crewName) applyCrewFromPicker(projectName, crewName);
    return;
  }
  // Crew composer (create / edit / delete a stored crew definition).
  if (sub === "_crew-compose") {
    if (args[1]) runCrewComposer(args[1], args[2]);
    return;
  }
  if (sub === "_crew-pick-stored") {
    const [, projectName, action] = args;
    if (projectName && action) runStoredCrewPicker(projectName, action);
    return;
  }
  if (sub === "_crew-dim") {
    const [, projectName, field] = args;
    if (projectName && field) runCrewDimSubmenu(projectName, field);
    return;
  }
  if (sub === "_crew-dim-set") {
    // Value may be empty (the "clear" rows).
    const [, projectName, field] = args;
    if (projectName && field) setCrewDimFromPicker(projectName, field, args.slice(3).join(" "));
    return;
  }
  if (sub === "_crew-save") {
    const [, projectName] = args;
    if (projectName) saveCrewFromPicker(projectName, args.slice(2).join(" "));
    return;
  }
  if (sub === "_crew-edit") {
    const [, projectName, crewName] = args;
    if (projectName && crewName) runCrewEdit(projectName, crewName);
    return;
  }
  if (sub === "_crew-delete") {
    const [, projectName, crewName] = args;
    if (projectName && crewName) deleteCrewFromPicker(projectName, crewName);
    return;
  }
  if (sub === "_crew-cancel") {
    if (args[1]) cancelCrewComposer(args[1]);
    return;
  }
  if (sub === "_worker-menu") {
    runWorkerMenu(args[1], args[2]);
    return;
  }
  if (sub === "_worker-branch-submenu") {
    if (args[1] && args[2]) runWorkerBranchSubmenu(args[1], args[2]);
    return;
  }
  if (sub === "_worker-crew-submenu") {
    if (args[1] && args[2]) runWorkerCrewSubmenu(args[1], args[2]);
    return;
  }
  if (sub === "_worker-model-submenu") {
    if (args[1] && args[2]) runWorkerModelSubmenu(args[1], args[2]);
    return;
  }
  if (sub === "_worker-kill-confirm") {
    if (args[1] && args[2]) runWorkerKillConfirm(args[1], args[2]);
    return;
  }
  if (sub === "_worker-set") {
    // _worker-set <project> <worker> <field> <value>; value may be empty (clear).
    const [, projectName, workerName, field] = args;
    if (projectName && workerName && field) applyWorkerSet(projectName, workerName, field, args.slice(4).join(" "));
    return;
  }
  if (sub === "_worker-set-bounce") {
    const [, projectName, workerName, field] = args;
    if (projectName && workerName && field) applyWorkerSetBounce(projectName, workerName, field, args.slice(4).join(" "));
    return;
  }
  if (sub === "_project-menu") {
    runProjectMenu(args[1]);
    return;
  }
  if (sub === "_config-set") {
    // _config-set <project> <key> <value>; value may be empty (clear) or contain spaces.
    const [, projectName, key] = args;
    if (projectName && key) applyConfigSetFromMenu(projectName, key, args.slice(3).join(" "));
    return;
  }
  if (sub === "_config-branch-submenu") {
    if (args[1]) runProjectBranchSubmenu(args[1]);
    return;
  }
  if (sub === "_config-holistic-submenu") {
    if (args[1]) runHolisticSubmenu(args[1]);
    return;
  }
  if (sub === "_config-color-submenu") {
    if (args[1]) runColorSubmenu(args[1]);
    return;
  }
  if (sub === "_config-model-submenu") {
    if (args[1]) runProjectModelSubmenu(args[1]);
    return;
  }
  if (sub === "_config-effort-submenu") {
    if (args[1]) runProjectEffortSubmenu(args[1]);
    return;
  }
  if (sub === "_garden-menu") {
    runGardenMenu();
    return;
  }
  if (sub === "_garden-checks-submenu") {
    runChecksSlotsSubmenu();
    return;
  }
  if (sub === "_garden-reviews-submenu") {
    runMaxReviewsSubmenu();
    return;
  }
  if (sub === "_garden-branch-submenu") {
    runBuildBranchSubmenu();
    return;
  }
  if (sub === "_garden-branch-set") {
    // Branch names never contain spaces, but join defensively like the sibling
    // routes rather than silently truncating an odd ref.
    const branch = args.slice(1).join(" ").trim();
    if (branch) applyBuildBranch(branch);
    return;
  }
  if (sub === "_garden-limit-set") {
    // _garden-limit-set <key> <value>; value "unset" clears the override.
    const [, key] = args;
    if (key) applyGardenLimitFromMenu(key, args.slice(2).join(" "));
    return;
  }
  if (sub === "_grow-plant") {
    // The seed (args[2]) may contain spaces if it was substituted from
    // tmux %% with a multi-word user input. tmux command-prompt %% is a
    // single-token substitution by default, but operators can pass a
    // pre-quoted seed via the CLI subcommand directly.
    if (args[1]) plantGrowFromPicker(args[1], args.slice(2).join(" "));
    return;
  }
  if (sub === "_botanist-plant") {
    if (args[1]) plantBotanistFromPicker(args[1]);
    return;
  }
  if (sub === "_trellis-plant") {
    if (args[1] && args[2]) plantVineFromPicker(args[1], args[2]);
    return;
  }
  if (sub === "_trellis-plant-author") {
    if (args[1]) spawnTrellisAuthor(args[1]);
    return;
  }
  if (sub === "_trellis-revive-submenu") {
    if (args[1]) runReviveSubmenu(args[1]);
    return;
  }
  if (sub === "_seed-worker") {
    if (args[1] && args[2] && args[3]) seedWorker(args[1], args[2], args[3]);
    return;
  }
  if (sub === "_poll") {
    poll(args[1]);
    return;
  }
  if (sub === "_trigger-poll") {
    if (args[1]) return triggerProjectPoll(args[1]);
    const config = loadConfig();
    for (const pn of Object.keys(config.projects)) triggerProjectPoll(pn);
    return;
  }
  if (sub === "_post-push") return postPush(args[1]);
  if (sub === "_holistic-backtest") {
    const { runHolisticBacktest } = await import("./holistic-backtest.js");
    await runHolisticBacktest(args.slice(1));
    return;
  }
  if (sub === "_usage-poll-loop") {
    await runUsagePollerLoop();
    return;
  }
  if (sub === "_watchdog-loop") {
    await runWatchdogLoop();
    return;
  }
  if (sub === "_diag-status") {
    const { runDiagStatus } = await import("./diag-status.js");
    await runDiagStatus();
    return;
  }
  if (sub === "_diag-alert") {
    const { runDiagAlert } = await import("./diag-alert.js");
    await runDiagAlert(args[1]);
    return;
  }
  if (sub === "_usage-refresh") {
    const { refreshUsage } = await import("./usage.js");
    const { refreshDashboard } = await import("./header.js");
    const { probeCodexUsageIfStale } = await import("./codex-usage.js");
    await refreshUsage();
    // The Codex meter has no passive refresh path — reading the rollout only
    // re-reports the last time Codex ran, so refresh the active half here too.
    // Gated on staleness, NOT probed outright: this route is the Claude Code
    // Stop hook's usage lane (maybeRefreshUsage), which can re-fire on its 90s
    // demand cooldown throughout active work — an ungated probe would spend
    // Codex quota every 90s. The operator's explicit `garden usage refresh`
    // is the ungated path.
    try {
      probeCodexUsageIfStale();
    } catch { /* best effort — the Claude half already refreshed */ }
    try { refreshDashboard(); } catch { /* pane gone, not running, etc. */ }
    return;
  }
  if (sub === "_post-rebuild-refresh") {
    // Spawned via the rebuilt binary so respawnStatusPane bakes in the new code
    const { respawnStatusPane, respawnLogsPane } = await import("./create.js");
    const { resolveGardenRunner } = await import("./runner.js");
    const { readDashState } = await import("./state.js");
    const { refreshDashboard, setupStatusBar } = await import("./header.js");
    const { restartLongLivedPollers } = await import("./poller.js");
    if (dashboardExists()) {
      const state = readDashState();
      const runner = resolveGardenRunner();
      try { setupStatusBar(runner); } catch { /* best effort — pick up format-string changes */ }
      try { respawnStatusPane(state); } catch { /* pane gone */ }
      try { restartLongLivedPollers(runner); } catch { /* best effort */ }
      try { respawnLogsPane(state); } catch { /* pane gone */ }
      try { refreshDashboard(); } catch { /* no attached client */ }
    }
    return;
  }
  if (sub === "_header") return printHeader();
  if (sub === "_claude-hook") return handleClaudeHook(args[1]);
  // Back-compat: pre-auto-mode worktrees wired _judge-bash as a PreToolUse Bash hook; drop once no settings.local.json references it.
  if (sub === "_judge-bash") return;
  if (sub === "_pane-died") return handlePaneDied(args[1]);
  if (sub === "_title-changed") return handleTitleChanged(args[1], args[2]);
  if (sub === "_client-resized") {
    // Terminal resize: tmux redistributes pane sizes proportionally AND the
    // pre-baked pane content (status rows capped to width, usage bars scaled
    // to it) is now rendered for the old width. Re-bake content at the fresh
    // widths and reconcile the drifted heights — all via SIGUSR1 repaints,
    // never refresh-client/full refresh, which broke copy-mode scrolling
    // (a10642c). See rebakePanesOnResize.
    const { readDashState } = await import("./state.js");
    const { USAGE_PANE_HEIGHT, presizeHiddenWindows } = await import("./create.js");
    const { rebakePanesOnResize } = await import("./header.js");
    try {
      const state = readDashState();
      rebakePanesOnResize(state, USAGE_PANE_HEIGHT);
      // The right slot is 60% of the terminal, so resizing the terminal changes
      // its width. Hidden worker windows are window-size=manual (resize-window
      // sets that), so they stay frozen at the old width and a worker that keeps
      // working while parked paints scrollback that wraps early when later
      // viewed. Re-presize hidden windows to the new slot width. Only touches
      // hidden windows (drift-guarded) — never the visible pane, so it can't
      // disturb copy-mode the way a full refresh did (a10642c).
      presizeHiddenWindows(state);
    } catch { /* pane gone or no client */ }
    return;
  }
  if (sub === "_bootstrap-alert") {
    const [, projectName, baseBranch, projectPath, ...rest] = args;
    const errText = rest.join(" ").slice(0, 400);
    addAlert({
      level: "warn",
      source: "bootstrap",
      project: projectName ?? "unknown",
      message: `Worker bootstrap could not update main checkout at ${projectPath ?? "?"} to origin/${baseBranch ?? "base"}: ${errText}. Worker still branched off origin/${baseBranch ?? "base"}; clean the main checkout so future workers stay fresh.`,
      // errText carries variable git output; key on the project so a single
      // long-running fetch issue collapses to one alert per window.
      dedupKey: `bootstrap:${projectName ?? "unknown"}`,
    });
    return;
  }
  if (sub === "_bootstrap-rebase") {
    // Bootstrap detected the worker's pinned base branch is missing on
    // origin (operator merged + deleted the branch) and fell back to
    // origin's default. Update the registry entry so the poller, reviewer,
    // and Stop hook all rebase against the new base from this point on.
    const [, projectName, workerName, newBase, oldBase] = args;
    if (!projectName || !workerName || !newBase) return;
    try {
      const { updateWorkerFields } = await import("./registry.js");
      updateWorkerFields(projectName, workerName, { baseBranch: newBase });
    } catch (err) {
      log.warn("bootstrap", "rebase: failed to update registry", {
        worker: workerName,
        data: { project: projectName, error: String(err) },
      });
    }
    addAlert({
      level: "warn",
      source: "bootstrap",
      project: projectName,
      worker: workerName,
      message: `Base branch '${oldBase ?? "?"}' missing on origin (PR merged + deleted?); worker rebased to origin/${newBase}. Switch the main checkout at this project to ${newBase} so future workers stay fresh.`,
      dedupKey: `bootstrap-rebase:${projectName}:${oldBase ?? "?"}`,
    });
    return;
  }
  if (sub === "_bootstrap-fail") {
    // Bootstrap aborted irrecoverably (base missing on origin AND no
    // resolvable origin/HEAD). The worker entry was stamped in addWorker
    // before the bootstrap ran but never reached worktree creation, so
    // remove it before the pane dies — otherwise it persists as a ghost
    // (agentStatus="exited" with no worktree on disk) that the ghost
    // sweep can't clean.
    const [, projectName, workerName, ...rest] = args;
    const errText = rest.join(" ").slice(0, 400);
    if (projectName && workerName) {
      try {
        const { removeWorker } = await import("./registry.js");
        removeWorker(projectName, workerName);
      } catch (err) {
        log.warn("bootstrap", "fail: failed to remove worker entry", {
          worker: workerName,
          data: { project: projectName, error: String(err) },
        });
      }
    }
    addAlert({
      level: "error",
      source: "bootstrap",
      project: projectName ?? "unknown",
      worker: workerName,
      message: `Worker bootstrap aborted: ${errText}. Switch the main checkout to a pushed branch (e.g. main) and retry.`,
      dedupKey: `bootstrap-fail:${projectName ?? "unknown"}`,
    });
    return;
  }

  if (sub === "_install-worker-runtime") {
    // Called from a Codex worker's bootstrap script AFTER `git worktree add`,
    // BEFORE launching codex: install the harness runtime config the inline
    // bootstrap does not (it inlines only the claude dialect). For a claude
    // worker this is a no-op — its config is inlined. For codex: directory
    // trust + excludes (installRuntimeConfig) plus the composed rules as
    // AGENTS.md (hooks ride launch-time -c overrides). Best-effort: a failure
    // logs but does not abort the pane (the worker still launches; a missing
    // relay/rules degrades, it does not wedge).
    const [, projectName, workerName, contextFile] = args;
    if (!projectName || !workerName) return;
    try {
      const { findWorkerByName } = await import("./registry.js");
      const entry = findWorkerByName(projectName, workerName);
      if (!entry?.worktreePath || entry.harness !== "codex") return;
      const { tryGetProject } = await import("../config.js");
      const project = tryGetProject(projectName) ?? { path: entry.worktreePath };
      const { getHarness } = await import("./harness/index.js");
      let rulesText: string | undefined;
      if (contextFile) {
        const { readFileSync } = await import("node:fs");
        rulesText = readFileSync(contextFile, "utf-8");
      }
      getHarness(entry.harness).installRuntimeConfig(
        entry.worktreePath,
        project,
        rulesText === undefined ? undefined : { rulesText },
      );
    } catch (err) {
      log.warn("bootstrap", "install-worker-runtime failed", {
        worker: workerName,
        data: { project: projectName, error: String(err) },
      });
    }
    return;
  }

  if (sub === "help") {
    printDashboardHelp();
    return;
  }

  if (sub && sub !== "help") {
    throw new Error(`Unknown dashboard subcommand: ${sub}. Try 'garden dashboard help'.`);
  }

  // Default: create/attach
  resizeTerminal();
  ensureDashboard();
  console.log("Attaching to dashboard... (detach with ctrl-b d)");
  attachDashboardSession();
}

function printDashboardHelp(): void {
  console.log(`
garden dashboard — multi-project control center

Usage:
  garden dashboard                 Open the dashboard (creates if needed)
  garden dashboard exit            Close the dashboard
Layout:
  Left: garden title + usage meters (top), project status (middle), growhouse pane (bottom: growhouse, root, or logs).
  Right: active pane (worker or shell). Info in status bar.

Hotkeys (⌥ = Option/Alt, no prefix needed):
  ⌥1 – ⌥9     Switch to project by number (within active plot)
  ⌥p / ⌥P     Cycle to next/previous focused plot (⌥o also cycles previous)
  ⌥n           New worker (Claude session)
  ⌥w           Jump to first worker
  ⌥s           Jump to project shell
  ⌥] / ⌥[     Cycle workers and shell
  ⌥x           Kill current worker (shell is protected)
  ⌥b           Bounce current worker (restart Claude, preserve session history)
  ⌥g           Focus growhouse (garden> prompt with auto-dispatch)
  ⌥r           Focus root shell
  ⌥l           Focus logs
  ⌥a           Focus alerts (marks them read)
  ⌥d           Focus diary (focused project's diary in $EDITOR)
  ⌥/           Edit sticky logs filter (key:value or fuzzy; empty clears)
  ⌥.           Clear sticky logs filter immediately

Setup:
  iTerm2: Profiles → Keys → Left Option key → "Esc+"

Navigation:
  ctrl-b d     Detach (everything keeps running)
  ctrl-b z     Zoom/unzoom current pane
`.trim());
}

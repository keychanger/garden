// Worker lifecycle: creation and destruction of Claude worker sessions.
import path from "node:path";
import { spawn } from "node:child_process";
import { DASHBOARD_SESSION } from "../session.js";
import { getProject, tryGetProject, tryResolveProvider, loadConfig, plotsMap } from "../config.js";
import { syncProviderTokenToSession, providerTokenPresence } from "./claude-env.js";
import { readDashState, writeDashState, withStateLock } from "./state.js";
import { parkToHidden, restoreFromHidden } from "./layout.js";
import { refreshDashboard, setPaneProjectColor } from "./header.js";
import {
  tmux, tmuxDisplay, newDashboardWindowPaned, setPaneLabel, setPaneVar, shellEscape,
  getFirstPaneId, paneExists, windowExists,
  listHiddenWorkerWindows, killWindowSafe,
  getPaneSize, resizeWindow,
} from "./tmux.js";
import { generateWorkerName } from "./names.js";
import {
  addWorker, removeWorker, findWorkerByName, getAllWorkerNames,
  updateWorkerFields, getWorkers, resolveResumeAgentStatus, compareWorkerFreshness, type AgentStatus,
} from "./registry.js";
import { recordWorkerCreated, recordOperatorAction, shortHash, type RoleSnapshot } from "./telemetry.js";
import { deriveCrew, getCrew } from "./crew.js";
import { resolveReviewRole, type ReviewRole } from "./roles.js";
import { buildRulesContext } from "../rules.js";
import { GARDEN_VERSION } from "../version.js";
import { log } from "./log.js";
import { resolveAndApplyVineModel } from "./trellis-model.js";
import { getWorkflow } from "./workflows/index.js";
import {
  buildWorktreeBootstrapScript, buildWorktreeResumeCommand, buildResumeCommand,
  createShellWindow, trellisRelativePathForEntry,
} from "./create.js";
import { getHarness } from "./harness/index.js";
import { isRegisteredHarness, harnessNames, canonicalHarnessName } from "./harness/core.js";
import { resolveGardenRunner } from "./runner.js";
import {
  worktreePath, resolveBaseBranch, resolveSpawnBase, branchExistsOnOrigin, tryPublishBranch,
  gardenDoneTrackedInHead, getRemoteTrackingSha,
} from "./git.js";
import { addAlert } from "./alerts.js";
import { ensureProjectPoller, killReviewWindow, stopProjectPoller } from "./poller.js";
import { dispatchDelayedContinue, dispatchDelayedSeed } from "./continue.js";
import { swapVisibleToProject } from "./navigate.js";
import { workerWindowName as workerWin, parkingWindowName, shellWindowName as shellWin, parseWorkerSuffix } from "./window-names.js";

// Model half of the `--ultracode` handoff preset: pin the worker to Opus
// (1M context). The effort + dynamic-workflow half is rendered by the harness
// buildAgentCommand from the entry's `ultracode` flag. Operator-chosen recipe:
// max effort + workflows on + Opus.
const ULTRACODE_MODEL = "opus[1m]";

export interface NewWorkerOptions {
  // Target project. Defaults to state.activeProject. When the target differs
  // from the current active project AND background is false, the dashboard's
  // active project is switched to the target before the worker is created —
  // the new worker comes into view exactly like a ⌥n on the target project
  // would, and the previously-visible pane gets parked under its source
  // project. With background:true (the handoff path), the active project is
  // NOT switched; the new worker is created hidden and the operator's pane
  // is left undisturbed.
  projectName?: string;
  // Path to a file containing the seed prompt for the new worker. If set, a
  // detached subprocess sends the file's contents to the new worker's pane
  // after a few seconds (Claude TUI init delay), then deletes the file.
  seedMessageFile?: string;
  // Create the new worker in a hidden window without disturbing the visible
  // layout: skip the cross-project active-project/plot switch, skip the park
  // + restore swap, and leave activePaneType/activeWindowName/activePaneId
  // untouched. Used by `garden handoff` so spawning a fresh worker does not
  // yank the operator out of their current pane. The new worker is reachable
  // via ⌥n on the target project + ⌥w to cycle to it.
  background?: boolean;
  // Harness adapter for this worker (agent CLI in the pane). Defaults to
  // claude-code. "codex" spawns a Codex worker (own sandbox, .codex/hooks.json
  // event relay, AGENTS.md rules). Validated against the registry; an unknown
  // harness is refused. Persisted on entry.harness and threaded through
  // launch/resume/loop.
  harness?: string;
  // Per-worker base-branch override (`workers new --base`). Takes precedence
  // over the project's configured baseBranch and the checkout-follows default
  // (see resolveSpawnBase). Validated + published through the same
  // branchExistsOnOrigin / tryPublishBranch chain as any resolved base, then
  // pinned to entry.baseBranch.
  base?: string;
  // Per-worker crew (`workers new --crew`). Sets BOTH halves at spawn: the
  // build harness (the crew's worker member — mutually exclusive with
  // --harness) and the review family (stamped on entry.crew, applied live by
  // resolveReviewRole). A provider-backed worker member is rejected upstream
  // (no per-worker provider). Default workflow only, like --harness.
  crew?: string;
  // Workflow that drives the new worker's lifecycle. Defaults to "default".
  // Trellis vines pass "trellis" along with the trellis.name/trellis.path
  // pair below; see WORKFLOWS.md "Spawning a trellis vine".
  workflow?: string;
  // Per-worker model from `--model` for default and grow workers. Persisted
  // to entry.model and threaded into every launch/respawn/bounce. Opaque
  // string: an Anthropic alias or a concrete model id. Trellis vines use
  // trellis.workerModel below instead (iteration-resolved with fallback).
  model?: string;
  // Ultracode preset (`garden handoff --ultracode`). When true, the worker is
  // stamped with the Opus model pin and launches in Claude Code's ultracode
  // mode (`--effort max` + the dynamic-workflow keyword trigger). Persisted to
  // entry.ultracode + entry.model and threaded into every launch/resume/bounce.
  // Ignored for trellis vines (they resolve their own model per iteration).
  ultracode?: boolean;
  // Per-worker reasoning effort (one of WORKER_EFFORT_LEVELS: low/medium/high/
  // xhigh) for default/grow workers. Persisted to entry.effort and rendered as
  // `--effort <level>`. The "ultra" rung is expressed via `ultracode`, not
  // here; a caller must not set both. Ignored for trellis vines.
  effort?: string;
  // Trellis-specific options, ignored unless workflow === "trellis".
  trellis?: {
    name: string;
    path: string;
    maxIterations: number;
    /** Per-worker model override from `--model` at plant time. Persisted
     *  to entry.trellis.workerModel and read by each iteration's
     *  resolveVineModel call. Absent → workflow.workerModel default
     *  ("sonnet"). */
    workerModel?: string;
  };
  // Grow-specific options, ignored unless workflow === "grow". The seed is
  // the operator's task description, persisted on entry.grow.seed and
  // inlined into iter ≥ 2 continue prompts. maxIterations bounds the loop.
  grow?: {
    seed: string;
    maxIterations: number;
  };
  // Handoff lineage and callback opt-in. Set only when this worker is being
  // created via `garden handoff --expect-callback` (background path).
  // Writes the parent linkage and the expectCallback flag onto the child's
  // registry entry; transitionState fires a one-shot prompt at the parent's
  // pane on the child's first terminal prState. Absent on ⌥n workers, manual
  // newWorker calls, and plain handoffs.
  handoffCallback?: {
    parentProject: string;
    parentWorker: string;
    expectCallback: true;
  };
}

export function newWorker(opts: NewWorkerOptions = {}): string | null {
  let createdName: string | null = null;
  withStateLock(() => {
    const state = readDashState();
    const targetProject = opts.projectName ?? state.activeProject;
    if (!targetProject) {
      tmuxDisplay("No project selected. Use ⌥1-⌥9 first.");
      return;
    }

    const project = tryGetProject(targetProject);
    if (!project) {
      tmuxDisplay(`Unknown project '${targetProject}'.`);
      return;
    }

    // Worker harness selection (agent CLI in the pane): per-worker --harness,
    // else the project default (set directly or by a crew), else claude-code.
    // The project default applies to the DEFAULT workflow ONLY — trellis/grow
    // loop mechanics (per-iteration model resolution, cold-respawn session
    // identity) are wired for claude-code, so a foreign harness worker is
    // "default workflow only". This mirrors the CLI's explicit --harness guard
    // (commands/workers.ts), which rejects `--harness` with a non-default
    // workflow; without this gate a project defaulting to codex (via a crew or
    // `config <p> harness`) would silently stamp codex onto a trellis/grow vine.
    // Validate against the registry so an unknown name fails loudly here rather
    // than silently falling back at launch.
    const workflowName = opts.workflow ?? "default";
    // Worker harness resolution. A per-worker crew is AUTHORITATIVE over the
    // build harness (its worker member) — project.harness is not consulted when a
    // crew is given, so a claude-worker crew (claude-codex / all-claude) builds
    // with claude even on a project defaulting to a foreign harness, and a
    // codex-worker crew builds with codex. The claude-code member is pinned
    // explicitly (mirroring `--harness claude`) rather than left to fall through:
    // stamping undefined here would drop to project.harness at this line and
    // silently launch the project's default harness for a worker the operator
    // explicitly asked to build with claude. The CLI guard makes --crew and
    // --harness mutually exclusive and rejects a provider-backed worker member (no
    // per-worker provider); the !provider fall-through here is defense-in-depth for
    // other newWorker callers — an unsupported provider member drops to the project
    // default. The crew's REVIEW half rides entry.crew (stamped below) and is
    // applied live by resolveReviewRole.
    let rawHarness: string | undefined;
    if (opts.harness) {
      rawHarness = opts.harness;
    } else if (opts.crew) {
      const spec = getCrew(opts.crew, loadConfig());
      rawHarness = spec && !spec.worker.provider
        ? spec.worker.harness
        : (workflowName === "default" ? project.harness : undefined);
    } else {
      rawHarness = workflowName === "default" ? project.harness : undefined;
    }
    // Canonicalize the operator-facing "claude" alias to the registry name.
    // This is the chokepoint every worker-creation path funnels through (CLI
    // --harness, the workflow picker, the project default), so the stamped
    // entry.harness is always a registry name.
    const resolvedHarness = rawHarness === undefined ? undefined : canonicalHarnessName(rawHarness);
    if (resolvedHarness && !isRegisteredHarness(resolvedHarness)) {
      tmuxDisplay(`Unknown harness '${resolvedHarness}'. Known: ${harnessNames().join(", ")}.`);
      log.error("workers", "rejected newWorker: unknown harness", {
        data: { project: targetProject, harness: resolvedHarness },
      });
      return;
    }

    // Provider preflight: the worker's launch command references the API
    // key as "$<authTokenEnv>", expanded from the tmux session env. Sync
    // the key from this process (best-effort — covers the operator-shell
    // invocation path) and refuse to spawn a worker that would launch with
    // an empty token; an unauthenticated worker fails opaquely at first
    // inference, far from the cause.
    const workerProvider = tryResolveProvider(project);
    if (workerProvider) {
      syncProviderTokenToSession(workerProvider);
      const presence = providerTokenPresence(workerProvider);
      if (!presence.shell && presence.session !== true) {
        tmuxDisplay(`Provider '${workerProvider.name}' requires $${workerProvider.authTokenEnv} — not set in this shell or the dashboard session.`);
        log.error("workers", "rejected newWorker: provider token env var unset", {
          data: {
            project: targetProject,
            provider: workerProvider.name,
            envVar: workerProvider.authTokenEnv,
          },
        });
        return;
      }
    }

    // --workflow trellis without opts.trellis is a bug — the CLI must
    // surface this with a clear error before we add the worker.
    if (opts.workflow === "trellis" && !opts.trellis) {
      tmuxDisplay("--workflow trellis requires the trellis options to be set (caller bug).");
      log.error("workers", "rejected newWorker: workflow=trellis but no trellis opts", {
        data: { project: targetProject },
      });
      return;
    }
    // --workflow grow without opts.grow is the same caller bug.
    if (opts.workflow === "grow" && !opts.grow) {
      tmuxDisplay("--workflow grow requires the grow options to be set (caller bug).");
      log.error("workers", "rejected newWorker: workflow=grow but no grow opts", {
        data: { project: targetProject },
      });
      return;
    }

    const background = opts.background ?? false;

    // Cross-project foreground: switch active project to the target first, so
    // the park/restore + state mutation below behave exactly like ⌥n on that
    // project. If the target lives outside the current active plot, also
    // switch to a plot that contains it — otherwise ⌥1-9 navigation desyncs
    // from the visible pane. Skipped in background mode (handoff): the
    // operator's view stays put and the new worker remains hidden.
    if (!background && opts.projectName && opts.projectName !== state.activeProject) {
      const plots = plotsMap(loadConfig());
      const activePlotProjects = state.activePlot && plots[state.activePlot]
        ? plots[state.activePlot].projects
        : [];
      if (!activePlotProjects.includes(opts.projectName)) {
        for (const [plotName, plot] of Object.entries(plots)) {
          if (plot.projects.includes(opts.projectName)) {
            state.activePlot = plotName;
            break;
          }
        }
      }
      swapVisibleToProject(opts.projectName, project, state);
    }

    const existingNames = getAllWorkerNames();
    const workerName = generateWorkerName(existingNames);
    // Session identity is harness-shaped (Claude Code accepts a minted
    // UUID; Codex assigns its own id post-launch, so its adapter returns the
    // empty sentinel — recovered from the hook payload later).
    const sessionId = getHarness(resolvedHarness).allocateSessionId();
    const branchName = workerName;
    const wtPath = worktreePath(targetProject, workerName);
    const gardenRunner = resolveGardenRunner();

    const baseBranch = resolveSpawnBase(project, opts.base);

    // A worker whose base branch isn't on origin breaks silently: every
    // `origin/<base>..HEAD` check in the Stop hook and poller fails, so the
    // review cycle never starts. The natural failure mode is the operator
    // switching the main checkout to a brand-new local branch and pressing
    // ⌥n. Treat that as a publish gesture: push <base> to origin so it
    // gains the ref everything downstream needs, then proceed. If the push
    // fails (no remote, branch protection, non-fast-forward, network),
    // surface the real git error so the operator knows what to fix.
    // Check is local-refs only — see branchExistsOnOrigin doc.
    if (!branchExistsOnOrigin(project.path, baseBranch)) {
      const result = tryPublishBranch(project.path, baseBranch);
      if (result.ok) {
        tmuxDisplay(`Published '${baseBranch}' to origin (worker base ref).`);
        log.info("workers", "auto-published base branch for new worker", {
          worker: workerName,
          data: { project: targetProject, baseBranch },
        });
      } else {
        // The git stderr is often multi-line ("hint:" lines, etc.); the last
        // non-empty line is usually the actionable reason ("fatal: 'origin'
        // does not appear to be a git repository", "! [rejected] non-fast-
        // forward", "remote: error: GH006: Protected branch update failed").
        const lastLine =
          result.error.split("\n").map((l) => l.trim()).filter(Boolean).pop()
          ?? result.error;
        tmuxDisplay(
          `Cannot create worker: couldn't publish '${baseBranch}' to origin — ${lastLine}`,
        );
        log.error("workers", "rejected newWorker: base branch publish failed", {
          worker: workerName,
          data: { project: targetProject, baseBranch, error: result.error },
        });
        return;
      }
    }

    if (gardenDoneTrackedInHead(project.path)) {
      addAlert({
        level: "warn",
        source: "create",
        project: targetProject,
        message: `\`.garden-done\` is tracked in HEAD of ${targetProject}.`,
        dedupKey: `garden-done-tracked:${targetProject}`,
      });
    }

    // Compute the worktree-relative trellis path so buildWorktreeRules can
    // append the trellis-specific paragraphs to the worker's system prompt.
    // Default workers leave this undefined and get the baseline rules.
    const trellisRelativePath =
      opts.workflow === "trellis" && opts.trellis
        ? path.relative(project.path, opts.trellis.path)
        : undefined;

    // Stamp the registry entry FIRST so model resolution (below) can read
    // it. If model resolution refuses (Sonnet exhausted + fallback
    // disabled), we roll back via removeWorker before any tmux/disk work.
    // (workflowName resolved above, alongside harness selection.)
    // Ultracode preset pins Opus (unless an explicit --model was also passed).
    // Trellis vines resolve their own model per iteration, so the preset's
    // model pin does not apply there — only its non-trellis workers get it.
    const ultracode = opts.ultracode === true && workflowName !== "trellis";
    const effectiveModel = ultracode ? (opts.model ?? ULTRACODE_MODEL) : opts.model;
    // Per-worker effort rung for default/grow. Suppressed for trellis (own
    // model resolution) and when ultracode is set (that preset already fixes
    // max effort — the composer/CLI keep them mutually exclusive, this is
    // defense-in-depth so a caller passing both never double-sets effort).
    const effectiveEffort = !ultracode && workflowName !== "trellis" ? opts.effort : undefined;
    // origin/<baseBranch> tip at creation — the `from` endpoint of the
    // whole-task cumulative diff a later holistic review computes. Captured
    // here (after the publish gesture guarantees the ref exists) because the
    // base advances as this and sibling workers merge, so it cannot be
    // reconstructed reliably afterward.
    const baseBranchSha = getRemoteTrackingSha(project.path, baseBranch) ?? undefined;
    const createdAt = Date.now();
    addWorker(targetProject, {
      name: workerName,
      sessionId,
      task: "",
      worktreePath: wtPath,
      branchName,
      baseBranch,
      ...(baseBranchSha ? { baseBranchSha } : {}),
      agentStatus: "loading",
      createdAt,
      workflow: workflowName,
      // Harness adapter (agent CLI). Absent = claude-code; consumers read via
      // getHarness(entry.harness). Threaded into launch/resume/loop.
      ...(resolvedHarness ? { harness: resolvedHarness } : {}),
      // Per-worker crew — its review half, applied live by resolveReviewRole
      // (the build half is already folded into resolvedHarness above).
      ...(opts.crew ? { crew: opts.crew } : {}),
      // Per-worker model pin for default/grow workers (trellis resolves
      // per iteration via trellis.workerModel below). Ultracode folds its
      // Opus pin into effectiveModel above.
      ...(workflowName !== "trellis" && effectiveModel ? { model: effectiveModel } : {}),
      // Ultracode launch mode (max effort + dynamic-workflow trigger),
      // threaded into every launch/resume/bounce.
      ...(ultracode ? { ultracode: true } : {}),
      // Per-worker effort rung (default/grow), threaded like model. Never set
      // alongside ultracode (effectiveEffort is undefined then).
      ...(effectiveEffort ? { effort: effectiveEffort } : {}),
      // Trellis vine data — populated only when workflow === "trellis".
      // iteration starts at 0; launchReview increments to 1 before the
      // first review fires. See WORKFLOWS.md "Worker entry additions".
      ...(workflowName === "trellis" && opts.trellis
        ? {
            trellis: {
              name: opts.trellis.name,
              path: opts.trellis.path,
              iteration: 0,
              maxIterations: opts.trellis.maxIterations,
              workerModel: opts.trellis.workerModel,
            },
          }
        : {}),
      // Grow loop data — populated only when workflow === "grow". Same
      // iteration counter pattern as trellis (starts at 0, launchReview
      // increments before dispatch). The seed anchors iter ≥ 2 prompts
      // across context resets.
      ...(workflowName === "grow" && opts.grow
        ? {
            grow: {
              seed: opts.grow.seed,
              iteration: 0,
              maxIterations: opts.grow.maxIterations,
            },
          }
        : {}),
      ...(opts.handoffCallback
        ? {
            parentProject: opts.handoffCallback.parentProject,
            parentWorker: opts.handoffCallback.parentWorker,
            handoffCallbackExpected: true,
          }
        : {}),
    });

    // For trellis vines, resolve the iteration's model now (before the
    // bootstrap is built). Resolution may fall back Sonnet → Opus, or
    // refuse outright when Sonnet is exhausted and trellisOpusFallback
    // is false. A refusal rolls back the entry and bails — no pane
    // spawned, no worktree created.
    let resolvedModel: string | undefined =
      workflowName !== "trellis" ? effectiveModel : undefined;
    if (workflowName === "trellis") {
      const stamped = findWorkerByName(targetProject, workerName);
      if (stamped) {
        const m = resolveAndApplyVineModel(targetProject, stamped, getWorkflow("trellis"));
        if (m === null) {
          // Sonnet exhausted + trellisOpusFallback=false. Roll back.
          removeWorker(targetProject, workerName);
          tmuxDisplay(
            `Cannot plant vine: Sonnet exhausted and trellisOpusFallback=false. ` +
            `Wait for the Sonnet meter to reset, run 'garden auto on', or ` +
            `set 'garden config ${targetProject} trellisOpusFallback true'.`,
          );
          return;
        }
        resolvedModel = m;
      }
    }

    // Write the bootstrap script that handles slow setup (git fetch, worktree
    // creation, npm install) inside the tmux pane so the window appears instantly
    // with progress output instead of blocking the hotkey handler. Default
    // workers omit the options argument entirely (preserves arity for existing
    // callers and tests).
    const bootstrapOpts: { trellisRelativePath?: string; model?: string; ultracode?: boolean; effort?: string; harness?: string } = {};
    if (trellisRelativePath) bootstrapOpts.trellisRelativePath = trellisRelativePath;
    if (resolvedModel) bootstrapOpts.model = resolvedModel;
    if (ultracode) bootstrapOpts.ultracode = true;
    if (effectiveEffort) bootstrapOpts.effort = effectiveEffort;
    if (resolvedHarness) bootstrapOpts.harness = resolvedHarness;
    const scriptFile = (bootstrapOpts.trellisRelativePath || bootstrapOpts.model || bootstrapOpts.ultracode || bootstrapOpts.effort || bootstrapOpts.harness)
      ? buildWorktreeBootstrapScript(
          project.name, project.path, workerName, branchName, sessionId, wtPath, baseBranch,
          bootstrapOpts,
        )
      : buildWorktreeBootstrapScript(
          project.name, project.path, workerName, branchName, sessionId, wtPath, baseBranch,
        );

    const workerWindowName = workerWin(targetProject, workerName);

    try {
      // Spawn the bootstrap shell only after the window is sized to the right
      // slot. Otherwise the new window comes up at tmux's default (typically
      // 80×24, sometimes narrower), Claude's TUI does its first paint into
      // that small grid, and those hard-wrapped lines stay frozen in scrollback
      // forever. The placeholder/respawn-pane dance closes that race: create
      // window holding a long sleep, resize, then respawn-pane with the
      // real script in a correctly-sized grid. NOTE: `sleep infinity` is a
      // GNU coreutils-ism and exits 1 on macOS BSD sleep ("usage: sleep
      // seconds"), which destroyed the placeholder pane before respawn-pane
      // could land. Use a finite large value — respawn replaces it in ms.
      const rightSize = state.activePaneId ? getPaneSize(state.activePaneId) : null;
      const bootstrapCmd = `sh ${shellEscape(scriptFile)}`;
      if (background) {
        // Hidden creation only — no park, no restore. The window is born detached
        // and stays detached. The operator's visible pane and dashboard state are
        // not touched.
        const workerPaneId = newDashboardWindowPaned(workerWindowName, "-c", project.path,
          "sh", "-c", "exec sleep 86400");
        if (rightSize) resizeWindow(workerWindowName, rightSize.width, rightSize.height);
        tmux("respawn-pane", "-k", "-c", project.path, "-t", workerPaneId, "sh", "-c", bootstrapCmd);
        if (workerPaneId) {
          setPaneLabel(workerPaneId, workerName);
          setPaneVar(workerPaneId, "garden_clock", "1");
          setPaneProjectColor(workerPaneId, targetProject);
        }
      } else {
        // Show the new pane immediately — bootstrap runs inside it
        const parkName = state.activeWindowName ?? parkingWindowName(state.activeProject!);
        parkToHidden(parkName, state);

        const workerPaneId = newDashboardWindowPaned(workerWindowName, "-c", project.path,
          "sh", "-c", "exec sleep 86400");
        if (rightSize) resizeWindow(workerWindowName, rightSize.width, rightSize.height);
        tmux("respawn-pane", "-k", "-c", project.path, "-t", workerPaneId, "sh", "-c", bootstrapCmd);
        if (workerPaneId) setPaneLabel(workerPaneId, workerName);
        restoreFromHidden(workerWindowName, state);
        // Re-apply label after swap (swap-pane may not preserve pane options)
        if (state.activePaneId) {
          setPaneLabel(state.activePaneId, workerName);
          setPaneVar(state.activePaneId, "garden_clock", "1");
          setPaneProjectColor(state.activePaneId, targetProject);
        }
      }
    } catch (err) {
      // addWorker (and trellis model resolution) already wrote the registry
      // entry; if pane creation fails it would otherwise sit in agentStatus=
      // "loading" forever with no worktree and no pane. Roll back so the next
      // attempt isn't blocked by name collision and the dashboard isn't lying
      // about pending workers.
      removeWorker(targetProject, workerName);
      log.error("workers", "tmux pane creation failed; rolled back registry entry", {
        worker: workerName,
        data: { project: targetProject, error: String(err) },
      });
      throw err;
    }

    log.info("workers", "created", {
      worker: workerName,
      data: { project: targetProject, branch: branchName, model: resolvedModel, background },
    });

    // Ledger the launch now that the pane has actually spawned — emitting
    // before the pane-creation try/catch above would leave a phantom
    // worker.created in the append-only (never-truncated) ledger whenever that
    // rollback fires (tmux spawn failure), over-counting launches in read-time
    // aggregation. The full configuration snapshot is frozen onto the event
    // because config is mutable (a crew swap rewrites harness/roles) and can't
    // be reconstructed by joining against live config later. Best-effort: the
    // snapshot helpers (deriveCrew / resolveReviewRole / buildRulesContext)
    // read files and config, so guard the whole block — a telemetry failure
    // must never abort a worker launch.
    try {
      const cfg = loadConfig();
      // A per-worker crew (opts.crew) overrides the review family live, so the
      // frozen snapshot must record what actually applies to THIS worker, not
      // the project's crew — mirroring how resolvedHarness already folds in the
      // crew's build half. Thread it into both the role snapshot (review
      // harness) and the crew field (garden stats --by crew groups on it).
      const crewEntry = opts.crew ? { crew: opts.crew } : undefined;
      const roleSnapshot = (role: ReviewRole): RoleSnapshot => {
        const r = resolveReviewRole(project, workflowName, role, cfg, crewEntry);
        return { harness: r.harness, model: r.model };
      };
      recordWorkerCreated(targetProject, workerName, createdAt, {
        workflow: workflowName,
        harness: resolvedHarness ?? "claude-code",
        provider: project.provider ?? null,
        model: resolvedModel ?? null,
        ultracode,
        crew: opts.crew ?? deriveCrew(project, cfg),
        roles: {
          reviewer: roleSnapshot("reviewer"),
          resolver: roleSnapshot("resolver"),
          ciFix: roleSnapshot("ciFix"),
        },
        baseBranch,
        rulesHash: shortHash(buildRulesContext(project.name, project.path)),
        gardenVersion: GARDEN_VERSION,
      });
    } catch (err) {
      log.warn("workers", "telemetry worker.created emit failed", {
        worker: workerName,
        data: { project: targetProject, error: String(err) },
      });
    }

    ensureProjectPoller(targetProject, gardenRunner);

    if (!background) {
      state.activePaneType = "worker";
      state.activeWindowName = workerWindowName;
      state.lastActiveWorker[targetProject] = workerWindowName;
      writeDashState(state);
    }
    refreshDashboard({ state });

    if (opts.seedMessageFile) {
      dispatchDelayedSeed(gardenRunner, targetProject, workerName, opts.seedMessageFile);
    }

    createdName = workerName;
  });
  return createdName;
}

// Pick which hidden worker takes over the visible slot when the current one
// is killed. Sorts the killed worker in among its still-live siblings by the
// same freshness order the status pane and ⌥]/⌥[ use, finds the row position
// it held, and hands focus to whichever worker now occupies that position —
// mirrors closing a browser tab, rather than jumping to tmux's arbitrary
// window-creation order (workerWindows[0]), which is what made the prior
// focus target feel random.
function pickReplacementWorkerWindow(
  project: string,
  killedWindowName: string | null,
  hiddenWorkerWindows: string[],
): string {
  if (!killedWindowName) return hiddenWorkerWindows[0];

  const entryByLabel = new Map(getWorkers(project).map(e => [e.name, e]));
  const labelOf = (w: string): string => parseWorkerSuffix(w) ?? w;
  const byFreshness = (wa: string, wb: string): number => {
    const ea = entryByLabel.get(labelOf(wa));
    const eb = entryByLabel.get(labelOf(wb));
    if (ea && eb) return compareWorkerFreshness(ea, eb);
    if (ea) return -1;
    if (eb) return 1;
    return labelOf(wa).localeCompare(labelOf(wb));
  };

  const withKilled = [...hiddenWorkerWindows, killedWindowName].sort(byFreshness);
  const killedIdx = withKilled.indexOf(killedWindowName);
  const remaining = [...hiddenWorkerWindows].sort(byFreshness);
  return remaining[Math.min(killedIdx, remaining.length - 1)];
}

export function killPane(): void {
  // Declare cleanup vars outside the lock so backgroundGitCleanup can run
  // after the lock is released — it only spawns a child process and does not
  // touch state.
  let cleanupRepoPath: string | undefined;
  let cleanupWtPath: string | undefined;
  let cleanupBranch: string | undefined;

  withStateLock(() => {
    const state = readDashState();

    if (state.activePaneType === "shell") {
      tmuxDisplay("Cannot kill project shell. Use ⌥x on workers only.");
      return;
    }

    if (!state.activePaneId || !paneExists(state.activePaneId)) {
      tmuxDisplay("No pane to kill.");
      return;
    }

    if (!state.activeProject) {
      writeDashState(state);
      return;
    }

    const killedWindowName = state.activeWindowName;
    const workerWindows = listHiddenWorkerWindows(state.activeProject);
    const project = getProject(state.activeProject);

    if (workerWindows.length > 0) {
      const targetWindow = pickReplacementWorkerWindow(state.activeProject, killedWindowName, workerWindows);
      const targetPaneId = getFirstPaneId(`${DASHBOARD_SESSION}:${targetWindow}`);
      if (targetPaneId) {
        const visibleSize = state.activePaneId ? getPaneSize(state.activePaneId) : null;
        if (visibleSize) resizeWindow(targetWindow, visibleSize.width, visibleSize.height);
        tmux("swap-pane", "-s", state.activePaneId, "-t", targetPaneId);
        killWindowSafe(targetWindow);
        state.activePaneId = targetPaneId;
        state.activePaneType = "worker";
        state.activeWindowName = targetWindow;
        // Re-apply pane variables lost during swap-pane
        const nextLabel = parseWorkerSuffix(targetWindow);
        if (nextLabel) {
          setPaneLabel(targetPaneId, nextLabel);
          setPaneVar(targetPaneId, "garden_clock", "1");
          setPaneProjectColor(targetPaneId, state.activeProject);
          const nextEntry = findWorkerByName(state.activeProject, nextLabel);
          if (nextEntry?.task) setPaneVar(targetPaneId, "garden_task", nextEntry.task);
        }
      }
    } else {
      const shellTarget = shellWin(state.activeProject);
      if (!windowExists(shellTarget)) {
        createShellWindow(state.activeProject, project.path);
      }
      const shellPaneId = getFirstPaneId(`${DASHBOARD_SESSION}:${shellTarget}`);
      if (shellPaneId) {
        const visibleSize = state.activePaneId ? getPaneSize(state.activePaneId) : null;
        if (visibleSize) resizeWindow(shellTarget, visibleSize.width, visibleSize.height);
        tmux("swap-pane", "-s", state.activePaneId, "-t", shellPaneId);
        killWindowSafe(shellTarget);
        state.activePaneId = shellPaneId;
        state.activePaneType = "shell";
        state.activeWindowName = shellTarget;
      }
    }

    if (killedWindowName && state.activeProject) {
      if (state.lastActiveWorker[state.activeProject] === killedWindowName) {
        delete state.lastActiveWorker[state.activeProject];
      }
      const killedWorkerName = parseWorkerSuffix(killedWindowName);
      if (killedWorkerName) {
        const entry = findWorkerByName(state.activeProject, killedWorkerName);

        killReviewWindow(state.activeProject, killedWorkerName);
        removeWorker(state.activeProject, killedWorkerName);
        log.info("workers", "killed", {
          worker: killedWorkerName,
          data: { project: state.activeProject, branch: entry?.branchName },
        });

        const remaining = getWorkers(state.activeProject);
        if (remaining.length === 0) {
          stopProjectPoller(state.activeProject);
        }

        if (entry) {
          cleanupRepoPath = project.path;
          cleanupWtPath = entry.worktreePath;
          cleanupBranch = entry.branchName;
        }
      }
    }

    writeDashState(state);
    refreshDashboard();
  });

  // Heavy git cleanup runs outside the lock — only spawns a background process.
  if (cleanupRepoPath) {
    backgroundGitCleanup(cleanupRepoPath, cleanupWtPath, cleanupBranch);
  }
}

// Kill and restart the Claude process in a worker's pane via `claude --resume`.
// The pane, pane ID, worktree, and registry entry all stay put; only the Claude
// process is replaced, which forces a fresh read of .claude/settings.json
// (hook config, permissions.defaultMode) and drops any transient session state
// that's interrupting the operator (e.g., stuck in plan mode with no cycle back
// to auto). Works on both visible and parked workers — we resolve the pane by
// the worker's tracked window name, not the currently-active pane.
export function bounceWorker(projectName: string, workerName: string): void {
  const entry = findWorkerByName(projectName, workerName);
  if (!entry) {
    throw new Error(`No worker '${workerName}' in project '${projectName}'.`);
  }
  if (!entry.sessionId) {
    throw new Error(
      `Worker ${projectName}/${workerName} has no sessionId — can't resume. ` +
      `It may pre-date the worktree workflow; kill and recreate it instead.`,
    );
  }

  const paneId = resolveWorkerPaneId(projectName, workerName);
  if (!paneId) {
    throw new Error(
      `Worker ${projectName}/${workerName} has no live pane. Reattach the dashboard first.`,
    );
  }

  const projectInfo = tryGetProject(projectName);
  // Prefer the baseBranch pinned at worker creation — resolving fresh here
  // would pick up a new main-checkout branch and silently break the worker
  // (same failure mode WorkerEntry.baseBranch was added to prevent).
  const baseBranch = entry.baseBranch
    ?? (projectInfo ? resolveBaseBranch(projectInfo.path) : undefined);

  // Rewrite .claude/settings.json so bounce picks up hook/sandbox
  // changes from a rebuilt garden. buildWorktreeResumeCommand doesn't do
  // this on its own (unlike buildResumeCommand); the attach-time resume
  // path in ensureDashboard() calls it for the same reason.
  if (entry.worktreePath && projectInfo) {
    getHarness(entry.harness).installRuntimeConfig(entry.worktreePath, projectInfo);
  }

  const trellisRelativePath = projectInfo
    ? trellisRelativePathForEntry(entry, projectInfo.path)
    : undefined;
  // entry.model carries the default/grow per-worker pin; trellis vines
  // resolve their model per iteration, not on bounce. Plain workers omit
  // the options arg so existing tests (which assert exact argument arity)
  // still pass.
  const resumeOpts: { trellisRelativePath?: string; model?: string; ultracode?: boolean; effort?: string; harness?: string } = {};
  if (trellisRelativePath) resumeOpts.trellisRelativePath = trellisRelativePath;
  if (entry.model) resumeOpts.model = entry.model;
  if (entry.ultracode) resumeOpts.ultracode = true;
  if (entry.effort) resumeOpts.effort = entry.effort;
  if (entry.harness) resumeOpts.harness = entry.harness;
  const resumeCmd = entry.worktreePath && entry.branchName && projectInfo
    ? (resumeOpts.trellisRelativePath || resumeOpts.model || resumeOpts.ultracode || resumeOpts.effort || resumeOpts.harness
        ? buildWorktreeResumeCommand(
            projectName, projectInfo.path, entry.name, entry.branchName,
            entry.sessionId, baseBranch, resumeOpts,
          )
        : buildWorktreeResumeCommand(
            projectName, projectInfo.path, entry.name, entry.branchName,
            entry.sessionId, baseBranch,
          ))
    : buildResumeCommand(
        projectName,
        projectInfo?.path ?? entry.worktreePath ?? "",
        entry.sessionId,
      );

  // Resolve the post-resume status from the pre-bounce entry, before we
  // overwrite it. resolveResumeAgentStatus returns "ready" exactly for an
  // interrupted (mid-turn) worker — which is both the cold-start sentinel the
  // continue-retry watches and the signal to auto-send a continue below.
  const resumeStatus = resolveResumeAgentStatus(entry);
  const wasWorking = resumeStatus === "ready";

  const cwd = entry.worktreePath ?? projectInfo?.path;
  const respawnArgs = ["respawn-pane", "-k"];
  if (cwd) respawnArgs.push("-c", cwd);
  respawnArgs.push("-t", paneId, "sh", "-c", resumeCmd);
  tmux(...respawnArgs);

  // SessionStart fires on --resume (source="resume") but the hook now preserves
  // the status we write here (see hooks/default.ts) instead of resetting it, so
  // this write is authoritative. A bounced-while-working worker is parked at the
  // "ready" cold-start sentinel; an already-idle worker never becomes "ready".
  updateWorkerFields(projectName, workerName, { agentStatus: resumeStatus });

  if (wasWorking) {
    dispatchDelayedContinue(resolveGardenRunner(), projectName, workerName);
  }

  recordOperatorAction(projectName, workerName, entry.createdAt, entry.workflow ?? "default", "bounce");
  log.info("workers", "bounced", {
    worker: workerName,
    data: { project: projectName, sessionId: entry.sessionId, wasWorking },
  });

  refreshDashboard();
}

// Bounce the worker whose pane is currently active in the dashboard. Used by
// the ⌥b hotkey. Refuses on the project shell (no session to resume).
export function bounceActiveWorker(): void {
  const state = readDashState();
  if (state.activePaneType !== "worker" || !state.activeProject || !state.activeWindowName) {
    tmuxDisplay("Bounce only works on worker panes.");
    return;
  }
  const workerName = parseWorkerSuffix(state.activeWindowName);
  if (!workerName) {
    tmuxDisplay("Could not identify active worker.");
    return;
  }
  try {
    bounceWorker(state.activeProject, workerName);
    tmuxDisplay(`Bounced ${workerName}.`);
  } catch (err) {
    tmuxDisplay(`Bounce failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Operator "hold": interrupt the worker's current Claude turn and mark it
// `paused`. Unlike every other agentStatus writer (hooks, pane-died), this is
// operator-initiated — a hotkey / CLI keystroke is the event, which is exactly
// as event-driven as a hook firing (STATUS.md invariant 6). There is no hook
// for a user interrupt, so garden cannot observe a raw Escape; the operator
// drives both the interrupt and the state through this one action. The next
// UserPromptSubmit clears paused -> working, so the operator's redirect
// unpauses it for free (the same path that clears merged/done).
export interface HoldDecision {
  ok: boolean;
  // Whether to send Escape to interrupt a live turn. Only working/asking have
  // a turn in flight; idle/ready/loading have nothing to interrupt but can
  // still be marked paused as a deliberate "I'm holding this" signal.
  sendEscape: boolean;
  message: string;
}

export function decideHold(
  entry: { agentStatus?: AgentStatus; prState?: string } | undefined,
  worker: string,
): HoldDecision {
  if (!entry) return { ok: false, sendEscape: false, message: `No worker found with name '${worker}'` };
  // Pipeline lifecycle states own the display and are not the worker's own
  // Claude turn — you can't hold a reviewer/resolver/merge from the worker
  // pane. (merged/done are transient/terminal agent-side states, holdable.)
  const pr = entry.prState;
  if (pr && pr !== "working" && pr !== "merged" && pr !== "done") {
    return { ok: false, sendEscape: false, message: `Cannot hold ${worker}: in ${pr}. Hold only acts on an active worker turn.` };
  }
  const cs = entry.agentStatus;
  if (cs === "exited") return { ok: false, sendEscape: false, message: `Cannot hold ${worker}: its process has exited.` };
  if (cs === "paused") return { ok: false, sendEscape: false, message: `${worker} is already held.` };
  return {
    ok: true,
    sendEscape: cs === "working" || cs === "asking",
    message: `Held ${worker} (interrupted, awaiting your redirect). Prompt it to resume.`,
  };
}

// Apply a hold by name. Returns the decision so callers can surface the
// message. Idempotent: holding an already-held worker is a no-op.
export function holdWorker(project: string, worker: string): HoldDecision {
  const entry = findWorkerByName(project, worker);
  const decision = decideHold(entry, worker);
  if (!decision.ok) return decision;
  if (decision.sendEscape) {
    const paneId = resolveWorkerPaneId(project, worker);
    if (paneId) tmux("send-keys", "-t", paneId, "Escape");
  }
  updateWorkerFields(project, worker, { agentStatus: "paused" });
  refreshDashboard();
  recordOperatorAction(project, worker, entry?.createdAt, entry?.workflow ?? "default", "hold");
  return decision;
}

// Release a held worker back to idle without sending a prompt. The next
// prompt would clear paused anyway (UserPromptSubmit -> working); this is the
// "never mind" escape hatch for the dashboard toggle.
export function releaseWorker(project: string, worker: string): { ok: boolean; message: string } {
  const entry = findWorkerByName(project, worker);
  if (!entry) return { ok: false, message: `No worker found with name '${worker}'` };
  if (entry.agentStatus !== "paused") return { ok: true, message: `${worker} is not held.` };
  updateWorkerFields(project, worker, { agentStatus: "idle" });
  refreshDashboard();
  return { ok: true, message: `Released ${worker}.` };
}

// Dashboard hotkey: toggle hold/release on the focused worker pane. Held ->
// release; anything else -> hold.
export function holdActiveWorker(): void {
  const state = readDashState();
  if (state.activePaneType !== "worker" || !state.activeProject || !state.activeWindowName) {
    tmuxDisplay("Hold only works on worker panes.");
    return;
  }
  const workerName = parseWorkerSuffix(state.activeWindowName);
  if (!workerName) {
    tmuxDisplay("Could not identify active worker.");
    return;
  }
  const entry = findWorkerByName(state.activeProject, workerName);
  const result = entry?.agentStatus === "paused"
    ? releaseWorker(state.activeProject, workerName)
    : holdWorker(state.activeProject, workerName);
  tmuxDisplay(result.message);
}

function resolveWorkerPaneId(project: string, worker: string): string | null {
  const windowName = workerWin(project, worker);
  const state = readDashState();
  if (state.activeWindowName === windowName && state.activePaneId
      && paneExists(state.activePaneId)) {
    return state.activePaneId;
  }
  if (windowExists(windowName)) {
    return getFirstPaneId(`${DASHBOARD_SESSION}:${windowName}`);
  }
  return null;
}

function backgroundGitCleanup(
  repoPath: string,
  wtPath: string | undefined,
  branchName: string | undefined,
): void {
  const parts: string[] = [];
  if (wtPath) {
    parts.push(`git -C ${shellEscape(repoPath)} worktree remove ${shellEscape(wtPath)} --force`);
  }
  if (branchName) {
    parts.push(`git -C ${shellEscape(repoPath)} branch -D ${shellEscape(branchName)}`);
    parts.push(
      `git -C ${shellEscape(repoPath)} ls-remote --heads origin ${shellEscape(branchName)}`
      + ` | grep -q . && git -C ${shellEscape(repoPath)} push origin --delete ${shellEscape(branchName)}`,
    );
  }
  if (parts.length === 0) return;
  const script = parts.map(p => `(${p}) 2>/dev/null || true`).join("; ");
  const child = spawn("sh", ["-c", script], { detached: true, stdio: "ignore" });
  child.unref();
}

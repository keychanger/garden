// Worker lifecycle: creation and destruction of Claude worker sessions.
import path from "node:path";
import fs from "node:fs";
import { DASHBOARD_SESSION } from "../session.js";
import { getProject, tryGetProject, loadConfig, plotsMap, type ProjectConfig } from "../config.js";
import {
  syncProviderTokenToVault, providerTokenPresence, tmuxWorkerCommand,
} from "./claude-env.js";
import { readDashState, writeDashState, withStateLock } from "./state.js";
import { parkToHidden, restoreFromHidden } from "./layout.js";
import { healActivePaneInState } from "./validate.js";
import { refreshDashboard, setPaneProjectColor } from "./header.js";
import {
  tmux, tmuxDisplay, newDashboardWindowPaned, setPaneLabel, setPaneVar, shellEscape,
  getFirstPaneId, paneExists, windowExists,
  listHiddenWorkerWindows, killWindowSafe,
  getPaneSize, resizeWindow,
} from "./tmux.js";
import { generateWorkerName } from "./names.js";
import {
  addWorkerWithUniqueName, removeWorker, findWorkerByName,
  updateWorkerFields, getWorkers, resolveResumeAgentStatus, compareWorkerFreshness,
  type AgentStatus, type WorkerEntry,
} from "./registry.js";
import { recordWorkerCreated, recordOperatorAction, recordWorkerRemoved, shortHash, type RoleSnapshot } from "./telemetry.js";
import { deriveCrew, getCrew, resolveProjectCrew } from "./crew.js";
import { resolveReviewRole, type ReviewRole } from "./roles.js";
import { buildRulesContext } from "../rules.js";
import { GARDEN_VERSION } from "../version.js";
import { log } from "./log.js";
import { resolveAndApplyVineModel } from "./trellis-model.js";
import { getWorkflow } from "./workflows/index.js";
import {
  buildWorktreeBootstrapScript, buildWorktreeResumeCommand, buildResumeCommand,
  buildWorktreeContextText, createShellWindow, trellisRelativePathForEntry,
  type WorktreeCommandOptions,
} from "./create.js";
import { getHarness } from "./harness/index.js";
import { initialCodexActivity } from "./harness/codex-core.js";
import {
  canonicalHarnessName,
} from "./harness/core.js";
import { resolveWorkerLaunchPlan } from "./launch-plan.js";
import type { WorkerLaunchPlan } from "./harness/types.js";
import { resolveGardenRunner } from "./runner.js";
import {
  worktreePath, resolveBaseBranch, resolveSpawnBase, branchExistsOnOrigin, tryPublishBranch,
  gardenDoneTrackedInHead, getRemoteTrackingSha, localBranchExists,
} from "./git.js";
import { writeWorkerCleanupRequest, dispatchWorkerCleanup } from "./worker-cleanup.js";
import { captureAncestorPids } from "./worker-reap.js";
import { addAlert } from "./alerts.js";
import { showBeads, reopenBead, unassignBead } from "./beads.js";
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
  // claude-code. "codex" spawns a Codex worker (own sandbox, launch-time hook
  // relay, AGENTS.md rules). Validated against the registry; an unknown
  // harness is refused. Persisted on entry.harness and threaded through
  // launch/resume/loop.
  harness?: string;
  // Per-worker provider backend, the axis-1 half of a build member (the
  // `harness` sibling). Set when the chosen member carries a provider
  // (`deepseek` → claude-code against that endpoint). Naming a member is a
  // statement about BOTH halves, so passing `harness` with no `provider` means
  // first-party — it does not inherit the project's provider. Absent entirely
  // (no member named) keeps the project key. Validated against the configured
  // providers and persisted to entry.provider. Default workflow only, like
  // `harness`.
  provider?: string;
  // Per-worker base-branch override (`workers new --base`). Takes precedence
  // over the project's configured baseBranch and the checkout-follows default
  // (see resolveSpawnBase). Validated + published through the same
  // branchExistsOnOrigin / tryPublishBranch chain as any resolved base, then
  // pinned to entry.baseBranch.
  base?: string;
  // Per-worker crew (`workers new --crew`). Sets BOTH halves at spawn: the
  // build member — harness AND provider, mutually exclusive with --harness —
  // and the review family (stamped on entry.crew, applied live by
  // resolveReviewRole). Default workflow only, like --harness.
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
  // Per-worker reasoning effort for default/grow workers. Persisted to
  // entry.effort and rendered by the target harness's adapter. The value is in
  // the HARNESS's vocabulary, not one global ladder: claude-code takes
  // WORKER_EFFORT_LEVELS (low/medium/high/xhigh) and renders `--effort <level>`,
  // with the top rung "ultra" expressed via `ultracode` rather than here (a
  // caller must not set both); codex takes its own reasoning levels
  // (CODEX_EFFORT_LEVELS, which include a genuine "ultra" unrelated to the
  // ultracode preset) and renders `-c model_reasoning_effort=<level>`. Stored
  // opaquely — the composer and the CLI each validate against the ladder the
  // chosen harness actually accepts. Ignored for trellis vines.
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
  // Durable identity of the request-file IPC operation that created this
  // worker. The dispatcher uses it to reconcile an abandoned claim after a
  // crash without spawning the same handoff twice.
  handoffRequestId?: string;
  // Bead id this worker builds (WorkerEntry.bead). Set by the intake
  // dispatcher and by `garden handoff --bead` so both share this one write
  // path. Stamping makes NO bd claim — intake claims after the spawn
  // returns, and a handoff worker's own briefed claim is the claim.
  bead?: string;
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
  const initialState = readDashState();
  const targetProject = opts.projectName ?? initialState.activeProject;
  if (!targetProject) {
    tmuxDisplay("No project selected. Use ⌥1-⌥9 first.");
    return null;
  }

  const project = tryGetProject(targetProject);
  if (!project) {
    tmuxDisplay(`Unknown project '${targetProject}'.`);
    return null;
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
  // --harness mutually exclusive; a provider-backed worker member is accepted,
  // its backend riding entry.provider (see the provider block below). The
  // crew's REVIEW half rides entry.crew (stamped below) and is applied live by
  // resolveReviewRole.
  //
  // Beneath all of that sits the PROJECT's bound crew (project.crew), read by
  // reference so editing the definition re-targets the project: flat
  // project.harness still wins over it (the override layer), and it applies
  // on the default workflow only, exactly like project.harness.
  // Each crew dimension is gated exactly like the flat project key it sits
  // beneath: harness is default-workflow-only (like project.harness), while
  // model/effort follow project.model/effort (default+grow).
  const gardenConfig = loadConfig();
  const projectCrew = resolveProjectCrew(project, gardenConfig);
  const workerCrew = opts.crew ? getCrew(opts.crew, gardenConfig) : null;
  const projectHarness = workflowName === "default"
    ? (project.harness ?? projectCrew?.worker.harness)
    : undefined;
  let rawHarness: string | undefined;
  if (opts.harness) {
    rawHarness = opts.harness;
  } else if (opts.crew) {
    rawHarness = workerCrew?.worker.harness ?? projectHarness;
  } else {
    rawHarness = projectHarness;
  }

  // Worker PROVIDER resolution (axis 1), the sibling of the harness block
  // above. A build member is a (harness, provider) PAIR, so naming one is a
  // statement about both halves: `--harness claude` on a provider-backed
  // project means first-party claude, and staging the `deepseek` member means
  // claude-code against that backend. Without the pair semantics the composer
  // would have to lie — it would show `[claude]` for a worker that in fact
  // launches against the project's provider, and there would be no way to
  // spell "first-party" on such a project at all.
  //
  // Precedence therefore mirrors harness exactly: an explicit per-worker
  // member (opts.provider alongside opts.harness) > the per-worker crew's
  // worker half > the project key > the project's bound crew. The one
  // asymmetry is the default-workflow gate: harness is default-only, and a
  // provider rides with it, so a trellis/grow vine keeps the project's
  // provider whatever member was named.
  const projectProvider = project.provider ?? projectCrew?.worker.provider;
  // Was a build member named for THIS worker at all? Only then does the pair
  // rule apply; otherwise the project key answers, exactly as before.
  const memberNamed = workflowName === "default"
    && Boolean(opts.harness || opts.provider || (opts.crew && workerCrew));
  const namedProvider = opts.harness || opts.provider
    ? opts.provider
    : workerCrew?.worker.provider;
  // The provider this worker actually launches against.
  const rawProvider = memberNamed ? namedProvider : projectProvider;
  // What gets PERSISTED. A named member is recorded even when its provider is
  // absent, because "explicitly first-party" is a real answer that must
  // survive to launch: entry.provider absent means "inherit the project", so
  // a bare omission here would silently hand a provider-backed project's
  // backend to a worker whose member said claude. The empty string is that
  // explicit-first-party marker (the same clear-by-empty idiom the spawn
  // draft uses); resolveWorkerLaunchPlan is the decoder.
  // A provider supplied by the project's bound crew must also be pinned: the
  // project itself has no provider key for resume/bounce to inherit, and crew
  // definitions are intentionally resolved only at spawn time for the worker
  // half. Without the pin, the first launch uses the crew backend but the next
  // resume silently switches to first-party credentials.
  const providerStamp = memberNamed
    ? (namedProvider ?? "")
    : project.provider === undefined
      ? projectCrew?.worker.provider
      : undefined;
  // Validate a per-worker override before stamping: the operator named a
  // backend, so a name that resolves to nothing must fail loudly here rather
  // than silently launching first-party and billing the wrong pool. Scoped to
  // the named member deliberately; the structured launch-plan resolver below
  // validates inherited project and project-crew providers as well.
  const providerOverride = memberNamed ? namedProvider : undefined;
  if (providerOverride && !gardenConfig.providers?.[providerOverride]) {
    const known = Object.keys(gardenConfig.providers ?? {});
    tmuxDisplay(`Unknown provider '${providerOverride}'.${known.length ? ` Known: ${known.join(", ")}.` : " None configured."}`);
    log.error("workers", "rejected newWorker: unknown provider", {
      data: { project: targetProject, provider: providerOverride },
    });
    return null;
  }
  // Canonicalize the operator-facing "claude" alias to the registry name.
  // This is the chokepoint every worker-creation path funnels through (CLI
  // --harness, the workflow picker, the project default), so the stamped
  // entry.harness is always a registry name.
  const resolvedHarness = rawHarness === undefined ? undefined : canonicalHarnessName(rawHarness);
  let preflightPlan: WorkerLaunchPlan;
  try {
    preflightPlan = resolveWorkerLaunchPlan({
      project: { ...project, provider: rawProvider },
      harness: resolvedHarness,
      workflow: workflowName,
      resume: false,
    }, gardenConfig);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    tmuxDisplay(error);
    log.error("workers", "rejected newWorker: invalid launch plan", {
      data: {
        project: targetProject,
        harness: resolvedHarness ?? "claude-code",
        workflow: workflowName,
        provider: rawProvider ?? null,
        error,
      },
    });
    return null;
  }

  // Provider preflight: retain the key in tmux's hidden launch vault
  // (best-effort from this operator-shell invocation) and refuse to spawn a
  // worker without it. An unauthenticated worker fails opaquely at first
  // inference, far from the cause.
  // Resolved against the worker's OWN provider (which may differ from the
  // project's, or be absent where the project has one), so the token check
  // describes the endpoint this worker will actually reach.
  const workerProvider = preflightPlan.resolvedProvider;
  if (workerProvider) {
    syncProviderTokenToVault(workerProvider);
    const presence = providerTokenPresence(workerProvider);
    if (!presence.shell && presence.session !== true) {
      tmuxDisplay(`Provider '${workerProvider.name}' requires $${workerProvider.authTokenEnv} — not set in this shell or the scoped worker vault.`);
      log.error("workers", "rejected newWorker: provider token env var unset", {
        data: {
          project: targetProject,
          provider: workerProvider.name,
          envVar: workerProvider.authTokenEnv,
        },
      });
      return null;
    }
  }

  // --workflow trellis without opts.trellis is a bug — the CLI must
  // surface this with a clear error before we add the worker.
  if (opts.workflow === "trellis" && !opts.trellis) {
    tmuxDisplay("--workflow trellis requires the trellis options to be set (caller bug).");
    log.error("workers", "rejected newWorker: workflow=trellis but no trellis opts", {
      data: { project: targetProject },
    });
    return null;
  }
  // --workflow grow without opts.grow is the same caller bug.
  if (opts.workflow === "grow" && !opts.grow) {
    tmuxDisplay("--workflow grow requires the grow options to be set (caller bug).");
    log.error("workers", "rejected newWorker: workflow=grow but no grow opts", {
      data: { project: targetProject },
    });
    return null;
  }

  const background = opts.background ?? false;

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
        data: { project: targetProject, baseBranch, error: result.error },
      });
      return null;
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
  // Project-level model/effort defaults (config.ts ProjectConfig.model /
  // .effort) sit one layer beneath the per-spawn opts, exactly as
  // resolveSpawnBase layers project.baseBranch beneath --base: per-spawn
  // opts win, the project default fills the gap, the account/provider default
  // is the floor. They apply to default+grow only — trellis resolves its own
  // model per iteration and carries no effort, so it never consults them.
  const projectDefaultsApply = workflowName === "default" || workflowName === "grow";
  // The project effort default may itself be "ultra" (the ultracode preset).
  // A per-spawn effort/ultracode gesture wins; otherwise the project default
  // fills in, and "ultra" there means the preset just as `--effort ultra`
  // does at the CLI.
  //
  // A crew's worker half supplies both dims one layer down from the flat
  // project key: per-worker crew (--crew) above the project key, the
  // project's bound crew below it.
  const crewEffort = projectDefaultsApply
    ? (workerCrew?.worker.effort ?? project.effort ?? projectCrew?.worker.effort)
    : undefined;
  let reqUltracode = opts.ultracode === true;
  let reqEffort = opts.effort;
  if (!reqUltracode && reqEffort === undefined && crewEffort) {
    if (crewEffort === "ultra") reqUltracode = true;
    else reqEffort = crewEffort;
  }
  const projectModel = projectDefaultsApply
    ? (workerCrew?.worker.model ?? project.model ?? projectCrew?.worker.model)
    : undefined;
  // Workflow-level model/effort defaults (the designer/planner seats → Opus /
  // xhigh) sit one layer beneath the per-spawn and project defaults, mirroring
  // how trellis reads workflow.workerModel per iteration. Not applied for
  // trellis, which resolves its own model per iteration and carries no effort.
  const workflowDef = getWorkflow(workflowName);
  const workflowModelDefault = workflowName !== "trellis" ? workflowDef.workerModel : undefined;
  const workflowEffortDefault = workflowName !== "trellis" ? workflowDef.workerEffort : undefined;

  const ultracode = reqUltracode && workflowName !== "trellis";
  // Model precedence: per-spawn --model > the ultracode preset's Opus pin
  // (an explicit per-spawn gesture, more specific than a project default) >
  // project.model > the workflow's own default (designer Opus) > account/
  // provider default.
  const effectiveModel = ultracode
    ? (opts.model ?? ULTRACODE_MODEL)
    : (opts.model ?? projectModel ?? workflowModelDefault);
  // Per-worker effort rung for default/grow/designer. Suppressed for trellis
  // (own model resolution) and when ultracode is set (that preset already
  // fixes max effort — the composer/CLI keep them mutually exclusive, this is
  // defense-in-depth so a caller passing both never double-sets effort). The
  // workflow default (designer xhigh) fills in when no per-spawn/project rung
  // was requested.
  const effectiveEffort = !ultracode && workflowName !== "trellis"
    ? (reqEffort ?? workflowEffortDefault)
    : undefined;
  // origin/<baseBranch> tip at creation — the `from` endpoint of the
  // whole-task cumulative diff a later holistic review computes. Captured
  // here (after the publish gesture guarantees the ref exists) because the
  // base advances as this and sibling workers merge, so it cannot be
  // reconstructed reliably afterward.
  const baseBranchSha = getRemoteTrackingSha(project.path, baseBranch) ?? undefined;
  let initialTask = "";
  if (preflightPlan.harness === "codex") {
    let seed: string | undefined;
    if (opts.seedMessageFile) {
      try {
        seed = fs.readFileSync(opts.seedMessageFile, "utf8");
      } catch { /* seed dispatch reports unreadable files on its own path */ }
    }
    initialTask = initialCodexActivity(seed);
  }
  // Name allocation and insertion share one locked registry snapshot, so two
  // concurrent ⌥n presses can never mint the same worker name.
  const createdEntry = addWorkerWithUniqueName(targetProject, existingNames => {
    const workerName = generateWorkerName(existingNames);
    // Session identity is harness-shaped (Claude Code accepts a minted
    // UUID; Codex assigns its own id post-launch, so its adapter returns the
    // empty sentinel — recovered from the hook payload later).
    const sessionId = getHarness(preflightPlan.harness).allocateSessionId();
    const branchName = workerName;
    const wtPath = worktreePath(targetProject, workerName);
    return {
      name: workerName,
      sessionId,
      task: initialTask,
      worktreePath: wtPath,
      branchName,
      baseBranch,
      ...(baseBranchSha ? { baseBranchSha } : {}),
      agentStatus: "loading",
      createdAt: Date.now(),
      workflow: workflowName,
      ...(opts.handoffRequestId ? { handoffRequestId: opts.handoffRequestId } : {}),
      // Bead↔worker join (registry→bd half). See NewWorkerOptions.bead.
      ...(opts.bead ? { bead: opts.bead } : {}),
      // Harness adapter (agent CLI). Absent = claude-code; consumers read via
      // getHarness(entry.harness). Threaded into launch/resume/loop.
      ...(resolvedHarness ? { harness: resolvedHarness } : {}),
      // Durable provider backend (the member's axis-1 half). Absent = the
      // project's flat provider key applies; project-crew providers are pinned
      // because no flat key exists for later resume paths to inherit.
      ...(providerStamp !== undefined ? { provider: providerStamp } : {}),
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
    } satisfies WorkerEntry;
  });
  const {
    name: workerName,
    sessionId,
    branchName,
    worktreePath: wtPath,
    createdAt,
  } = createdEntry;

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
        // Pre-work rollback: no bd claim can exist yet, so raw removeWorker
        // (not the finalizeWorkerRemoval bead-unclaim tail) is deliberate.
        removeWorker(targetProject, workerName);
        tmuxDisplay(
          `Cannot plant vine: Sonnet exhausted and trellisOpusFallback=false. ` +
          `Wait for the Sonnet meter to reset, run 'garden auto on', or ` +
          `set 'garden config ${targetProject} trellisOpusFallback true'.`,
        );
        return null;
      }
      resolvedModel = m;
    }
  }

  const launchPlan: WorkerLaunchPlan = {
    ...preflightPlan,
    model: resolvedModel ?? preflightPlan.model,
    ultracode: ultracode || undefined,
    effort: effectiveEffort ?? preflightPlan.effort,
  };

  // Write the bootstrap script that handles slow setup (git fetch, worktree
  // creation, npm install) inside the tmux pane so the window appears instantly
  // with progress output instead of blocking the hotkey handler. Every
  // production spawn carries the resolved launch plan through this boundary.
  const bootstrapOpts: WorktreeCommandOptions = { launchPlan };
  if (trellisRelativePath) bootstrapOpts.trellisRelativePath = trellisRelativePath;
  if (workflowName === "designer") bootstrapOpts.designer = true;
  if (workflowName === "planner") bootstrapOpts.planner = true;
  const scriptFile = buildWorktreeBootstrapScript(
    project.name, project.path, workerName, branchName, sessionId, wtPath, baseBranch,
    bootstrapOpts,
  );

  const workerWindowName = workerWin(targetProject, workerName);
  // A generated name can outlive its registry entry when an older cleanup
  // failed. This spawn does not own such a worktree/branch yet, so a rollback
  // must not delete it merely because pane creation failed before bootstrap.
  const preexistingWorktree = fs.existsSync(wtPath);
  const preexistingBranch = localBranchExists(project.path, branchName)
    || branchExistsOnOrigin(project.path, branchName);

  let stateForRefresh = initialState;
  const bootstrapCmd = `sh ${shellEscape(scriptFile)}`;
  try {
    // Both branches below spawn the bootstrap shell only after the window is
    // sized to the right slot. Otherwise the new window comes up at tmux's
    // default (typically 80×24, sometimes narrower), Claude's TUI does its
    // first paint into that small grid, and those hard-wrapped lines stay
    // frozen in scrollback forever. The placeholder/respawn-pane dance closes
    // that race: create window holding a long sleep, resize, then respawn-pane
    // with the real script in a correctly-sized grid. NOTE: `sleep infinity` is
    // a GNU coreutils-ism and exits 1 on macOS BSD sleep ("usage: sleep
    // seconds"), which destroyed the placeholder pane before respawn-pane could
    // land. Use a finite large value — respawn replaces it in ms.
    if (background) {
      // Hidden creation only — no park, no restore, and no state lock: the
      // window is born detached and stays detached, so none of the operator's
      // visible pane state is touched.
      const rightSize = initialState.activePaneId
        ? getPaneSize(initialState.activePaneId)
        : null;
      const workerPaneId = newDashboardWindowPaned(workerWindowName, "-c", project.path,
        "sh", "-c", "exec sleep 86400");
      if (rightSize) resizeWindow(workerWindowName, rightSize.width, rightSize.height);
      tmuxWorkerCommand(
        launchPlan,
        "respawn-pane", "-k", "-c", project.path, "-t", workerPaneId, "sh", "-c", bootstrapCmd,
      );
      if (workerPaneId) {
        setPaneLabel(workerPaneId, workerName);
        setPaneVar(workerPaneId, "garden_clock", "1");
        setPaneProjectColor(workerPaneId, targetProject);
      }
    } else {
      // Show the new pane immediately — bootstrap runs inside it. Only the
      // visible-state mutations (project/plot switch, park, restore, final
      // write) need the state lock; everything slow or failure-prone already
      // finished above, so the lock is held for tmux calls alone.
      withStateLock(() => {
        const state = readDashState();
        if (targetProject !== state.activeProject) {
          const plots = plotsMap(gardenConfig);
          const activePlotProjects = state.activePlot && plots[state.activePlot]
            ? plots[state.activePlot].projects
            : [];
          if (!activePlotProjects.includes(targetProject)) {
            for (const [plotName, plot] of Object.entries(plots)) {
              if (plot.projects.includes(targetProject)) {
                state.activePlot = plotName;
                break;
              }
            }
          }
          swapVisibleToProject(targetProject, project, state);
        }

        const rightSize = state.activePaneId ? getPaneSize(state.activePaneId) : null;
        const parkName = state.activeWindowName ?? parkingWindowName(state.activeProject!);
        parkToHidden(parkName, state);

        const workerPaneId = newDashboardWindowPaned(workerWindowName, "-c", project.path,
          "sh", "-c", "exec sleep 86400");
        if (rightSize) resizeWindow(workerWindowName, rightSize.width, rightSize.height);
        tmuxWorkerCommand(
          launchPlan,
          "respawn-pane", "-k", "-c", project.path, "-t", workerPaneId, "sh", "-c", bootstrapCmd,
        );
        if (workerPaneId) setPaneLabel(workerPaneId, workerName);
        restoreFromHidden(workerWindowName, state);
        // Re-apply label after swap (swap-pane may not preserve pane options)
        if (state.activePaneId) {
          setPaneLabel(state.activePaneId, workerName);
          setPaneVar(state.activePaneId, "garden_clock", "1");
          setPaneProjectColor(state.activePaneId, targetProject);
        }
        state.activePaneType = "worker";
        state.activeWindowName = workerWindowName;
        state.lastActiveWorker[targetProject] = workerWindowName;
        writeDashState(state);
        stateForRefresh = state;
      });
    }
  } catch (err) {
    // addWorker (and trellis model resolution) already wrote the registry
    // entry; if pane creation fails it would otherwise sit in agentStatus=
    // "loading" forever with no pane. Roll back so the next attempt isn't
    // blocked by name collision and the dashboard isn't lying about pending
    // workers.
    // Pre-work rollback: a stamped `bead` field may exist, but no bd claim
    // does (intake claims only after newWorker returns; a handoff worker's
    // claim is its own first action), so raw removeWorker without the
    // finalizeWorkerRemoval bead-unclaim tail is deliberate.
    //
    // Unlike the trellis-model rollback above, this one can NOT assume "no
    // worktree created". The bootstrap script (git fetch, worktree add, npm
    // install) runs inside the pane, so once respawn-pane has handed it off
    // it is already running detached — a throw from any later step leaves it
    // alive, and it goes on to build the worktree for an entry that no longer
    // exists. Three such spawns leaked 1.5GB of unowned worktrees (plus two
    // live windows the watchdog then alerted on hourly) on 2026-08-24, when a
    // stale right-pane id failed every swap-pane across two projects.
    //
    // Order is load-bearing: kill the window FIRST so the bootstrap is dead
    // before cleanup runs. Cleaning up first would race the surviving script
    // into re-creating the tree we just removed. The cleanup request is then
    // written unconditionally rather than gated on the worktree existing —
    // the bootstrap may not have got that far, and every cleanup step skips a
    // target that is already gone, so the no-op case is free while the
    // partially-created case (worktree metadata but no checkout, or the
    // reverse) is exactly what its remove + prune + branch -D sequence and
    // the watchdog's retry are built to finish. Targets that predated this
    // spawn are excluded: they may be the only surviving copy of an older
    // worker's unmerged work, and this attempt never owned them.
    killWindowSafe(workerWindowName);
    removeWorker(targetProject, workerName);
    backgroundGitCleanup(
      targetProject,
      workerName,
      project.path,
      preexistingWorktree ? undefined : wtPath,
      preexistingBranch ? undefined : branchName,
    );
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
      provider: rawProvider ?? null,
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

  refreshDashboard({ state: stateForRefresh });

  if (opts.seedMessageFile) {
    dispatchDelayedSeed(gardenRunner, targetProject, workerName, opts.seedMessageFile);
  }

  return workerName;
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

interface WorkerRemovalTarget {
  projectName: string;
  workerName: string;
}

export function killPane(target?: WorkerRemovalTarget): void {
  // The removal target is captured inside the state lock and finalized after
  // it releases: finalizeWorkerRemoval shells out to bd for the removal-time
  // bead unclaim (up to ~20s per call) and must never run while the dashboard
  // state lock is held.
  let removalProject: string | undefined;
  let removalWorker: string | undefined;
  let removalEntry: WorkerEntry | null = null;
  let didKill = false;

  withStateLock(() => {
    const state = readDashState();

    if (target) {
      const targetWindow = workerWin(target.projectName, target.workerName);
      const targetIsLiveActivePane = state.activeProject === target.projectName
        && state.activePaneType === "worker"
        && state.activeWindowName === targetWindow
        && state.activePaneId !== null
        && paneExists(state.activePaneId);
      if (!targetIsLiveActivePane) {
        killWindowSafe(targetWindow);
        if (state.lastActiveWorker[target.projectName] === targetWindow) {
          delete state.lastActiveWorker[target.projectName];
        }
        removalProject = target.projectName;
        removalWorker = target.workerName;
        removalEntry = findWorkerByName(target.projectName, target.workerName) ?? null;
        log.info("workers", "kill: removed a window outside the right slot", {
          worker: target.workerName,
          data: { project: target.projectName, window: targetWindow },
        });
        // This branch also handles a target whose visible pane already died.
        // Repair that slot before persisting the stale id back to state.
        writeDashState(healActivePaneInState(state));
        didKill = true;
        return;
      }
    }

    if (state.activePaneType === "shell") {
      tmuxDisplay("Cannot kill project shell. Use ⌥x on workers only.");
      return;
    }

    // A dead active pane is the slot itself failing, not a worker to kill.
    // Repair it before refusing so the operator's kill shortcut can recover
    // the dashboard without removing a worker that is still registered.
    const slotHealed = healActivePaneInState(state);
    if (slotHealed !== state) {
      writeDashState(slotHealed);
      log.warn("workers", "kill: right slot was gone, repaired it instead", {
        data: { project: state.activeProject, paneId: slotHealed.activePaneId },
      });
      tmuxDisplay("Right pane was gone — restored it. Press ⌥x again to kill a worker.");
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
        log.info("workers", "kill: swapped a sibling worker into the right slot", {
          worker: parseWorkerSuffix(killedWindowName ?? "") ?? undefined,
          data: { project: state.activeProject, killed: killedWindowName, replacement: targetWindow },
        });
      } else {
        log.warn("workers", "kill: replacement window has no pane; right slot left as-is", {
          data: { project: state.activeProject, replacement: targetWindow },
        });
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
        log.info("workers", "kill: swapped the project shell into the right slot", {
          worker: parseWorkerSuffix(killedWindowName ?? "") ?? undefined,
          data: { project: state.activeProject, killed: killedWindowName },
        });
      } else {
        log.warn("workers", "kill: project shell has no pane; right slot left as-is", {
          data: { project: state.activeProject, shell: shellTarget },
        });
      }
    }

    if (killedWindowName && state.activeProject) {
      if (state.lastActiveWorker[state.activeProject] === killedWindowName) {
        delete state.lastActiveWorker[state.activeProject];
      }
      const killedWorkerName = parseWorkerSuffix(killedWindowName);
      if (killedWorkerName) {
        removalProject = state.activeProject;
        removalWorker = killedWorkerName;
        removalEntry = findWorkerByName(state.activeProject, killedWorkerName) ?? null;
      }
    }

    writeDashState(state);
    didKill = true;
  });

  if (!didKill) return;
  if (removalProject && removalWorker) {
    finalizeWorkerRemoval(removalProject, removalWorker, removalEntry);
  }
  refreshDashboard();
}

// Shared removal tail — every operator removal path (the dashboard ⌥x kill in
// killPane above, `garden workers stop` via stopWorkerByName below) funnels
// through this one function so the tombstone and the Decision-12 bead unclaim
// exist in exactly one place. Runs OUTSIDE the dashboard state lock: the
// unclaim shells out to bd (up to ~20s per call under store-lock retries) and
// must not freeze the dashboard. The pre-work rollback removal sites
// (trellis-model refusal, tmux spawn failure, bootstrap aborts) deliberately
// stay on raw removeWorker — no bd claim exists there to unclaim.
export function finalizeWorkerRemoval(
  projectName: string,
  workerName: string,
  entry: WorkerEntry | null,
): void {
  const project = tryGetProject(projectName);

  killReviewWindow(projectName, workerName);
  if (entry) {
    recordWorkerRemoved(
      projectName, workerName, entry.createdAt,
      entry.workflow ?? "default", { ...entry },
    );
    // Decision-12 unclaim runs BEFORE removeWorker: if it crashes mid-write,
    // the registry entry (and its bead join) is still on disk for a retry,
    // instead of a hard-deleted entry orphaning an in_progress bead.
    unclaimBeadOnRemoval(projectName, project, entry);
  }
  removeWorker(projectName, workerName);
  log.info("workers", "killed", {
    worker: workerName,
    data: { project: projectName, branch: entry?.branchName },
  });

  const remaining = getWorkers(projectName);
  if (remaining.length === 0 && project?.beadIntake !== true) {
    stopProjectPoller(projectName);
  }

  if (entry && project) {
    backgroundGitCleanup(
      projectName, workerName, project.path, entry.worktreePath, entry.branchName,
    );
  }
}

// The guarded removal-time unclaim (board docs/DELEGATION.md Decision 12).
// Garden's registry hard-deletes worker entries, and the intake reaper
// deliberately never touches a bead whose assignee has no registry entry — so
// without this, removing a worker orphans its in_progress bead forever. The
// guard: reopen (when in_progress) + unassign ONLY a bead that is still
// open/in_progress AND still assigned to this worker. A closed bead is done
// work; a foreign-assigned bead is the operator's recall claim (or another
// actor's work) — both are left untouched. Failures are never silent: any bd
// read or write failure raises a warn alert naming the bead, because a failed
// unclaim reopens the orphaned-bead hole this exists to close.
function unclaimBeadOnRemoval(
  projectName: string,
  project: (ProjectConfig & { name: string }) | null,
  entry: WorkerEntry,
): void {
  const beadId = entry.bead;
  if (!beadId) return;
  try {
    if (!project) {
      throw new Error(`project '${projectName}' is not registered; no checkout to run bd in`);
    }
    const detail = showBeads(project, [beadId])[0];
    if (!detail) throw new Error(`bd show returned no data for bead ${beadId}`);
    if (detail.status !== "open" && detail.status !== "in_progress") return;
    if (detail.assignee !== entry.name) return;
    if (detail.status === "in_progress"
        && !reopenBead(project, beadId, `garden: worker ${entry.name} removed`)) {
      throw new Error("bd reopen failed");
    }
    if (!unassignBead(project, beadId)) throw new Error("bd assign '' failed");
    log.info("workers", "unclaimed bead on worker removal", {
      worker: entry.name,
      data: { project: projectName, bead: beadId },
    });
  } catch (err) {
    addAlert({
      level: "warn",
      source: "workers",
      project: projectName,
      worker: entry.name,
      message:
        `Bead ${beadId} was not unclaimed when worker '${entry.name}' was removed `
        + `(${err instanceof Error ? err.message : String(err)}). It may still be `
        + `assigned to the removed worker — reopen/unassign it manually.`,
      dedupKey: `bead-unclaim:${projectName}:${beadId}`,
    });
    log.warn("workers", "bead unclaim failed on worker removal", {
      worker: entry.name,
      data: { project: projectName, bead: beadId, error: String(err) },
    });
  }
}

// `garden workers stop <worker>` back end: remove a worker by name — the
// dashboard ⌥x kill, addressed from the CLI. A target holding the visible
// pane routes through killPane (the focus-swap path picks its replacement);
// a parked or hidden target kills its window directly. Both end in the same
// finalizeWorkerRemoval tail (tombstone, Decision-12 bead unclaim, registry
// removal, poller-stop check, background git cleanup).
export function stopWorkerByName(projectName: string, workerName: string): void {
  if (!findWorkerByName(projectName, workerName)) {
    throw new Error(`No worker '${workerName}' in project '${projectName}'.`);
  }
  // Resolve active-vs-parked and kill the requested pane from the same locked
  // state snapshot. A focus change must never retarget this destructive verb.
  killPane({ projectName, workerName });
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

  const launchPlan = resolveWorkerLaunchPlan({
    project: projectInfo ?? { path: entry.worktreePath ?? "" },
    provider: entry.provider,
    harness: entry.harness,
    workflow: entry.workflow ?? "default",
    resume: true,
    model: entry.model,
    ultracode: entry.ultracode,
    effort: entry.effort,
  });

  // Rewrite .claude/settings.json so bounce picks up hook/sandbox
  // changes from a rebuilt garden. buildWorktreeResumeCommand doesn't do
  // this on its own (unlike buildResumeCommand); the attach-time resume
  // path in ensureDashboard() calls it for the same reason.
  // The worker's own backend, so a bounce cannot rewrite the sandbox's egress
  // allowlist back to the project's provider under a worker launching at
  // another (`""` = explicitly first-party — see workerProject).
  const trellisRelativePath = projectInfo
    ? trellisRelativePathForEntry(entry, projectInfo.path)
    : undefined;
  // entry.model carries the default/grow per-worker pin; trellis vines
  // resolve their model per iteration, not on bounce.
  const resumeOpts: WorktreeCommandOptions = { launchPlan };
  if (trellisRelativePath) resumeOpts.trellisRelativePath = trellisRelativePath;
  if (entry.workflow === "grow" && entry.grow) {
    resumeOpts.grow = {
      iteration: entry.grow.iteration ?? 0,
      maxIterations: entry.grow.maxIterations ?? 5,
    };
  }
  if (entry.workflow === "designer") resumeOpts.designer = true;
  if (entry.workflow === "planner") resumeOpts.planner = true;
  if (entry.worktreePath && projectInfo && entry.branchName) {
    getHarness(launchPlan.harness).installRuntimeConfig(
      entry.worktreePath,
      launchPlan.runtimeProject,
      {
        rulesText: buildWorktreeContextText(
          projectName, projectInfo.path, entry.branchName, baseBranch, resumeOpts,
        ),
      },
    );
  }
  const resumeCmd = entry.worktreePath && entry.branchName && projectInfo
    ? buildWorktreeResumeCommand(
        projectName, projectInfo.path, entry.name, entry.branchName,
        entry.sessionId, baseBranch, resumeOpts,
      )
    : buildResumeCommand(
        projectName,
        projectInfo?.path ?? entry.worktreePath ?? "",
        entry.sessionId,
        launchPlan,
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
  tmuxWorkerCommand(
    launchPlan,
    ...respawnArgs,
  );

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

// Hand a removed worker's worktree/branch cleanup to the `_worker-cleanup`
// subcommand, via a request file the watchdog can retry.
//
// This function's caller is whatever process removed the worker, and that is
// not always allowed to write the project checkout: `garden` invoked from
// inside an agent's sandbox can kill the pane and delete the registry entry
// (both land in permitted paths) and then be denied every git step. The old
// implementation composed the git commands inline with `2>/dev/null || true`,
// so that denial produced a leaked worktree and not one byte of diagnostics.
// Writing the request first means a failed fast path is recoverable: the
// watchdog re-dispatches it from its own always-unsandboxed process.
function backgroundGitCleanup(
  project: string,
  worker: string,
  repoPath: string,
  wtPath: string | undefined,
  branchName: string | undefined,
): void {
  if (!wtPath && !branchName) return;
  writeWorkerCleanupRequest({
    project,
    worker,
    repoPath,
    worktreePath: wtPath,
    branchName,
    protectedPids: captureAncestorPids(),
    attempts: 0,
  });
  dispatchWorkerCleanup(resolveGardenRunner(), project, worker);
}

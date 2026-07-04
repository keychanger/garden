// Cross-process handoff IPC: garden CLI runs `garden handoff` from inside a
// Claude Code worker pane, which means the OS sandbox blocks access to the
// tmux server socket. The sandbox lets the worker write to ~/.garden/sessions,
// so handoff drops a request file there and pokes a project poller's FIFO.
// Pollers run in unsandboxed tmux windows and pick up pending requests in
// their poll cycle, calling newWorker — which performs the tmux ops the
// worker could not do itself.
//
// The client side (`submitHandoffRequest` + `waitForHandoffResponse`) and the
// server side (`processPendingHandoffs`) communicate via a pair of JSON files
// per request:
//
//   <id>.req.json  — written by client, atomically claimed by server via rename
//   <id>.resp.json — written by server when newWorker returns
//
// Atomic rename to .processing claims a request so concurrent pollers don't
// double-spawn. Response files are removed by the client after read.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SESSIONS_DIR } from "../config.js";
import { atomicWriteFile } from "./atomic-write.js";
import { newWorker } from "./workers.js";
import { log } from "./log.js";

// Resolved per-call so tests that mutate SESSIONS_DIR after import (see
// test/handoff-dispatch.test.ts) point at fresh tmpdirs. A module-level
// constant captured SESSIONS_DIR's empty initial value before the test's
// beforeEach ran and silently dropped writes into "./handoff-requests".
function requestsDir(): string {
  return path.join(SESSIONS_DIR, "handoff-requests");
}

export interface HandoffRequest {
  id: string;
  targetProject: string;
  seedFile: string;
  createdAt: number;
  // Set when the source worker invoked `garden handoff` with --expect-callback.
  // The child's registry entry inherits these so transitionState can fire a
  // one-shot callback prompt at the parent on the child's first terminal
  // state. parentProject + parentWorker are captured from the source worker's
  // $GARDEN_PROJECT / $GARDEN_WORKER env at submit time; both are required for
  // expectCallback to take effect (an unhealthed handoff invocation outside a
  // worker pane has no parent to call back to).
  expectCallback?: boolean;
  parentProject?: string;
  parentWorker?: string;
  // Set when the source worker invoked `garden handoff --ultracode`. The child
  // is created with the ultracode preset (Opus + max effort + dynamic-workflow
  // trigger). See `NewWorkerOptions.ultracode`.
  ultracode?: boolean;
}

export interface HandoffResponse {
  workerName?: string;
  error?: string;
  completedAt: number;
}

function requestPath(id: string): string {
  return path.join(requestsDir(), `${id}.req.json`);
}

function responsePath(id: string): string {
  return path.join(requestsDir(), `${id}.resp.json`);
}

export function submitHandoffRequest(opts: {
  targetProject: string;
  seedFile: string;
  expectCallback?: boolean;
  parentProject?: string;
  parentWorker?: string;
  ultracode?: boolean;
}): string {
  fs.mkdirSync(requestsDir(), { recursive: true });
  const id = crypto.randomUUID();
  const req: HandoffRequest = {
    id,
    targetProject: opts.targetProject,
    seedFile: opts.seedFile,
    createdAt: Date.now(),
    expectCallback: opts.expectCallback,
    parentProject: opts.parentProject,
    parentWorker: opts.parentWorker,
    ultracode: opts.ultracode,
  };
  atomicWriteFile(requestPath(id), JSON.stringify(req));
  return id;
}

export async function waitForHandoffResponse(
  id: string,
  timeoutMs: number,
): Promise<HandoffResponse | null> {
  const deadline = Date.now() + timeoutMs;
  const respFile = responsePath(id);
  while (Date.now() < deadline) {
    try {
      const data = fs.readFileSync(respFile, "utf8");
      const resp = JSON.parse(data) as HandoffResponse;
      try { fs.unlinkSync(respFile); } catch { /* ignore */ }
      return resp;
    } catch {
      // Not yet written.
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  return null;
}

// Called by the poller loop on every wake. O(pending requests) per cycle;
// usually zero. Safe to call concurrently — atomic-rename claim ensures one
// poller wins each request.
// Shape guard for a worker-authored request file. The request crosses the
// sandbox boundary (a sandboxed worker writes it; the unsandboxed poller acts on
// it), so its fields must be validated before use rather than trusted from
// JSON.parse's `any`.
function isHandoffRequest(x: unknown): x is HandoffRequest {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  return typeof r.id === "string"
    && typeof r.targetProject === "string"
    && typeof r.seedFile === "string"
    && typeof r.createdAt === "number"
    && (r.expectCallback === undefined || typeof r.expectCallback === "boolean")
    && (r.parentProject === undefined || typeof r.parentProject === "string")
    && (r.parentWorker === undefined || typeof r.parentWorker === "string")
    && (r.ultracode === undefined || typeof r.ultracode === "boolean");
}

// The seed file MUST resolve (through symlinks) to inside the handoff seeds
// directory. Without this a worker-authored request could point seedFile at an
// arbitrary path (/etc/…, ~/.ssh/…, a sibling worktree) or a symlink escaping
// the seeds dir, and newWorker would read its contents into the child's first
// prompt — an info-disclosure read across the sandbox boundary.
function seedFileWithinSeedsDir(seedFile: string): boolean {
  const seedsDir = path.join(SESSIONS_DIR, "seeds");
  let realFile: string;
  let realDir: string;
  try {
    realFile = fs.realpathSync(seedFile);
    realDir = fs.realpathSync(seedsDir);
  } catch {
    return false; // missing file / dir, or a dangling symlink
  }
  const rel = path.relative(realDir, realFile);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function processPendingHandoffs(): void {
  const dir = requestsDir();
  if (!fs.existsSync(dir)) return;
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const file of files) {
    if (!file.endsWith(".req.json")) continue;
    const reqFile = path.join(dir, file);
    const claimFile = reqFile + ".processing";
    try {
      fs.renameSync(reqFile, claimFile);
    } catch {
      // Another poller claimed it, or it was withdrawn — move on.
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(claimFile, "utf8"));
    } catch (err) {
      log.error("handoff", "invalid request file", {
        data: { file, error: String(err) },
      });
      try { fs.unlinkSync(claimFile); } catch { /* ignore */ }
      continue;
    }
    if (!isHandoffRequest(parsed)) {
      log.error("handoff", "malformed request file (shape guard rejected)", {
        data: { file },
      });
      try { fs.unlinkSync(claimFile); } catch { /* ignore */ }
      continue;
    }
    const req = parsed;
    if (!seedFileWithinSeedsDir(req.seedFile)) {
      log.error("handoff", "rejected: seedFile escapes the seeds directory", {
        data: { file, targetProject: req.targetProject, seedFile: req.seedFile },
      });
      try { fs.unlinkSync(claimFile); } catch { /* ignore */ }
      continue;
    }

    let response: HandoffResponse;
    try {
      // Only propagate parent linkage when --expect-callback was set AND
      // both env-derived fields are present. A handoff submitted from outside
      // a worker pane has nowhere to call back to; record nothing rather than
      // half-state.
      const handoffCallback = req.expectCallback && req.parentProject && req.parentWorker
        ? {
            parentProject: req.parentProject,
            parentWorker: req.parentWorker,
            expectCallback: true as const,
          }
        : undefined;
      const workerName = newWorker({
        projectName: req.targetProject,
        seedMessageFile: req.seedFile,
        background: true,
        handoffCallback,
        ...(req.ultracode ? { ultracode: true } : {}),
      });
      response = workerName
        ? { workerName, completedAt: Date.now() }
        : {
            error: "newWorker returned null (rejected before pane creation; see dashboard.log)",
            completedAt: Date.now(),
          };
    } catch (err) {
      response = { error: String(err), completedAt: Date.now() };
    }

    try {
      atomicWriteFile(responsePath(req.id), JSON.stringify(response));
    } catch (err) {
      log.error("handoff", "failed to write response", {
        data: { id: req.id, error: String(err) },
      });
    }
    try { fs.unlinkSync(claimFile); } catch { /* ignore */ }

    log.info("handoff", "processed", {
      data: {
        id: req.id,
        project: req.targetProject,
        workerName: response.workerName,
        error: response.error,
      },
    });
  }
}

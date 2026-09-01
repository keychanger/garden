// Cross-process handoff IPC. Sandboxed workers can write the sessions inbox
// but cannot reach tmux, so an unsandboxed poller claims each request into the
// protected control tree and performs the worker spawn.
//
//   sessions/handoff-requests/<id>.req.json   untrusted inbox
//   control/handoff/claims/<id>...processing protected in-flight claim
//   control/handoff/seeds/<id>.txt            protected delayed prompt
//   control/handoff/receipts/<id>.result.json durable result + client response
//
// The filename UUID is authoritative. Request bodies never choose a response
// path. Claims carry a PID and owner token, so another poller can take over a
// dead owner's claim without racing a live dispatcher. A durable request ID on
// WorkerEntry closes the remaining crash window between spawn and receipt.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SESSIONS_DIR } from "../config.js";
import { CONTROL_DIR } from "../paths.js";
import { atomicWriteFile } from "./atomic-write.js";
import { getWorkers } from "./registry.js";
import { newWorker } from "./workers.js";
import { getCrew } from "./crew.js";
import { loadConfig } from "../config.js";
import { log } from "./log.js";

const UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const HANDOFF_ID_RE = new RegExp(`^${UUID_SOURCE}$`, "i");
const REQUEST_FILE_RE = new RegExp(`^(${UUID_SOURCE})\\.req\\.json$`, "i");
const CLAIM_FILE_RE = new RegExp(
  `^(${UUID_SOURCE})\\.req\\.json\\.processing\\.(\\d+)\\.(${UUID_SOURCE})$`,
  "i",
);
const LEGACY_CLAIM_FILE_RE = new RegExp(`^(${UUID_SOURCE})\\.req\\.json\\.processing$`, "i");
const RECEIPT_FILE_RE = new RegExp(`^(${UUID_SOURCE})\\.result\\.json$`, "i");

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RECEIPT_BYTES = 64 * 1024;
const MAX_SEED_BYTES = 1024 * 1024;
const LEGACY_CLAIM_STALE_MS = 120_000;
const RECEIPT_RETENTION_MS = 24 * 60 * 60 * 1000;
const RESPONSE_POLL_MS = 150;

// Every directory below is resolved per-call, never captured in a module-level
// constant: tests mutate SESSIONS_DIR / CONTROL_DIR after import (see
// test/handoff-dispatch.test.ts) to point at fresh tmpdirs. A const would
// capture their empty initial values and silently drop writes into relative
// paths under CWD.
function requestsDir(): string {
  return path.join(SESSIONS_DIR, "handoff-requests");
}

function handoffControlDir(): string {
  return path.join(CONTROL_DIR, "handoff");
}

function claimsDir(): string {
  return path.join(handoffControlDir(), "claims");
}

function protectedSeedsDir(): string {
  return path.join(handoffControlDir(), "seeds");
}

function receiptsDir(): string {
  return path.join(handoffControlDir(), "receipts");
}

function assertHandoffId(id: string): void {
  if (!HANDOFF_ID_RE.test(id)) throw new Error(`Invalid handoff request id: ${id}`);
}

function requestPath(id: string): string {
  assertHandoffId(id);
  return path.join(requestsDir(), `${id}.req.json`);
}

function protectedSeedPath(id: string): string {
  assertHandoffId(id);
  return path.join(protectedSeedsDir(), `${id}.txt`);
}

function receiptPath(id: string): string {
  assertHandoffId(id);
  return path.join(receiptsDir(), `${id}.result.json`);
}

function ownedClaimPath(id: string): string {
  assertHandoffId(id);
  return path.join(
    claimsDir(),
    `${id}.req.json.processing.${process.pid}.${crypto.randomUUID()}`,
  );
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
  // expectCallback to take effect (an invocation outside a worker pane has no
  // parent to call back to).
  expectCallback?: boolean;
  parentProject?: string;
  parentWorker?: string;
  // Set when the source worker invoked `garden handoff --ultracode`. The child
  // is created with the ultracode preset (Opus + max effort + dynamic-workflow
  // trigger). See `NewWorkerOptions.ultracode`.
  ultracode?: boolean;
  // Set when the source worker invoked `garden handoff --crew <name>`, or
  // when it carried a per-worker crew of its own that the CLI forwarded. The
  // child spawns under that crew (its build member and review family). A
  // name only — resolved against garden config at spawn, so the untrusted
  // request can name a crew but not define one. See `NewWorkerOptions.crew`.
  crew?: string;
  // Set when the source worker invoked `garden handoff --bead <id>`. Stamped
  // onto the child's registry entry (the registry→bd bead↔worker join); the
  // dispatch makes no bd claim — the child's own briefed claim is the claim.
  // See `NewWorkerOptions.bead`.
  bead?: string;
}

export interface HandoffResponse {
  workerName?: string;
  error?: string;
  completedAt: number;
}

export function submitHandoffRequest(opts: {
  targetProject: string;
  seedFile: string;
  expectCallback?: boolean;
  parentProject?: string;
  parentWorker?: string;
  ultracode?: boolean;
  crew?: string;
  bead?: string;
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
    crew: opts.crew,
    bead: opts.bead,
  };
  atomicWriteFile(requestPath(id), JSON.stringify(req), { mode: 0o600 });
  return id;
}

// Withdraw only while the request is still in the untrusted inbox. unlink and
// the dispatcher's rename race atomically: exactly one wins. Once claimed, the
// caller must leave the seed in place so crash recovery can still copy it.
export function withdrawPendingHandoffRequest(id: string): boolean {
  try {
    fs.unlinkSync(requestPath(id));
    return true;
  } catch {
    return false;
  }
}

interface StableFile {
  data: Buffer;
  dev: number;
  ino: number;
}

function sameFile(a: Pick<fs.Stats, "dev" | "ino">, b: Pick<fs.Stats, "dev" | "ino">): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function withinDirectory(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

// Read an untrusted file through a pinned descriptor. Containment is checked
// both before and after the read, the final component may not be a symlink or
// hard link, and inode/timestamps must stay stable for the whole operation.
// The returned bytes no longer depend on the worker-writable pathname.
function readStableRegularFile(filePath: string, rootDir: string, maxBytes: number): StableFile | null {
  let fd: number | null = null;
  try {
    const rootBefore = fs.lstatSync(rootDir);
    if (!rootBefore.isDirectory()) return null;
    const realRootBefore = fs.realpathSync(rootDir);
    const realFileBefore = fs.realpathSync(filePath);
    if (!withinDirectory(realRootBefore, realFileBefore)) return null;

    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const before = fs.fstatSync(fd);
    const pathBefore = fs.statSync(filePath);
    if (!before.isFile() || before.nlink !== 1 || !sameFile(before, pathBefore)) return null;
    if (before.size > maxBytes) return null;

    const data = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    const rootAfter = fs.lstatSync(rootDir);
    const realRootAfter = fs.realpathSync(rootDir);
    const realFileAfter = fs.realpathSync(filePath);
    const pathAfter = fs.statSync(filePath);
    if (!rootAfter.isDirectory() || !sameFile(rootBefore, rootAfter)) return null;
    if (realRootAfter !== realRootBefore || !withinDirectory(realRootAfter, realFileAfter)) return null;
    if (!sameFile(before, after) || !sameFile(after, pathAfter)) return null;
    if (before.size !== after.size
        || before.mtimeMs !== after.mtimeMs
        || before.ctimeMs !== after.ctimeMs
        || data.byteLength !== after.size) return null;
    return { data, dev: after.dev, ino: after.ino };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function removeIfSameFile(filePath: string, file: StableFile): void {
  try {
    const current = fs.lstatSync(filePath);
    if (current.isFile() && current.dev === file.dev && current.ino === file.ino) {
      fs.unlinkSync(filePath);
    }
  } catch { /* already gone or replaced */ }
}

function isHandoffResponse(value: unknown): value is HandoffResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const response = value as Record<string, unknown>;
  return Number.isFinite(response.completedAt)
    && (response.workerName === undefined || typeof response.workerName === "string")
    && (response.error === undefined || typeof response.error === "string")
    && (response.workerName !== undefined || response.error !== undefined);
}

export async function waitForHandoffResponse(
  id: string,
  claimTimeoutMs: number,
  processingTimeoutMs = claimTimeoutMs,
): Promise<HandoffResponse | null> {
  assertHandoffId(id);
  const reqFile = requestPath(id);
  let deadline = Date.now() + claimTimeoutMs;
  let claimObserved = false;
  while (Date.now() < deadline) {
    const response = readReceipt(id);
    if (response) return response;
    if (!claimObserved && !fs.existsSync(reqFile)) {
      claimObserved = true;
      deadline = Math.max(deadline, Date.now() + processingTimeoutMs);
    }
    await new Promise(resolve => setTimeout(resolve, RESPONSE_POLL_MS));
  }
  return null;
}

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function validBeadId(value: unknown): value is string {
  return boundedString(value, 128) && !value.startsWith("-");
}

function isHandoffRequest(value: unknown): value is HandoffRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  return boundedString(request.id, 64)
    && HANDOFF_ID_RE.test(request.id)
    && boundedString(request.targetProject, 128)
    && boundedString(request.seedFile, 4096)
    && path.isAbsolute(request.seedFile)
    && Number.isFinite(request.createdAt)
    && (request.expectCallback === undefined || typeof request.expectCallback === "boolean")
    && (request.parentProject === undefined || boundedString(request.parentProject, 128))
    && (request.parentWorker === undefined || boundedString(request.parentWorker, 128))
    && (request.ultracode === undefined || typeof request.ultracode === "boolean")
    && (request.crew === undefined || boundedString(request.crew, 128))
    && (request.bead === undefined || validBeadId(request.bead));
}

function parseJson(data: Buffer): unknown {
  return JSON.parse(data.toString("utf8")) as unknown;
}

function readReceipt(id: string): HandoffResponse | null {
  const file = readStableRegularFile(receiptPath(id), receiptsDir(), MAX_RECEIPT_BYTES);
  if (!file) return null;
  try {
    const parsed = parseJson(file.data);
    return isHandoffResponse(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function persistReceipt(id: string, response: HandoffResponse): void {
  atomicWriteFile(receiptPath(id), JSON.stringify(response), { mode: 0o600 });
}

// The seed MUST resolve (through symlinks) to inside the handoff seeds
// directory. Without that bound a worker-authored request could point seedFile
// at an arbitrary path (/etc/…, ~/.ssh/…, a sibling worktree) and newWorker
// would read its contents into the child's first prompt — an info-disclosure
// read across the sandbox boundary. Copying the validated bytes into the
// control tree is what makes the check stick: the pathname the worker can still
// rewrite is never opened again, so the delayed seed delivery cannot be fed a
// file swapped in after validation.
function protectedSeedFor(request: HandoffRequest): string | null {
  const destination = protectedSeedPath(request.id);
  const existing = readStableRegularFile(destination, protectedSeedsDir(), MAX_SEED_BYTES);
  if (existing) return destination;

  const seedsDir = path.join(SESSIONS_DIR, "seeds");
  const source = readStableRegularFile(request.seedFile, seedsDir, MAX_SEED_BYTES);
  if (!source) return null;
  atomicWriteFile(destination, source.data, { mode: 0o600 });
  removeIfSameFile(request.seedFile, source);
  return destination;
}

function findExistingWorker(request: HandoffRequest): string | null {
  return getWorkers(request.targetProject)
    .find(entry => entry.handoffRequestId === request.id)?.name ?? null;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function deliverClaimResult(
  claimFile: string,
  id: string,
  response: HandoffResponse,
  request?: HandoffRequest,
): void {
  try {
    persistReceipt(id, response);
  } catch (err) {
    log.error("handoff", "failed to persist dispatch receipt", {
      data: { id, error: String(err) },
    });
    return;
  }

  if (response.error) {
    try { fs.unlinkSync(protectedSeedPath(id)); } catch { /* absent */ }
  }
  try { fs.unlinkSync(claimFile); } catch { /* recovery will replay the receipt */ }

  log.info("handoff", "processed", {
    data: {
      id,
      project: request?.targetProject,
      workerName: response.workerName,
      error: response.error,
    },
  });
}

function rejectClaim(claimFile: string, id: string, error: string): void {
  log.error("handoff", error, { data: { id, file: path.basename(claimFile) } });
  deliverClaimResult(claimFile, id, { error, completedAt: Date.now() });
}

function processClaim(claimFile: string, filenameId: string): void {
  const priorReceipt = readReceipt(filenameId);
  if (priorReceipt) {
    deliverClaimResult(claimFile, filenameId, priorReceipt);
    return;
  }

  const claim = readStableRegularFile(claimFile, claimsDir(), MAX_REQUEST_BYTES);
  if (!claim) {
    rejectClaim(claimFile, filenameId, "invalid request file");
    return;
  }

  let parsed: unknown;
  try {
    parsed = parseJson(claim.data);
  } catch (err) {
    rejectClaim(claimFile, filenameId, `invalid request JSON: ${String(err)}`);
    return;
  }
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    const bodyId = (parsed as Record<string, unknown>).id;
    if (typeof bodyId === "string" && bodyId !== filenameId) {
      rejectClaim(claimFile, filenameId, "request body id does not match its filename");
      return;
    }
  }
  if (!isHandoffRequest(parsed)) {
    rejectClaim(claimFile, filenameId, "malformed request file (shape guard rejected)");
    return;
  }
  const request = parsed;

  const existingWorker = findExistingWorker(request);
  if (existingWorker) {
    deliverClaimResult(
      claimFile,
      filenameId,
      { workerName: existingWorker, completedAt: Date.now() },
      request,
    );
    return;
  }

  const seedFile = protectedSeedFor(request);
  if (!seedFile) {
    rejectClaim(
      claimFile,
      filenameId,
      "seed file rejected: it must be a regular file inside the seeds directory, "
      + "unchanged during the read, and no larger than 1MB",
    );
    return;
  }

  // A crew is resolved by name at spawn, and newWorker treats a name it
  // cannot resolve as "no crew" — silently spawning on the project default
  // when the caller asked for something specific. Refuse here instead.
  if (request.crew && !getCrew(request.crew, loadConfig())) {
    rejectClaim(claimFile, filenameId, `unknown crew '${request.crew}'`);
    return;
  }

  let response: HandoffResponse;
  try {
    // Only propagate parent linkage when --expect-callback was set AND both
    // env-derived fields are present. A handoff submitted from outside a worker
    // pane has nowhere to call back to; record nothing rather than half-state.
    const handoffCallback = request.expectCallback && request.parentProject && request.parentWorker
      ? {
          parentProject: request.parentProject,
          parentWorker: request.parentWorker,
          expectCallback: true as const,
        }
      : undefined;
    const workerName = newWorker({
      projectName: request.targetProject,
      seedMessageFile: seedFile,
      background: true,
      handoffRequestId: request.id,
      ...(handoffCallback ? { handoffCallback } : {}),
      ...(request.ultracode ? { ultracode: true } : {}),
      ...(request.crew ? { crew: request.crew } : {}),
      ...(request.bead ? { bead: request.bead } : {}),
    });
    const reconciledWorker = workerName ?? findExistingWorker(request);
    response = reconciledWorker
      ? { workerName: reconciledWorker, completedAt: Date.now() }
      : {
          error: "newWorker returned null (rejected before pane creation; see dashboard.log)",
          completedAt: Date.now(),
        };
  } catch (err) {
    const reconciledWorker = findExistingWorker(request);
    response = reconciledWorker
      ? { workerName: reconciledWorker, completedAt: Date.now() }
      : { error: String(err), completedAt: Date.now() };
  }

  deliverClaimResult(claimFile, filenameId, response, request);
}

function recoverAbandonedClaims(): void {
  let files: string[];
  try {
    files = fs.readdirSync(claimsDir());
  } catch {
    return;
  }
  for (const file of files) {
    const match = CLAIM_FILE_RE.exec(file);
    if (!match) continue;
    const ownerPid = Number(match[2]);
    if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0 || processIsAlive(ownerPid)) continue;
    const abandoned = path.join(claimsDir(), file);
    const recovered = ownedClaimPath(match[1]);
    try {
      fs.renameSync(abandoned, recovered);
    } catch {
      continue;
    }
    processClaim(recovered, match[1]);
  }
}

function recoverLegacyClaims(): void {
  let files: string[];
  try {
    files = fs.readdirSync(requestsDir());
  } catch {
    return;
  }
  fs.mkdirSync(claimsDir(), { recursive: true });
  for (const file of files) {
    const match = LEGACY_CLAIM_FILE_RE.exec(file);
    if (!match) continue;
    const legacy = path.join(requestsDir(), file);
    try {
      if (Date.now() - fs.statSync(legacy).mtimeMs < LEGACY_CLAIM_STALE_MS) continue;
    } catch {
      continue;
    }
    const recovered = ownedClaimPath(match[1]);
    try {
      fs.renameSync(legacy, recovered);
    } catch {
      continue;
    }
    rejectClaim(
      recovered,
      match[1],
      "abandoned legacy claim cannot be replayed safely; submit the handoff again",
    );
  }
}

function claimPendingRequests(): void {
  let files: string[];
  try {
    files = fs.readdirSync(requestsDir());
  } catch {
    return;
  }
  fs.mkdirSync(claimsDir(), { recursive: true });
  for (const file of files) {
    if (!file.endsWith(".req.json")) continue;
    const match = REQUEST_FILE_RE.exec(file);
    const reqFile = path.join(requestsDir(), file);
    if (!match) {
      log.error("handoff", "rejected request with invalid filename", { data: { file } });
      try { fs.unlinkSync(reqFile); } catch { /* ignore */ }
      continue;
    }
    const claimFile = ownedClaimPath(match[1]);
    try {
      fs.renameSync(reqFile, claimFile);
    } catch {
      continue;
    }
    processClaim(claimFile, match[1]);
  }
}

function sweepOldReceipts(): void {
  let files: string[];
  try {
    files = fs.readdirSync(receiptsDir());
  } catch {
    return;
  }
  const cutoff = Date.now() - RECEIPT_RETENTION_MS;
  for (const file of files) {
    if (!RECEIPT_FILE_RE.test(file)) continue;
    const fullPath = path.join(receiptsDir(), file);
    try {
      if (fs.statSync(fullPath).mtimeMs < cutoff) fs.unlinkSync(fullPath);
    } catch { /* best effort */ }
  }
}

// Called by the poller on every wake. Pending claims are atomically moved out
// of the worker-writable inbox. Existing protected claims are touched only when
// their recorded owner PID is demonstrably dead.
export function processPendingHandoffs(): void {
  sweepOldReceipts();
  recoverAbandonedClaims();
  recoverLegacyClaims();
  claimPendingRequests();
}

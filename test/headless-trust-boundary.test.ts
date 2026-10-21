import path from "node:path";
import { describe, expect, it } from "vitest";
import { SESSIONS_DIR } from "../src/config.js";
import { buildSandboxConfig } from "../src/dashboard/sandbox.js";
import {
  holisticFindingsPath,
  reviewPromptPath,
  reviewResultPath,
  ciFixPromptPath,
  ciFixResultPath,
  claudeSettingsPath,
  contextFilePath,
  STATUS_LINE_SCRIPT_PATH,
} from "../src/dashboard/headless-paths.js";
import { STATUS_DIAG_DIR } from "../src/dashboard/header.js";
import { USAGE_FILE, USAGE_LOCK } from "../src/dashboard/usage.js";
import { CODEX_PROBE_ATTEMPT_FILE, CODEX_PROBE_LOCK, CODEX_USAGE_FILE } from "../src/dashboard/codex-usage.js";
import { hookCompileCachePrefix } from "../src/dashboard/runner.js";
import {
  CONTROL_DIR,
  CONTROL_REPORTS_DIR,
  CONTROL_SCRIPTS_DIR,
  CONTROL_SEEDS_DIR,
  HEADLESS_RUNS_DIR,
} from "../src/paths.js";

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

describe("headless-agent trust boundary", () => {
  it("keeps every review-family prompt and result outside the worker-writable sessions tree", () => {
    const sandbox = buildSandboxConfig({
      worktreePath: "/tmp/garden-worker",
      project: { path: "/tmp/garden-project" },
      remoteHost: null,
    });
    expect(sandbox.filesystem.allowWrite).toContain("~/.garden/sessions");
    expect(sandbox.filesystem.allowWrite).not.toContain("~/.garden/control");

    const files = [
      reviewPromptPath("garden", "swift-oak"),
      reviewResultPath("garden", "swift-oak"),
      ciFixPromptPath("garden", "swift-oak"),
      ciFixResultPath("garden", "swift-oak"),
      holisticFindingsPath("garden", "swift-oak"),
    ];

    for (const file of files) {
      expect(isWithin(SESSIONS_DIR, file), file).toBe(false);
      expect(isWithin(CONTROL_DIR, file), file).toBe(true);
    }
    expect(isWithin(HEADLESS_RUNS_DIR, files[0])).toBe(true);
    expect(isWithin(CONTROL_REPORTS_DIR, files[4])).toBe(true);
  });

  it("keeps what an unsandboxed process runs or hands an agent as instructions outside the sessions tree", () => {
    // Bootstrap and pane scripts, the status line Claude Code runs outside the
    // sandbox, system-prompt context files, seed prompts, and the status pane's
    // diag captures (a capture becomes a worker's briefing).
    const files = [
      path.join(CONTROL_SCRIPTS_DIR, "bootstrap-garden-swift-oak.sh"),
      STATUS_LINE_SCRIPT_PATH,
      claudeSettingsPath("/tmp/garden-worker"),
      contextFilePath("/tmp/garden-worker"),
      path.join(CONTROL_SEEDS_DIR, "grow-1.txt"),
      path.join(STATUS_DIAG_DIR, "diag-snap-1-1.txt"),
      // What the unsandboxed poller and the auto-continue gate read as quota.
      USAGE_FILE,
      CODEX_USAGE_FILE,
      CODEX_PROBE_ATTEMPT_FILE,
      // Their locks too: file-lock waits out any lock naming a live pid, so
      // one planted in a worker-writable dir freezes the meter and the probe.
      USAGE_LOCK,
      CODEX_PROBE_LOCK,
      // Bytecode the unsandboxed hook loads.
      hookCompileCachePrefix().replace(/^NODE_COMPILE_CACHE=/, "").trim(),
    ];
    for (const file of files) {
      expect(isWithin(SESSIONS_DIR, file), file).toBe(false);
      expect(isWithin(CONTROL_DIR, file), file).toBe(true);
    }
  });

  it("contains artifacts even when registry-controlled names contain traversal syntax", () => {
    const project = "../../outside";
    const worker = "../forged/worker";

    expect(isWithin(HEADLESS_RUNS_DIR, reviewResultPath(project, worker))).toBe(true);
    expect(isWithin(HEADLESS_RUNS_DIR, ciFixResultPath(project, worker))).toBe(true);
    expect(isWithin(CONTROL_REPORTS_DIR, holisticFindingsPath(project, worker))).toBe(true);
  });

  it("bounds malformed and oversized registry identities to valid filename lengths", () => {
    const forged = `../${"x".repeat(1_000)}\uD800`;

    const result = reviewResultPath(forged, forged);
    expect(isWithin(HEADLESS_RUNS_DIR, result)).toBe(true);
    expect(path.basename(result).length).toBeLessThanOrEqual(255);
  });

  // Hashing is the fallback, not the rule: an ordinary project/worker pair
  // keeps its readable filename. The operator reads these names out of
  // `garden logs` and off disk while debugging a stuck review, and the legacy
  // SESSIONS_DIR sweep in cleanContextFiles matches on the same basenames.
  it("preserves ordinary project and worker names verbatim in the filename", () => {
    expect(path.basename(reviewResultPath("garden", "swift-oak")))
      .toBe("garden-swift-oak-review-result.txt");
    expect(path.basename(ciFixPromptPath("wolf", "bleak-hoar-glow")))
      .toBe("wolf-bleak-hoar-glow-ci-fix-prompt.txt");
  });

  // Two distinct forged identities must not collapse onto one verdict file —
  // sharing it would let one worker read or overwrite another's verdict, which
  // is the boundary this whole module exists to hold. Lone surrogates are the
  // sharp case: they are unrepresentable in UTF-8, so hashing the name as UTF-8
  // replaces every one of them with U+FFFD and collides distinct names.
  it("maps distinct unsafe identities to distinct artifact paths", () => {
    const paths = [
      reviewResultPath("p", "\uD800"),
      reviewResultPath("p", "\uD801"),
      reviewResultPath("p", "worker/../../escape"),
      reviewResultPath("p", "worker\0escape"),
    ];
    expect(new Set(paths).size).toBe(paths.length);
  });
});

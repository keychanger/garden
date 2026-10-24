// The status pane's spinner loop runs one animation frame every 120ms for as
// long as anything on screen is working, so whatever a frame forks becomes
// ambient load on the operator's machine. This runs buildStatusCommand's real
// script in bash for a bounded number of frames, with stub `sleep` and `tmux`
// on PATH, and counts the children each frame reaps (a CHLD trap under set -m).
// It also replays the per-frame awk the loop used to run, on this platform's
// awk, and checks the loop still writes exactly the bytes that awk wrote.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildStatusCommand } from "../../src/dashboard/header.js";

const FRAMES = 12;
const ESC = "\x1b";

function shellCanCountChildren(): boolean {
  const r = spawnSync("bash", ["-c",
    "set -m; n=0; trap 'n=$((n+1))' CHLD; /bin/sh -c :; /bin/sh -c :; trap - CHLD; echo \"$n\""],
  { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim() === "2";
}

const available = shellCanCountChildren();

function replaceOnce(s: string, from: RegExp, to: string): string {
  let n = 0;
  const out = s.replace(from, () => { n++; return to; });
  expect(n, `pattern ${from} must match the generated loop once`).toBe(1);
  return out;
}

interface LoopRun { stdout: string; children: number; frames: number; tmuxCalls: string[] }

function runLoop(dir: string, content: string, template: string): LoopRun {
  fs.writeFileSync(path.join(dir, "status.rendered"), content);
  fs.writeFileSync(path.join(dir, "plot-strip.template"), template);
  let script = buildStatusCommand("garden-stub");
  script = replaceOnce(script, /^sf='[^']*'$/m, `sf='${dir}/status.rendered'`);
  script = replaceOnce(script, /^pst='[^']*'$/m, `pst='${dir}/plot-strip.template'`);
  script = replaceOnce(script, /^cd='[^']*'$/m, `cd='${dir}/cur.dump'`);
  script = replaceOnce(script, /^sd='[^']*'$/m, `sd='${dir}/diag'`);
  script = replaceOnce(script, /while \[ \$sc -lt 500 \]; do/, `while [ $sc -lt ${FRAMES} ]; do`);
  // Count only what the animation frames reap, then stop after one inner loop.
  script = replaceOnce(script, /^ {4}sc=0;$/m, "    sc=0; nch=0; trap 'nch=$((nch+1))' CHLD;");
  script = replaceOnce(script, /^ {4}done;$/m,
    "    done; trap - CHLD; printf 'FRAMES=%s CHILDREN=%s\\n' \"$sc\" \"$nch\" >&2; exit 0;");
  const scriptPath = path.join(dir, "loop.sh");
  fs.writeFileSync(scriptPath, `set -m\n${script}`);

  const stub = path.join(dir, "stub");
  fs.mkdirSync(stub);
  const tmuxLog = path.join(dir, "tmux.log");
  fs.writeFileSync(path.join(stub, "tmux"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${tmuxLog}'\n`, { mode: 0o755 });
  // A frame's sleep is a fork whether or not it waits; the stub keeps the run fast.
  fs.writeFileSync(path.join(stub, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(tmuxLog, "");

  const r = spawnSync("bash", [scriptPath], {
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, PATH: `${stub}:${process.env.PATH}`, TMUX_PANE: "%9" },
  });
  const m = r.stderr.match(/FRAMES=(\d+) CHILDREN=(\d+)/);
  expect(m, r.stderr).not.toBeNull();
  return {
    stdout: r.stdout,
    frames: Number(m![1]),
    children: Number(m![2]),
    tmuxCalls: fs.readFileSync(tmuxLog, "utf8").split("\n").filter(Boolean),
  };
}

// What the loop wrote per frame before the overlay moved out of the frame:
// one awk over the whole pane content, substituting that frame's glyph.
function previousFrameOverlay(content: string, frame: string): string {
  const r = spawnSync("bash", ["-c",
    `printf '%s\\n' "$cur" | awk -v b="$cls" -v f="$frame" '$0 ~ b { gsub(b, f); printf "\\033[%d;1H%s", NR, $0 }'`],
  { encoding: "utf8", env: { ...process.env, cur: content, cls: "[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]", frame } });
  expect(r.status).toBe(0);
  return r.stdout;
}

const spinnerRows = [
  "",
  `  1. ${ESC}[1;32mgarden${ESC}[0m ◄`,
  `    ● ${ESC}[1m⠋ bold-ash${ESC}[0m   working 3m   fixing auth`,
  "    ○ ◆ calm-fen    idle         reviewed it",
  `    ○ ${ESC}[31m⠋ dry-oak${ESC}[0m    ${ESC}[31mfailing${ESC}[0m      red ⠹ again`,
  "",
].map(l => `${l}${ESC}[K`).join("\n");
const busyStrip = "#[fg=default,bold]● __GSP__ all#[default]  #[fg=yellow]○ ⚑ __GSP__ imp#[default]";
const quietStrip = "#[fg=default,bold]● all#[default]  #[fg=green]○ ✓ imp#[default]";

describe.skipIf(!available)("status pane spinner loop (real bash)", () => {
  it("forks only the sleep and the plot-strip tmux call per frame", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-status-loop-"));
    try {
      const run = runLoop(dir, spinnerRows, busyStrip);
      expect(run.frames).toBe(FRAMES);
      expect(run.tmuxCalls.filter(c => c.startsWith("set-option")).length).toBe(FRAMES);
      expect(run.children).toBeGreaterThanOrEqual(FRAMES);
      expect(run.children).toBeLessThanOrEqual(2 * FRAMES);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("forks only the sleep per frame when the plot strip is static", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-status-loop-"));
    try {
      const run = runLoop(dir, spinnerRows, quietStrip);
      expect(run.frames).toBe(FRAMES);
      expect(run.tmuxCalls.filter(c => c.startsWith("set-option"))).toEqual([]);
      expect(run.children).toBe(FRAMES);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes the same bytes the per-frame awk overlay wrote", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-status-loop-"));
    try {
      const run = runLoop(dir, spinnerRows, quietStrip);
      const frames = [...buildStatusCommand("garden-stub").matchAll(/(\d+)\) sf_char='(.)';;/gu)]
        .sort((a, b) => Number(a[1]) - Number(b[1])).map(m => m[2]);
      expect(frames).toHaveLength(10);
      let expected = `${ESC}[H${ESC}[2J${ESC}[3J${ESC}[H${spinnerRows}${ESC}[J`;
      for (let fc = 1; fc <= FRAMES; fc++) expected += previousFrameOverlay(spinnerRows, frames[fc % frames.length]);
      expect(run.stdout).toBe(expected);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

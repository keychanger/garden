// tmux expands a display-menu's title, item names and item commands as formats
// when the menu opens, and run-shell expands its command again before /bin/sh
// sees it, so a `#(...)` in a branch name or a worker-written registry field
// ran as the operator (measured on tmux 3.7c before the escaping). These cases
// run garden's own builders against a real client and check that every
// untrusted string arrives as text.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildMenuArgv } from "../../src/dashboard/menu.js";
import { promptArgv, promptCommand, shellEscape, tmuxDoubleQuote, tmuxLiteral } from "../../src/dashboard/tmux.js";

// An OS sandbox denies the tmux server socket; skip rather than hard-fail there.
// See menu-dispatch.real.test.ts, including why the socket file is unlinked.
function tmuxServerAvailable(): boolean {
  const probeSock = `garden-literal-probe-${process.pid}`;
  const probe = spawnSync("tmux", ["-L", probeSock, "new-session", "-d", "-x", "80", "-y", "24"], { encoding: "utf8" });
  const ok = spawnSync("tmux", ["-L", probeSock, "list-sessions"], { encoding: "utf8" }).status === 0;
  spawnSync("tmux", ["-L", probeSock, "kill-server"], { encoding: "utf8" });
  const dir = process.env.TMUX_TMPDIR || "/tmp";
  fs.rmSync(path.join(dir, `tmux-${process.getuid?.() ?? 0}`, probeSock), { force: true });
  return probe.status === 0 && ok;
}

const available = spawnSync("python3", ["--version"], { encoding: "utf8" }).error === undefined
  && tmuxServerAvailable();

describe.skipIf(!available)("tmux literal text (real tmux client)", () => {
  it("keeps untrusted text inert in menus, run-shell commands, popups, prompts and messages", () => {
    // Short: the socket path must fit the 104-byte AF_UNIX limit.
    const dir = fs.mkdtempSync(path.join("/tmp", "gl-"));
    const socket = path.join(dir, "s");
    const file = (name: string) => path.join(dir, name);
    const read = (name: string) => fs.readFileSync(file(name), "utf8");
    // What a hostile branch name or registry field could carry.
    const hostile = (tag: string) => `#(touch ${file(`ran-${tag}`)}) #{session_name} ##x`;

    // A stand-in for the garden CLI, recording the route it was given and the
    // reply tmux stored for it.
    fs.writeFileSync(file("runner.sh"), [
      `printf '%s\\n' "$@" > ${shellEscape(dir)}/"$3".argv`,
      `tmux -S ${shellEscape(socket)} show-options -gv @garden_prompt_reply > ${shellEscape(dir)}/"$3".reply`,
    ].join("\n"));
    const runner = `/bin/sh ${shellEscape(file("runner.sh"))}`;

    const typed = `seed "dq" 'sq' $(touch ${file("ran-dollar")}) ${hostile("typed")} ; ,comma`;
    // No comma: tmux splits a pre-fill on commas into one prompt per piece
    // (the flag that disables that is 3.6+). The typed reply is never split.
    const prefill = `pre fill ${hostile("prefill")}`;
    const menu = buildMenuArgv({
      title: `T ${hostile("title")}`,
      rows: [
        { label: `L ${hostile("label")}`, key: "a", run: `printf %s ${shellEscape(`V ${hostile("run")}`)} > ${shellEscape(file("run.out"))}` },
        { label: "popup", key: "o", tmux: `display-popup -E ${tmuxDoubleQuote(`printf %s ${shellEscape(`P ${hostile("popup")}`)} > ${shellEscape(file("popup.out"))}`)}` },
        { label: "prompt", key: "p", tmux: promptCommand("x: ", runner, ["_grow-plant", `proj ${hostile("route")}`]) },
      ],
    });
    const message = `D ${hostile("message")}`;

    const result = spawnSync("python3", [
      path.resolve("test/integration/fixtures/tmux-literal.py"),
      JSON.stringify({
        socket,
        cases: [
          { argv: menu, keys: ["a"] },
          { argv: menu, keys: ["o"] },
          { argv: menu, keys: ["p", `${typed}\r`] },
          { argv: promptArgv("f: ", runner, ["_logs-filter-apply"], prefill), keys: ["\r"] },
          { argv: ["display-message", "-p", tmuxLiteral(message)], capture: file("message.out") },
        ],
      }),
    ], { encoding: "utf8", timeout: 60_000 });
    try {
      expect(result.status, result.stderr + result.stdout).toBe(0);

      expect(read("run.out")).toBe(`V ${hostile("run")}`);
      expect(read("popup.out")).toBe(`P ${hostile("popup")}`);
      expect(read("_grow-plant.argv").split("\n").slice(0, 4))
        .toEqual(["dashboard", "_prompt-reply", "_grow-plant", `proj ${hostile("route")}`]);
      expect(read("_grow-plant.reply").replace(/\n$/, "")).toBe(typed);
      expect(read("_logs-filter-apply.reply").replace(/\n$/, "")).toBe(prefill);
      expect(read("message.out").replace(/\n$/, "")).toBe(message);
      expect(fs.readdirSync(dir).filter(f => f.startsWith("ran-"))).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

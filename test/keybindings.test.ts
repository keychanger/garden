import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { captureConsoleLog } from "./helpers.js";
import { DASHBOARD_HOTKEYS, hotkeyDisplay } from "../src/dashboard/keybindings.js";
import { keys } from "../src/commands/keys.js";

// The shared table (keybindings.ts) is the anti-drift device: hotkeys.ts binds
// it and keys.ts documents it. These tests guard the two remaining ways it can
// still go wrong — a duplicate/undocumented key, or a binding that points at a
// dashboard handler that no longer exists.
describe("dashboard keybindings table", () => {
  it("binds each Meta key at most once", () => {
    const seen = new Set<string>();
    for (const b of DASHBOARD_HOTKEYS) {
      expect(seen.has(b.key), `duplicate binding for ⌥${b.key}`).toBe(false);
      seen.add(b.key);
    }
  });

  it("`garden keys` documents every bound hotkey", async () => {
    const out = (await captureConsoleLog(() => keys())).join("\n");
    for (const b of DASHBOARD_HOTKEYS) {
      expect(out, `missing key ${hotkeyDisplay(b.key)}`).toContain(hotkeyDisplay(b.key));
      expect(out, `missing label for ⌥${b.key}`).toContain(b.label);
    }
  });

  it("every dashboard-command binding maps to a real dispatch handler", () => {
    const indexSrc = fs.readFileSync(
      path.resolve(__dirname, "../src/dashboard/index.ts"), "utf8",
    );
    for (const b of DASHBOARD_HOTKEYS) {
      if (b.raw) continue;
      const cmd = b.command.split(" ")[0]; // "_cycle-pane next" -> "_cycle-pane"
      expect(indexSrc, `binding ⌥${b.key} → ${cmd} has no dispatch handler`)
        .toContain(`sub === "${cmd}"`);
    }
  });
});

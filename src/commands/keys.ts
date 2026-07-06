// Shows dashboard keybindings, derived from the same shared table that
// hotkeys.ts binds into tmux (src/dashboard/keybindings.ts) so the two can't
// drift. ⌥1–⌥9 and the ctrl-b prefix defaults are fixed lines (see the table's
// header comment for why they're not in the table).
import { DASHBOARD_HOTKEYS, hotkeyDisplay, type KeyCategory } from "../dashboard/keybindings.js";

const CATEGORY_ORDER: KeyCategory[] = ["Navigation", "Projects", "Workers", "General"];

export async function keys(): Promise<void> {
  const lines: string[] = ["Garden Dashboard Keybindings (⌥ = Option/Alt)", ""];

  // Widest key column across all rows (including the fixed ⌥1–⌥9 / ctrl-b rows)
  // so descriptions line up.
  const fixedKeys = ["⌥1 – ⌥9", "ctrl-b d", "ctrl-b z"];
  const keyWidth = Math.max(
    ...DASHBOARD_HOTKEYS.map(b => hotkeyDisplay(b.key).length),
    ...fixedKeys.map(k => k.length),
  );
  const row = (key: string, label: string) => `    ${key.padEnd(keyWidth)}   ${label}`;

  for (const category of CATEGORY_ORDER) {
    lines.push(`  ${category}`);
    if (category === "Projects") {
      lines.push(row("⌥1 – ⌥9", "Switch to project by number (within active plot)"));
    }
    for (const b of DASHBOARD_HOTKEYS.filter(b => b.category === category)) {
      lines.push(row(hotkeyDisplay(b.key), b.label));
    }
    if (category === "General") {
      lines.push(row("ctrl-b d", "Detach (everything keeps running)"));
      lines.push(row("ctrl-b z", "Zoom/unzoom current pane"));
    }
    lines.push("");
  }

  lines.push('Setup: iTerm2 → Settings → Profiles → Keys → Left Option key → "Esc+"');
  console.log(lines.join("\n"));
}

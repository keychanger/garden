// Shows dashboard keybindings.
export async function keys(): Promise<void> {
  console.log(`
Garden Dashboard Keybindings (⌥ = Option/Alt)

  Navigation
    ⌥g           Focus garden console
    ⌥l           Focus logs
    ⌥w           Jump to first worker
    ⌥s           Jump to project shell
    ⌥] / ⌥[     Cycle workers (right pane) or views (garden pane)

  Projects
    ⌥1 – ⌥9     Switch to project by number

  Workers
    ⌥n           New worker (Claude session)
    ⌥x           Kill current worker (shell protected)
    ⌥b           Bounce current worker (restart Claude, preserve history)

  General
    ⌥k           Refresh/redraw screen
    ctrl-b d     Detach (everything keeps running)
    ctrl-b z     Zoom/unzoom current pane

Setup: iTerm2 → Settings → Profiles → Keys → Left Option key → "Esc+"
`.trim());
}

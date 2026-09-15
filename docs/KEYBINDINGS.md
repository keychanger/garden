# Dashboard keybindings

Reference. `garden keys` prints the live list from `src/dashboard/keybindings.ts`,
the single source of truth; this page is the same list for reading outside a
terminal. If they disagree, `garden keys` is right.

⌥ is the Option key (Alt on Linux). In iTerm2, set Settings → Profiles →
Keys → Left Option key → "Esc+" so Option sends Meta.

## Navigation

| Key | Action |
|---|---|
| `⌥g` | Focus growhouse (the `garden>` prompt) |
| `⌥r` | Focus root shell |
| `⌥l` | Focus logs |
| `⌥h` | Focus history (focused worker's prompt history) |
| `⌥a` | Focus alerts (marks them read; press again to clear the unread mark) |
| `⌥d` | Focus diary (focused project's diary in `$EDITOR`) |
| `⌥w` | Jump to first worker |
| `⌥s` | Jump to project shell |
| `⌥]` | Cycle to next worker (right pane) |
| `⌥[` | Cycle to previous worker (right pane) |
| `⌥/` | Edit the logs sticky filter |
| `⌥.` | Clear the logs sticky filter |

## Projects

| Key | Action |
|---|---|
| `⌥1` – `⌥9` | Switch to project by number (within the active plot) |
| `⌥p` | Cycle to next focused plot |
| `⌥⇧P` | Cycle to previous focused plot |
| `⌥o` | Cycle to previous focused plot (alias of `⌥⇧P`) |
| `⌥⇧C` | Crew picker (set the focused project's crew: who builds, who reviews) |
| `⌥,` | Project config menu (base branch, crew, model, effort, CI gate, holistic review, log color) |
| `⌥;` | Garden settings menu (machine-wide limits: checks slots, max reviews, build branch) |

## Workers

| Key | Action |
|---|---|
| `⌥n` | New worker (Claude session) |
| `⌥⇧N` | Workflow picker and spawn composer (default, designer, trellis, hoop) |
| `⌥i` | Worker menu (inspect and act on the focused worker: base, reviewer, model, verbs) |
| `⌥e` | Hold or resume the focused worker (tracked interrupt → `paused`) |
| `⌥x` | Kill current worker (the shell pane is protected) |
| `⌥b` | Bounce current worker (restart Claude, preserve history) |

## General

| Key | Action |
|---|---|
| `⌥k` | Refresh and redraw the screen |
| `ctrl-b d` | Detach (everything keeps running) |
| `ctrl-b z` | Zoom or unzoom the current pane |

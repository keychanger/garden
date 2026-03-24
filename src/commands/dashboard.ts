// Dashboard: a single tmux window with three zones:
//   - Status pane (top, fixed height) — live project status
//   - Shell pane (below status, fixed height) — command center
//   - Workspace (remaining space) — Claude/shell panes, tiled
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import {
  checkTmux,
  dashboardExists,
  createDashboardSession,
  attachDashboardSession,
  killDashboardSession,
  setTmuxBinding,
  DASHBOARD_SESSION,
} from "../session.js";
import { getProject, SESSIONS_DIR } from "../config.js";
import { buildRulesContext } from "../rules.js";

const STATUS_HEIGHT = 3;  // lines for status pane
const SHELL_HEIGHT = 8;   // lines for shell pane
const MAX_WORKSPACE_PANES = 9;

export async function dashboard(args: string[]): Promise<void> {
  checkTmux();

  const sub = args[0];

  if (sub === "open") {
    const projectName = args[1];
    if (!projectName) throw new Error("Usage: garden dashboard open <project>");
    const project = getProject(projectName);
    ensureDashboard();
    addPane(project.name, project.path, "shell");
    return;
  }

  if (sub === "claude") {
    const projectName = args[1];
    if (!projectName) throw new Error("Usage: garden dashboard claude <project>");
    const project = getProject(projectName);
    ensureDashboard();
    addPane(project.name, project.path, "claude");
    return;
  }

  if (sub === "exit" || sub === "close") {
    if (!dashboardExists()) {
      console.log("No dashboard running.");
      return;
    }
    killDashboardSession();
    console.log("Dashboard closed.");
    return;
  }

  if (sub && sub !== "help") {
    throw new Error(`Unknown dashboard subcommand: ${sub}. Try 'garden dashboard help'.`);
  }

  if (sub === "help") {
    printDashboardHelp();
    return;
  }

  // Default: create/attach
  ensureDashboard();
  console.log("Attaching to dashboard... (detach with ctrl-b d)");
  attachDashboardSession();
}

// --- Pane tracking ---
// Layout: pane 0 = status, pane 1 = shell, panes 2+ = workspace
// We track pane IDs by their creation order (pane_index).

interface PaneInfo {
  index: string;
  id: string;
}

function listPanes(): PaneInfo[] {
  try {
    const output = execFileSync(
      "tmux",
      ["list-panes", "-t", `${DASHBOARD_SESSION}:0`, "-F", "#{pane_index}:#{pane_id}"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }
    );
    return output.trim().split("\n").filter(Boolean).map((line) => {
      const [index, id] = line.split(":");
      return { index, id };
    });
  } catch {
    return [];
  }
}

function getWorkspacePanes(): PaneInfo[] {
  const panes = listPanes();
  // Workspace panes are index 2+
  return panes.filter((p) => parseInt(p.index) >= 2);
}

// --- Dashboard creation ---

function ensureDashboard(): void {
  if (dashboardExists()) return;

  const gardenRunner = resolveGardenRunner();
  const statusCmd = `prev=""; while true; do cur=$(GARDEN_PRETTY=1 ${gardenRunner} status 2>&1); if [ "$cur" != "$prev" ]; then printf '\\033[H\\033[2J%s\\n' "$cur"; prev="$cur"; fi; sleep 2; done`;

  const cwd = process.cwd();

  // Create session — pane 0 is the status pane
  createDashboardSession(statusCmd, cwd);

  // Split pane 0 vertically → pane 1 (shell) appears below status
  tmux("split-window", "-v", "-t", `${DASHBOARD_SESSION}:0`, "-c", cwd);

  fixLayout();

  // Set tmux hooks to re-pin layout after any pane changes
  installLayoutHooks();
  setupKeybindings();
}

function setupKeybindings(): void {
  const gardenRunner = resolveGardenRunner();

  setTmuxBinding(
    DASHBOARD_SESSION,
    "C",
    `${gardenRunner} dashboard claude $(tmux display-message -p '#{pane_current_path}' | xargs -I{} basename {})`
  );

  setTmuxBinding(
    DASHBOARD_SESSION,
    "S",
    `${gardenRunner} dashboard open $(tmux display-message -p '#{pane_current_path}' | xargs -I{} basename {})`
  );
}

// --- Pane management ---

function claudeCommandForProject(projectName: string, projectPath: string): string {
  const context = buildRulesContext(projectName, projectPath);
  const contextFile = path.join(SESSIONS_DIR, `dashboard-${projectName}.context`);
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.writeFileSync(contextFile, context);
  return `claude --append-system-prompt-file ${contextFile}`;
}

function addPane(
  projectName: string,
  projectPath: string,
  type: "shell" | "claude"
): void {
  const workspace = getWorkspacePanes();

  if (workspace.length >= MAX_WORKSPACE_PANES) {
    throw new Error(`Dashboard is full (${MAX_WORKSPACE_PANES} panes max). Close a pane first.`);
  }

  const command = type === "claude"
    ? claudeCommandForProject(projectName, projectPath)
    : undefined;

  if (workspace.length === 0) {
    // First workspace pane: split below the shell pane
    const panes = listPanes();
    const shellPane = panes[1]; // pane index 1 = shell
    const splitArgs = ["split-window", "-v", "-t", shellPane.id, "-c", projectPath];
    if (command) splitArgs.push(command);
    tmux(...splitArgs);
  } else {
    // Split the last workspace pane
    const target = workspace[workspace.length - 1];
    // Alternate horizontal/vertical splits for a grid feel
    const splitDir = workspace.length % 2 === 0 ? "-v" : "-h";
    const splitArgs = ["split-window", splitDir, "-t", target.id, "-c", projectPath];
    if (command) splitArgs.push(command);
    tmux(...splitArgs);
  }

  fixLayout();

  const label = type === "claude" ? "Claude" : "shell";
  console.log(`Added ${projectName} ${label} to dashboard`);
}

/**
 * Fix the layout: pin status and shell to fixed heights,
 * let workspace panes share remaining space.
 * Resize shell first (lower pane), then status, to avoid cascade effects.
 */
function fixLayout(): void {
  const panes = listPanes();
  if (panes.length < 2) return;

  try {
    // Resize shell first, then status — order matters to avoid tmux redistribution
    tmux("resize-pane", "-t", panes[1].id, "-y", String(SHELL_HEIGHT));
    tmux("resize-pane", "-t", panes[0].id, "-y", String(STATUS_HEIGHT));
  } catch {
    // ignore resize errors (e.g., pane too small)
  }
}

/**
 * Install tmux hooks on the dashboard session so that status and shell
 * pane heights are re-pinned after any layout-changing event.
 */
function installLayoutHooks(): void {
  const panes = listPanes();
  if (panes.length < 2) return;

  const fixCmd = `tmux resize-pane -t ${panes[1].id} -y ${SHELL_HEIGHT} \\; resize-pane -t ${panes[0].id} -y ${STATUS_HEIGHT}`;

  // Re-pin after splits, closes, and resizes
  for (const hook of ["after-split-window", "pane-exited", "after-resize-pane"]) {
    try {
      tmux("set-hook", "-t", DASHBOARD_SESSION, hook, `run-shell '${fixCmd}'`);
    } catch {
      // ignore if hook type not supported
    }
  }
}

// --- Helpers ---

function tmux(...args: string[]): void {
  execFileSync("tmux", args, { stdio: "ignore" });
}

function resolveGardenRunner(): string {
  const gardenBin = path.resolve(process.argv[1]);
  if (gardenBin.endsWith(".ts")) {
    const gardenRoot = path.dirname(path.dirname(gardenBin));
    const tsxBin = path.join(gardenRoot, "node_modules", ".bin", "tsx");
    return fs.existsSync(tsxBin) ? `${tsxBin} ${gardenBin}` : `npx tsx ${gardenBin}`;
  }
  return `node ${gardenBin}`;
}

function printDashboardHelp(): void {
  console.log(`
garden dashboard — multi-project terminal dashboard

Usage:
  garden dashboard                 Open the dashboard (creates if needed)
  garden dashboard exit            Close the dashboard
  garden dashboard open <project>  Add a shell pane
  garden dashboard claude <project> Add a Claude Code pane

Layout:
  Status and shell pinned at top. Project panes fill the space below.
  Up to ${MAX_WORKSPACE_PANES} workspace panes. ctrl-b z to zoom any pane.

Keybindings (inside the dashboard):
  prefix + C    Add Claude Code pane (current project)
  prefix + S    Add shell pane (current project)

Navigation:
  ctrl-b arrows   Move between panes
  ctrl-b z        Zoom/unzoom a pane to fullscreen
  ctrl-b d        Detach (everything keeps running)

Claude sessions include global and project rules via --append-system-prompt-file.
`.trim());
}

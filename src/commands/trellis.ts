// `garden trellis <subcommand>` — trellis document management. Phase 2 ships
// only `new` (scaffold a trellis file). list / show / status / amend /
// resume / retire / revive land in phase 4.
import fs from "node:fs";
import path from "node:path";
import { tryGetProject } from "../config.js";
import { trellisDirFor } from "../dashboard/trellis-tag.js";

export async function trellis(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === "new") {
    await newCommand(args.slice(1));
    return;
  }
  throw new Error(
    "Usage: garden trellis new <project> <name>",
  );
}

async function newCommand(args: string[]): Promise<void> {
  const projectName = args[0];
  const trellisName = args[1];
  if (!projectName || !trellisName) {
    throw new Error("Usage: garden trellis new <project> <name>");
  }
  if (!tryGetProject(projectName)) {
    throw new Error(`Unknown project '${projectName}'. Run 'garden list' to see registered projects.`);
  }
  const dir = trellisDirFor(projectName);
  if (!dir) {
    throw new Error(`Could not resolve trellisDir for project '${projectName}'.`);
  }

  // Strip .md if the operator typed it; we always add it.
  const stem = trellisName.endsWith(".md") ? trellisName.slice(0, -3) : trellisName;
  const filePath = path.join(dir, `${stem}.md`);

  if (fs.existsSync(filePath)) {
    throw new Error(
      `Trellis already exists at ${filePath}. Use 'garden trellis amend' to edit it.`,
    );
  }

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, scaffoldContent(stem));
  console.log(`Created trellis at ${filePath}`);
  console.log(
    "Edit the scaffold to fill in the recommended sections, then plant a vine with:",
  );
  console.log(
    `  garden workers new ${projectName} --workflow trellis --trellis ${stem}`,
  );
}

// Scaffold content per TRELLIS.md "The trellis document". Includes the
// required spine (title, sentinel within the first paragraph, trellis tag
// within the first 200 bytes), and the recommended section headings as
// a starting structure. Operators fill in the prose.
function scaffoldContent(name: string): string {
  return `# ${name}

Spec for the **${name}** feature: a one-paragraph summary of what this feature does and why it exists. **If the code disagrees with this document, the code is wrong.**

<!-- trellis: v1 -->

## Intent

One paragraph: what this feature does, why it exists, what user-visible behavior changes when it lands.

## Surface

The concrete API/CLI/UI surface this feature must expose. Be specific:
function signatures, command flags, file paths, exported symbols. The
reviewer verifies these via grep + signature checks.

- (replace with concrete bullets)

## Behavior

Invariants the feature must satisfy. Mix of objective ("error path
returns \`{ok: false, reason}\`") and judgment-graded ("errors should be
specific and structured"). Number them so drift items can cite them.

1. (replace with concrete bullets)

## Tests

Test cases that should exist. Concrete: file paths or test names. The
reviewer verifies via grep on test files.

- (replace with concrete bullets)

## Docs

Documentation surface that should exist or update. Concrete: file
paths and section titles, or DESIGN.md/CLAUDE.md updates expected.

- (replace with concrete bullets)

## Out of scope

Explicit non-goals. Prevents the loop from chasing adjacent improvements.
Each bullet is a thing the reviewer should bounce back as drift if the
worker tries to include it.

- (replace with concrete bullets)
`;
}

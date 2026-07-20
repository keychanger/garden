// Manage crews: named bundles of who runs each role and how strong.
//
// Shipped v1 crews were generated (members x reviewer-members) and could carry
// only a harness. Stored crews put the name in the operator's hands, so a crew
// can also pin model and effort — `heavy` / `cheap` rather than
// `sonnet-xhigh-claude-opus-claude`. The generated set survives as builtins.
//
// See src/dashboard/crew.ts for resolution, docs/future/CREWS.md for the model.
import { loadConfig, resolveProjectFromArgs, type GardenConfig, type StoredCrew } from "../config.js";
import {
  deleteCrew,
  formatRecipe,
  getCrew,
  isBuiltinCrew,
  listCrews,
  listMembers,
  reviewerMembers,
  saveCrew,
  type CrewSpec,
} from "../dashboard/crew.js";
import { applyCrewToProject } from "./config.js";
import { isTTY, output } from "../output.js";

const USAGE = "Usage: garden crew [list|show|add|edit|remove|apply]";

export async function crew(args: string[]): Promise<void> {
  const sub = args[0] ?? "list";
  const rest = args.slice(1);

  if (sub === "list") return handleList();
  if (sub === "show") return handleShow(rest);
  if (sub === "add") return handleWrite(rest, "add");
  if (sub === "edit") return handleWrite(rest, "edit");
  if (sub === "remove" || sub === "rm") return handleRemove(rest);
  if (sub === "apply") return handleApply(rest);

  throw new Error(`Unknown subcommand: ${sub}. ${USAGE}`);
}

function crewData(spec: CrewSpec, config: GardenConfig): Record<string, unknown> {
  return {
    name: spec.name,
    builtin: spec.builtin,
    recipe: formatRecipe(spec),
    worker: {
      member: spec.worker.name,
      harness: spec.worker.harness,
      ...(spec.worker.provider ? { provider: spec.worker.provider } : {}),
      ...(spec.worker.model ? { model: spec.worker.model } : {}),
      ...(spec.worker.effort ? { effort: spec.worker.effort } : {}),
    },
    review: {
      member: spec.review.name,
      harness: spec.review.harness,
      ...(spec.review.model ? { model: spec.review.model } : {}),
    },
    projects: Object.entries(config.projects)
      .filter(([, p]) => p.crew === spec.name)
      .map(([n]) => n),
  };
}

function handleList(): void {
  const config = loadConfig();
  const crews = listCrews(config);
  const data = crews.map((c) => crewData(c, config));

  if (!isTTY) {
    console.log(JSON.stringify({ crews: data }));
    return;
  }

  const width = Math.max(...crews.map((c) => c.name.length), 4);
  const stored = data.filter((c) => !c.builtin);
  const builtin = data.filter((c) => c.builtin);
  for (const [label, group] of [["defined", stored], ["builtin", builtin]] as const) {
    if (group.length === 0) continue;
    console.log(`  ${label}:`);
    for (const c of group) {
      const bound = (c.projects as string[]).length > 0 ? `  [${(c.projects as string[]).join(", ")}]` : "";
      console.log(`    ${String(c.name).padEnd(width)}  ${c.recipe}${bound}`);
    }
  }
  if (stored.length === 0) {
    console.log("");
    console.log("  No crews defined — the builtins carry a harness pairing only.");
    console.log("  Define one with a model/effort recipe:");
    console.log("    garden crew add heavy --worker claude --model opus --effort xhigh --review claude --review-model opus");
  }
}

function handleShow(args: string[]): void {
  const name = args[0];
  if (!name) throw new Error("Usage: garden crew show <name>");
  const config = loadConfig();
  const spec = requireCrew(name, config);
  const data = crewData(spec, config);

  output(data, () => {
    const lines = [
      `  ${spec.name}${spec.builtin ? "  (builtin)" : ""}`,
      `    recipe:  ${formatRecipe(spec)}`,
      `    worker:  member=${spec.worker.name} harness=${spec.worker.harness}`
        + (spec.worker.provider ? ` provider=${spec.worker.provider}` : "")
        + (spec.worker.model ? ` model=${spec.worker.model}` : "")
        + (spec.worker.effort ? ` effort=${spec.worker.effort}` : ""),
      `    review:  member=${spec.review.name} harness=${spec.review.harness}`
        + (spec.review.model ? ` model=${spec.review.model}` : ""),
    ];
    const bound = data.projects as string[];
    lines.push(`    projects: ${bound.length > 0 ? bound.join(", ") : "(none bound)"}`);
    return lines.join("\n");
  });
}

interface WriteFlags {
  worker?: string;
  model?: string;
  effort?: string;
  review?: string;
  reviewModel?: string;
  from?: string;
}

function parseWriteFlags(args: string[]): WriteFlags {
  const flags: WriteFlags = {};
  const map: Record<string, keyof WriteFlags> = {
    "--worker": "worker",
    "--model": "model",
    "--effort": "effort",
    "--review": "review",
    "--review-model": "reviewModel",
    "--from": "from",
  };
  for (let i = 0; i < args.length; i++) {
    const key = map[args[i]];
    if (!key) throw new Error(`Unknown flag: ${args[i]}. ${USAGE}`);
    const value = args[++i];
    if (value === undefined) throw new Error(`${args[i - 1]} requires a value.`);
    flags[key] = value;
  }
  return flags;
}

function handleWrite(args: string[], mode: "add" | "edit"): void {
  const name = args[0];
  if (!name || name.startsWith("--")) {
    throw new Error(`Usage: garden crew ${mode} <name> [--from <crew>] [--worker <member>] [--model <m>] [--effort <e>] [--review <member>] [--review-model <m>]`);
  }
  const flags = parseWriteFlags(args.slice(1));
  const config = loadConfig();
  const existing = config.crews?.[name];

  if (mode === "add" && existing) {
    throw new Error(`Crew '${name}' already exists. Use 'garden crew edit ${name}' to change it.`);
  }
  // Editing a BUILTIN is allowed and materializes a stored crew of the same
  // name that shadows it — the same gesture the ⌥⇧C picker offers, so the two
  // surfaces agree. `--from` remains the way to clone under a DIFFERENT name.
  // `garden crew remove <name>` later drops the override and restores the
  // generated pairing.
  if (mode === "edit" && !existing && !isBuiltinCrew(name, config)) {
    throw new Error(`No stored crew '${name}'. Create it with: garden crew add ${name} …`);
  }

  // --from seeds every dimension from another crew (builtin or stored) so
  // "clone and tweak" is a single call — the common agentic gesture.
  const seedFrom = (src: CrewSpec): StoredCrew => ({
    worker: {
      member: src.worker.name,
      ...(src.worker.model ? { model: src.worker.model } : {}),
      ...(src.worker.effort ? { effort: src.worker.effort } : {}),
    },
    review: { member: src.review.name, ...(src.review.model ? { model: src.review.model } : {}) },
  });

  let base: StoredCrew;
  if (flags.from) {
    base = seedFrom(requireCrew(flags.from, config));
  } else if (mode === "edit" && !existing) {
    // Editing a builtin: seed from the generated pairing so the flags express a
    // DELTA against it, rather than forcing the operator to restate both halves.
    base = seedFrom(requireCrew(name, config));
  } else if (existing) {
    base = { worker: { ...existing.worker }, review: { ...existing.review } };
  } else {
    if (!flags.worker || !flags.review) {
      throw new Error(
        `garden crew add ${name} requires --worker <member> and --review <member> (or --from <crew>).\n`
        + `  members:  ${listMembers(config).map((m) => m.name).join(", ")}\n`
        + `  reviewers: ${reviewerMembers(config).map((m) => m.name).join(", ")}`,
      );
    }
    base = { worker: { member: flags.worker }, review: { member: flags.review } };
  }

  if (flags.worker) base.worker.member = flags.worker;
  if (flags.review) base.review.member = flags.review;
  applyDim(base.worker, "model", flags.model);
  applyDim(base.worker, "effort", flags.effort);
  applyDim(base.review, "model", flags.reviewModel);

  saveCrew(name, base);
  const spec = getCrew(name, loadConfig());
  console.log(`${mode === "add" ? "Created" : "Updated"} crew '${name}': ${spec ? formatRecipe(spec) : "(unresolvable)"}`);
  const bound = Object.entries(loadConfig().projects).filter(([, p]) => p.crew === name).map(([n]) => n);
  if (mode === "edit" && bound.length > 0) {
    console.log(`Applies to ${bound.join(", ")} on the next spawn or review.`);
  }
}

// A dimension flag: a value sets it, the literal "none" clears it (there is no
// other way to remove a pin once set, and an empty string is ambiguous at the
// shell).
function applyDim(half: { model?: string; effort?: string }, dim: "model" | "effort", value?: string): void {
  if (value === undefined) return;
  if (value === "none") delete half[dim];
  else half[dim] = value;
}

function handleRemove(args: string[]): void {
  const name = args[0];
  if (!name) throw new Error("Usage: garden crew remove <name>");
  const config = loadConfig();
  if (isBuiltinCrew(name, config)) throw new Error(`'${name}' is a builtin crew and cannot be removed.`);
  const bound = deleteCrew(name);
  console.log(`Removed crew '${name}'.`);
  if (bound.length > 0) {
    // The binding is a reference, so a dangling one is inert rather than
    // broken: resolution simply skips the crew layer.
    console.log(`${bound.join(", ")} referenced it — they now resolve from their own config keys.`);
  }
}

function handleApply(args: string[]): void {
  const name = args[0];
  if (!name) throw new Error("Usage: garden crew apply <name> [project]");
  const { project } = resolveProjectFromArgs(args.slice(1));
  applyCrewToProject(project, name);
}

function requireCrew(name: string, config: GardenConfig): CrewSpec {
  const spec = getCrew(name, config);
  if (!spec) {
    throw new Error(`Unknown crew '${name}'. Available: ${listCrews(config).map((c) => c.name).join(", ")}.`);
  }
  return spec;
}

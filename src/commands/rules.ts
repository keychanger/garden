// Command: garden rules — view pending rule suggestions, accept them into
// rules.md, or dismiss them. See src/dashboard/findings.ts for the tally
// logic and src/dashboard/prompts.ts for where findings are emitted.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { GARDEN_DIR, getProject, tryGetProject } from "../config.js";
import {
  pendingSuggestions, getSuggestion, markSuggestion, listFindings,
  type SuggestionSummary, type Finding,
} from "../dashboard/findings.js";
import { isTTY, outputLines } from "../output.js";

export async function rules(args: string[]): Promise<void> {
  const sub = args[0] ?? "suggest";
  const rest = args.slice(1);

  if (sub === "suggest") return handleSuggest();
  if (sub === "accept")  return handleAccept(rest);
  if (sub === "dismiss") return handleDismiss(rest);
  if (sub === "findings") return handleFindings(rest);
  if (sub === "list") return handleList();

  throw new Error(
    `Unknown subcommand: ${sub}. Usage: garden rules [suggest|list|accept|dismiss|findings]`,
  );
}

// --- suggest ---

async function handleSuggest(): Promise<void> {
  const suggestions = pendingSuggestions();
  if (suggestions.length === 0) {
    if (isTTY) console.log("No pending rule suggestions.");
    else console.log(JSON.stringify({ suggestions: [] }));
    return;
  }

  if (!isTTY) {
    for (const s of suggestions) console.log(JSON.stringify(s));
    return;
  }

  if (process.stdin.isTTY) {
    await runInteractive(suggestions);
    return;
  }

  printSuggestionList(suggestions);
  console.log(`Accept one: garden rules accept <category> --rule "..." [--confirm]`);
  console.log(`Dismiss:    garden rules dismiss <category>`);
}

function handleList(): void {
  const suggestions = pendingSuggestions();
  if (suggestions.length === 0) {
    if (isTTY) console.log("No pending rule suggestions.");
    else console.log(JSON.stringify({ suggestions: [] }));
    return;
  }
  if (!isTTY) {
    for (const s of suggestions) console.log(JSON.stringify(s));
    return;
  }
  printSuggestionList(suggestions);
}

function printSuggestionList(suggestions: SuggestionSummary[]): void {
  console.log(`${suggestions.length} pending rule suggestion${suggestions.length === 1 ? "" : "s"}:`);
  console.log("");
  for (const s of suggestions) {
    console.log(`  ${s.category}`);
    console.log(`    count: ${s.count}  workers: ${s.distinctWorkers}  scope: ${describeScope(s)}`);
    for (const ex of s.examples) console.log(`    - ${ex}`);
    console.log("");
  }
}

function describeScope(s: SuggestionSummary): string {
  return s.projects.length > 1 ? `global (${s.projects.length} projects)` : `project: ${s.projects[0]}`;
}

async function runInteractive(suggestions: SuggestionSummary[]): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>(resolve => rl.question(q, resolve));
  try {
    console.log(`${suggestions.length} pending rule suggestion${suggestions.length === 1 ? "" : "s"}.`);
    for (let i = 0; i < suggestions.length; i++) {
      const s = suggestions[i];
      console.log("");
      console.log(`[${i + 1}/${suggestions.length}] ${s.category}`);
      console.log(`  count: ${s.count}  workers: ${s.distinctWorkers}  scope: ${describeScope(s)}`);
      for (const ex of s.examples) console.log(`  - ${ex}`);
      const target = resolveTarget(s, { category: s.category, global: false, confirm: false });
      console.log(`  target: ${target.label}`);
      console.log(`          (${target.filePath})`);

      const choice = (await ask(`[a]ccept / [d]ismiss / [s]kip > `)).trim().toLowerCase();
      if (choice === "a" || choice === "accept") {
        const rule = (await ask(`  rule text (Enter for evidence-only): `)).trim();
        const block = buildRuleBlock(s, rule || undefined);
        appendToRules(target.filePath, block);
        markSuggestion(s.category, "accepted", { appendedTo: target.filePath });
        console.log(`  appended to ${target.filePath}`);
      } else if (choice === "d" || choice === "dismiss") {
        markSuggestion(s.category, "dismissed");
        console.log(`  dismissed.`);
      } else {
        console.log(`  skipped.`);
      }
    }
  } finally {
    rl.close();
  }
}

// --- accept ---

export interface AcceptFlags {
  category: string;
  global: boolean;
  project?: string;
  rule?: string;
  confirm: boolean;
}

export function parseAcceptFlags(args: string[]): AcceptFlags {
  if (args.length === 0 || args[0].startsWith("--")) {
    throw new Error(`Usage: garden rules accept <category> [--global | --project <name>] --rule "..." [--confirm]`);
  }
  const flags: AcceptFlags = {
    category: args[0],
    global: false,
    confirm: false,
  };
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "--global") flags.global = true;
    else if (a === "--project") {
      if (!args[i + 1]) throw new Error("--project requires a value");
      flags.project = args[++i];
    }
    else if (a === "--rule") {
      if (!args[i + 1]) throw new Error("--rule requires a value");
      flags.rule = args[++i];
    }
    else if (a === "--confirm") flags.confirm = true;
    else throw new Error(`Unknown flag: ${a}`);
  }
  if (flags.global && flags.project) {
    throw new Error("Specify at most one of --global or --project <name>");
  }
  return flags;
}

function handleAccept(args: string[]): void {
  const flags = parseAcceptFlags(args);
  const summary = getSuggestion(flags.category);
  if (!summary) {
    throw new Error(`No findings recorded for category: ${flags.category}`);
  }
  if (summary.status === "accepted") {
    throw new Error(`Category already accepted: ${flags.category}${summary.appendedTo ? ` (appended to ${summary.appendedTo})` : ""}`);
  }
  if (summary.status === "dismissed") {
    throw new Error(`Category previously dismissed: ${flags.category}. Use a different category name if you want to reconsider.`);
  }

  const target = resolveTarget(summary, flags);
  const block = buildRuleBlock(summary, flags.rule);

  console.log(`Proposed append to ${target.label}:`);
  console.log(`  (${target.filePath})`);
  console.log("");
  console.log(indent(block, "    "));
  console.log("");

  if (!flags.confirm) {
    console.log(`Re-run with --confirm to append. Provide --rule "..." to embed an imperative rule (otherwise only an evidence block is appended).`);
    return;
  }

  appendToRules(target.filePath, block);
  markSuggestion(flags.category, "accepted", { appendedTo: target.filePath });
  console.log(`Appended rule suggestion "${flags.category}" to ${target.filePath}`);
}

interface AcceptTarget {
  filePath: string;
  label: string;
}

function resolveTarget(summary: SuggestionSummary, flags: AcceptFlags): AcceptTarget {
  if (flags.global) {
    return { filePath: path.join(GARDEN_DIR, "rules.md"), label: "global rules" };
  }
  if (flags.project) {
    const proj = getProject(flags.project);
    return {
      filePath: path.join(proj.path, ".garden", "rules.md"),
      label: `project rules (${proj.name})`,
    };
  }
  // Inferred default
  if (summary.projects.length === 1) {
    const name = summary.projects[0];
    const proj = tryGetProject(name);
    if (proj) {
      return {
        filePath: path.join(proj.path, ".garden", "rules.md"),
        label: `project rules (${name}) — inferred from findings`,
      };
    }
  }
  return {
    filePath: path.join(GARDEN_DIR, "rules.md"),
    label: `global rules — inferred (${summary.projects.length} projects affected)`,
  };
}

export function buildRuleBlock(summary: SuggestionSummary, rule?: string): string {
  const heading = humanize(summary.category);
  const lines: string[] = [];
  lines.push("");
  lines.push(`## ${heading}`);
  lines.push("");
  if (rule) {
    lines.push(rule.trim());
    lines.push("");
  }
  lines.push(`Observed in ${summary.count} reviewer finding${summary.count === 1 ? "" : "s"} across ${summary.distinctWorkers} worker${summary.distinctWorkers === 1 ? "" : "s"}:`);
  for (const ex of summary.examples) lines.push(`- ${ex}`);
  return lines.join("\n") + "\n";
}

function appendToRules(filePath: string, block: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : "";
  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, existing + separator + block);
  fs.renameSync(tmp, filePath);
}

export function humanize(category: string): string {
  return category
    .split("-")
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function indent(text: string, prefix: string): string {
  return text.split("\n").map(l => (l.length > 0 ? prefix + l : l)).join("\n");
}

// --- dismiss ---

function handleDismiss(args: string[]): void {
  const category = args[0];
  if (!category) throw new Error(`Usage: garden rules dismiss <category>`);
  const summary = getSuggestion(category);
  if (!summary) {
    throw new Error(`No findings recorded for category: ${category}`);
  }
  if (summary.status === "accepted") {
    throw new Error(`Category already accepted, cannot dismiss: ${category}`);
  }
  markSuggestion(category, "dismissed");
  console.log(`Dismissed rule suggestion: ${category}`);
}

// --- findings ---

function handleFindings(args: string[]): void {
  let project: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--project") {
      if (!args[i + 1]) throw new Error("--project requires a value");
      project = args[++i];
    }
    else throw new Error(`Unknown flag: ${args[i]}`);
  }

  const items = listFindings({ project });
  if (items.length === 0) {
    if (isTTY) console.log(project ? `No findings for project: ${project}` : "No findings recorded.");
    else console.log(JSON.stringify({ findings: [] }));
    return;
  }
  outputLines(items, (item) => {
    const f = item as Finding;
    const ts = f.ts.replace("T", " ").slice(0, 19);
    return `  [${ts}] ${f.project}/${f.worker} ${f.verdict.toUpperCase()} ${f.category}: ${f.summary}`;
  });
}

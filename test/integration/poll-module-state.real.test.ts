// Guard against module-level state in the code a poll runs (real esbuild and
// the TypeScript parser, no mocks).
//
// The poller loop execs a fresh `garden dashboard _poll` for every wake, so a
// module-level Map, Set, array or reassigned `let` in code a poll runs is empty
// again at the next poll. State meant to carry from one poll to the next then
// silently never does: the CI gate's check-run flag, the base checkout's last
// fast-forward outcome and the gate-block log throttle each shipped as a module
// Map, with a comment promising what the Map could not keep. State a poll must
// remember belongs on disk (DESIGN.md "Merge Handling"). This test finds the
// module-level state that code a poll loads can change, and fails on any not
// listed below.
import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import ts from "typescript";

const ROOT = path.resolve(__dirname, "../..");
// What `garden dashboard _poll` calls: every module a poll runs is in its
// import closure.
const POLL_ENTRY = "src/dashboard/poller.ts";

// Module-level state that code a poll loads changes, and that is right to lose
// when the process exits, by module. Remove an entry when its state goes. A new
// one needs a line here saying why losing it at every poll is correct; when it
// is not, the state belongs on disk instead.
const PER_PROCESS: Record<string, readonly string[]> = {
  // Read caches checked against the file's mtime and size on every read: a
  // fresh process pays one parse, and a stale value is never returned.
  "src/dashboard/registry.ts": ["cachedRegistry"],
  "src/dashboard/state.ts": ["cachedState"],
  "src/diary.ts": ["contentCache"],
  // Display caches with a TTL of seconds (the checkout's branch, the bases
  // missing from origin, the status pane's width) and the status bar values
  // last sent to tmux. They save forks and tmux calls across the re-bakes
  // within one process; the first call in any process does the work.
  "src/commands/status.ts": ["projectBranchCache", "missingBaseCache"],
  "src/dashboard/header.ts": ["lastBarLeft", "lastBarRight", "lastBarStyle", "cachedStatusWidth"],
  // The `garden logs` renderer's memos (config, worker-to-project maps, column
  // widths, the day last printed) for its long-lived --follow tail. A poll
  // loads the module for formatLogsPaneLabel, which reads none of them.
  "src/commands/logs.ts": [
    "cachedConfig", "configLoadFailed", "workerToProjectCache", "workerToProjectHistoryCache",
    "registryLoadFailed", "cachedLayouts", "lastRenderedDay",
  ],
  // One warning per process by design: a process that cannot write the ledger
  // cannot write its next event either (DESIGN.md "Telemetry ledger").
  "src/dashboard/telemetry.ts": ["writeFailureLogged"],
  // A test seam that only tests reassign, and a counter that pairs with the
  // pid to give each paste buffer a unique name.
  "src/dashboard/tmux.ts": ["tmuxExecAllowed", "pasteBufferCounter"],
  // The workflow definitions, registered at load, and the unknown-workflow
  // warning's dedup. The dedup holds within one process only: a poll logs the
  // warning once however many workers name the workflow, and the next poll
  // logs it again.
  "src/dashboard/workflows/index.ts": ["registry", "warnedUnknown"],
};

// Names are resolved, never type-checked, so the standard library is left out.
const PROGRAM_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.Node16,
  moduleResolution: ts.ModuleResolutionKind.Node16,
  noLib: true,
  types: [],
  noEmit: true,
};

// Every source file the poll entry loads, following static and dynamic imports
// as esbuild resolves them. A type-only import loads nothing, and is dropped.
async function pollModules(): Promise<string[]> {
  const result = await build({
    absWorkingDir: ROOT,
    entryPoints: [path.join(ROOT, POLL_ENTRY)],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    metafile: true,
    outdir: path.join(os.tmpdir(), "garden-poll-module-state"),
    logLevel: "silent",
    define: { __GARDEN_VERSION__: '"test"', __GARDEN_COMMIT__: '"test"' },
  });
  return Object.keys(result.metafile.inputs).filter((file) => file.startsWith("src/"));
}

const COLLECTIONS = new Set(["Map", "Set", "WeakMap", "WeakSet", "Array"]);
const MUTATORS = new Set([
  "set", "add", "delete", "clear", "push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill",
  "copyWithin",
]);

function unwrap(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)
    || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node)) {
    node = node.expression;
  }
  return node;
}

// The binding a write through `a.b[k].c` changes: `a`.
function rootName(node: ts.Expression): ts.Identifier | undefined {
  let target = unwrap(node);
  while (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
    target = unwrap(target.expression);
  }
  return ts.isIdentifier(target) ? target : undefined;
}

function holdsCollection(initializer: ts.Expression | undefined): boolean {
  if (!initializer) return false;
  const value = unwrap(initializer);
  return ts.isArrayLiteralExpression(value) || ts.isObjectLiteralExpression(value)
    || (ts.isNewExpression(value) && ts.isIdentifier(value.expression) && COLLECTIONS.has(value.expression.text));
}

// `file:name` for each module-level binding in `scan` that code inside a
// function changes: a `let` or `var` it reassigns, or a Map, Set, array or
// object literal it writes through (a mutating method, an element or property
// assignment, a delete). Changes made at load time, outside any function, are
// left out, since they happen alike in every process. Names go through the
// checker, so a local that shadows a module binding is not taken for it, and a
// change made through an import counts against the module that declares it.
function changedModuleState(program: ts.Program, root: string, scan: ReadonlySet<string>): string[] {
  const checker = program.getTypeChecker();
  const relative = (file: string) => path.relative(root, file).split(path.sep).join("/");
  const sources = program.getSourceFiles().filter((source) => scan.has(relative(source.fileName)));
  const bindings = new Map<ts.Node, { key: string; reassignable: boolean; collection: boolean }>();
  for (const source of sources) {
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      const reassignable = (statement.declarationList.flags & ts.NodeFlags.Const) === 0;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        bindings.set(declaration, {
          key: `${relative(source.fileName)}:${declaration.name.text}`,
          reassignable,
          collection: holdsCollection(declaration.initializer),
        });
      }
    }
  }

  const found = new Set<string>();
  const bindingOf = (name: ts.Identifier) => {
    let symbol = checker.getSymbolAtLocation(name);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    return symbol?.valueDeclaration ? bindings.get(symbol.valueDeclaration) : undefined;
  };
  const changed = (target: ts.Expression) => {
    const name = rootName(target);
    const binding = name ? bindingOf(name) : undefined;
    if (binding?.collection) found.add(binding.key);
  };
  const written = (target: ts.Expression) => {
    const unwrapped = unwrap(target);
    if (ts.isIdentifier(unwrapped)) {
      const binding = bindingOf(unwrapped);
      if (binding?.reassignable) found.add(binding.key);
    } else {
      changed(unwrapped);
    }
  };
  const visit = (node: ts.Node, inFunction: boolean): void => {
    inFunction ||= ts.isFunctionLike(node);
    if (inFunction) {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
        && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
        written(node.left);
      } else if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
        && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) {
        written(node.operand);
      } else if (ts.isDeleteExpression(node)) {
        changed(node.expression);
      } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && MUTATORS.has(node.expression.name.text)) {
        changed(node.expression.expression);
      }
    }
    ts.forEachChild(node, (child) => visit(child, inFunction));
  };
  for (const source of sources) visit(source, false);
  return [...found].sort();
}

// A program over in-memory sources, rooted inside the repository so its
// package.json makes them ES modules, as the real ones are.
function programOver(sources: Record<string, string>): { program: ts.Program; root: string } {
  const root = path.join(ROOT, "test", "poll-module-state-fixture");
  const files = new Map(Object.entries(sources).map(([name, text]) => [path.join(root, name), text]));
  const host = ts.createCompilerHost(PROGRAM_OPTIONS);
  const { readFile, fileExists, directoryExists } = host;
  host.readFile = (file) => files.get(file) ?? readFile(file);
  host.fileExists = (file) => files.has(file) || fileExists(file);
  // Module resolution skips a directory it cannot see, and these exist only here.
  host.directoryExists = (dir) => [...files.keys()].some((file) => file.startsWith(dir + path.sep))
    || (directoryExists?.(dir) ?? false);
  return { program: ts.createProgram([...files.keys()], PROGRAM_OPTIONS, host), root };
}

describe("module-level state in the code a poll runs", () => {
  it("is all listed as right to lose at every poll", async () => {
    const modules = await pollModules();
    const program = ts.createProgram(modules.map((file) => path.join(ROOT, file)), PROGRAM_OPTIONS);
    const found = changedModuleState(program, ROOT, new Set(modules));
    const listed = Object.entries(PER_PROCESS).flatMap(([file, names]) => names.map((name) => `${file}:${name}`));

    expect(
      found.filter((key) => !listed.includes(key)),
      "state a poll changes that the next poll's process starts without: keep it on disk, "
        + "or list it in PER_PROCESS with why losing it is right",
    ).toEqual([]);
    expect(listed.filter((key) => !found.includes(key)), "listed in PER_PROCESS but no longer found").toEqual([]);
  });

  it("is found where code inside a function changes it, through an import too, and nowhere else", () => {
    const { program, root } = programOver({
      "src/shared.ts": "export const shared = new Set<string>();\n",
      "src/entry.ts": [
        'import { shared } from "./shared.js";',
        "const cache = new Map<string, number>();",
        "const seen = new Set<string>();",
        "const queue: string[] = [];",
        "const counts: Record<string, number> = {};",
        "let polls = 0;",
        "let lastProject: string | null = null;",
        "const TABLE = new Set(['a', 'b']);",
        "const LIST = ['x', 'y'] as const;",
        "const idle = new Map<string, number>();",
        "const atLoad = new Map<string, number>();",
        "atLoad.set('a', 1);",
        "let settled = 0;",
        "settled = 1;",
        "const script = `let raw = \"\"; raw += \"x\";`;",
        "export function poll(project: string): boolean {",
        "  cache.set(project, 1);",
        "  seen.add(project);",
        "  queue.push(project);",
        "  counts[project] = 1;",
        "  polls++;",
        "  lastProject = project;",
        "  shared.clear();",
        "  const local = new Map<string, number>();",
        "  local.set(project, 1);",
        "  const sorted = [...LIST].sort();",
        "  return TABLE.has(project) && sorted.length > 0 && script.length > 0 && settled > 0;",
        "}",
        "export function warm(idle: Map<string, number>): void {",
        "  idle.set('x', atLoad.get('a') ?? 0);",
        "}",
        "",
      ].join("\n"),
    });

    expect(changedModuleState(program, root, new Set(["src/entry.ts", "src/shared.ts"]))).toEqual([
      "src/entry.ts:cache",
      "src/entry.ts:counts",
      "src/entry.ts:lastProject",
      "src/entry.ts:polls",
      "src/entry.ts:queue",
      "src/entry.ts:seen",
      "src/shared.ts:shared",
    ]);
  });
});

// Builds dist/cli.js and dist/hook.js.
//
// Each bundle is written to a temp file and renamed into place. The live fleet
// executes these files on every hook and every poll, and esbuild rewrites an
// existing outfile in place, so a process starting mid-build could load a
// truncated bundle. The temp file is created executable because a renamed-in
// file does not inherit the old one's mode, and `garden` on PATH is a symlink
// to dist/cli.js.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { build } from "esbuild";

const BUNDLES = [
  { entry: "src/cli.ts", outfile: "dist/cli.js" },
  { entry: "src/hook-entry.ts", outfile: "dist/hook.js" },
];

function headSha(...flags) {
  try {
    return execFileSync("git", ["rev-parse", ...flags, "HEAD"], { encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
}

const version = headSha("--short");
const commit = headSha();
fs.mkdirSync("dist", { recursive: true });
for (const { entry, outfile } of BUNDLES) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    minify: true,
    keepNames: true,
    outfile,
    write: false,
    banner: { js: "#!/usr/bin/env node" },
    define: { __GARDEN_VERSION__: JSON.stringify(version), __GARDEN_COMMIT__: JSON.stringify(commit) },
  });
  const [output] = result.outputFiles;
  const tmp = `${outfile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, output.contents, { mode: 0o755 });
  fs.renameSync(tmp, outfile);
  console.log(`${outfile}  ${(output.contents.length / 1024).toFixed(1)}kb`);
}

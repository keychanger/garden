// Every test runs against a bare, throwaway HOME.
//
// Without this floor, a test that reads the operator's real ~/.garden passes on
// the workstation (where a config exists) and fails on a bare CI runner. That
// asymmetry shipped a broken main and mailed a CI failure notice on every push
// (2026-07-20: resolveReviewRole's unconditional loadConfig). The local checks
// command is the merge gate, so it has to see what CI sees.
//
// Per-test isolation still belongs to useTmpHome() in helpers.ts — that gives a
// test its own writable garden. This only guarantees the floor is never the
// operator's own. Keyed on pid so each run starts clean and workers share one.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = path.join(os.tmpdir(), `garden-suite-home-${process.pid}`);
fs.mkdirSync(home, { recursive: true });
process.env.HOME = home;
process.env.USERPROFILE = home;

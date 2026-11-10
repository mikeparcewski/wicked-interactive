#!/usr/bin/env node
// The change-scoped test command for this repo (`.wicked/checks.json` `test_targeted`).
//
// The repo-checks floor splices one argv entry per touched file, spelled relative to the repo root
// (`src/service/server.js`, `test/bridge.test.js`), and runs this from the root. node:test has no
// "related" mode, so this is the one place that maps a change to its tests:
//
//   1. a touched `test/*.test.js` runs itself;
//   2. any other touched file runs every `test/*.test.js` that names it in a string literal: an
//      import (`from "../src/service/server.js"`), a spawned entry point (`"wicked-interactive.js"`
//      in a path join), a data file it reads (`"doc.created.json"`);
//   3. a touched file under `src/`, `bin/`, `scripts/`, `.wicked/` or `test/` (or `package.json` /
//      `package-lock.json`) that no suite names runs EVERY suite: its dependents can't be told,
//      so the check stays conservative rather than passing on nothing;
//   4. anything else (docs, site, assets) that no suite names → say so and exit 0.
//
// Then `node --test <selected>` and exit with its status. `--dry-run` prints the selection as JSON.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Paths whose dependents can't be told when no suite names them: fall back to the whole suite.
const CONSERVATIVE = /^(?:src|bin|scripts|\.wicked|test)\/|^package(?:-lock)?\.json$/;

export function selectTests(files, { root = ROOT } = {}) {
  const testDir = join(root, "test");
  const suites = existsSync(testDir) ? readdirSync(testDir).filter((f) => f.endsWith(".test.js")).sort() : [];
  const text = new Map(suites.map((t) => [t, readFileSync(join(testDir, t), "utf8")]));
  const chosen = new Set();
  let everything = false;
  for (const raw of files) {
    const rel = relative(root, resolve(root, raw)).split(sep).join("/");
    if (/^test\/[^/]+\.test\.js$/.test(rel)) { if (existsSync(join(root, rel))) chosen.add(rel); continue; }
    // A string literal that is the file's name or ends in `/<name>`: "../src/service/server.js",
    // "wicked-interactive.js", "doc.created.json" — not the name inside a longer word.
    const named = new RegExp(`["'\`](?:[^"'\`\\n]*/)?${esc(basename(rel))}["'\`]`);
    let hit = false;
    for (const suite of suites) if (named.test(text.get(suite))) { chosen.add(`test/${suite}`); hit = true; }
    if (!hit && CONSERVATIVE.test(rel)) everything = true;
  }
  return everything ? suites.map((t) => `test/${t}`) : [...chosen].sort();
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const files = args.filter((a) => a !== "--dry-run");
  const tests = selectTests(files);
  if (dryRun) {
    process.stdout.write(JSON.stringify({ files, tests }, null, 2) + "\n");
    process.exit(0);
  }
  if (!tests.length) {
    console.log(`test-related: no test covers the ${files.length} touched file(s); nothing to run.`);
    process.exit(0);
  }
  console.log(`test-related: ${tests.length} suite(s): ${tests.join(" ")}`);
  const r = spawnSync(process.execPath, ["--test", ...tests], { cwd: ROOT, stdio: "inherit" });
  process.exit(r.status ?? 1);
}

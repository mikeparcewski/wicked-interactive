#!/usr/bin/env node
// The change-scoped test command for this repo (`.wicked/checks.json` `test_targeted`).
//
// The repo-checks floor splices one argv entry per touched file, spelled relative to the repo root
// (`src/service/server.js`, `test/bridge.test.js`), and runs this from the root. node:test has no
// "related" mode, so this is the one place that maps a change to its tests. It errs towards
// running MORE: a targeted check that passes on nothing is worse than a slow one.
//
//   1. a touched `test/*.test.js` runs itself;
//   2. a touched JS module (`src/`, `bin/`, `scripts/`, `frontend/src/`) runs every suite that
//      reaches it: suites that import it or any module that transitively imports it, plus suites
//      that name one of those files in a string literal (a spawned `bin/wicked-interactive.js`);
//      a module no suite reaches runs EVERY suite;
//   3. a docs-only file (`*.md`, `docs/`, `site/`, `examples/`, images) runs the suites that name it,
//      usually none — then say so and exit 0;
//   4. anything else (schemas and other data files, package manifests, `.wicked/`, `frontend/dist`
//      assets, test helpers) runs EVERY suite: directory readers can't be told from a file name.
//
// Then `node --test <selected>` and exit with its status. `--dry-run` prints the selection as JSON.

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const MODULE_DIRS = ["src", "bin", "scripts", "frontend/src"];
const IS_MODULE = /^(?:src|bin|scripts|frontend\/src)\/.+\.(?:m?js|cjs|jsx)$/;
const DOCS_ONLY = /\.(?:md|png|jpe?g|gif|svg|webp)$|^(?:docs|site|examples)\//;
const SPECIFIER = /(?:\bfrom|\bimport\s*\(?|\brequire\s*\()\s*["'](\.{1,2}\/[^"'\n]+)["']/g;

const toRel = (root, p) => relative(root, p).split(sep).join("/");

function walk(root, dir, out) {
  if (!existsSync(join(root, dir))) return out;
  for (const name of readdirSync(join(root, dir))) {
    if (name === "node_modules" || name === "dist") continue;
    const rel = posix.join(dir, name);
    if (statSync(join(root, rel)).isDirectory()) walk(root, rel, out);
    else if (/\.(?:m?js|cjs|jsx)$/.test(name)) out.push(rel);
  }
  return out;
}

/** Relative import specifiers in `text` (the source of `rel`), resolved to repo-relative paths. */
function importsOf(rel, text) {
  return [...text.matchAll(SPECIFIER)].map((m) => posix.normalize(posix.join(posix.dirname(rel), m[1])));
}

export function selectTests(files, { root = ROOT } = {}) {
  const testDir = join(root, "test");
  const suites = existsSync(testDir)
    ? readdirSync(testDir).filter((f) => f.endsWith(".test.js")).sort().map((f) => `test/${f}`)
    : [];
  const read = (rel) => readFileSync(join(root, rel), "utf8");
  // Reverse import graph over the modules: module → the modules that import it.
  const importers = new Map();
  for (const mod of MODULE_DIRS.flatMap((d) => walk(root, d, []))) {
    for (const dep of importsOf(mod, read(mod))) {
      if (!importers.has(dep)) importers.set(dep, new Set());
      importers.get(dep).add(mod);
    }
  }
  const suiteText = new Map(suites.map((t) => [t, read(t)]));
  const suiteImports = new Map(suites.map((t) => [t, new Set(importsOf(t, suiteText.get(t)))]));
  // A string literal that is the file's name or ends in `/<name>` ("wicked-interactive.js").
  const names = (suite, rel) =>
    new RegExp(`["'\`](?:[^"'\`\\n]*/)?${esc(basename(rel))}["'\`]`).test(suiteText.get(suite));

  const chosen = new Set();
  let everything = false;
  for (const raw of files) {
    const rel = toRel(root, resolve(root, raw));
    if (/^test\/[^/]+\.test\.js$/.test(rel)) { if (existsSync(join(root, rel))) chosen.add(rel); continue; }
    if (DOCS_ONLY.test(rel)) { for (const s of suites) if (names(s, rel)) chosen.add(s); continue; }
    if (!IS_MODULE.test(rel)) { everything = true; continue; }
    // The module and every module that transitively imports it.
    const reach = new Set([rel]);
    for (const queue = [rel]; queue.length;) {
      for (const up of importers.get(queue.pop()) ?? []) if (!reach.has(up)) { reach.add(up); queue.push(up); }
    }
    let hit = false;
    for (const s of suites) {
      if ([...reach].some((m) => suiteImports.get(s).has(m) || names(s, m))) { chosen.add(s); hit = true; }
    }
    if (!hit) everything = true;
  }
  return everything ? suites : [...chosen].sort();
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

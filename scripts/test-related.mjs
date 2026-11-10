#!/usr/bin/env node
// The change-scoped test command for this repo (`.wicked/checks.json` `test_targeted`).
//
// The repo-checks floor splices one argv entry per touched file, spelled relative to the repo root
// (`src/service/server.js`, `test/bridge.test.js`), and runs this from the root. node:test has no
// "related" mode, so this is the one place that maps a change to its tests:
//
//   1. a touched `test/*.test.js` runs itself;
//   2. a touched source file (`src/**`, `bin/**`) runs every `test/*.test.js` that imports it by
//      name — its direct dependents, e.g. `src/service/server.js` → the bridge suites;
//   3. nothing selected (docs, site, frontend, a file no test imports) → say so and exit 0.
//
// Then `node --test <selected>` and exit with its status. `--dry-run` prints the selection as JSON.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function selectTests(files, { root = ROOT } = {}) {
  const testDir = join(root, "test");
  const suites = existsSync(testDir) ? readdirSync(testDir).filter((f) => f.endsWith(".test.js")).sort() : [];
  const chosen = new Set();
  const sources = [];
  for (const raw of files) {
    const rel = relative(root, resolve(root, raw)).split(sep).join("/");
    if (/^test\/[^/]+\.test\.js$/.test(rel)) { if (existsSync(join(root, rel))) chosen.add(rel); continue; }
    if (/^(src|bin)\/.+\.(m?js)$/.test(rel)) sources.push(rel);
  }
  for (const src of sources) {
    const name = basename(src);
    // An import of a specifier ending in the module's file name: `from "../src/service/server.js"`
    // or `import("../src/service/server.js")` — not the name merely quoted in a test body.
    const spec = new RegExp(`(?:\\bfrom|\\bimport\\s*\\()\\s*["'][^"'\\n]*/${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`);
    for (const suite of suites) {
      if (spec.test(readFileSync(join(testDir, suite), "utf8"))) chosen.add(`test/${suite}`);
    }
  }
  return [...chosen].sort();
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
